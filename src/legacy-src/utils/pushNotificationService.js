const https = require('https');
const { createHash, randomUUID } = require('crypto');
const log = require('./logger');

const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_PUSH_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const EXPO_PUSH_TOKEN_PATTERN = /^ExponentPushToken\[[\w-]+\]$|^ExpoPushToken\[[\w-]+\]$/;
const EXPO_PUSH_TOKEN_MAX_LENGTH = Math.max(64, Number(process.env.EXPO_PUSH_TOKEN_MAX_LENGTH || 512));
const EXPO_PUSH_REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.EXPO_PUSH_REQUEST_TIMEOUT_MS || 15000));
const EXPO_MAX_BATCH_SIZE = 100;
const EXPO_MAX_RECEIPT_BATCH_SIZE = 300;
const EXPO_MAX_PAYLOAD_BYTES = Math.max(1024, Number(process.env.EXPO_MAX_PAYLOAD_BYTES || 4096));
const BROADCAST_CLIENT_CONTEXT_MAX_AGE_DAYS = Math.max(
  1,
  Math.min(3650, Number(process.env.BROADCAST_CLIENT_CONTEXT_MAX_AGE_DAYS || 90))
);
const EXPO_RECEIPT_DELAY_MS = Number(process.env.EXPO_PUSH_RECEIPT_DELAY_MS || 2000);
const EXPO_BROADCAST_RECEIPT_DELAY_MS = Math.max(
  15000,
  Number(process.env.EXPO_BROADCAST_RECEIPT_DELAY_MS || 15 * 60 * 1000)
);
const EXPO_BROADCAST_RECEIPT_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.EXPO_BROADCAST_RECEIPT_MAX_ATTEMPTS || 8)
);
const EXPO_BROADCAST_SEND_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.EXPO_BROADCAST_SEND_MAX_ATTEMPTS || 12)
);
const PROVIDER_LEASE_MS = 5 * 60 * 1000;
const PUSH_PROVIDER_NAME = String(process.env.PUSH_NOTIFICATION_PROVIDER || 'expo').toLowerCase();

const NOTIFICATION_SETTING_DEFAULTS = {
  pushEnabled: true,
  inAppEnabled: true,
  likes: true,
  comments: true,
  follows: true,
  messages: true,
  tournamentUpdates: true,
  scrimUpdates: true,
  recruitmentApps: true,
  systemAlerts: true,
  marketingEnabled: true,
  announcementsEnabled: true,
  promotionsEnabled: true,
  mutedBroadcastCategories: []
};

const getChannelIdForNotification = (notification) => {
  const data = notification?.data || {};
  const customData = data.customData || {};
  const broadcastId = toId(data.broadcastId || customData.broadcastId);
  if (broadcastId) {
    const broadcastPriority = typeof customData.priority === 'string'
      ? customData.priority.trim().toLowerCase()
      : '';
    if (broadcastPriority === 'critical') return 'broadcasts-critical';
    if (broadcastPriority === 'high') return 'broadcasts-high';
    return 'broadcasts';
  }

  switch (notification?.type) {
    case 'message':
      return 'messages';
    case 'like':
    case 'comment':
    case 'mention':
    case 'follow':
    case 'achievement':
      return 'social';
    case 'tournament':
      return 'tournaments';
    case 'call':
      return 'calls';
    default:
      return 'default';
  }
};

const toId = (value) => {
  if (!value) return '';
  return String(value._id || value.id || value);
};

const toUsername = (value) => {
  if (!value || typeof value !== 'object') return '';
  return sanitizeString(value.username || value.profile?.username);
};

const chunk = (items, size) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

const getValidPushTokens = (user) => Array.from(new Map(
  (user?.pushTokens || [])
    .filter((entry) => typeof entry?.token === 'string' &&
      entry.token.length <= EXPO_PUSH_TOKEN_MAX_LENGTH &&
      EXPO_PUSH_TOKEN_PATTERN.test(entry.token))
    .map((entry) => [entry.token, {
      token: entry.token,
      platform: ['ios', 'android', 'web'].includes(entry.platform) ? entry.platform : 'unknown',
      appVersion: sanitizeString(entry.appVersion).slice(0, 40),
      deviceName: sanitizeString(entry.deviceName).slice(0, 200),
      lastUsedAt: entry.lastUsedAt || entry.createdAt || null
    }])
).values());

const hashPushToken = (token) => createHash('sha256').update(String(token)).digest('hex');
const previewPushToken = (token) => {
  const value = String(token || '');
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
};

const isTransientExpoError = (errorCode) => new Set([
  'MessageRateExceeded',
  'ServiceUnavailable',
  'InternalServerError',
  'ExpoServerError',
  'ExpoRequestTimeout'
]).has(sanitizeString(errorCode));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));

const sanitizeString = (value, fallback = '') => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
};

const getPreferenceKeyForNotification = (notification) => {
  switch (notification?.type) {
    case 'like':
      return 'likes';
    case 'comment':
    case 'mention':
      return 'comments';
    case 'follow':
      return 'follows';
    case 'message':
    case 'call':
      return 'messages';
    case 'story':
    case 'clip':
      return 'comments';
    case 'recruitment':
      return 'recruitmentApps';
    case 'tournament':
      return notification?.data?.customData?.scrimId || notification?.data?.customData?.scrimCode
        ? 'scrimUpdates'
        : 'tournamentUpdates';
    case 'system':
    case 'achievement':
      return 'systemAlerts';
    default:
      return null;
  }
};

const shouldSendPushNotification = async (recipientId, notification) => {
  const preferenceKey = getPreferenceKeyForNotification(notification);
  if (!preferenceKey) return true;

  const User = require('../models/User');
  const user = await User.findById(recipientId).select('notificationSettings').lean();
  const settings = { ...NOTIFICATION_SETTING_DEFAULTS, ...(user?.notificationSettings || {}) };
  return settings.pushEnabled !== false && settings[preferenceKey] !== false;
};

const buildRouteFromNotification = (notification) => {
  const data = notification?.data || {};
  const customData = data.customData || {};
  const explicitUrl = sanitizeString(customData.url || customData.deepLink || data.url || data.deepLink);
  if (explicitUrl.startsWith('/') || /^(https:\/\/|squadhunt:\/\/|arc:\/\/|arcmobile:\/\/|com\.arcsquadhunt:\/\/)/i.test(explicitUrl)) {
    return explicitUrl;
  }

  const postId = toId(data.postId || customData.postId);
  if (postId) return `/post/${postId}`;

  const clipId = toId(data.clipId || customData.clipId);
  if (clipId) return `/clip/${clipId}`;

  const tournamentId = toId(data.tournamentId || customData.tournamentId);
  if (tournamentId) return `/tournament/${tournamentId}`;

  const recruitmentId = toId(data.recruitmentId || customData.recruitmentId);
  if (recruitmentId) return `/recruitment/${recruitmentId}`;

  const chatId = toId(data.chatId || data.conversationId || customData.chatId || customData.conversationId);
  if (chatId) return `/conversation/${chatId}`;

  const senderUsername = toUsername(notification?.sender);
  const senderId = toId(notification?.sender);
  if (notification?.type === 'follow' && (senderUsername || senderId)) return `/user/${senderUsername || senderId}`;

  return '/notifications';
};

