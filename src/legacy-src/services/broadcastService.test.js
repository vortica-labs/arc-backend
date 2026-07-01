const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const {
  normalizeAudience,
  normalizeSchedule,
  normalizeBroadcastPayload,
  buildAudienceQuery,
  nextRecurrenceDate,
  resolveEffectiveDeliveryType,
  resolveOverallStatus,
  resolvePushDeliveryStatus,
  assertBroadcastPushPayloadSize,
  isBroadcastCategoryAllowed
} = require('./broadcastService');
const { serializeBroadcast } = require('../controllers/broadcastController');
const {
  classifyBroadcastPushRecords,
  filterBroadcastTokens,
  isTransientExpoError,
  buildPushData,
  getExpoMessageByteLength,
  assertExpoMessageSize,
  notificationMatchesClientContext,
  getPushProviderCapabilities
} = require('../utils/pushNotificationService');
const Broadcast = require('../models/Broadcast');
const BroadcastOccurrence = require('../models/BroadcastOccurrence');
const Notification = require('../models/Notification');

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
};

test('audience compiler refuses an implicit all-user broadcast', () => {
  assert.throws(
    () => normalizeAudience({}),
    /explicitly select allUsers/
  );
  assert.throws(
    () => buildAudienceQuery({ allUsers: false, accountTypes: [] }),
    /explicitly select allUsers/
  );
});

test('allUsers is explicit and clears stale disabled filters', () => {
  const audience = normalizeAudience({
    allUsers: true,
    accountTypes: ['team'],
    premium: 'premium',
    platforms: ['ios'],
    userIds: ['stale-invalid-id-that-must-be-ignored']
  });
  assert.strictEqual(audience.allUsers, true);
  assert.deepStrictEqual(audience.userTypes, []);
  assert.strictEqual(audience.premium, 'all');
  assert.deepStrictEqual(audience.platforms, []);
  const query = buildAudienceQuery(audience);
  assert.deepStrictEqual(query.userType, { $ne: 'admin' });
  assert.strictEqual(query.pushTokens, undefined);
});

test('simultaneous filters compile as an intersection', () => {
  const userId = new mongoose.Types.ObjectId().toString();
  const audience = normalizeAudience({
    allUsers: false,
    accountTypes: ['player', 'team'],
    premium: 'premium',
    hostVerification: 'verified',
    creatorMonetization: 'pending',
    countries: ['India'],
    states: ['Punjab'],
    cities: ['Chandigarh'],
    platforms: ['android', 'web'],
    appVersions: ['2.4.0'],
    lastActiveFrom: '2026-01-01T00:00:00.000Z',
    joinedTo: '2026-06-30',
    followersMin: 10,
    followersMax: 5000,
    premiumPlans: ['player_pro'],
    userIds: [userId],
    usernames: ['Example_User'],
    emails: ['USER@Example.com']
  });
  const query = buildAudienceQuery(audience);
  assert.deepStrictEqual(query.userType, { $in: ['player', 'team', 'creator'] });
  assert.strictEqual(query.isPremium, true);
  assert.strictEqual(query.isVerifiedHost, true);
  assert.deepStrictEqual(query.creatorMonetizationStatus, { $in: ['pending'] });
  assert.deepStrictEqual(query['membership.tier'], { $in: ['player_pro'] });
  assert(query.lastSeen.$gte instanceof Date);
  assert(query.createdAt.$lte instanceof Date);
  assert.strictEqual(query.createdAt.$lte.toISOString(), '2026-06-30T23:59:59.999Z');
  assert(Array.isArray(query.$and));
  assert(query.$and.length >= 6);
  const platformClause = query.$and.find((clause) => clause.$or?.some((entry) => entry.notificationClients));
  assert(platformClause, 'platform/app version must match durable clients or push tokens');
  const customClause = query.$and.find((clause) => clause.$or?.some((entry) => entry.username));
  const usernameRegex = customClause.$or.find((entry) => entry.username).username.$in[0];
  assert(usernameRegex.test('EXAMPLE_USER'));
  const emailSelector = customClause.$or.find((entry) => entry.email).email.$in;
  assert.deepStrictEqual(emailSelector, ['user@example.com']);
  const geoClause = query.$and.find((clause) => clause.$or?.some((entry) => entry['profile.location']));
  const geoMatch = geoClause.$or.find((entry) => entry['profile.location'])['profile.location'];
  const geoRegex = new RegExp(geoMatch.$regex, geoMatch.$options);
  assert(geoRegex.test('Chandigarh, Punjab, India'));
  assert(!geoRegex.test('Indiana, USA'));
});

