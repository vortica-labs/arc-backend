const mongoose = require('mongoose');
const { createHash } = require('crypto');
const Broadcast = require('../models/Broadcast');
const BroadcastRecipient = require('../models/BroadcastRecipient');
const BroadcastChunk = require('../models/BroadcastChunk');
const BroadcastTemplate = require('../models/BroadcastTemplate');
const BroadcastOccurrence = require('../models/BroadcastOccurrence');
const BroadcastPushReceipt = require('../models/BroadcastPushReceipt');
const BroadcastEvent = require('../models/BroadcastEvent');
const NotificationFailure = require('../models/NotificationFailure');
const User = require('../models/User');
const {
  normalizeBroadcastPayload,
  WEB_PUSH_ACK_TIMEOUT_MS,
  buildAudienceQuery,
  getTimezoneDayBounds,
  getMatchedNotificationClients,
  isBroadcastCategoryAllowed,
  resolveOverallStatus,
  buildNotificationData,
  assertBroadcastPushPayloadSize,
  refreshBroadcastMetrics,
  getActor,
  createOccurrenceKey,
  fail
} = require('../services/broadcastService');

const BROADCAST_FILTER_STATUSES = new Set([
  'draft', 'scheduled', 'queued', 'processing', 'sending', 'sent', 'cancelled', 'failed'
]);
const LOG_FILTER_STATUSES = new Set([
  'pending', 'queued', 'processing', 'delivered', 'partial', 'opened', 'clicked', 'failed', 'skipped'
]);
const LOG_PLATFORMS = new Set(['android', 'ios', 'web', 'unknown']);
const DELIVERY_TYPES = new Set(['push', 'in_app', 'both']);
const PRIORITIES = new Set(['normal', 'high', 'critical']);
const CATEGORIES = new Set([
  'announcement', 'update', 'maintenance', 'feature_release', 'tournament',
  'recruitment', 'promotion', 'creator', 'premium', 'system', 'custom'
]);

const normalizeSearchTerm = (value, maxLength = 100) => String(value || '')
  .trim()
  .slice(0, maxLength)
  .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const canonicalizePayload = (value) => {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  if (Array.isArray(value)) {
    return value
      .map(canonicalizePayload)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      if (value[key] !== undefined) result[key] = canonicalizePayload(value[key]);
      return result;
    }, {});
  }
  return value;
};

const createBroadcastPayloadHash = (payload) => createHash('sha256')
  .update(JSON.stringify(canonicalizePayload(payload)))
  .digest('hex');

const assertIdempotentCreateReplay = (broadcast, payloadHash) => {
  if (!broadcast.creationPayloadHash || broadcast.creationPayloadHash !== payloadHash) {
    throw fail('Idempotency-Key was already used with a different broadcast payload', 409);
  }
};

const mapWithConcurrency = async (items, concurrency, handler) => {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await handler(items[index], index);
    }
  });
  await Promise.all(workers);
};

const assertQueryEnum = (value, allowed, fieldName) => {
  if (value === undefined || value === null || value === '') return '';
  const normalized = String(value);
  if (!allowed.has(normalized)) throw fail(`${fieldName} filter is invalid`);
  return normalized;
};

const parsePagination = (query, defaultLimit = 20, maxLimit = 100) => {
  const page = Math.max(1, Number.parseInt(String(query.page || '1'), 10) || 1);
  const limit = Math.max(1, Math.min(maxLimit, Number.parseInt(String(query.limit || defaultLimit), 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
};

const parseSort = (query, allowlist, defaultKey = 'createdAt') => {
  const key = String(query.sortBy || defaultKey);
  const field = allowlist[key] || allowlist[defaultKey];
  const direction = String(query.sortOrder || query.sortDirection || 'desc').toLowerCase() === 'asc' ? 1 : -1;
  return { [field]: direction };
};

const assertObjectId = (value, label = 'ID') => {
  if (!mongoose.Types.ObjectId.isValid(value)) throw fail(`${label} is invalid`);
  return value;
};

const applyLogFilters = (filter, query) => {
  const status = assertQueryEnum(query.status, LOG_FILTER_STATUSES, 'status');
  if (status === 'opened') filter.openedAt = { $ne: null };
  else if (status === 'clicked') filter.clickedAt = { $ne: null };
  else if (status === 'queued') filter.overallStatus = 'pending';
  else if (status) filter.overallStatus = status;
  const platform = assertQueryEnum(query.platform, LOG_PLATFORMS, 'platform');
  if (platform === 'unknown') {
    filter.$and = [
      ...(filter.$and || []),
      { $or: [
        { 'recipientSnapshot.platforms': { $exists: false } },
        { 'recipientSnapshot.platforms': { $size: 0 } },
        { 'recipientSnapshot.platforms': 'unknown' }
      ] }
    ];
  } else if (platform) {
    filter['recipientSnapshot.platforms'] = platform;
  }
  const deliveryType = assertQueryEnum(query.deliveryType, DELIVERY_TYPES, 'deliveryType');
  if (deliveryType) filter.requestedDeliveryType = deliveryType;
  const from = query.from ? new Date(String(query.from)) : null;
  const to = query.to ? new Date(String(query.to)) : null;
  if (from && Number.isNaN(from.getTime())) throw fail('from must be a valid date');
  if (to && Number.isNaN(to.getTime())) throw fail('to must be a valid date');
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(String(query.to))) to.setUTCHours(23, 59, 59, 999);
  if (from && to && from > to) throw fail('from cannot be after to');
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }
};

const getPushReceiptsByDelivery = async (logs) => {
  const ids = logs.map((log) => log._id).filter(Boolean);
  if (!ids.length) return new Map();
  const receipts = await BroadcastPushReceipt.find({ broadcastRecipient: { $in: ids } })
    .select('broadcastRecipient platform appVersion ticketStatus receiptStatus providerTicketId providerErrorCode providerErrorMessage sentAt receiptCheckedAt')
    .sort({ createdAt: 1 })
    .lean();
  return receipts.reduce((map, receipt) => {
    const key = String(receipt.broadcastRecipient);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      id: String(receipt._id),
      platform: receipt.platform || 'unknown',
      appVersion: receipt.appVersion || '',
      ticketStatus: receipt.ticketStatus,
      receiptStatus: receipt.receiptStatus,
      providerTicketId: receipt.providerTicketId || '',
      failureReason: receipt.providerErrorMessage || receipt.providerErrorCode || '',
      sentAt: receipt.sentAt || null,
      receiptCheckedAt: receipt.receiptCheckedAt || null
    });
    return map;
  }, new Map());
};

const serializeRecipientLog = (log, pushReceipts = []) => {
  const knownPlatforms = Array.from(new Set((log.recipientSnapshot?.platforms || []).filter(Boolean)));
  const matchedPushPlatforms = Array.from(new Set(pushReceipts.map((receipt) => receipt.platform).filter(Boolean)));
  const platforms = matchedPushPlatforms.length ? matchedPushPlatforms : knownPlatforms;
  const receiptFailureReason = pushReceipts
    .map((receipt) => receipt.failureReason)
    .filter(Boolean)
    .join('; ');
  return {
    ...log,
    id: String(log._id),
    broadcastId: String(log.broadcast?._id || log.broadcast),
    broadcastTitle: log.broadcast?.title || '',
    recipientId: String(log.recipient),
    notificationId: log.notification ? String(log.notification) : String(log._id),
    recipientName: log.recipientSnapshot?.displayName || log.recipientSnapshot?.username || '',
    platform: platforms.length === 1 ? platforms[0] : 'unknown',
    platforms,
    knownPlatforms,
    matchedPushPlatforms,
    pushReceipts,
    status: log.clickedAt ? 'clicked' : (log.openedAt ? 'opened' : log.overallStatus),
    delivered: ['delivered', 'partial'].includes(log.overallStatus),
    opened: Boolean(log.openedAt),
    clicked: Boolean(log.clickedAt),
    failed: log.overallStatus === 'failed',
    failureReason: log.lastError || log.push?.failureReason || log.inApp?.failureReason || receiptFailureReason || '',
    deliveredAt: log.inApp?.deliveredAt || log.push?.deliveredAt || null,
    failedAt: log.overallStatus === 'failed' ? log.updatedAt : null,
    timestamp: log.createdAt
  };
};