const buildPushData = (notification) => {
  const data = notification?.data || {};
  const customData = data.customData || {};
  const route = buildRouteFromNotification(notification);
  const broadcastId = toId(data.broadcastId || customData.broadcastId);

  // Provider payloads have a tight size ceiling. Broadcast rich media and CTA
  // already travel as richContent/deepLink, so do not duplicate the same large
  // URLs and nested objects in Expo's data envelope.
  if (broadcastId) {
    const cta = data.cta || customData.cta || {};
    return {
      notificationId: toId(notification?._id),
      broadcastId,
      deliveryLogId: toId(data.deliveryLogId || customData.deliveryLogId) || undefined,
      deepLink: sanitizeString(data.deepLink || customData.deepLink || customData.url) || route,
      hasCta: Boolean(sanitizeString(cta.text) || (sanitizeString(cta.type) && cta.type !== 'none')),
      deliveryType: sanitizeString(customData.deliveryType) || undefined,
      category: sanitizeString(customData.category) || undefined,
      priority: sanitizeString(customData.priority) || undefined,
      targetPlatforms: Array.isArray(data.targetPlatforms)
        ? data.targetPlatforms
        : (Array.isArray(customData.targetPlatforms) ? customData.targetPlatforms : []),
      targetAppVersions: Array.isArray(data.targetAppVersions)
        ? data.targetAppVersions
        : (Array.isArray(customData.targetAppVersions) ? customData.targetAppVersions : []),
      type: notification?.type || 'system'
    };
  }

  return {
    url: route,
    route,
    notificationId: toId(notification?._id),
    broadcastId: toId(data.broadcastId || customData.broadcastId) || undefined,
    broadcastRecipientId: toId(data.deliveryLogId || customData.deliveryLogId) || undefined,
    deliveryLogId: toId(data.deliveryLogId || customData.deliveryLogId) || undefined,
    deliveryType: sanitizeString(customData.deliveryType) || undefined,
    deepLink: sanitizeString(data.deepLink || customData.deepLink || customData.url) || route,
    cta: data.cta || customData.cta || undefined,
    bannerImage: sanitizeString(data.bannerImage || customData.bannerImage) || undefined,
    thumbnail: sanitizeString(data.thumbnail || customData.thumbnail) || undefined,
    category: sanitizeString(customData.category) || undefined,
    priority: sanitizeString(customData.priority) || undefined,
    collapseKey: sanitizeString(customData.pushOptions?.collapseKey) || undefined,
    type: notification?.type || 'system',
    postId: toId(data.postId || customData.postId) || undefined,
    clipId: toId(data.clipId || customData.clipId) || undefined,
    tournamentId: toId(data.tournamentId || customData.tournamentId) || undefined,
    recruitmentId: toId(data.recruitmentId || customData.recruitmentId) || undefined,
    chatId: toId(data.chatId || data.conversationId || customData.chatId || customData.conversationId) || undefined,
    messageId: toId(data.messageId || customData.messageId) || undefined,
    userId: toId(notification?.sender || customData.userId) || undefined
  };
};

const notificationMatchesClientContext = (notification, platform, appVersion) => {
  const data = notification?.data || {};
  const customData = data.customData || {};
  const targetPlatforms = Array.isArray(data.targetPlatforms)
    ? data.targetPlatforms
    : (Array.isArray(customData.targetPlatforms) ? customData.targetPlatforms : []);
  const targetAppVersions = Array.isArray(data.targetAppVersions)
    ? data.targetAppVersions
    : (Array.isArray(customData.targetAppVersions) ? customData.targetAppVersions : []);
  return (targetPlatforms.length === 0 || targetPlatforms.includes(platform)) &&
    (targetAppVersions.length === 0 || targetAppVersions.includes(appVersion));
};

const getExpoMessageByteLength = (message) => Buffer.byteLength(JSON.stringify(message), 'utf8');

const assertExpoMessageSize = (message) => {
  const bytes = getExpoMessageByteLength(message);
  if (bytes > EXPO_MAX_PAYLOAD_BYTES) {
    const error = new Error(`Push notification payload is ${bytes} bytes; maximum is ${EXPO_MAX_PAYLOAD_BYTES} bytes`);
    error.code = 'PushPayloadTooLarge';
    error.statusCode = 400;
    throw error;
  }
  return bytes;
};