test('invalid custom IDs and inverted ranges fail before MongoDB', () => {
  assert.throws(
    () => normalizeAudience({ userIds: ['not-an-object-id'] }),
    /Invalid custom user ID/
  );
  assert.throws(
    () => normalizeAudience({ followersMin: 20, followersMax: 10 }),
    /cannot be greater/
  );
  assert.throws(
    () => normalizeAudience({ lastActiveFrom: '2026-02-01', lastActiveTo: '2026-01-01' }),
    /cannot be after/
  );
  assert.throws(
    () => normalizeAudience({ emails: ['not-an-email'] }),
    /Invalid audience email/
  );
});

test('email targeting and category preferences are normalized consistently', () => {
  const audience = normalizeAudience({ customEmails: ['USER@Example.com', 'user@example.com'] });
  assert.deepStrictEqual(audience.emails, ['user@example.com']);
  assert.deepStrictEqual(buildAudienceQuery(audience).$and[0].email, { $in: ['user@example.com'] });
  assert.strictEqual(isBroadcastCategoryAllowed({ systemAlerts: false }, 'announcement'), true);
  assert.strictEqual(isBroadcastCategoryAllowed({ systemAlerts: false }, 'system'), false);
  assert.strictEqual(isBroadcastCategoryAllowed({ announcementsEnabled: false }, 'feature_release'), false);
  assert.strictEqual(isBroadcastCategoryAllowed({ marketingEnabled: false }, 'premium'), false);
  assert.strictEqual(isBroadcastCategoryAllowed({ mutedBroadcastCategories: ['tournament'] }, 'tournament'), false);
});

test('nested recurrence contract preserves interval, end date, and timezone', () => {
  const schedule = normalizeSchedule({
    mode: 'scheduled',
    scheduledAt: '2026-07-10T03:30:00.000Z',
    timezone: 'Asia/Kolkata',
    recurrence: { frequency: 'weekly', interval: 2, endAt: '2027-01-01T00:00:00.000Z' }
  });
  assert.strictEqual(schedule.recurrence, 'weekly');
  assert.strictEqual(schedule.recurrenceInterval, 2);
  assert.strictEqual(schedule.timezone, 'Asia/Kolkata');
  assert(schedule.recurrenceEndAt instanceof Date);
  assert.throws(() => normalizeSchedule({ mode: 'scheduled', timezone: 'Not/A_Zone' }), /scheduledAt is required|IANA/);
});

test('recurrence preserves local wall-clock time across DST', () => {
  // 9am New York: EST on March 7, EDT on March 8.
  const next = nextRecurrenceDate('2026-03-07T14:00:00.000Z', 'daily', 1, 'America/New_York');
  assert.strictEqual(next.toISOString(), '2026-03-08T13:00:00.000Z');
});

const validPayload = {
  title: 'Feature update',
  message: 'A useful announcement',
  cta: { text: 'Open', type: 'home' },
  priority: 'normal',
  category: 'update',
  deliveryType: 'both',
  audience: { allUsers: true },
  schedule: { mode: 'immediate', timezone: 'UTC', recurrence: { frequency: 'once', interval: 1 } },
  push: { badge: 1, sound: 'default', ttl: 3600, collapseKey: 'feature-update' }
};

test('CTA and media validators allow production schemes only', () => {
  for (const url of ['/premium', 'https://squadhunt.in/premium', 'arcmobile://premium', 'com.arcsquadhunt://premium']) {
    assert.strictEqual(normalizeBroadcastPayload({ ...validPayload, cta: { type: 'custom', url } }).cta.url, url);
  }
  assert.throws(
    () => normalizeBroadcastPayload({ ...validPayload, cta: { type: 'custom', url: 'javascript:alert(1)' } }),
    /invalid/
  );
  assert.throws(
    () => normalizeBroadcastPayload({ ...validPayload, cta: { type: 'custom', url: '/%2f%2fevil.example' } }),
    /invalid/
  );
  assert.throws(
    () => normalizeBroadcastPayload({ ...validPayload, bannerImage: 'http://example.com/image.png' }),
    /HTTPS/
  );
});