const asyncRoute = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    const status = Number(error.statusCode) ||
      (error.code === 11000 || error.name === 'VersionError'
        ? 409
        : (['ValidationError', 'CastError'].includes(error.name) ? 400 : 500));
    if (status >= 500) console.error('[BROADCAST API]', error);
    res.status(status).json({
      success: false,
      message: status >= 500 ? 'Broadcast operation failed' : error.message,
      ...(process.env.NODE_ENV !== 'production' && status >= 500 ? { error: error.message } : {})
    });
  }
};

const deliveryRates = (metrics = {}) => {
  const recipients = Number(metrics.recipients || 0);
  const delivered = Number(metrics.delivered || 0);
  const opened = Number(metrics.opened || 0);
  const clicked = Number(metrics.clicked || 0);
  const eligible = Math.max(0, recipients - Number(metrics.skipped || 0));
  return {
    sent: eligible,
    deliveryRate: eligible ? Number(((delivered / eligible) * 100).toFixed(2)) : 0,
    openRate: delivered ? Number(((opened / delivered) * 100).toFixed(2)) : 0,
    ctr: delivered ? Number(((clicked / delivered) * 100).toFixed(2)) : 0,
    clickRate: opened ? Number(((clicked / opened) * 100).toFixed(2)) : 0
  };
};

const serializeBroadcast = (document) => {
  const value = document?.toObject ? document.toObject() : document;
  if (!value) return value;
  const audience = value.audience || {};
  const schedule = value.schedule || {};
  const accountTypes = Array.from(new Set((audience.userTypes || []).map((type) =>
    type === 'creator' ? 'player' : type
  )));
  let creatorMonetization = 'all';
  if ((audience.creatorMonetizationStatuses || []).includes('approved')) creatorMonetization = 'enabled';
  if ((audience.creatorMonetizationStatuses || []).includes('pending')) creatorMonetization = 'pending';
  const metrics = { ...(value.metrics || {}), ...deliveryRates(value.metrics || {}) };
  return {
    ...value,
    id: String(value._id),
    status: value.status === 'processing' ? 'sending' : value.status,
    audience: {
      ...audience,
      accountTypes,
      creatorMonetization,
      customUserIds: audience.userIds || [],
      customUsernames: audience.usernames || [],
      emails: audience.emails || [],
      customEmails: audience.emails || []
    },
    schedule: {
      mode: schedule.mode || 'draft',
      scheduledAt: value.status === 'scheduled'
        ? (schedule.nextRunAt || schedule.scheduledAt || null)
        : (schedule.scheduledAt || null),
      timezone: schedule.timezone || 'UTC',
      recurrence: {
        frequency: schedule.recurrence || 'once',
        interval: schedule.recurrenceInterval || 1,
        endAt: schedule.recurrenceEndAt || null
      },
      nextRunAt: schedule.nextRunAt || null
    },
    metrics,
    analytics: metrics,
    recipientCount: Number(value.metrics?.recipients || 0),
    retryableFailureCount: Number(value.metrics?.retryableFailures || 0)
  };
};

const queueBroadcast = async (broadcast, occurrenceKeyOverride = '', enqueueKey = '') => {
  const runAt = broadcast.schedule?.nextRunAt || new Date();
  const occurrenceKey = occurrenceKeyOverride || createOccurrenceKey(runAt);
  try {
    const { enqueueBroadcast } = require('../utils/jobQueue');
    await enqueueBroadcast(String(broadcast._id), runAt, occurrenceKey, enqueueKey || undefined);
    return occurrenceKey;
  } catch (error) {
    // MongoDB is the durable outbox. The scheduler recovery loop will enqueue
    // queued/scheduled records after Redis recovers, so an admin request does
    // not synchronously fan out or lose the broadcast.
    await Broadcast.updateOne(
      { _id: broadcast._id },
      { $set: { 'execution.lastError': `Queue pending: ${String(error.message || error)}`.slice(0, 1000) } }
    ).catch(() => {});
    console.error('[BROADCAST QUEUE PENDING]', String(error));
    return null;
  }
};

const createBroadcast = asyncRoute(async (req, res) => {
  const payload = normalizeBroadcastPayload(req.body, { allowIncomplete: true });
  assertBroadcastPushPayloadSize(payload);
  const creationPayloadHash = createBroadcastPayloadHash(payload);
  const actor = getActor(req.user);
  const rawIdempotencyKey = String(req.get('Idempotency-Key') || '').trim();
  if (rawIdempotencyKey.length > 200) throw fail('Idempotency-Key cannot exceed 200 characters');
  const actorScope = String(actor.user || actor.username || 'admin');
  const creationIdempotencyKeyHash = rawIdempotencyKey
    ? createHash('sha256').update(`${actorScope}:${rawIdempotencyKey}`).digest('hex')
    : undefined;
  if (creationIdempotencyKeyHash) {
    const existing = await Broadcast.findOne({ creationIdempotencyKeyHash });
    if (existing) {
      assertIdempotentCreateReplay(existing, creationPayloadHash);
      res.locals.auditAfter = { broadcastId: String(existing._id), status: existing.status, idempotentReplay: true };
      return res.status(200).json({ success: true, idempotentReplay: true, data: serializeBroadcast(existing) });
    }
  }
  let broadcast;
  try {
    broadcast = await Broadcast.create({
      ...payload,
      status: 'draft',
      createdBy: actor,
      updatedBy: actor,
      creationIdempotencyKeyHash,
      creationPayloadHash,
      'schedule.nextRunAt': null
    });
  } catch (error) {
    if (error?.code !== 11000 || !creationIdempotencyKeyHash) throw error;
    broadcast = await Broadcast.findOne({ creationIdempotencyKeyHash });
    if (!broadcast) throw error;
    assertIdempotentCreateReplay(broadcast, creationPayloadHash);
    res.locals.auditAfter = { broadcastId: String(broadcast._id), status: broadcast.status, idempotentReplay: true };
    return res.status(200).json({ success: true, idempotentReplay: true, data: serializeBroadcast(broadcast) });
  }
  res.locals.auditAfter = { broadcastId: String(broadcast._id), status: broadcast.status };
  res.status(201).json({ success: true, data: serializeBroadcast(broadcast) });
});