const postJson = async (url, body) => {
  const headers = {
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    'Content-Type': 'application/json',
    ...(process.env.EXPO_ACCESS_TOKEN
      ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` }
      : {})
  };
  if (typeof fetch === 'function') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EXPO_PUSH_REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        const timeoutError = new Error(`Expo push request timed out after ${EXPO_PUSH_REQUEST_TIMEOUT_MS}ms`);
        timeoutError.code = 'ExpoRequestTimeout';
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`Expo push request failed with HTTP ${response.status}`);
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const requestBody = JSON.stringify(body);
    const req = https.request({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(requestBody)
      }
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (part) => { responseBody += part; });
      res.on('end', () => {
        let payload = {};
        try {
          payload = responseBody ? JSON.parse(responseBody) : {};
        } catch {}
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`Expo push request failed with HTTP ${res.statusCode}`);
          error.payload = payload;
          reject(error);
          return;
        }
        resolve(payload);
      });
    });
    req.setTimeout(EXPO_PUSH_REQUEST_TIMEOUT_MS, () => {
      const timeoutError = new Error(`Expo push request timed out after ${EXPO_PUSH_REQUEST_TIMEOUT_MS}ms`);
      timeoutError.code = 'ExpoRequestTimeout';
      req.destroy(timeoutError);
    });
    req.on('error', reject);
    req.write(requestBody);
    req.end();
  });
};

// Provider boundary for broadcast and generic push delivery. Expo is the
// configured gateway today; Expo routes each device message to FCM (Android)
// or APNs (iOS) using the project's EAS credentials. A direct provider can be
// added here without changing broadcast queue/delivery state machines.
const PUSH_PROVIDERS = new Map([
  ['expo', {
    name: 'expo',
    downstreamTransports: ['fcm', 'apns'],
    maxBatchSize: EXPO_MAX_BATCH_SIZE,
    maxReceiptBatchSize: EXPO_MAX_RECEIPT_BATCH_SIZE,
    send: (messages) => postJson(EXPO_PUSH_SEND_URL, messages),
    getReceipts: (ids) => postJson(EXPO_PUSH_RECEIPTS_URL, { ids })
  }]
]);

const getPushProvider = (name = PUSH_PROVIDER_NAME) => {
  const provider = PUSH_PROVIDERS.get(String(name).toLowerCase());
  if (!provider) {
    const error = new Error(`Unsupported push notification provider: ${name}`);
    error.code = 'UnsupportedPushProvider';
    throw error;
  }
  return provider;
};

const getPushProviderCapabilities = () => {
  const provider = getPushProvider();
  return {
    name: provider.name,
    downstreamTransports: [...provider.downstreamTransports],
    maxBatchSize: provider.maxBatchSize,
    maxReceiptBatchSize: provider.maxReceiptBatchSize,
    maxPayloadBytes: EXPO_MAX_PAYLOAD_BYTES
  };
};

const removeInvalidToken = async (token) => {
  if (!token) return;
  const User = require('../models/User');
  await User.updateMany(
    { 'pushTokens.token': token },
    { $pull: { pushTokens: { token } } }
  );
};

const processExpoTickets = async (tickets, messages) => {
  const ticketList = Array.isArray(tickets) ? tickets : [tickets].filter(Boolean);
  const invalidTokens = [];
  const receipts = [];
  let accepted = 0;
  let failed = 0;

  for (let index = 0; index < ticketList.length; index += 1) {
    const ticket = ticketList[index];
    const token = messages[index]?.to;
    if (ticket?.status === 'ok') {
      accepted += 1;
      if (ticket.id && token) {
        receipts.push({
          id: ticket.id,
          token,
          notificationId: messages[index]?.data?.notificationId,
          type: messages[index]?.data?.type
        });
      }
      continue;
    }

    failed += 1;
    const errorCode = ticket?.details?.error;
    log.warn('Expo push ticket error', {
      tokenPreview: previewPushToken(token),
      errorCode,
      message: ticket?.message
    });

    if (errorCode === 'DeviceNotRegistered' && token) {
      invalidTokens.push(token);
    }
  }

  await Promise.allSettled(invalidTokens.map(removeInvalidToken));
  return { accepted, failed, invalidTokensRemoved: invalidTokens.length, receipts };
};

const processExpoReceipts = async (receiptRequests) => {
  if (!Array.isArray(receiptRequests) || receiptRequests.length === 0) {
    return { ok: 0, failed: 0, unavailable: 0, invalidTokensRemoved: 0 };
  }

  if (EXPO_RECEIPT_DELAY_MS > 0) {
    await delay(EXPO_RECEIPT_DELAY_MS);
  }

  let ok = 0;
  let failed = 0;
  let unavailable = 0;
  const invalidTokens = [];

  for (const batch of chunk(receiptRequests, EXPO_MAX_RECEIPT_BATCH_SIZE)) {
    const ids = batch.map((receipt) => receipt.id).filter(Boolean);
    if (ids.length === 0) continue;

    let payload = {};
    try {
      payload = await getPushProvider().getReceipts(ids);
    } catch (error) {
      unavailable += ids.length;
      log.error('Expo push receipt request failed', {
        receiptCount: ids.length,
        message: error?.message,
        payload: error?.payload
      });
      continue;
    }

    const receiptMap = payload?.data || {};
    for (const receiptRequest of batch) {
      const receipt = receiptMap[receiptRequest.id];
      if (!receipt) {
        unavailable += 1;
        continue;
      }

      if (receipt.status === 'ok') {
        ok += 1;
        continue;
      }

      failed += 1;
      const errorCode = receipt?.details?.error;
      log.error('Expo push receipt error', {
        receiptId: receiptRequest.id,
        tokenPreview: previewPushToken(receiptRequest.token),
        notificationId: receiptRequest.notificationId,
        type: receiptRequest.type,
        errorCode,
        message: receipt?.message
      });

      if (errorCode === 'DeviceNotRegistered' && receiptRequest.token) {
        invalidTokens.push(receiptRequest.token);
      }
    }
  }

  await Promise.allSettled(invalidTokens.map(removeInvalidToken));
  return { ok, failed, unavailable, invalidTokensRemoved: invalidTokens.length };
};

const getRecipientPushState = async (recipientId, notification) => {
  const User = require('../models/User');
  const Notification = require('../models/Notification');
  const [user, unreadCount] = await Promise.all([
    User.findById(recipientId).select('pushTokens notificationSettings').lean(),
    Notification.countDocuments({
      recipient: recipientId,
      isRead: false,
      deletedAt: null,
      archivedAt: null
    }).catch(() => 0)
  ]);

  const preferenceKey = getPreferenceKeyForNotification(notification);
  const settings = { ...NOTIFICATION_SETTING_DEFAULTS, ...(user?.notificationSettings || {}) };
  // Preserve the legacy generic-notification contract: categories without a
  // preference key are always eligible; keyed categories respect global + key.
  const allowed = !preferenceKey || (settings.pushEnabled !== false && settings[preferenceKey] !== false);
  if (!allowed) return { tokens: [], unreadCount };
  const tokens = getValidPushTokens(user).map((entry) => entry.token);
  return { tokens, unreadCount };
};

const buildExpoMessages = (tokens, notification, unreadCount = 0) => {
  const title = sanitizeString(notification.title, 'SquadHunt');
  const body = sanitizeString(notification.message, 'You have a new notification');
  const data = buildPushData(notification);
  const isBroadcast = Boolean(data.broadcastId);
  const image = sanitizeString(notification?.data?.image || notification?.data?.customData?.image);
  const channelId = getChannelIdForNotification(notification);
  const pushOptions = notification?.data?.customData?.pushOptions || {};
  const ttl = Number.isFinite(Number(pushOptions.ttl))
    ? Math.max(0, Math.min(2419200, Number(pushOptions.ttl)))
    : 2419200;
  const priority = ['default', 'normal', 'high'].includes(pushOptions.priority)
    ? pushOptions.priority
    : (notification?.data?.customData?.priority === 'normal' ? 'normal' : 'high');
  const badge = pushOptions.badge !== null && pushOptions.badge !== undefined && Number.isFinite(Number(pushOptions.badge))
    ? Number(pushOptions.badge)
    : unreadCount;
  const sound = pushOptions.sound === null || pushOptions.sound === 'none'
    ? undefined
    : sanitizeString(pushOptions.sound, 'default');
  const richImage = sanitizeString(pushOptions.image || image);
  const subtitle = sanitizeString(notification?.data?.customData?.subtitle);

  return tokens.map((tokenEntry) => {
    const token = typeof tokenEntry === 'string' ? tokenEntry : tokenEntry.token;
    const message = {
      to: token,
      title,
      body,
      ...(subtitle ? { subtitle } : {}),
      ...(sound ? { sound } : {}),
      priority,
      channelId,
      badge,
      ttl,
      expiration: Math.floor(Date.now() / 1000) + ttl,
      data,
      // Broadcast alerts stay visible while also allowing iOS to wake the app
      // for background delivery tracking. Generic notifications must not all
      // opt into background processing.
      ...(isBroadcast ? { _contentAvailable: true } : {}),
      ...(pushOptions.collapseKey ? { collapseId: sanitizeString(pushOptions.collapseKey) } : {}),
      // Expo/APNs requires mutable-content for the Notification Service
      // Extension to download and attach a remote image on iOS. Android safely
      // ignores this flag while continuing to use richContent.image.
      ...(richImage ? { richContent: { image: richImage }, mutableContent: true } : {})
    };
    assertExpoMessageSize(message);
    return message;
  });
};

const sendPushNotification = async (recipientId, notification) => {
  const resolvedRecipientId = toId(recipientId || notification?.recipient);
  if (!resolvedRecipientId || !notification) {
    return { sent: 0, accepted: 0, failed: 0 };
  }

  const { tokens, unreadCount } = await getRecipientPushState(resolvedRecipientId, notification);
  if (tokens.length === 0) {
    log.info('Expo push skipped: no registered tokens', {
      recipientId: resolvedRecipientId,
      notificationId: toId(notification._id),
      type: notification?.type || 'system'
    });
    return { sent: 0, accepted: 0, failed: 0 };
  }

  const messages = buildExpoMessages(tokens, notification, unreadCount);

  let accepted = 0;
  let failed = 0;
  let invalidTokensRemoved = 0;
  let receiptOk = 0;
  let receiptFailed = 0;
  let receiptUnavailable = 0;
  let receiptInvalidTokensRemoved = 0;

  for (const batch of chunk(messages, EXPO_MAX_BATCH_SIZE)) {
    const response = await getPushProvider().send(batch);
    if (Array.isArray(response?.errors) && response.errors.length > 0) {
      log.error('Expo push request error', { errors: response.errors });
    }
    const result = await processExpoTickets(response?.data || [], batch);
    accepted += result.accepted;
    failed += result.failed;
    invalidTokensRemoved += result.invalidTokensRemoved;

    const receiptResult = await processExpoReceipts(result.receipts);
    receiptOk += receiptResult.ok;
    receiptFailed += receiptResult.failed;
    receiptUnavailable += receiptResult.unavailable;
    receiptInvalidTokensRemoved += receiptResult.invalidTokensRemoved;
  }

  log.info('Expo push notification sent', {
    recipientId: resolvedRecipientId,
    notificationId: toId(notification._id),
    sent: messages.length,
    accepted,
    failed,
    invalidTokensRemoved,
    receiptOk,
    receiptFailed,
    receiptUnavailable,
    receiptInvalidTokensRemoved
  });

  return {
    sent: messages.length,
    accepted,
    failed,
    invalidTokensRemoved,
    receiptOk,
    receiptFailed,
    receiptUnavailable,
    receiptInvalidTokensRemoved
  };
};

const filterBroadcastTokens = (user, audience = {}) => {
  const platforms = new Set(Array.isArray(audience.platforms) ? audience.platforms : []);
  const appVersions = new Set(Array.isArray(audience.appVersions) ? audience.appVersions : []);
  const hasDeviceTarget = platforms.size > 0 || appVersions.size > 0;
  const cutoff = Date.now() - (BROADCAST_CLIENT_CONTEXT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  return getValidPushTokens(user).filter((entry) =>
    (!hasDeviceTarget || (entry.lastUsedAt && new Date(entry.lastUsedAt).getTime() >= cutoff)) &&
    (platforms.size === 0 || platforms.has(entry.platform)) &&
    (appVersions.size === 0 || appVersions.has(entry.appVersion))
  );
};

const classifyBroadcastPushRecords = (records) => {
  if (!records.length) return { status: 'skipped', providerMessageIds: [], failureReason: '' };
  const providerMessageIds = records.map((record) => record.providerTicketId).filter(Boolean);
  if (records.some((record) => record.receiptStatus === 'delivered')) {
    return { status: 'delivered', providerMessageIds, failureReason: '' };
  }
  if (records.some((record) =>
    ['queued', 'sending'].includes(record.ticketStatus) ||
    (record.ticketStatus === 'accepted' && record.receiptStatus === 'pending')
  )) {
    return { status: 'processing', providerMessageIds, failureReason: '' };
  }
  if (records.every((record) => ['skipped', 'cancelled'].includes(record.ticketStatus) ||
    ['skipped', 'cancelled'].includes(record.receiptStatus))) {
    return { status: 'skipped', providerMessageIds, failureReason: '' };
  }
  const failureReason = records
    .map((record) => sanitizeString(record.providerErrorMessage || record.providerErrorCode))
    .filter(Boolean)
    .join('; ')
    .slice(0, 1000);
  return { status: 'failed', providerMessageIds, failureReason: failureReason || 'Push provider rejected every matched device' };
};

/**
 * Broadcast-only provider path. It persists a device-level request before the
 * provider call, claims it with a lease, and submits messages in Expo's maximum
 * batch size. Receipt checks are intentionally not performed here.
 */
const sendBroadcastPushBatch = async (entries, audience = {}) => {
  const BroadcastPushReceipt = require('../models/BroadcastPushReceipt');
  const Notification = require('../models/Notification');
  const User = require('../models/User');
  const normalizedEntries = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const messageEntries = [];
  const messageBuildFailures = [];
  const unreadNotifications = normalizedEntries.length
    ? await Notification.find({
      recipient: { $in: normalizedEntries.map((entry) => entry.recipientId) },
      isRead: false,
      deletedAt: null,
      archivedAt: null
    }).select('recipient data.targetPlatforms data.targetAppVersions data.customData.targetPlatforms data.customData.targetAppVersions').lean()
    : [];
  const unreadByRecipient = unreadNotifications.reduce((map, notification) => {
    const key = String(notification.recipient);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(notification);
    return map;
  }, new Map());

  for (const entry of normalizedEntries) {
    const tokens = filterBroadcastTokens(entry.user, audience);
    tokens.forEach((tokenEntry) => {
      const scopedUnreadCount = (unreadByRecipient.get(String(entry.recipientId)) || [])
        .filter((notification) => notificationMatchesClientContext(
          notification,
          tokenEntry.platform,
          tokenEntry.appVersion
        )).length;
      const tokenHash = hashPushToken(tokenEntry.token);
      try {
        const [message] = buildExpoMessages([tokenEntry], entry.notification, scopedUnreadCount);
        messageEntries.push({ entry, tokenEntry, tokenHash, message });
      } catch (error) {
        messageBuildFailures.push({
          entry,
          tokenEntry,
          tokenHash,
          errorCode: sanitizeString(error?.code, 'PushMessageBuildFailed').slice(0, 200),
          errorMessage: String(error?.message || error).slice(0, 1000)
        });
      }
    });
  }

  if (messageEntries.length || messageBuildFailures.length) {
    try {
      await BroadcastPushReceipt.bulkWrite([
        ...messageEntries.map(({ entry, tokenEntry, tokenHash }) => ({
        updateOne: {
          filter: { broadcastRecipient: entry.recipientLogId, tokenHash },
          update: {
            $setOnInsert: {
              broadcast: entry.broadcastId,
              broadcastRecipient: entry.recipientLogId,
              recipient: entry.recipientId,
              notification: entry.notificationId || null,
              occurrenceKey: entry.occurrenceKey,
              tokenHash,
              tokenPreview: previewPushToken(tokenEntry.token),
              platform: tokenEntry.platform,
              appVersion: tokenEntry.appVersion,
              deviceName: tokenEntry.deviceName,
              ticketStatus: 'queued',
              receiptStatus: 'pending'
            }
          },
          upsert: true
        }
        })),
        ...messageBuildFailures.map(({ entry, tokenEntry, tokenHash, errorCode, errorMessage }) => ({
          updateOne: {
            filter: { broadcastRecipient: entry.recipientLogId, tokenHash },
            update: {
              $setOnInsert: {
                broadcast: entry.broadcastId,
                broadcastRecipient: entry.recipientLogId,
                recipient: entry.recipientId,
                notification: entry.notificationId || null,
                occurrenceKey: entry.occurrenceKey,
                tokenHash,
                tokenPreview: previewPushToken(tokenEntry.token),
                platform: tokenEntry.platform,
                appVersion: tokenEntry.appVersion,
                deviceName: tokenEntry.deviceName,
                ticketStatus: 'failed',
                receiptStatus: 'failed',
                receiptCheckedAt: new Date(),
                providerErrorCode: errorCode,
                providerErrorMessage: errorMessage
              }
            },
            upsert: true
          }
        }))
      ], { ordered: false });
    } catch (error) {
      // Concurrent chunk recovery can race an upsert; the unique key is the
      // idempotency boundary and duplicate-key losers may safely continue.
      if (error?.code !== 11000 && !error?.writeErrors?.every((item) => item.code === 11000)) throw error;
    }
  }

  // A token may rotate between provider attempts. Retire queued records that
  // no longer correspond to any currently eligible token for that recipient;
  // otherwise recovery would enqueue the obsolete hash forever even when a
  // newer device token has already delivered successfully.
  if (normalizedEntries.length) {
    const hashesByRecipient = messageEntries.reduce((map, item) => {
      const key = String(item.entry.recipientLogId);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item.tokenHash);
      return map;
    }, new Map());
    await BroadcastPushReceipt.bulkWrite(normalizedEntries.map((entry) => {
      const currentTokenHashes = hashesByRecipient.get(String(entry.recipientLogId)) || [];
      return {
        updateMany: {
          filter: {
            broadcastRecipient: entry.recipientLogId,
            ticketStatus: 'queued',
            receiptStatus: 'pending',
            ...(currentTokenHashes.length ? { tokenHash: { $nin: currentTokenHashes } } : {})
          },
          update: {
            $set: {
              ticketStatus: 'skipped',
              receiptStatus: 'skipped',
              receiptCheckedAt: new Date(),
              providerErrorCode: 'RetryTokenUnavailable',
              providerErrorMessage: 'The originally targeted device token is no longer eligible'
            },
            $unset: { sendLeaseAt: 1, sendLeaseKey: 1, nextReceiptAt: 1 }
          }
        }
      };
    }), { ordered: false });
  }

  const recipientLogIds = normalizedEntries.map((entry) => entry.recipientLogId);
  const currentEntries = [...messageEntries, ...messageBuildFailures];
  const currentHashes = currentEntries.map((item) => item.tokenHash);
  let records = currentHashes.length
    ? await BroadcastPushReceipt.find({
      broadcastRecipient: { $in: recipientLogIds },
      tokenHash: { $in: currentHashes }
    })
    : [];
  const tokenByKey = new Map(messageEntries.map((item) => [
    `${item.entry.recipientLogId}:${item.tokenHash}`,
    item
  ]));
  const currentKeys = new Set(currentEntries.map((item) =>
    `${item.entry.recipientLogId}:${item.tokenHash}`
  ));
  records = records.filter((record) =>
    currentKeys.has(`${record.broadcastRecipient}:${record.tokenHash}`)
  );
  const staleLease = new Date(Date.now() - PROVIDER_LEASE_MS);
  const leaseKey = `expo-send-${randomUUID()}`;
  const claimableIds = records
    .filter((record) => record.sendAttempts < EXPO_BROADCAST_SEND_MAX_ATTEMPTS && (record.ticketStatus === 'queued' ||
      (record.ticketStatus === 'sending' && (!record.sendLeaseAt || record.sendLeaseAt < staleLease)))
    )
    .map((record) => record._id);

  if (claimableIds.length) {
    await BroadcastPushReceipt.updateMany(
      {
        _id: { $in: claimableIds },
        $or: [
          { ticketStatus: 'queued' },
          { ticketStatus: 'sending', sendLeaseAt: { $lt: staleLease } },
          { ticketStatus: 'sending', sendLeaseAt: null }
        ]
      },
      {
        $set: { ticketStatus: 'sending', sendLeaseAt: new Date(), sendLeaseKey: leaseKey },
        $inc: { sendAttempts: 1 }
      }
    );
  }

  const exhaustedSendIds = records
    .filter((record) => record.ticketStatus === 'queued' && record.sendAttempts >= EXPO_BROADCAST_SEND_MAX_ATTEMPTS)
    .map((record) => record._id);
  if (exhaustedSendIds.length) {
    await BroadcastPushReceipt.updateMany(
      { _id: { $in: exhaustedSendIds }, ticketStatus: 'queued' },
      {
        $set: {
          ticketStatus: 'failed',
          receiptStatus: 'failed',
          receiptCheckedAt: new Date(),
          providerErrorCode: 'SendRetryExhausted',
          providerErrorMessage: 'Expo ticket submission exhausted its retry budget'
        },
        $unset: { sendLeaseAt: 1, sendLeaseKey: 1, nextReceiptAt: 1 }
      }
    );
  }

  let claimedRecords = claimableIds.length
    ? await BroadcastPushReceipt.find({ _id: { $in: claimableIds }, sendLeaseKey: leaseKey })
    : [];
  if (claimedRecords.length) {
    const Broadcast = require('../models/Broadcast');
    const activeIds = new Set((await Broadcast.find({
      _id: { $in: claimedRecords.map((record) => record.broadcast) },
      status: { $ne: 'cancelled' },
      cancelledAt: null
    }).distinct('_id')).map(String));
    const cancelledRecords = claimedRecords.filter((record) => !activeIds.has(String(record.broadcast)));
    if (cancelledRecords.length) {
      await BroadcastPushReceipt.updateMany(
        { _id: { $in: cancelledRecords.map((record) => record._id) }, sendLeaseKey: leaseKey, ticketStatus: 'sending' },
        {
          $set: {
            ticketStatus: 'cancelled',
            receiptStatus: 'cancelled',
            receiptCheckedAt: new Date(),
            providerErrorCode: 'BroadcastCancelled',
            providerErrorMessage: 'Broadcast was cancelled before provider submission'
          },
          $unset: { sendLeaseAt: 1, sendLeaseKey: 1, nextReceiptAt: 1 }
        }
      );
      claimedRecords = claimedRecords.filter((record) => activeIds.has(String(record.broadcast)));
    }
  }
  let transientError = null;
  for (const recordBatch of chunk(claimedRecords, EXPO_MAX_BATCH_SIZE)) {
    // Cancellation can race a large multi-batch submission. Re-check directly
    // before each provider call so later 100-message batches never fan out
    // after the admin cancels the broadcast.
    const Broadcast = require('../models/Broadcast');
    const activeBatchBroadcastIds = new Set((await Broadcast.find({
      _id: { $in: recordBatch.map((record) => record.broadcast) },
      status: { $ne: 'cancelled' },
      cancelledAt: null
    }).distinct('_id')).map(String));
    const cancelledBatchRecords = recordBatch.filter(
      (record) => !activeBatchBroadcastIds.has(String(record.broadcast))
    );
    if (cancelledBatchRecords.length) {
      await BroadcastPushReceipt.updateMany(
        { _id: { $in: cancelledBatchRecords.map((record) => record._id) }, sendLeaseKey: leaseKey, ticketStatus: 'sending' },
        {
          $set: {
            ticketStatus: 'cancelled',
            receiptStatus: 'cancelled',
            receiptCheckedAt: new Date(),
            providerErrorCode: 'BroadcastCancelled',
            providerErrorMessage: 'Broadcast was cancelled before provider submission'
          },
          $unset: { sendLeaseAt: 1, sendLeaseKey: 1, nextReceiptAt: 1 }
        }
      );
    }
    const activeRecordBatch = recordBatch.filter(
      (record) => activeBatchBroadcastIds.has(String(record.broadcast))
    );
    if (!activeRecordBatch.length) continue;
    const batchItems = activeRecordBatch.map((record) => tokenByKey.get(`${record.broadcastRecipient}:${record.tokenHash}`));
    if (batchItems.some((item) => !item)) {
      transientError = new Error('A claimed Expo broadcast request lost its in-memory message mapping');
      await BroadcastPushReceipt.updateMany(
        { _id: { $in: activeRecordBatch.map((record) => record._id) }, sendLeaseKey: leaseKey },
        { $set: { ticketStatus: 'queued', providerErrorMessage: transientError.message }, $unset: { sendLeaseAt: 1, sendLeaseKey: 1 } }
      );
      continue;
    }

    let response;
    try {
      response = await getPushProvider().send(batchItems.map((item) => item.message));
    } catch (error) {
      await BroadcastPushReceipt.updateMany(
        { _id: { $in: activeRecordBatch.map((record) => record._id) }, sendLeaseKey: leaseKey },
        {
          $set: { ticketStatus: 'queued', providerErrorMessage: String(error?.message || error).slice(0, 1000) },
          $unset: { sendLeaseAt: 1, sendLeaseKey: 1 }
        }
      );
      throw error;
    }

    const tickets = Array.isArray(response?.data) ? response.data : [response?.data].filter(Boolean);
    const invalidTokens = [];
    const operations = activeRecordBatch.map((record, index) => {
      const ticket = tickets[index];
      const item = batchItems[index];
      if (ticket?.status === 'ok' && ticket.id) {
        return {
          updateOne: {
            filter: { _id: record._id, sendLeaseKey: leaseKey },
            update: {
              $set: {
                ticketStatus: 'accepted',
                providerTicketId: ticket.id,
                receiptStatus: 'pending',
                sentAt: new Date(),
                nextReceiptAt: new Date(Date.now() + EXPO_BROADCAST_RECEIPT_DELAY_MS),
                providerErrorCode: '',
                providerErrorMessage: ''
              },
              $unset: { sendLeaseAt: 1, sendLeaseKey: 1 }
            }
          }
        };
      }
      if (!ticket) {
        transientError = new Error('Expo returned fewer push tickets than submitted messages');
        return {
          updateOne: {
            filter: { _id: record._id, sendLeaseKey: leaseKey },
            update: {
              $set: { ticketStatus: 'queued', providerErrorMessage: transientError.message },
              $unset: { sendLeaseAt: 1, sendLeaseKey: 1 }
            }
          }
        };
      }
      const errorCode = sanitizeString(ticket?.details?.error).slice(0, 200);
      if (isTransientExpoError(errorCode)) {
        transientError = new Error(`Expo temporarily rejected a push ticket: ${errorCode}`);
        return {
          updateOne: {
            filter: { _id: record._id, sendLeaseKey: leaseKey },
            update: {
              $set: {
                ticketStatus: 'queued',
                receiptStatus: 'pending',
                providerErrorCode: errorCode,
                providerErrorMessage: sanitizeString(ticket?.message, transientError.message).slice(0, 1000)
              },
              $unset: { sendLeaseAt: 1, sendLeaseKey: 1, providerTicketId: 1, nextReceiptAt: 1 }
            }
          }
        };
      }
      if (errorCode === 'DeviceNotRegistered') invalidTokens.push(item.tokenEntry.token);
      return {
        updateOne: {
          filter: { _id: record._id, sendLeaseKey: leaseKey },
          update: {
            $set: {
              ticketStatus: 'failed',
              receiptStatus: 'failed',
              receiptCheckedAt: new Date(),
              providerErrorCode: errorCode,
              providerErrorMessage: sanitizeString(ticket?.message, 'Expo rejected the push ticket').slice(0, 1000)
            },
            $unset: { sendLeaseAt: 1, sendLeaseKey: 1, nextReceiptAt: 1 }
          }
        }
      };
    });
    await BroadcastPushReceipt.bulkWrite(operations, { ordered: false });
    if (invalidTokens.length) {
      await User.updateMany(
        { 'pushTokens.token': { $in: invalidTokens } },
        { $pull: { pushTokens: { token: { $in: invalidTokens } } } }
      );
    }
  }
  if (transientError) throw transientError;

  records = currentHashes.length
    ? await BroadcastPushReceipt.find({
      broadcastRecipient: { $in: recipientLogIds },
      tokenHash: { $in: currentHashes }
    }).lean()
    : [];
  records = records.filter((record) =>
    currentKeys.has(`${record.broadcastRecipient}:${record.tokenHash}`)
  );
  const recordsByRecipient = new Map();
  for (const record of records) {
    const key = String(record.broadcastRecipient);
    if (!recordsByRecipient.has(key)) recordsByRecipient.set(key, []);
    recordsByRecipient.get(key).push(record);
  }
  const recipientResults = Object.fromEntries(normalizedEntries.map((entry) => [
    String(entry.recipientLogId),
    classifyBroadcastPushRecords(recordsByRecipient.get(String(entry.recipientLogId)) || [])
  ]));
  const receiptRecordIds = records
    .filter((record) => record.ticketStatus === 'accepted' && record.receiptStatus === 'pending')
    .map((record) => String(record._id));
  const receiptRunAt = records
    .filter((record) => record.ticketStatus === 'accepted' && record.receiptStatus === 'pending' && record.nextReceiptAt)
    .reduce((latest, record) => {
      const value = new Date(record.nextReceiptAt);
      return !latest || value > latest ? value : latest;
    }, null);

  log.info('Expo broadcast push batch submitted', {
    recipients: normalizedEntries.length,
    messages: messageEntries.length,
    claimed: claimedRecords.length,
    pendingReceipts: receiptRecordIds.length
  });
  return { recipientResults, receiptRecordIds, receiptRunAt, messageCount: messageEntries.length };
};

const removeInvalidHashedTokens = async (records) => {
  if (!records.length) return 0;
  const User = require('../models/User');
  let removed = 0;
  const byRecipient = new Map();
  for (const record of records) {
    const key = String(record.recipient);
    if (!byRecipient.has(key)) byRecipient.set(key, new Set());
    byRecipient.get(key).add(record.tokenHash);
  }
  const users = await User.find({ _id: { $in: Array.from(byRecipient.keys()) } }).select('pushTokens').lean();
  for (const user of users) {
    const hashes = byRecipient.get(String(user._id)) || new Set();
    const invalidTokens = (user.pushTokens || [])
      .map((entry) => entry?.token)
      .filter((token) => token && hashes.has(hashPushToken(token)));
    if (invalidTokens.length) {
      const result = await User.updateOne(
        { _id: user._id },
        { $pull: { pushTokens: { token: { $in: invalidTokens } } } }
      );
      removed += Number(result.modifiedCount || 0);
    }
  }
  return removed;
};

/** Reconcile durable Expo tickets without blocking the originating chunk. */
const reconcileBroadcastPushReceipts = async (recordIds, processingKey) => {
  const BroadcastPushReceipt = require('../models/BroadcastPushReceipt');
  const ids = Array.from(new Set((recordIds || []).map(toId).filter(Boolean)));
  if (!ids.length) return { recipientLogIds: [], pendingRecordIds: [], delivered: 0, failed: 0 };
  const staleLease = new Date(Date.now() - PROVIDER_LEASE_MS);
  const leaseKey = sanitizeString(processingKey, `expo-receipt-${randomUUID()}`).slice(0, 250);
  const exhausted = await BroadcastPushReceipt.find({
    _id: { $in: ids },
    receiptStatus: 'pending',
    receiptAttempts: { $gte: EXPO_BROADCAST_RECEIPT_MAX_ATTEMPTS },
    $or: [{ receiptLeaseAt: null }, { receiptLeaseAt: { $lt: staleLease } }]
  }).select('_id broadcastRecipient').lean();
  if (exhausted.length) {
    await BroadcastPushReceipt.updateMany(
      { _id: { $in: exhausted.map((record) => record._id) }, receiptStatus: 'pending' },
      {
        $set: {
          receiptStatus: 'failed',
          receiptCheckedAt: new Date(),
          nextReceiptAt: null,
          providerErrorCode: 'ReceiptUnavailable',
          providerErrorMessage: 'Expo receipt reconciliation exhausted its retry budget'
        },
        $unset: { receiptLeaseAt: 1, receiptLeaseKey: 1 }
      }
    );
  }
  const queuedForRetry = await BroadcastPushReceipt.find({
    _id: { $in: ids },
    ticketStatus: 'queued',
    receiptStatus: 'pending'
  }).select('_id broadcastRecipient').lean();
  await BroadcastPushReceipt.updateMany(
    {
      _id: { $in: ids },
      ticketStatus: 'accepted',
      receiptStatus: 'pending',
      receiptAttempts: { $lt: EXPO_BROADCAST_RECEIPT_MAX_ATTEMPTS },
      $or: [
        { receiptLeaseAt: null },
        { receiptLeaseAt: { $lt: staleLease } },
        { receiptLeaseKey: leaseKey }
      ]
    },
    {
      $set: { receiptLeaseAt: new Date(), receiptLeaseKey: leaseKey },
      $inc: { receiptAttempts: 1 }
    }
  );
  const claimed = await BroadcastPushReceipt.find({ _id: { $in: ids }, receiptLeaseKey: leaseKey });
  if (!claimed.length) {
    return {
      recipientLogIds: Array.from(new Set([
        ...exhausted.map((record) => String(record.broadcastRecipient)),
        ...queuedForRetry.map((record) => String(record.broadcastRecipient))
      ])),
      pendingRecordIds: [],
      delivered: 0,
      failed: exhausted.length,
      retryRecipientLogIds: Array.from(new Set(queuedForRetry.map((record) => String(record.broadcastRecipient))))
    };
  }

  let delivered = 0;
  let failed = exhausted.length;
  let missing = 0;
  const invalidRecords = [];
  const retryRecipientLogIds = new Set(queuedForRetry.map((record) => String(record.broadcastRecipient)));
  try {
    for (const recordBatch of chunk(claimed, EXPO_MAX_RECEIPT_BATCH_SIZE)) {
      const providerIds = recordBatch.map((record) => record.providerTicketId).filter(Boolean);
      const payload = await getPushProvider().getReceipts(providerIds);
      const receiptMap = payload?.data || {};
      const operations = recordBatch.map((record) => {
        const receipt = receiptMap[record.providerTicketId];
        const baseFilter = { _id: record._id, receiptLeaseKey: leaseKey, receiptStatus: 'pending' };
        if (receipt?.status === 'ok') {
          delivered += 1;
          return {
            updateOne: {
              filter: baseFilter,
              update: {
                $set: { receiptStatus: 'delivered', receiptCheckedAt: new Date(), providerErrorCode: '', providerErrorMessage: '' },
                $unset: { receiptLeaseAt: 1, receiptLeaseKey: 1, nextReceiptAt: 1 }
              }
            }
          };
        }
        if (receipt) {
          const errorCode = sanitizeString(receipt?.details?.error).slice(0, 200);
          const transient = isTransientExpoError(errorCode) &&
            record.receiptAttempts < EXPO_BROADCAST_RECEIPT_MAX_ATTEMPTS;
          if (transient) {
            retryRecipientLogIds.add(String(record.broadcastRecipient));
            return {
              updateOne: {
                filter: baseFilter,
                update: {
                  $set: {
                    ticketStatus: 'queued',
                    receiptStatus: 'pending',
                    receiptCheckedAt: new Date(),
                    providerErrorCode: errorCode,
                    providerErrorMessage: sanitizeString(receipt?.message, 'Expo requested a delivery retry').slice(0, 1000)
                  },
                  $unset: { providerTicketId: 1, receiptLeaseAt: 1, receiptLeaseKey: 1, nextReceiptAt: 1 }
                }
              }
            };
          }
          failed += 1;
          if (errorCode === 'DeviceNotRegistered') invalidRecords.push(record);
          return {
            updateOne: {
              filter: baseFilter,
              update: {
                $set: {
                  receiptStatus: 'failed',
                  receiptCheckedAt: new Date(),
                  providerErrorCode: errorCode,
                  providerErrorMessage: sanitizeString(receipt?.message, 'Expo receipt failed').slice(0, 1000)
                },
                $unset: { receiptLeaseAt: 1, receiptLeaseKey: 1, nextReceiptAt: 1 }
              }
            }
          };
        }

        missing += 1;
        const terminal = record.receiptAttempts >= EXPO_BROADCAST_RECEIPT_MAX_ATTEMPTS;
        if (terminal) failed += 1;
        const retryDelay = Math.min(60 * 60 * 1000, 30000 * (2 ** Math.max(0, record.receiptAttempts - 1)));
        return {
          updateOne: {
            filter: baseFilter,
            update: {
              $set: {
                receiptStatus: terminal ? 'failed' : 'pending',
                receiptCheckedAt: new Date(),
                nextReceiptAt: terminal ? null : new Date(Date.now() + retryDelay),
                providerErrorCode: terminal ? 'ReceiptUnavailable' : '',
                providerErrorMessage: terminal ? 'Expo receipt remained unavailable after retries' : 'Expo receipt is not available yet'
              },
              $unset: { receiptLeaseAt: 1, receiptLeaseKey: 1 }
            }
          }
        };
      });
      await BroadcastPushReceipt.bulkWrite(operations, { ordered: false });
    }
  } catch (error) {
    const nextReceiptAt = new Date(Date.now() + 60000);
    const errorMessage = String(error?.message || error).slice(0, 1000);
    const retryable = claimed.filter((record) => record.receiptAttempts < EXPO_BROADCAST_RECEIPT_MAX_ATTEMPTS);
    const terminal = claimed.filter((record) => record.receiptAttempts >= EXPO_BROADCAST_RECEIPT_MAX_ATTEMPTS);
    if (retryable.length) {
      await BroadcastPushReceipt.updateMany(
        { _id: { $in: retryable.map((record) => record._id) }, receiptLeaseKey: leaseKey, receiptStatus: 'pending' },
        {
          $set: { nextReceiptAt, providerErrorMessage: errorMessage },
          $unset: { receiptLeaseAt: 1, receiptLeaseKey: 1 }
        }
      );
    }
    if (terminal.length) {
      failed += terminal.length;
      await BroadcastPushReceipt.updateMany(
        { _id: { $in: terminal.map((record) => record._id) }, receiptLeaseKey: leaseKey, receiptStatus: 'pending' },
        {
          $set: {
            receiptStatus: 'failed',
            receiptCheckedAt: new Date(),
            nextReceiptAt: null,
            providerErrorCode: 'ReceiptProviderUnavailable',
            providerErrorMessage: errorMessage
          },
          $unset: { receiptLeaseAt: 1, receiptLeaseKey: 1 }
        }
      );
    }
    if (retryable.length) throw error;
  }

  await removeInvalidHashedTokens(invalidRecords);
  const refreshed = await BroadcastPushReceipt.find({ _id: { $in: ids } }).lean();
  const pendingRecordIds = refreshed
    .filter((record) => record.receiptStatus === 'pending')
    .map((record) => String(record._id));
  return {
    recipientLogIds: Array.from(new Set(refreshed.map((record) => String(record.broadcastRecipient)))),
    pendingRecordIds,
    delivered,
    failed,
    unavailable: missing,
    retryRecipientLogIds: Array.from(retryRecipientLogIds)
  };
};

const sendBulkPushNotification = async (recipientIds, notification) => {
  const uniqueRecipientIds = Array.from(new Set((recipientIds || []).map(toId).filter(Boolean)));
  const results = await Promise.allSettled(
    uniqueRecipientIds.map((recipientId) => sendPushNotification(recipientId, {
      ...notification,
      recipient: recipientId
    }))
  );

  return results.reduce((acc, result) => {
    if (result.status === 'fulfilled') {
      acc.sent += result.value.sent || 0;
      acc.accepted += result.value.accepted || 0;
      acc.failed += result.value.failed || 0;
      acc.receiptOk += result.value.receiptOk || 0;
      acc.receiptFailed += result.value.receiptFailed || 0;
      acc.receiptUnavailable += result.value.receiptUnavailable || 0;
    } else {
      acc.failed += 1;
    }
    return acc;
  }, { sent: 0, accepted: 0, failed: 0, receiptOk: 0, receiptFailed: 0, receiptUnavailable: 0 });
};

module.exports = {
  sendPushNotification,
  sendBulkPushNotification,
  sendBroadcastPushBatch,
  reconcileBroadcastPushReceipts,
  classifyBroadcastPushRecords,
  filterBroadcastTokens,
  isTransientExpoError,
  buildPushData,
  buildExpoMessages,
  getExpoMessageByteLength,
  assertExpoMessageSize,
  getPushProviderCapabilities,
  notificationMatchesClientContext,
  shouldSendPushNotification
};