test('database validators preserve the broadcast content contract', () => {
  assert.throws(
    () => normalizeBroadcastPayload({ ...validPayload, message: 'x'.repeat(1001) }),
    /cannot exceed 1000/
  );
  const customCategoryError = new Broadcast({
    title: 'Custom',
    message: 'Custom broadcast',
    category: 'custom',
    customCategory: '',
    audience: { allUsers: true }
  }).validateSync();
  assert(customCategoryError?.errors?.customCategory);
  const longNotification = new Notification({
    recipient: new mongoose.Types.ObjectId(),
    type: 'system',
    title: 'Broadcast',
    message: 'x'.repeat(1000)
  });
  assert.strictEqual(longNotification.validateSync(), undefined);
  const lifecycleNotification = new Notification({
    recipient: new mongoose.Types.ObjectId(),
    type: 'system',
    title: 'Lifecycle',
    message: 'Archived safely',
    archivedAt: new Date(),
    deletedAt: null
  });
  assert.strictEqual(lifecycleNotification.validateSync(), undefined);
});

test('push provider abstraction documents Expo downstream transports', () => {
  const capabilities = getPushProviderCapabilities();
  assert.strictEqual(capabilities.name, 'expo');
  assert.deepStrictEqual(capabilities.downstreamTransports, ['fcm', 'apns']);
  assert.strictEqual(capabilities.maxPayloadBytes, 4096);
});

test('admin serializer matches the Web contract', () => {
  const id = new mongoose.Types.ObjectId();
  const serialized = serializeBroadcast({
    _id: id,
    title: 'Test',
    message: 'Test body',
    status: 'processing',
    audience: { allUsers: false, userTypes: ['player'], creatorMonetizationStatuses: ['approved'] },
    schedule: {
      mode: 'scheduled',
      scheduledAt: new Date('2026-08-01T00:00:00.000Z'),
      timezone: 'UTC',
      recurrence: 'monthly',
      recurrenceInterval: 2,
      recurrenceEndAt: new Date('2027-01-01T00:00:00.000Z')
    },
    metrics: { recipients: 10, delivered: 8, failed: 1, skipped: 1, opened: 4, clicked: 2 }
  });
  assert.strictEqual(serialized.id, id.toString());
  assert.strictEqual(serialized.status, 'sending');
  assert.deepStrictEqual(serialized.audience.accountTypes, ['player']);
  assert.strictEqual(serialized.audience.creatorMonetization, 'enabled');
  assert.strictEqual(serialized.schedule.recurrence.frequency, 'monthly');
  assert.strictEqual(serialized.schedule.recurrence.interval, 2);
  assert.strictEqual(serialized.recipientCount, 10);
  assert.strictEqual(serialized.analytics.recipients, 10);
});

test('preference fallback and provider receipts resolve delivery status safely', () => {
  assert.strictEqual(resolveEffectiveDeliveryType({ push: false, inApp: true }), 'in_app');
  assert.strictEqual(resolveEffectiveDeliveryType({ push: true, inApp: true }), 'both');
  assert.strictEqual(resolvePushDeliveryStatus({ sent: 1, accepted: 1, receiptOk: 0, receiptFailed: 1 }), 'failed');
  assert.strictEqual(resolvePushDeliveryStatus({ sent: 1, accepted: 1, receiptOk: 0, receiptFailed: 0, receiptUnavailable: 1 }), 'delivered');
  assert.strictEqual(resolvePushDeliveryStatus({ sent: 0 }), 'skipped');
  assert.strictEqual(resolveOverallStatus('processing', 'skipped'), 'processing');
  assert.strictEqual(resolveOverallStatus('processing', 'delivered'), 'partial');
});