const listBroadcasts = asyncRoute(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const sort = parseSort(req.query, {
    createdAt: 'createdAt', updatedAt: 'updatedAt', sentAt: 'sentAt',
    scheduledAt: 'schedule.nextRunAt', recipients: 'metrics.recipients',
    title: 'title', status: 'status'
  });
  const filter = {};
  const requestedStatus = String(req.query.status || '');
  if (requestedStatus) assertQueryEnum(requestedStatus, BROADCAST_FILTER_STATUSES, 'status');
  if (requestedStatus === 'sent') {
    filter.$and = [{ $or: [
      { status: { $in: ['queued', 'processing', 'sent', 'failed'] } },
      { status: 'scheduled', sentAt: { $ne: null } },
      { status: 'cancelled' }
    ] }];
  }
  else if (requestedStatus) filter.status = requestedStatus === 'sending' ? 'processing' : requestedStatus;
  const category = assertQueryEnum(req.query.category, CATEGORIES, 'category');
  const priority = assertQueryEnum(req.query.priority, PRIORITIES, 'priority');
  const deliveryType = assertQueryEnum(req.query.deliveryType, DELIVERY_TYPES, 'deliveryType');
  if (category) filter.category = category;
  if (priority) filter.priority = priority;
  if (deliveryType) filter.deliveryType = deliveryType;
  if (req.query.search) {
    const search = normalizeSearchTerm(req.query.search);
    const searchClause = { $or: [{ title: { $regex: search, $options: 'i' } }, { message: { $regex: search, $options: 'i' } }] };
    if (filter.$and) filter.$and.push(searchClause);
    else filter.$or = searchClause.$or;
  }
  const [items, total] = await Promise.all([
    Broadcast.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    Broadcast.countDocuments(filter)
  ]);
  res.json({
    success: true,
    data: {
      broadcasts: items.map(serializeBroadcast),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    }
  });
});

const getBroadcast = asyncRoute(async (req, res) => {
  assertObjectId(req.params.id, 'Broadcast ID');
  const broadcast = await Broadcast.findById(req.params.id).lean();
  if (!broadcast) throw fail('Broadcast not found', 404);
  res.json({ success: true, data: serializeBroadcast(broadcast) });
});

const updateBroadcast = asyncRoute(async (req, res) => {
  assertObjectId(req.params.id, 'Broadcast ID');
  const existing = await Broadcast.findById(req.params.id);
  if (!existing) throw fail('Broadcast not found', 404);
  res.locals.auditBefore = { broadcastId: String(existing._id), status: existing.status, updatedAt: existing.updatedAt };
  if (!['draft', 'scheduled'].includes(existing.status)) {
    throw fail('Only draft or scheduled broadcasts can be edited; duplicate a failed broadcast to change its content', 409);
  }
  const payload = normalizeBroadcastPayload(req.body, {
    partial: true,
    allowIncomplete: existing.status === 'draft'
  });
  const mergedAudience = payload.audience || existing.audience?.toObject?.() || existing.audience;
  // Scheduled records must remain delivery-ready. Drafts may intentionally be
  // incomplete and are validated strictly at the send boundary.
  if (existing.status === 'scheduled') buildAudienceQuery(mergedAudience);
  const wasScheduled = existing.status === 'scheduled';
  Object.assign(existing, payload);
  if (wasScheduled) existing.set(normalizeBroadcastPayload(existing.toObject()));
  assertBroadcastPushPayloadSize(existing.toObject());
  existing.updatedBy = getActor(req.user);
  if (wasScheduled && existing.schedule?.mode !== 'scheduled') {
    existing.status = 'draft';
    existing.schedule.nextRunAt = null;
  } else if (existing.status === 'scheduled') {
    const effectiveNextRunAt = payload.schedule
      ? existing.schedule?.scheduledAt
      : (existing.schedule?.nextRunAt || existing.schedule?.scheduledAt);
    if (!effectiveNextRunAt || effectiveNextRunAt <= new Date()) {
      throw fail('Scheduled time must be in the future');
    }
    existing.schedule.scheduledAt = effectiveNextRunAt;
    existing.schedule.nextRunAt = effectiveNextRunAt;
  }
  try {
    await existing.save();
  } catch (error) {
    if (error?.name === 'VersionError') {
      throw fail('Broadcast changed while it was being edited; reload before retrying', 409);
    }
    throw error;
  }
  if (wasScheduled) {
    const { removeBroadcastJobs } = require('../utils/jobQueue');
    await removeBroadcastJobs(String(existing._id)).catch(() => {});
  }
  if (existing.status === 'scheduled') await queueBroadcast(existing);
  res.locals.auditAfter = { broadcastId: String(existing._id), status: existing.status, updatedAt: existing.updatedAt };
  res.json({ success: true, data: serializeBroadcast(existing) });
});

const deleteBroadcast = asyncRoute(async (req, res) => {
  assertObjectId(req.params.id, 'Broadcast ID');
  const deleted = await Broadcast.findOneAndDelete({ _id: req.params.id, status: 'draft' });
  if (!deleted) throw fail('Only draft broadcasts can be deleted', 409);
  res.locals.auditBefore = { broadcastId: String(deleted._id), status: deleted.status };
  await BroadcastRecipient.deleteMany({ broadcast: deleted._id });
  res.json({ success: true, message: 'Broadcast deleted' });
});

const duplicateBroadcast = asyncRoute(async (req, res) => {
  assertObjectId(req.params.id, 'Broadcast ID');
  const source = await Broadcast.findById(req.params.id).lean();
  if (!source) throw fail('Broadcast not found', 404);
  const actor = getActor(req.user);
  const duplicate = await Broadcast.create({
    title: `${source.title} (Copy)`.slice(0, 100),
    message: source.message,
    subtitle: source.subtitle,
    bannerImage: source.bannerImage,
    thumbnail: source.thumbnail,
    cta: source.cta,
    priority: source.priority,
    category: source.category,
    customCategory: source.customCategory,
    deliveryType: source.deliveryType,
    push: source.push,
    audience: source.audience,
    schedule: { mode: 'draft', timezone: source.schedule?.timezone || 'UTC', recurrence: 'once' },
    status: 'draft',
    createdBy: actor,
    updatedBy: actor
  });
  res.locals.auditAfter = { broadcastId: String(duplicate._id), duplicatedFrom: String(source._id), status: duplicate.status };
  res.status(201).json({ success: true, data: serializeBroadcast(duplicate) });
});

const previewPayload = asyncRoute(async (req, res) => {
  const payload = normalizeBroadcastPayload(req.body);
  assertBroadcastPushPayloadSize(payload);
  const query = buildAudienceQuery(payload.audience);
  const [recipientCount, sampleUsers] = await Promise.all([
    User.countDocuments(query),
    User.find(query).select('username profile.displayName profile.avatar userType isPremium pushTokens.platform').limit(5).lean()
  ]);
  res.json({
    success: true,
    data: {
      recipientCount,
      sampleUsers,
      previews: {
        android: payload,
        ios: payload,
        web: payload,
        inApp: payload
      }
    }
  });
});

const previewBroadcast = asyncRoute(async (req, res) => {
  assertObjectId(req.params.id, 'Broadcast ID');
  const broadcast = await Broadcast.findById(req.params.id).lean();
  if (!broadcast) throw fail('Broadcast not found', 404);
  const query = buildAudienceQuery(broadcast.audience);
  const [recipientCount, sampleUsers] = await Promise.all([
    User.countDocuments(query),
    User.find(query).select('username profile.displayName profile.avatar userType isPremium pushTokens.platform').limit(5).lean()
  ]);
  res.json({
    success: true,
    data: { recipientCount, sampleUsers, broadcast: serializeBroadcast(broadcast) }
  });
});