test('broadcast push targeting filters platform and app version on the same device token', () => {
  const user = {
    pushTokens: [
      { token: 'ExponentPushToken[ios-current]', platform: 'ios', appVersion: '3.2.0', deviceName: 'iPhone', lastUsedAt: new Date() },
      { token: 'ExponentPushToken[ios-stale]', platform: 'ios', appVersion: '3.2.0', deviceName: 'Old iPhone', lastUsedAt: new Date('2020-01-01') },
      { token: 'ExponentPushToken[ios-old-version]', platform: 'ios', appVersion: '3.1.0', deviceName: 'Old version', lastUsedAt: new Date() },
      { token: 'ExponentPushToken[android-current]', platform: 'android', appVersion: '3.2.0', deviceName: 'Pixel', lastUsedAt: new Date() }
    ]
  };
  const matched = filterBroadcastTokens(user, { platforms: ['ios'], appVersions: ['3.2.0'] });
  assert.deepStrictEqual(matched.map((entry) => entry.token), ['ExponentPushToken[ios-current]']);
});

test('durable provider states distinguish tickets, receipts, and transient retries', () => {
  assert.strictEqual(classifyBroadcastPushRecords([]).status, 'skipped');
  assert.strictEqual(classifyBroadcastPushRecords([{ ticketStatus: 'accepted', receiptStatus: 'pending' }]).status, 'processing');
  assert.strictEqual(classifyBroadcastPushRecords([{ ticketStatus: 'accepted', receiptStatus: 'delivered', providerTicketId: 'ticket-1' }]).status, 'delivered');
  assert.strictEqual(classifyBroadcastPushRecords([{ ticketStatus: 'failed', receiptStatus: 'failed', providerErrorCode: 'DeviceNotRegistered' }]).status, 'failed');
  assert.strictEqual(classifyBroadcastPushRecords([{ ticketStatus: 'skipped', receiptStatus: 'skipped' }]).status, 'skipped');
  assert.strictEqual(classifyBroadcastPushRecords([{ ticketStatus: 'cancelled', receiptStatus: 'cancelled' }]).status, 'skipped');
  assert.strictEqual(isTransientExpoError('MessageRateExceeded'), true);
  assert.strictEqual(isTransientExpoError('DeviceNotRegistered'), false);
});

test('device-scoped inbox visibility requires both platform and app version', () => {
  const targeted = { data: { targetPlatforms: ['ios'], targetAppVersions: ['3.2.0'] } };
  assert.strictEqual(notificationMatchesClientContext(targeted, 'ios', '3.2.0'), true);
  assert.strictEqual(notificationMatchesClientContext(targeted, 'ios', '3.1.0'), false);
  assert.strictEqual(notificationMatchesClientContext(targeted, 'web', '3.2.0'), false);
  assert.strictEqual(notificationMatchesClientContext({ data: {} }, 'web', '1.0.0'), true);
});

test('broadcast push data stays compact and enforces the provider byte ceiling', () => {
  const notification = {
    _id: new mongoose.Types.ObjectId(),
    type: 'system',
    title: 'Compact',
    message: 'Payload',
    data: {
      broadcastId: new mongoose.Types.ObjectId(),
      deliveryLogId: new mongoose.Types.ObjectId(),
      deepLink: '/premium',
      bannerImage: `https://cdn.example/${'x'.repeat(500)}`,
      cta: { text: 'Upgrade', url: '/premium', type: 'premium' },
      customData: {
        category: 'premium',
        priority: 'high',
        targetPlatforms: ['ios'],
        targetAppVersions: ['3.2.0']
      }
    }
  };
  const compact = buildPushData(notification);
  assert.strictEqual(compact.deepLink, '/premium');
  assert.strictEqual(compact.hasCta, true);
  assert.strictEqual(compact.bannerImage, undefined);
  assert.strictEqual(compact.cta, undefined);
  assert(getExpoMessageByteLength({ data: 'x'.repeat(4000) }) < 4096);
  assert.throws(() => assertExpoMessageSize({ data: 'x'.repeat(4096) }), /maximum is/);
  assert(assertBroadcastPushPayloadSize(validPayload) < 4096);
  const longUrl = `https://example.com/${'x'.repeat(2028)}`;
  assert.throws(
    () => assertBroadcastPushPayloadSize({ ...validPayload, bannerImage: longUrl, cta: { text: 'Open', type: 'custom', url: longUrl } }),
    /maximum is/
  );
});