const sendBroadcast = asyncRoute(async (req, res) => {
  assertObjectId(req.params.id, 'Broadcast ID');
  const broadcast = await Broadcast.findById(req.params.id);
  if (!broadcast) throw fail('Broadcast not found', 404);
  if (!['draft', 'scheduled', 'failed'].includes(broadcast.status)) {
    throw fail('Broadcast has already been queued or sent', 409);
  }
  const wasFailed = broadcast.status === 'failed';
  const retryOccurrenceKey = wasFailed ? broadcast.execution?.occurrenceKey : '';
  const recipientEstimate = Number(broadcast.execution?.audienceSnapshotRecipients || 0) || null;
  const requestedSchedule = req.body?.schedule
    ? require('../services/broadcastService').normalizeSchedule(req.body.schedule)
    : null;
  if (requestedSchedule) broadcast.schedule = requestedSchedule;
  // Persisted drafts may be structurally incomplete; this is the strict,
  // normalized delivery boundary before any status or queue side effect.
  broadcast.set(normalizeBroadcastPayload(broadcast.toObject()));
  const audience = broadcast.audience?.toObject ? broadcast.audience.toObject() : broadcast.audience;
  buildAudienceQuery(audience);
  assertBroadcastPushPayloadSize(broadcast.toObject());
  const scheduled = broadcast.schedule?.mode === 'scheduled' && (!wasFailed || Boolean(requestedSchedule));
  if (scheduled && (!broadcast.schedule.scheduledAt || broadcast.schedule.scheduledAt <= new Date())) {
    throw fail('Scheduled time must be in the future');
  }
  broadcast.status = scheduled ? 'scheduled' : 'queued';
  broadcast.schedule.mode = scheduled ? 'scheduled' : 'immediate';
  broadcast.schedule.nextRunAt = scheduled ? broadcast.schedule.scheduledAt : new Date();
  broadcast.execution.lastError = '';
  broadcast.updatedBy = getActor(req.user);
  await broadcast.save();
  if (retryOccurrenceKey) {
    const { removeBroadcastJobs } = require('../utils/jobQueue');
    await removeBroadcastJobs(String(broadcast._id)).catch(() => {});
  }
  await queueBroadcast(broadcast, retryOccurrenceKey || '', retryOccurrenceKey ? `manual-${Date.now()}` : '');
  res.locals.auditAfter = {
    broadcastId: String(broadcast._id),
    status: broadcast.status,
    retryOccurrenceKey: retryOccurrenceKey || null,
    deliveryType: broadcast.deliveryType,
    scheduledAt: broadcast.schedule?.nextRunAt || null,
    recipientEstimate,
    recipientEstimateState: recipientEstimate === null ? 'pending_async_snapshot' : 'exact_snapshot',
    audience
  };
  res.status(202).json({ success: true, data: serializeBroadcast(broadcast) });
});