test('route ordering and tracking endpoints are unambiguous', () => {
  const backendRoot = path.resolve(__dirname, '..', '..');
  const adminRoutes = fs.readFileSync(path.join(backendRoot, 'modules', 'admin', 'broadcast.routes.ts'), 'utf8');
  const controllerSource = fs.readFileSync(path.join(backendRoot, 'legacy-src', 'controllers', 'broadcastController.js'), 'utf8');
  const notificationRoutes = fs.readFileSync(path.join(backendRoot, 'modules', 'notifications', 'notifications.routes.ts'), 'utf8');
  const storyRoutes = fs.readFileSync(path.join(backendRoot, 'modules', 'stories', 'stories.routes.ts'), 'utf8');
  assert(adminRoutes.indexOf('/delivery-logs') < adminRoutes.indexOf('/:id'));
  assert(adminRoutes.indexOf('/preview') < adminRoutes.indexOf('/:id'));
  assert(notificationRoutes.includes('router.post("/:id/open"'));
  assert(notificationRoutes.includes('router.post("/:id/click"'));
  assert(notificationRoutes.includes('router.post("/:id/delivered"'));
  assert(notificationRoutes.includes('router.put("/:id/archive"'));
  assert(notificationRoutes.includes('router.put("/:id/unarchive"'));
  assert(notificationRoutes.includes('notification.deletedAt = new Date()'));
  assert(storyRoutes.indexOf('router.get("/:storyId"') < storyRoutes.indexOf('router.get("/:storyId/views"'));
  assert(controllerSource.includes("!['draft', 'scheduled'].includes(existing.status)"));
  assert(controllerSource.includes("status: 'draft'"), 'create must be side-effect-free and require the send endpoint');
  assert(controllerSource.includes("{ status: { $in: ['queued', 'processing', 'sent', 'failed'] } }"));
  assert(controllerSource.includes("existing.status = 'draft'"), 'scheduled-to-immediate edits must demote before send');
  assert(controllerSource.includes('retryOccurrenceKey'), 'failed sends must resume their immutable occurrence');
  assert(adminRoutes.includes('requireAdminPermission("broadcasts:send")'));
  assert(adminRoutes.includes('router.post("/:id/retry-failed"'));
  assert(notificationRoutes.includes('isRead: false'));
  assert(notificationRoutes.includes('A click implies an open'));
  assert(!notificationRoutes.includes('source: "mark_read"'), 'mark-read must not steal explicit open platform attribution');
  assert(notificationRoutes.includes('buildClientVisibilityFilter'));
  assert(notificationRoutes.includes('notificationClients.clientId": clientId'));
  assert(controllerSource.includes("creationIdempotencyKeyHash"));
  assert(controllerSource.includes("Idempotency-Key"));
  assert(controllerSource.includes("status: 'scheduled', sentAt: { $ne: null }"));
});