const retryFailedNotifications = asyncRoute(async (req, res) => {
  assertObjectId(req.params.id, 'Broadcast ID');
  const broadcast = await Broadcast.findById(req.params.id);
  if (!broadcast) throw fail('Broadcast not found', 404);
  if (broadcast.status === 'cancelled' || broadcast.cancelledAt) {
    throw fail('Cancelled broadcasts cannot be retried', 409);
  }
  if (['draft', 'queued', 'processing'].includes(broadcast.status)) {
    throw fail('This broadcast has no terminal failures available for retry', 409);
  }

  const requestedRecipients = Array.isArray(req.body?.recipientIds)
    ? Array.from(new Set(req.body.recipientIds.map(String).filter(Boolean)))
    : [];
  if (requestedRecipients.length > 5000) throw fail('At most 5000 recipient IDs can be retried at once');
  requestedRecipients.forEach((id) => assertObjectId(id, 'Recipient ID'));
  const recipientFilter = {
    broadcast: broadcast._id,
    $or: [
      { overallStatus: { $in: ['failed', 'partial'] } },
      { 'push.status': 'failed' },
      { 'inApp.status': 'failed' }
    ],
    ...(requestedRecipients.length ? { recipient: { $in: requestedRecipients } } : {})
  };
  const totalFailures = await BroadcastRecipient.countDocuments(recipientFilter);
  if (!totalFailures) throw fail('No failed notifications are available to retry', 409);
  const resetReceiptUpdate = {
    $set: {
      ticketStatus: 'queued', receiptStatus: 'pending', sendAttempts: 0, receiptAttempts: 0,
      nextReceiptAt: new Date(), providerErrorCode: '', providerErrorMessage: ''
    },
    $inc: { manualRetryCount: 1 },
    $unset: {
      providerTicketId: 1, sendLeaseAt: 1, sendLeaseKey: 1,
      receiptLeaseAt: 1, receiptLeaseKey: 1, sentAt: 1, receiptCheckedAt: 1
    }
  };

  const failedOccurrenceChunkCount = broadcast.status === 'failed' && broadcast.execution?.occurrenceKey
    ? await BroadcastChunk.countDocuments({
      broadcast: broadcast._id,
      occurrenceKey: broadcast.execution.occurrenceKey,
      status: 'failed'
    })
    : 0;
  if (failedOccurrenceChunkCount) {
    const failedReceiptFilter = {
      broadcast: broadcast._id,
      $or: [{ ticketStatus: 'failed' }, { receiptStatus: 'failed' }]
    };
    const providerRecordCount = await BroadcastPushReceipt.countDocuments(failedReceiptFilter);
    if (providerRecordCount) await BroadcastPushReceipt.updateMany(failedReceiptFilter, resetReceiptUpdate);
    await NotificationFailure.updateMany(
      { broadcast: broadcast._id, status: 'open' },
      { $set: { status: 'retrying', retryRequestedAt: new Date() } }
    );
    await BroadcastChunk.updateMany(
      { broadcast: broadcast._id, occurrenceKey: broadcast.execution.occurrenceKey, status: 'failed' },
      { $set: { status: 'pending', processingLeaseAt: null, workerJobId: '', lastError: '' }, $unset: { completedAt: 1 } }
    );
    broadcast.status = 'queued';
    broadcast.execution.lastError = '';
    broadcast.execution.finishedAt = null;
    broadcast.execution.attempts = 0;
    broadcast.updatedBy = getActor(req.user);
    await broadcast.save();
    const { removeBroadcastJobs } = require('../utils/jobQueue');
    await removeBroadcastJobs(String(broadcast._id)).catch(() => {});
    await queueBroadcast(broadcast, broadcast.execution.occurrenceKey, `manual-${Date.now()}`);
    res.locals.auditAfter = {
      broadcastId: String(broadcast._id), retryMode: 'occurrence_chunks',
      recipientCount: totalFailures, providerRecordCount
    };
    return res.status(202).json({
      success: true,
      data: { broadcastId: String(broadcast._id), retryMode: 'occurrence_chunks', recipientCount: totalFailures, hasMore: false }
    });
  }

  const retryBatchLimit = 5000;
  const providerRecipientFilter = {
    broadcast: broadcast._id,
    'push.status': 'failed',
    webPushAcknowledgedAt: null,
    ...(requestedRecipients.length ? { recipient: { $in: requestedRecipients } } : {})
  };
  const providerFailureCount = await BroadcastRecipient.countDocuments(providerRecipientFilter);
  if (!providerFailureCount) throw fail('No retryable provider delivery records were found', 409);
  const failedRecipients = await BroadcastRecipient.find(providerRecipientFilter)
    .select('_id recipient occurrenceKey requestedDeliveryType notification push inApp overallStatus webPushEmittedAt webPushAckDeadlineAt webPushRetryRequestedAt')
    .sort({ _id: 1 })
    .limit(retryBatchLimit)
    .lean();
  const recipientLogIds = failedRecipients.map((row) => row._id);
  const failedReceipts = await BroadcastPushReceipt.find({
    broadcast: broadcast._id,
    broadcastRecipient: { $in: recipientLogIds },
    $or: [{ ticketStatus: 'failed' }, { receiptStatus: 'failed' }]
  }).select('_id broadcastRecipient').lean();
  const providerRecipientIds = new Set(failedReceipts.map((row) => String(row.broadcastRecipient)));
  const providerRecipients = failedRecipients.filter((row) => providerRecipientIds.has(String(row._id)));
  // Only rows backed by concrete receipt jobs enter provider processing. This
  // prevents Web-only ACK timeouts from being stranded in processing forever.
  if (failedReceipts.length) {
    await BroadcastPushReceipt.updateMany(
      { _id: { $in: failedReceipts.map((row) => row._id) } },
      resetReceiptUpdate
    );
    await BroadcastRecipient.bulkWrite(providerRecipients.map((row) => ({
      updateOne: {
        filter: { _id: row._id, webPushAcknowledgedAt: null, 'push.status': 'failed' },
        update: { $set: {
          overallStatus: resolveOverallStatus('processing', row.inApp?.status),
          'push.status': 'processing',
          'push.failureReason': '',
          lastError: ''
        } }
      }
    })), { ordered: false });
  }

  const webCandidates = failedRecipients.filter((row) => Boolean(row.webPushEmittedAt));
  const occurrenceKeys = Array.from(new Set(webCandidates.map((row) => row.occurrenceKey).filter(Boolean)));
  const [users, occurrences] = await Promise.all([
    User.find({ _id: { $in: webCandidates.map((row) => row.recipient) }, isActive: true })
      .select('notificationClients notificationSettings')
      .lean(),
    BroadcastOccurrence.find({ broadcast: broadcast._id, occurrenceKey: { $in: occurrenceKeys } }).lean()
  ]);
  const userById = new Map(users.map((user) => [String(user._id), user]));
  const occurrenceByKey = new Map(occurrences.map((occurrence) => [occurrence.occurrenceKey, occurrence.snapshot]));
  const fallbackBroadcast = broadcast.toObject();
  const webRetryRecipientIds = [];
  const { emitBroadcastPushNotification } = require('../utils/notificationEmitter');
  await mapWithConcurrency(webCandidates, 25, async (row) => {
    const user = userById.get(String(row.recipient));
    const deliveryBroadcast = {
      ...(occurrenceByKey.get(row.occurrenceKey) || fallbackBroadcast),
      _id: broadcast._id
    };
    const settings = user?.notificationSettings || {};
    const pushAllowed = Boolean(user) &&
      settings.pushEnabled !== false &&
      isBroadcastCategoryAllowed(settings, deliveryBroadcast.category);
    const webPushAvailable = pushAllowed && getMatchedNotificationClients(
      user,
      deliveryBroadcast.audience || {}
    ).some((client) =>
      client.platform === 'web' &&
      client.notificationPermission === 'granted' &&
      client.browserNotificationsSupported === true
    );
    if (!webPushAvailable) return;

    const hasProviderRetry = providerRecipientIds.has(String(row._id));
    const retryRequestedAt = new Date();
    const ackDeadline = new Date(retryRequestedAt.getTime() + WEB_PUSH_ACK_TIMEOUT_MS);
    const claim = await BroadcastRecipient.findOneAndUpdate(
      {
        _id: row._id,
        webPushAcknowledgedAt: null,
        webPushEmittedAt: { $ne: null },
        'push.status': { $in: hasProviderRetry ? ['failed', 'processing'] : ['failed'] }
      },
      { $set: {
        webPushEmittedAt: retryRequestedAt,
        webPushAckDeadlineAt: ackDeadline,
        webPushRetryRequestedAt: retryRequestedAt,
        overallStatus: resolveOverallStatus('processing', row.inApp?.status),
        'push.status': 'processing',
        'push.failureReason': '',
        lastError: ''
      } },
      { new: true }
    );
    if (!claim) return;

    let emitted = false;
    try {
      emitted = emitBroadcastPushNotification(row.recipient, {
        id: String(row._id),
        type: 'system',
        title: deliveryBroadcast.title,
        message: deliveryBroadcast.message,
        subtitle: deliveryBroadcast.subtitle || '',
        bannerImage: deliveryBroadcast.bannerImage || '',
        thumbnail: deliveryBroadcast.thumbnail || '',
        data: buildNotificationData(
          deliveryBroadcast,
          claim,
          row.requestedDeliveryType || deliveryBroadcast.deliveryType
        )
      });
    } catch {
      emitted = false;
    }
    if (emitted) {
      webRetryRecipientIds.push(row._id);
      return;
    }
    const fallbackPushStatus = hasProviderRetry ? 'processing' : 'failed';
    const failureReason = hasProviderRetry
      ? ''
      : (row.push?.failureReason || 'No active Web socket accepted the retry');
    await BroadcastRecipient.updateOne(
      { _id: row._id, webPushAcknowledgedAt: null, webPushRetryRequestedAt: retryRequestedAt },
      { $set: {
        webPushAckDeadlineAt: null,
        overallStatus: resolveOverallStatus(fallbackPushStatus, row.inApp?.status),
        'push.status': fallbackPushStatus,
        'push.failureReason': failureReason,
        lastError: failureReason ? `Push: ${failureReason}`.slice(0, 1000) : ''
      } }
    );
  });

  const { enqueueBroadcastReceipts } = require('../utils/jobQueue');
  if (failedReceipts.length) {
    await enqueueBroadcastReceipts(
      failedReceipts.map((row) => String(row._id)),
      new Date(),
      `manual-${String(broadcast._id)}-${Date.now()}`
    ).catch(() => {});
  }
  const actionableRecipientIds = Array.from(new Set([
    ...providerRecipients.map((row) => String(row._id)),
    ...webRetryRecipientIds.map(String)
  ]));
  if (!actionableRecipientIds.length) {
    throw fail('No retryable provider or Web delivery records were found', 409);
  }
  await NotificationFailure.updateMany(
    { broadcast: broadcast._id, broadcastRecipient: { $in: actionableRecipientIds }, status: 'open' },
    { $set: { status: 'retrying', retryRequestedAt: new Date() } }
  );
  await refreshBroadcastMetrics(broadcast._id);
  const hasMore = providerFailureCount > failedRecipients.length;
  const remaining = Math.max(0, providerFailureCount - failedRecipients.length);
  const retryMode = providerRecipients.length && webRetryRecipientIds.length
    ? 'mixed'
    : (webRetryRecipientIds.length ? 'web_socket' : 'provider_receipts');
  res.locals.auditAfter = {
    broadcastId: String(broadcast._id), retryMode,
    recipientCount: actionableRecipientIds.length,
    providerRecipientCount: providerRecipients.length,
    webRecipientCount: webRetryRecipientIds.length,
    providerRecordCount: failedReceipts.length,
    hasMore, remaining
  };
  return res.status(202).json({
    success: true,
    data: {
      broadcastId: String(broadcast._id), retryMode,
      recipientCount: actionableRecipientIds.length,
      providerRecipientCount: providerRecipients.length,
      webRecipientCount: webRetryRecipientIds.length,
      hasMore, remaining
    }
  });
});

const cancelBroadcast = asyncRoute(async (req, res) => {
  assertObjectId(req.params.id, 'Broadcast ID');
  const broadcast = await Broadcast.findOneAndUpdate(
    { _id: req.params.id, status: { $in: ['scheduled', 'queued', 'processing', 'failed'] } },
    {
      $set: {
        status: 'cancelled',
        cancelledAt: new Date(),
        'schedule.nextRunAt': null,
        updatedBy: getActor(req.user)
      }
    },
    { new: true }
  );
  if (!broadcast) throw fail('Broadcast cannot be cancelled in its current state', 409);
  await BroadcastPushReceipt.updateMany(
    { broadcast: broadcast._id, ticketStatus: 'queued', receiptStatus: 'pending' },
    {
      $set: {
        ticketStatus: 'cancelled',
        receiptStatus: 'cancelled',
        receiptCheckedAt: new Date(),
        providerErrorCode: 'BroadcastCancelled',
        providerErrorMessage: 'Broadcast was cancelled before provider submission'
      },
      $unset: { sendLeaseAt: 1, sendLeaseKey: 1, receiptLeaseAt: 1, receiptLeaseKey: 1, nextReceiptAt: 1 }
    }
  );
  const cancellableRecipientFilter = {
    broadcast: broadcast._id,
    webPushAcknowledgedAt: null,
    'push.status': { $in: ['pending', 'processing'] }
  };
  await Promise.all([
    BroadcastRecipient.updateMany(
      { ...cancellableRecipientFilter, 'inApp.status': 'delivered' },
      { $set: { 'push.status': 'skipped', overallStatus: 'delivered', processingLeaseAt: null, processingKey: '' } }
    ),
    BroadcastRecipient.updateMany(
      { ...cancellableRecipientFilter, 'inApp.status': 'failed' },
      { $set: { 'push.status': 'skipped', overallStatus: 'failed', processingLeaseAt: null, processingKey: '' } }
    ),
    BroadcastRecipient.updateMany(
      { ...cancellableRecipientFilter, 'inApp.status': { $nin: ['delivered', 'failed'] } },
      { $set: { 'push.status': 'skipped', overallStatus: 'skipped', processingLeaseAt: null, processingKey: '' } }
    )
  ]);
  await refreshBroadcastMetrics(broadcast._id);
  res.locals.auditAfter = { broadcastId: String(broadcast._id), status: broadcast.status };
  const { removeBroadcastJobs } = require('../utils/jobQueue');
  await removeBroadcastJobs(String(broadcast._id)).catch(() => {});
  res.json({ success: true, data: serializeBroadcast(broadcast) });
});

const getDashboard = asyncRoute(async (req, res) => {
  const {
    timezone,
    start: startOfToday,
    end: endOfToday
  } = getTimezoneDayBounds(req.query.timezone || 'UTC');
  const [statuses, broadcastsSent, sentToday, recipientSummary, openTimes, recentBroadcasts, todayBroadcasts] = await Promise.all([
    Broadcast.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Broadcast.countDocuments({ sentAt: { $ne: null } }),
    Broadcast.countDocuments({ sentAt: { $gte: startOfToday, $lt: endOfToday } }),
    Broadcast.aggregate([{
      $group: {
        _id: null,
        recipients: { $sum: '$metrics.recipients' },
        delivered: { $sum: '$metrics.delivered' },
        failed: { $sum: '$metrics.failed' },
        skipped: { $sum: '$metrics.skipped' },
        opened: { $sum: '$metrics.opened' },
        clicked: { $sum: '$metrics.clicked' },
        pushDelivered: { $sum: '$metrics.pushDelivered' },
        pushAttempted: { $sum: '$metrics.pushAttempted' },
        retryableFailures: { $sum: '$metrics.retryableFailures' }
      }
    }]),
    BroadcastRecipient.aggregate([
      { $match: { openedAt: { $ne: null } } },
      { $project: { duration: { $subtract: ['$openedAt', '$createdAt'] } } },
      { $group: { _id: null, averageMs: { $avg: '$duration' } } }
    ]),
    Broadcast.find().sort({ updatedAt: -1 }).limit(8).lean(),
    Broadcast.find({ sentAt: { $gte: startOfToday, $lt: endOfToday } })
      .sort({ sentAt: -1 })
      .limit(20)
      .lean()
  ]);
  const statusMap = Object.fromEntries(statuses.map((entry) => [entry._id, entry.count]));
  const summary = recipientSummary[0] || { recipients: 0, delivered: 0, failed: 0, skipped: 0, opened: 0, clicked: 0, pushDelivered: 0, pushAttempted: 0 };
  const rates = deliveryRates(summary);
  res.json({
    success: true,
    data: {
      timezone,
      totalBroadcasts: Object.values(statusMap).reduce((sum, value) => sum + Number(value), 0),
      drafts: statusMap.draft || 0,
      scheduled: statusMap.scheduled || 0,
      broadcastsSent,
      sent: broadcastsSent,
      sending: (statusMap.processing || 0) + (statusMap.queued || 0),
      sentToday,
      recipients: summary.recipients,
      delivered: summary.delivered,
      failed: summary.failed,
      skipped: summary.skipped,
      opened: summary.opened,
      clicked: summary.clicked,
      retryableFailures: summary.retryableFailures || 0,
      totalRecipients: summary.recipients,
      pushDeliveryRate: summary.pushAttempted ? Number(((summary.pushDelivered / summary.pushAttempted) * 100).toFixed(2)) : 0,
      deliveryRate: rates.deliveryRate,
      openRate: rates.openRate,
      ctr: rates.ctr,
      clickRate: rates.clickRate,
      averageOpenTime: Number(((openTimes[0]?.averageMs || 0) / 1000).toFixed(1)),
      averageOpenTimeMs: Math.round(openTimes[0]?.averageMs || 0),
      recentBroadcasts: recentBroadcasts.map(serializeBroadcast),
      todayBroadcasts: todayBroadcasts.map(serializeBroadcast)
    }
  });
});

const getRecipients = asyncRoute(async (req, res) => {
  assertObjectId(req.params.id, 'Broadcast ID');
  const { page, limit, skip } = parsePagination(req.query, 50, 200);
  const sort = parseSort(req.query, {
    createdAt: 'createdAt', deliveredAt: 'inApp.deliveredAt', openedAt: 'openedAt',
    clickedAt: 'clickedAt', status: 'overallStatus'
  });
  const filter = { broadcast: req.params.id };
  applyLogFilters(filter, req.query);
  if (req.query.search) {
    const rawSearch = String(req.query.search).trim().slice(0, 100);
    const search = rawSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { 'recipientSnapshot.username': { $regex: search, $options: 'i' } },
      { 'recipientSnapshot.displayName': { $regex: search, $options: 'i' } }
    ];
    if (mongoose.Types.ObjectId.isValid(rawSearch)) {
      const objectId = new mongoose.Types.ObjectId(rawSearch);
      filter.$or.push({ _id: objectId }, { recipient: objectId }, { notification: objectId });
    }
  }
  const [recipients, total] = await Promise.all([
    BroadcastRecipient.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    BroadcastRecipient.countDocuments(filter)
  ]);
  const receiptsByDelivery = await getPushReceiptsByDelivery(recipients);
  const serialized = recipients.map((log) => serializeRecipientLog(log, receiptsByDelivery.get(String(log._id)) || []));
  res.json({ success: true, data: { recipients: serialized, pagination: { page, limit, total, pages: Math.ceil(total / limit) } } });
});