test('queue and recipient source contracts include durable idempotency and preference fallback', () => {
  const backendRoot = path.resolve(__dirname, '..', '..');
  const queueSource = fs.readFileSync(path.join(backendRoot, 'infrastructure', 'jobs', 'queue.ts'), 'utf8');
  const serviceSource = fs.readFileSync(path.join(__dirname, 'broadcastService.js'), 'utf8');
  const notificationModel = fs.readFileSync(path.resolve(__dirname, '..', 'models', 'Notification.js'), 'utf8');
  const auditModel = fs.readFileSync(path.resolve(__dirname, '..', 'models', 'AdminAuditLog.js'), 'utf8');
  const pushSource = fs.readFileSync(path.resolve(__dirname, '..', 'utils', 'pushNotificationService.js'), 'utf8');
  const receiptModel = fs.readFileSync(path.resolve(__dirname, '..', 'models', 'BroadcastPushReceipt.js'), 'utf8');
  const failureModel = fs.readFileSync(path.resolve(__dirname, '..', 'models', 'NotificationFailure.js'), 'utf8');
  assert(queueSource.includes('broadcastJobId("broadcast-chunk"'));
  assert(queueSource.includes('status: "processing"'));
  assert(queueSource.includes('recovery-${Math.floor(Date.now() / 60000)}'));
  assert(serviceSource.includes("BroadcastChunk.findOneAndUpdate"));
  assert(serviceSource.includes("status: 'completed'"));
  assert(serviceSource.includes('if (pushRequested && !pushAllowed && inAppAllowed)'));
  assert(serviceSource.includes("inAppStatus === 'delivered'"));
  assert(notificationModel.includes('broadcastRecipient'));
  assert(auditModel.includes('Admin audit logs are immutable'));
  assert(queueSource.includes('"reconcile-receipts"'));
  assert(queueSource.includes('queuedPushRetries'), 'scheduler must recover transient queued sends');
  assert(pushSource.includes('chunk(claimedRecords, EXPO_MAX_BATCH_SIZE)'));
  assert(pushSource.includes('currentKeys.has(`${record.broadcastRecipient}:${record.tokenHash}`)'));
  assert(pushSource.includes('retryRecipientLogIds'));
  assert(receiptModel.includes('{ broadcastRecipient: 1, tokenHash: 1 }'));
  assert(receiptModel.includes('sendAttempts'));
  assert(queueSource.includes('EXPO_BROADCAST_SEND_MAX_ATTEMPTS'));
  assert(queueSource.includes('SendRetryExhausted'));
  assert(queueSource.includes('reconcileTerminalPushReceipts'));
  assert(queueSource.includes('BROADCAST_SEND_MAX_ATTEMPTS'));
  assert(queueSource.includes('broadcastIds'), 'receipt jobs must identify broadcasts for cancellation');
  assert(serviceSource.includes('chunkRecord.recipientIds.map(String)'), 'recovery must enqueue the persisted audience snapshot');
  assert(serviceSource.includes("_id: { $in: chunk.recipientIds }"), 'workers must ignore stale job recipient arrays');
  assert(serviceSource.includes("status: { $ne: 'cancelled' }"), 'provider retries must reject cancelled broadcasts');
  assert(serviceSource.includes("ticketStatus: 'cancelled'"));
  assert(serviceSource.includes("ticketStatus: 'skipped'"), 'preference opt-outs must not become provider failures');
  assert(serviceSource.includes("data: buildNotificationData(broadcast, recipientLog, 'in_app')"), 'retry-time push opt-out needs in-app fallback');
  assert(serviceSource.includes('emitBroadcastPushNotification'));
  assert(serviceSource.includes('expireUnacknowledgedWebPushes'));
  assert(serviceSource.includes("status: 'resolved'"), 'DLQ entries must resolve after a successful retry');
  assert(failureModel.includes("enum: ['open', 'retrying', 'resolved']"));
  assert(pushSource.includes('tokenPreview: previewPushToken'));
  assert(!pushSource.includes('token: receiptRequest.token'), 'provider logs must not expose raw tokens');
  assert(!receiptModel.includes('token: { type: String'), 'provider logs must not persist raw device tokens');
});

test('multi-instance socket delivery uses dedicated Redis adapter clients', () => {
  const backendRoot = path.resolve(__dirname, '..', '..');
  const socketSource = fs.readFileSync(path.join(backendRoot, 'infrastructure', 'websocket', 'socket.ts'), 'utf8');
  const redisSource = fs.readFileSync(path.join(backendRoot, 'infrastructure', 'cache', 'redis.ts'), 'utf8');
  const serverSource = fs.readFileSync(path.join(backendRoot, 'server.ts'), 'utf8');
  assert(socketSource.includes('createAdapter(socketRedisPubClient, socketRedisSubClient)'));
  assert(redisSource.includes('socketRedisPubClient'));
  assert(redisSource.includes('socketRedisSubClient'));
  assert(redisSource.includes('disconnectRedis'));
  assert(serverSource.includes('attachSocketRedisAdapter(io)'));
  assert(serverSource.includes('await disconnectRedis()'));
});