const getDeliveryLogs = asyncRoute(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query, 50, 200);
  const sort = parseSort(req.query, {
    createdAt: 'createdAt', deliveredAt: 'inApp.deliveredAt', openedAt: 'openedAt',
    clickedAt: 'clickedAt', status: 'overallStatus'
  });
  const filter = {};
  if (req.query.broadcastId) filter.broadcast = assertObjectId(req.query.broadcastId, 'Broadcast ID');
  applyLogFilters(filter, req.query);
  if (req.query.search) {
    const rawSearch = String(req.query.search).trim().slice(0, 100);
    const search = rawSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { 'recipientSnapshot.username': { $regex: search, $options: 'i' } },
      { 'recipientSnapshot.displayName': { $regex: search, $options: 'i' } }
    ];
    if (mongoose.Types.ObjectId.isValid(rawSearch)) {
      const objectId = new mongoose.Types.ObjectId(rawSearch);
      filter.$or.push(
        { _id: objectId },
        { broadcast: objectId },
        { recipient: objectId },
        { notification: objectId }
      );
    }
  }
  const [logs, total] = await Promise.all([
    BroadcastRecipient.find(filter)
      .populate('broadcast', 'title status category')
      .sort(sort).skip(skip).limit(limit).lean(),
    BroadcastRecipient.countDocuments(filter)
  ]);
  const receiptsByDelivery = await getPushReceiptsByDelivery(logs);
  const serialized = logs.map((log) => serializeRecipientLog(log, receiptsByDelivery.get(String(log._id)) || []));
  res.json({ success: true, data: { logs: serialized, pagination: { page, limit, total, pages: Math.ceil(total / limit) } } });
});

const getAnalytics = asyncRoute(async (req, res) => {
  assertObjectId(req.params.id, 'Broadcast ID');
  const broadcastObjectId = new mongoose.Types.ObjectId(req.params.id);
  const broadcast = await Broadcast.findById(broadcastObjectId).lean();
  if (!broadcast) throw fail('Broadcast not found', 404);
  const match = { broadcast: broadcastObjectId };
  const [summaryRows, platformReceipts, platformEvents, accountTypes, premium, locations, averageOpen] = await Promise.all([
    BroadcastRecipient.aggregate([
      { $match: match },
      { $group: {
        _id: null,
        recipients: { $sum: 1 },
        delivered: { $sum: { $cond: [{ $in: ['$overallStatus', ['delivered', 'partial']] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ['$overallStatus', 'failed'] }, 1, 0] } },
        skipped: { $sum: { $cond: [{ $eq: ['$overallStatus', 'skipped'] }, 1, 0] } },
        opened: { $sum: { $cond: [{ $ne: ['$openedAt', null] }, 1, 0] } },
        clicked: { $sum: { $cond: [{ $ne: ['$clickedAt', null] }, 1, 0] } },
        pushDelivered: { $sum: { $cond: [{ $eq: ['$push.status', 'delivered'] }, 1, 0] } },
        inAppDelivered: { $sum: { $cond: [{ $eq: ['$inApp.status', 'delivered'] }, 1, 0] } }
      } }
    ]),
    BroadcastPushReceipt.aggregate([
      { $match: { broadcast: broadcastObjectId } },
      { $group: {
        _id: { platform: { $ifNull: ['$platform', 'unknown'] }, recipient: '$broadcastRecipient' },
        delivered: { $max: { $cond: [{ $eq: ['$receiptStatus', 'delivered'] }, 1, 0] } },
        failedAny: { $max: { $cond: [{ $eq: ['$receiptStatus', 'failed'] }, 1, 0] } }
      } },
      { $group: {
        _id: '$_id.platform',
        recipients: { $sum: 1 },
        delivered: { $sum: '$delivered' },
        failed: { $sum: { $cond: [{ $eq: ['$delivered', 1] }, 0, '$failedAny'] } }
      } }
    ]),
    BroadcastEvent.aggregate([
      { $match: { broadcast: broadcastObjectId, eventType: { $in: ['delivered', 'open', 'click'] } } },
      { $group: {
        _id: { platform: { $ifNull: ['$platform', 'unknown'] }, recipient: '$broadcastRecipient' },
        delivered: { $max: { $cond: [{ $eq: ['$eventType', 'delivered'] }, 1, 0] } },
        opened: { $max: { $cond: [{ $eq: ['$eventType', 'open'] }, 1, 0] } },
        clicked: { $max: { $cond: [{ $eq: ['$eventType', 'click'] }, 1, 0] } }
      } },
      { $group: {
        _id: '$_id.platform',
        recipients: { $sum: 1 },
        delivered: { $sum: '$delivered' },
        opened: { $sum: '$opened' },
        clicked: { $sum: '$clicked' }
      } }
    ]),
    BroadcastRecipient.aggregate([{ $match: match }, { $group: { _id: '$recipientSnapshot.userType', recipients: { $sum: 1 }, delivered: { $sum: { $cond: [{ $in: ['$overallStatus', ['delivered', 'partial']] }, 1, 0] } }, failed: { $sum: { $cond: [{ $eq: ['$overallStatus', 'failed'] }, 1, 0] } }, opened: { $sum: { $cond: [{ $ne: ['$openedAt', null] }, 1, 0] } }, clicked: { $sum: { $cond: [{ $ne: ['$clickedAt', null] }, 1, 0] } } } }]),
    BroadcastRecipient.aggregate([{ $match: match }, { $group: { _id: '$recipientSnapshot.isPremium', recipients: { $sum: 1 }, delivered: { $sum: { $cond: [{ $in: ['$overallStatus', ['delivered', 'partial']] }, 1, 0] } }, failed: { $sum: { $cond: [{ $eq: ['$overallStatus', 'failed'] }, 1, 0] } }, opened: { $sum: { $cond: [{ $ne: ['$openedAt', null] }, 1, 0] } }, clicked: { $sum: { $cond: [{ $ne: ['$clickedAt', null] }, 1, 0] } } } }]),
    BroadcastRecipient.aggregate([{ $match: match }, { $group: { _id: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$recipientSnapshot.country', ''] } }, 0] }, '$recipientSnapshot.country', 'Unknown'] }, recipients: { $sum: 1 }, delivered: { $sum: { $cond: [{ $in: ['$overallStatus', ['delivered', 'partial']] }, 1, 0] } }, failed: { $sum: { $cond: [{ $eq: ['$overallStatus', 'failed'] }, 1, 0] } }, opened: { $sum: { $cond: [{ $ne: ['$openedAt', null] }, 1, 0] } }, clicked: { $sum: { $cond: [{ $ne: ['$clickedAt', null] }, 1, 0] } } } }, { $sort: { recipients: -1 } }, { $limit: 50 }]),
    BroadcastRecipient.aggregate([{ $match: { ...match, openedAt: { $ne: null } } }, { $project: { duration: { $subtract: ['$openedAt', '$createdAt'] } } }, { $group: { _id: null, averageMs: { $avg: '$duration' } } }])
  ]);
  const summary = summaryRows[0] || { recipients: 0, delivered: 0, failed: 0, skipped: 0, opened: 0, clicked: 0, pushDelivered: 0, inAppDelivered: 0 };
  const normalizedAccountTypes = Object.values(accountTypes.reduce((acc, row) => {
    const key = row._id === 'creator' ? 'player' : (row._id || 'unknown');
    if (!acc[key]) acc[key] = { _id: key, recipients: 0, delivered: 0, failed: 0, opened: 0, clicked: 0 };
    for (const metric of ['recipients', 'delivered', 'failed', 'opened', 'clicked']) {
      acc[key][metric] += Number(row[metric] || 0);
    }
    return acc;
  }, {}));
  const platformMap = new Map();
  for (const row of platformReceipts) {
    platformMap.set(String(row._id || 'unknown'), {
      recipients: Number(row.recipients || 0),
      delivered: Number(row.delivered || 0),
      failed: Number(row.failed || 0),
      opened: 0,
      clicked: 0
    });
  }
  for (const row of platformEvents) {
    const key = String(row._id || 'unknown');
    const current = platformMap.get(key) || { recipients: 0, delivered: 0, failed: 0, opened: 0, clicked: 0 };
    current.recipients = Math.max(current.recipients, Number(row.recipients || 0));
    current.delivered = Math.max(current.delivered, Number(row.delivered || 0));
    current.opened = Number(row.opened || 0);
    current.clicked = Number(row.clicked || 0);
    platformMap.set(key, current);
  }
  const platforms = Array.from(platformMap.entries())
    .map(([platform, metrics]) => ({ _id: platform, ...metrics }))
    .sort((left, right) => right.recipients - left.recipients);
  res.json({
    success: true,
    data: {
      ...summary,
      ...deliveryRates(summary),
      averageOpenTime: Number(((averageOpen[0]?.averageMs || 0) / 1000).toFixed(1)),
      averageOpenTimeMs: Math.round(averageOpen[0]?.averageMs || 0),
      broadcast: serializeBroadcast(broadcast),
      platformBreakdownBasis: 'provider_device_receipts_and_client_events',
      platformBreakdown: platforms.map((row) => ({ ...row, key: String(row._id || 'unknown'), platform: String(row._id || 'unknown') })),
      inAppBreakdown: {
        basis: 'account_level_not_device_attributed',
        delivered: Number(summary.inAppDelivered || 0)
      },
      accountTypeBreakdown: normalizedAccountTypes.map((row) => ({ ...row, key: String(row._id || 'unknown'), accountType: String(row._id || 'unknown') })),
      premiumBreakdown: premium.map((row) => ({ ...row, key: row._id ? 'premium' : 'non_premium', premium: row._id ? 'premium' : 'non_premium' })),
      countryBreakdown: locations.map((row) => ({ ...row, key: String(row._id || 'Unknown'), country: String(row._id || 'Unknown') }))
    }
  });
});

const normalizeTemplate = (body, { partial = false } = {}) => {
  const contentInput = body.payload && typeof body.payload === 'object'
    ? body.payload
    : (body.content && typeof body.content === 'object' ? body.content : body);
  const normalized = normalizeBroadcastPayload({
    ...contentInput,
    ...(contentInput.category === 'custom' && !contentInput.customCategory
      ? { customCategory: String(body.name || 'Custom').trim().slice(0, 60) || 'Custom' }
      : {}),
    audience: { allUsers: true },
    schedule: { mode: 'draft', timezone: 'UTC', recurrence: 'once' }
  }, { partial: false });
  const result = {
    content: {
      title: normalized.title,
      message: normalized.message,
      subtitle: normalized.subtitle,
      bannerImage: normalized.bannerImage,
      thumbnail: normalized.thumbnail,
      cta: normalized.cta,
      priority: normalized.priority,
      category: normalized.category,
      customCategory: normalized.customCategory,
      deliveryType: normalized.deliveryType,
      push: normalized.push
    }
  };
  if (!partial || body.name !== undefined) {
    result.name = String(body.name || '').trim().slice(0, 100);
    if (!result.name) throw fail('Template name is required');
  }
  if (!partial || body.description !== undefined) result.description = String(body.description || '').trim().slice(0, 300);
  if (result.content.category === 'custom' && !result.content.customCategory) {
    result.content.customCategory = result.name || String(body.name || 'Custom').trim().slice(0, 60) || 'Custom';
  }
  return result;
};

const serializeTemplate = (template) => {
  const value = template?.toObject ? template.toObject() : template;
  return { ...value, id: String(value._id), ...(value.content || {}) };
};

const listTemplates = asyncRoute(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query, 50, 100);
  const sort = parseSort(req.query, {
    updatedAt: 'updatedAt', createdAt: 'createdAt', name: 'name', category: 'content.category'
  }, 'updatedAt');
  const filter = req.query.includeInactive === 'true' ? {} : { isActive: true };
  const category = assertQueryEnum(req.query.category, CATEGORIES, 'category');
  if (category) filter['content.category'] = category;
  if (req.query.search) {
    const search = normalizeSearchTerm(req.query.search);
    filter.$or = [{ name: { $regex: search, $options: 'i' } }, { description: { $regex: search, $options: 'i' } }];
  }
  const [templates, total] = await Promise.all([
    BroadcastTemplate.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    BroadcastTemplate.countDocuments(filter)
  ]);
  res.json({ success: true, data: { templates: templates.map(serializeTemplate), pagination: { page, limit, total, pages: Math.ceil(total / limit) } } });
});

const createTemplate = asyncRoute(async (req, res) => {
  const payload = normalizeTemplate(req.body);
  const actor = getActor(req.user);
  // Names remain globally unique so duplicate active templates fail closed.
  // Reusing an archived name restores that durable template instead of
  // colliding with its soft-delete tombstone.
  let template = await BroadcastTemplate.findOne({ name: payload.name, isActive: false });
  const restored = Boolean(template);
  if (template) {
    Object.assign(template, payload, { isActive: true, updatedBy: actor });
    await template.save();
  } else {
    template = await BroadcastTemplate.create({ ...payload, createdBy: actor, updatedBy: actor });
  }
  res.locals.auditAfter = { templateId: String(template._id), name: template.name, restored };
  res.status(201).json({ success: true, restored, data: serializeTemplate(template) });
});

const updateTemplate = asyncRoute(async (req, res) => {
  assertObjectId(req.params.id, 'Template ID');
  const template = await BroadcastTemplate.findById(req.params.id);
  if (!template) throw fail('Template not found', 404);
  const contentPatch = req.body.payload && typeof req.body.payload === 'object'
    ? req.body.payload
    : (req.body.content && typeof req.body.content === 'object' ? req.body.content : {});
  const payload = normalizeTemplate({
    name: req.body.name ?? template.name,
    description: req.body.description ?? template.description,
    content: {
      ...(template.content?.toObject ? template.content.toObject() : template.content || {}),
      ...contentPatch
    }
  });
  Object.assign(template, payload, {
    ...(typeof req.body.isActive === 'boolean' ? { isActive: req.body.isActive } : {}),
    updatedBy: getActor(req.user)
  });
  await template.save();
  res.locals.auditAfter = { templateId: String(template._id), name: template.name, isActive: template.isActive };
  res.json({ success: true, data: serializeTemplate(template) });
});

const deleteTemplate = asyncRoute(async (req, res) => {
  assertObjectId(req.params.id, 'Template ID');
  const template = await BroadcastTemplate.findByIdAndUpdate(req.params.id, { $set: { isActive: false, updatedBy: getActor(req.user) } }, { new: true });
  if (!template) throw fail('Template not found', 404);
  res.locals.auditAfter = { templateId: String(template._id), name: template.name, isActive: false };
  res.json({ success: true, message: 'Template archived' });
});

module.exports = {
  getDashboard,
  listBroadcasts,
  getBroadcast,
  createBroadcast,
  updateBroadcast,
  deleteBroadcast,
  duplicateBroadcast,
  previewPayload,
  previewBroadcast,
  sendBroadcast,
  retryFailedNotifications,
  cancelBroadcast,
  getRecipients,
  getDeliveryLogs,
  getAnalytics,
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  serializeBroadcast,
  normalizeSearchTerm,
  applyLogFilters,
  createBroadcastPayloadHash,
  assertIdempotentCreateReplay
};