test('production hardening contracts cover retries, audit, indexes, and provider bounds', () => {
  const backendRoot = path.resolve(__dirname, '..', '..');
  const queueSource = fs.readFileSync(path.join(backendRoot, 'infrastructure', 'jobs', 'queue.ts'), 'utf8');
  const serviceSource = fs.readFileSync(path.join(backendRoot, 'legacy-src', 'services', 'broadcastService.js'), 'utf8');
  const pushSource = fs.readFileSync(path.join(backendRoot, 'legacy-src', 'utils', 'pushNotificationService.js'), 'utf8');
  const controllerSource = fs.readFileSync(path.join(backendRoot, 'legacy-src', 'controllers', 'broadcastController.js'), 'utf8');
  const adminAuthSource = fs.readFileSync(path.join(backendRoot, 'legacy-src', 'middleware', 'adminAuth.js'), 'utf8');
  const adminRoutes = fs.readFileSync(path.join(backendRoot, 'modules', 'admin', 'broadcast.routes.ts'), 'utf8');
  const migrationSource = fs.readFileSync(path.join(backendRoot, '..', 'scripts', 'migrate-broadcast-indexes.js'), 'utf8');

  assert.strictEqual(isTransientExpoError('ExpoRequestTimeout'), true);
  assert(pushSource.includes('AbortController'));
  assert(pushSource.includes('req.setTimeout(EXPO_PUSH_REQUEST_TIMEOUT_MS'));
  assert(pushSource.includes('Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}`'));
  assert(pushSource.includes('EXPO_PUSH_TOKEN_MAX_LENGTH'));
  assert(pushSource.includes('messageBuildFailures'), 'one malformed device payload must not fail sibling tokens');
  assert(pushSource.includes("providerErrorCode: 'RetryTokenUnavailable'"));
  assert(pushSource.includes('activeBatchBroadcastIds'), 'every provider batch must re-check cancellation');
  assert(serviceSource.includes("'x'.repeat(512 - tokenPrefix.length - 1)"), 'preflight must use the maximum accepted token size');

  assert(queueSource.includes('(isProcessing || isQueued) && broadcast.execution?.occurrenceKey'));
  assert(queueSource.includes('], 0, 4999, true)'), 'queue cleanup must remain bounded');
  assert(serviceSource.includes('BroadcastOccurrence.findOneAndUpdate'));
  assert(serviceSource.includes('occurrenceByKey'));
  assert.strictEqual(BroadcastOccurrence.schema.options.timestamps.updatedAt, false);
  assert(controllerSource.includes('await removeBroadcastJobs(String(broadcast._id))'));
  assert(controllerSource.includes('`manual-${Date.now()}`'), 'manual retries need a fresh deterministic queue suffix');
  assert(controllerSource.includes('(existing.schedule?.nextRunAt || existing.schedule?.scheduledAt)'));
  assert(serviceSource.includes("'schedule.scheduledAt': nextRunAt"));

  assert(adminAuthSource.includes('durableMutationAudit'));
  assert(adminAuthSource.includes("`${action}_INTENT`"));
  assert(adminAuthSource.includes("`${action}_OUTCOME`"));
  assert(adminRoutes.includes('durableMutationAudit("VIEW_BROADCAST_ANALYTICS")'));
  assert(adminRoutes.includes('durableMutationAudit("SEND_BROADCAST")'));
  assert(migrationSource.includes("'BroadcastOccurrence'"));
  assert(migrationSource.includes("'AdminAuditLog'"));
  assert(migrationSource.includes('Model.createIndexes()'));

  assert(serviceSource.includes('webPushAcknowledgedAt: null'));
  assert(serviceSource.includes("? { ...providerResult, status: 'delivered'"));
  assert(serviceSource.includes('metricsSourceUpdatedAt: { $lte: sourceUpdatedAt }'));
  assert(!serviceSource.includes('return Broadcast.updateOne({ _id: broadcastId }, { $inc: increments })'));
  const trackDeliverySource = serviceSource.slice(
    serviceSource.indexOf('const trackDelivery ='),
    serviceSource.indexOf('const trackEvent =')
  );
  assert(!trackDeliverySource.includes("'push.status': { $in:"), 'first valid Web ACK must override a prior native failure');
  const trackEventSource = serviceSource.slice(serviceSource.indexOf('const trackEvent ='));
  assert(!trackEventSource.includes("update.$set['push.status']"), 'Web open must use the atomic delivery ACK path');
  assert(!trackEventSource.includes('{ $inc: { [`metrics.'), 'engagement metrics must use authoritative refresh');
  assert(controllerSource.includes('BroadcastPushReceipt.aggregate'));
  assert(controllerSource.includes('BroadcastEvent.aggregate'));
  assert(controllerSource.includes("platformBreakdownBasis: 'provider_device_receipts_and_client_events'"));
});

console.log(`Broadcast backend contracts passed (${passed}/20)`);
