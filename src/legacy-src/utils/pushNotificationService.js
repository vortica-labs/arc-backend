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
const EXPO_GENERIC_RECEIPT_DELAY_MS = Math.max(
  15000,
  Number(process.env.EXPO_GENERIC_PUSH_RECEIPT_DELAY_MS || 15 * 60 * 1000)
);
const EXPO_GENERIC_RECEIPT_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.EXPO_GENERIC_PUSH_RECEIPT_MAX_ATTEMPTS || 8)
);
const EXPO_GENERIC_SEND_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.EXPO_GENERIC_PUSH_SEND_MAX_ATTEMPTS || 5)
);
const EXPO_GENERIC_INLINE_SEND_ATTEMPTS = Math.max(
  1,
  Math.min(EXPO_GENERIC_SEND_MAX_ATTEMPTS, Number(process.env.EXPO_GENERIC_PUSH_INLINE_SEND_ATTEMPTS || 1))
);
const PUSH_REQUEST_RECOVERY_MAX_ATTEMPTS = Math.max(
  1,
  Math.min(10, Number(process.env.PUSH_REQUEST_RECOVERY_MAX_ATTEMPTS || 5))
);
const NOTIFICATION_PUSH_OUTBOX_MAX_ATTEMPTS = Math.max(
  1,
  Math.min(50, Number(process.env.NOTIFICATION_PUSH_OUTBOX_MAX_ATTEMPTS || 12))
);
const EXPO_GENERIC_RETRY_BASE_MS = Math.max(
  1000,
  Number(process.env.EXPO_GENERIC_PUSH_RETRY_BASE_MS || 10000)
);
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
const boundedCollapseId = (value, fallback) => {
  const candidate = sanitizeString(value, fallback);
  return /^[\x20-\x7E]+$/.test(candidate) && Buffer.byteLength(candidate, 'utf8') <= 64
    ? candidate
    : createHash('sha256').update(candidate).digest('hex');
};
const previewPushToken = (token) => {
  const value = String(token || '');
  if (value.length <= 18) return '[redacted]';
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
};

const isTransientExpoError = (errorCode) => new Set([
  'MessageRateExceeded',
  'ServiceUnavailable',
  'InternalServerError',
  'ExpoServerError',
  'ExpoRequestTimeout'
]).has(sanitizeString(errorCode));

const isRetryableExpoRequestError = (error) => {
  const statusCode = Number(error?.statusCode || 0);
  const code = sanitizeString(error?.code || error?.cause?.code);
  return statusCode === 429 || statusCode >= 500 || new Set([
    'ExpoRequestTimeout', 'ExpoNetworkError', 'ETIMEDOUT', 'ECONNRESET',
    'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'
  ]).has(code);
};

const getExpoRetryDelayMs = (error, attempt = 1) => {
  const retryAfter = Array.isArray(error?.retryAfter) ? error.retryAfter[0] : error?.retryAfter;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const parsed = Number.isFinite(seconds)
      ? seconds * 1000
      : new Date(String(retryAfter)).getTime() - Date.now();
    if (Number.isFinite(parsed) && parsed > 0) return Math.max(10000, Math.min(60 * 60 * 1000, parsed));
  }
  const base = Math.min(60 * 60 * 1000, EXPO_GENERIC_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)));
  return base + Math.floor(Math.random() * Math.max(250, Math.min(5000, base * 0.2)));
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));

const sanitizeString = (value, fallback = '') => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
};

const getPushRequestKey = (recipientId, notification) => {
  const forced = sanitizeString(notification?.pushRequestKey).toLowerCase();
  if (/^[a-f\d]{64}$/.test(forced)) return forced;
  const customData = notification?.data?.customData || {};
  const explicit = sanitizeString(customData.pushRequestId || notification?.pushRequestId).slice(0, 200);
  // Producer request IDs are the logical idempotency boundary. Do not mix the
  // database row ID into this branch: a crash-recovery or transport fallback
  // may reconstruct the same request without the original Notification doc.
  if (explicit) {
    return createHash('sha256')
      .update(`${toId(recipientId)}:explicit:${explicit}`)
      .digest('hex');
  }
  const notificationId = toId(notification?._id);
  const revision = sanitizeString(
    notification?.createdAt?.toISOString?.() || notification?.createdAt ||
    notification?.updatedAt?.toISOString?.() || notification?.updatedAt
  ) || (notificationId ? 'initial' : randomUUID());
  return createHash('sha256')
    .update(`${toId(recipientId)}:${notificationId || 'ephemeral'}:${revision}`)
    .digest('hex');
};

const getPushSource = (notification) => {
  const source = sanitizeString(notification?.data?.customData?.pushSource).toLowerCase();
  return ['generic', 'diagnostic', 'admin_test', 'bulk'].includes(source) ? source : 'generic';
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
    pushRequestId: sanitizeString(customData.pushRequestId).slice(0, 200) || undefined,
    pushDeliveryAttemptId: toId(customData.pushDeliveryAttemptId) || undefined,
    collapseKey: sanitizeString(customData.pushOptions?.collapseKey) || undefined,
    type: notification?.type || 'system',
    postId: toId(data.postId || customData.postId) || undefined,
    clipId: toId(data.clipId || customData.clipId) || undefined,
    tournamentId: toId(data.tournamentId || customData.tournamentId) || undefined,
    recruitmentId: toId(data.recruitmentId || customData.recruitmentId) || undefined,
    chatId: toId(data.chatId || data.conversationId || customData.chatId || customData.conversationId) || undefined,
    messageId: toId(data.messageId || customData.messageId) || undefined,
    userId: toId(notification?.sender || customData.userId) || undefined,
    eventType: sanitizeString(customData.eventType).slice(0, 80) || undefined,
    callId: toId(customData.callId) || undefined,
    nativeCallId: sanitizeString(customData.nativeCallId).slice(0, 64) || undefined,
    roomId: sanitizeString(customData.roomId).slice(0, 200) || undefined,
    randomRoomId: sanitizeString(customData.randomRoomId).slice(0, 200) || undefined,
    callType: sanitizeString(customData.callType).slice(0, 40) || undefined,
    callerId: toId(customData.callerId) || undefined,
    callerName: sanitizeString(customData.callerName).slice(0, 120) || undefined,
    ...(sanitizeString(customData.eventType).toLowerCase() === 'incoming_call' ? {
      title: sanitizeString(notification?.title).slice(0, 160) || undefined
    } : {}),
    deadlineAt: sanitizeString(customData.deadlineAt).slice(0, 50) || undefined,
    expiresAt: sanitizeString(customData.expiresAt).slice(0, 50) || undefined,
    status: sanitizeString(customData.status || customData.callStatus).slice(0, 40) || undefined,
    callStatus: sanitizeString(customData.callStatus || customData.status).slice(0, 40) || undefined,
    stateRevision: sanitizeString(customData.stateRevision).slice(0, 80) || undefined,
    reason: sanitizeString(customData.reason).slice(0, 80) || undefined
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
      if (error && typeof error === 'object' && !error.code) {
        error.code = error?.cause?.code || 'ExpoNetworkError';
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`Expo push request failed with HTTP ${response.status}`);
      error.payload = payload;
      error.statusCode = response.status;
      error.retryAfter = response.headers.get('retry-after') || '';
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
          error.statusCode = res.statusCode;
          error.retryAfter = res.headers['retry-after'] || '';
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
  const PushDevice = require('../models/PushDevice');
  const { invalidatePushDevicesByHash } = require('../services/pushDeviceService');
  const tokenHash = hashPushToken(token);
  const devices = await PushDevice.find({ tokenHash }).select('user tokenHash').lean();
  if (devices.length) await invalidatePushDevicesByHash(devices.map((device) => ({
    recipient: device.user,
    tokenHash: device.tokenHash
  })), 'DeviceNotRegistered');
  else await User.updateMany(
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
  const { getPushDevicesForUser } = require('../services/pushDeviceService');
  const [user, unreadCount, devices] = await Promise.all([
    User.findById(recipientId).select('notificationSettings isActive').lean(),
    Notification.countDocuments({
      recipient: recipientId,
      isRead: false,
      deletedAt: null,
      archivedAt: null
    }).catch(() => 0),
    getPushDevicesForUser(recipientId)
  ]);

  const preferenceKey = getPreferenceKeyForNotification(notification);
  const settings = { ...NOTIFICATION_SETTING_DEFAULTS, ...(user?.notificationSettings || {}) };
  const callStateReconciliation = notification?.data?.customData?.eventType === 'call_state_update' &&
    notification?.data?.customData?.callStateReconciliation === true;
  const allowed = Boolean(user) && user.isActive !== false && (callStateReconciliation || (
    settings.pushEnabled !== false && (!preferenceKey || settings[preferenceKey] !== false)
  ));
  if (!allowed) {
    const suppressionReason = !user || user.isActive === false
      ? 'RECIPIENT_INACTIVE'
      : settings.pushEnabled === false ? 'PUSH_DISABLED' : 'CATEGORY_MUTED';
    return { tokens: [], devices: [], unreadCount, suppressionReason };
  }
  const targetInstallationId = sanitizeString(notification?.data?.customData?.pushTargetInstallationId);
  const targetPlatform = sanitizeString(notification?.data?.customData?.pushTargetPlatform).toLowerCase();
  const targetPlatforms = new Set(
    (Array.isArray(notification?.data?.customData?.pushTargetPlatforms)
      ? notification.data.customData.pushTargetPlatforms
      : [])
      .map((value) => sanitizeString(value).toLowerCase())
      .filter((value) => ['android', 'ios', 'web'].includes(value))
  );
  const targetProjectId = sanitizeString(notification?.data?.customData?.pushTargetProjectId);
  const excludedInstallationId = sanitizeString(notification?.data?.customData?.pushExcludeInstallationId);
  const allowedTokenHashes = new Set(
    (Array.isArray(notification?.pushTargetTokenHashes) ? notification.pushTargetTokenHashes : [])
      .map((value) => sanitizeString(value).toLowerCase())
      .filter((value) => /^[a-f\d]{64}$/.test(value))
  );
  const validDevices = devices.filter((entry) => typeof entry?.token === 'string' &&
    entry.token.length <= EXPO_PUSH_TOKEN_MAX_LENGTH && EXPO_PUSH_TOKEN_PATTERN.test(entry.token));
  const callEventType = sanitizeString(notification?.data?.customData?.eventType).toLowerCase();
  const isIncomingCall = callEventType === 'incoming_call' ||
    (notification?.type === 'call' && !callEventType);
  const allowIosVoipFallback = notification?.pushAllowVoipFallback === true;
  const targetedDevices = validDevices.filter((entry) =>
    (!targetInstallationId || entry.installationId === targetInstallationId) &&
    (!excludedInstallationId || entry.installationId !== excludedInstallationId) &&
    (!targetPlatform || entry.platform === targetPlatform) &&
    (targetPlatforms.size === 0 || targetPlatforms.has(entry.platform)) &&
    (!targetProjectId || entry.projectId === targetProjectId) &&
    (allowedTokenHashes.size === 0 || allowedTokenHashes.has(entry.tokenHash || hashPushToken(entry.token))) &&
    // PushKit + CallKit is the canonical iOS incoming-call presentation. Do
    // not also display an Expo alert on installations that registered a VoIP
    // token; iOS installations without PushKit still receive the fallback.
    (!isIncomingCall || allowIosVoipFallback || entry.platform !== 'ios' || !entry.voipTokenHash)
  );
  return {
    tokens: targetedDevices.map((entry) => entry.token),
    devices: targetedDevices,
    unreadCount,
    suppressionReason: targetedDevices.length
      ? ''
      : (validDevices.length ? 'NO_MATCHING_INSTALLATION' : 'NO_ACTIVE_INSTALLATION')
  };
};

const getIncomingCallDeadline = (notification) => {
  const customData = notification?.data?.customData || {};
  const eventType = sanitizeString(customData.eventType).toLowerCase();
  if (eventType !== 'incoming_call' && notification?.type !== 'call') return null;
  const value = sanitizeString(customData.expiresAt || customData.deadlineAt);
  if (!value) return null;
  const deadline = new Date(value);
  return Number.isNaN(deadline.getTime()) ? null : deadline;
};

const buildExpoMessages = (tokens, notification, unreadCount = 0) => {
  const title = sanitizeString(notification.title, 'SquadHunt');
  const body = sanitizeString(notification.message, 'You have a new notification');
  const data = buildPushData(notification);
  const isBroadcast = Boolean(data.broadcastId);
  const image = sanitizeString(notification?.data?.image || notification?.data?.customData?.image);
  const channelId = getChannelIdForNotification(notification);
  const pushOptions = notification?.data?.customData?.pushOptions || {};
  const callEventType = sanitizeString(notification?.data?.customData?.eventType).toLowerCase();
  const isIncomingCall = callEventType === 'incoming_call' ||
    (notification?.type === 'call' && !callEventType);
  const isCallStateUpdate = callEventType === 'call_state_update';
  const configuredTtl = Number.isFinite(Number(pushOptions.ttl))
    ? Math.max(0, Math.min(2419200, Number(pushOptions.ttl)))
    : (isIncomingCall ? 30 : 2419200);
  const callDeadline = isIncomingCall ? getIncomingCallDeadline(notification) : null;
  const remainingCallTtl = callDeadline
    ? Math.max(0, Math.floor((callDeadline.getTime() - Date.now()) / 1000))
    : configuredTtl;
  const ttl = isIncomingCall ? Math.min(configuredTtl, remainingCallTtl) : configuredTtl;
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
    const platform = typeof tokenEntry === 'string'
      ? ''
      : sanitizeString(tokenEntry.platform).toLowerCase();
    // FCM does not invoke FirebaseMessagingService for a background/killed
    // app when a message contains a notification envelope. Android incoming
    // calls therefore use a high-priority data-only message so the checked-in
    // native service can immediately publish CallStyle/full-screen UI. Other
    // alerts and the iOS fallback retain the normal visible envelope.
    const isNativeCallData = (isIncomingCall && platform === 'android') ||
      (isCallStateUpdate && ['android', 'ios'].includes(platform));
    // APNs content-available/data-only notifications require priority 5;
    // Expo's `normal` maps to that value. Android call state remains high.
    const providerPriority = isCallStateUpdate && platform === 'ios' ? 'normal' : priority;
    const message = {
      to: token,
      ...(!isNativeCallData ? {
        title,
        body,
        ...(subtitle ? { subtitle } : {}),
        ...(sound ? { sound } : {}),
        channelId,
        ...(isIncomingCall ? { categoryId: 'incoming_call' } : {}),
        badge
      } : {}),
      priority: providerPriority,
      ttl,
      expiration: Math.floor(Date.now() / 1000) + ttl,
      data,
      // Broadcast alerts stay visible while also allowing iOS to wake the app
      // for background delivery tracking. Generic notifications must not all
      // opt into background processing.
      ...((isBroadcast || isIncomingCall || isCallStateUpdate) ? { _contentAvailable: true } : {}),
      ...((pushOptions.collapseKey || isIncomingCall) ? {
        collapseId: boundedCollapseId(
          pushOptions.collapseKey || notification?.data?.customData?.callId || notification?.data?.customData?.conversationId,
          `call-${toId(notification?._id) || 'incoming'}`
        )
      } : {}),
      // Expo/APNs requires mutable-content for the Notification Service
      // Extension to download and attach a remote image on iOS. Android safely
      // ignores this flag while continuing to use richContent.image.
      ...(richImage ? { richContent: { image: richImage }, mutableContent: true } : {})
    };
    assertExpoMessageSize(message);
    return message;
  });
};

const summarizePushAttempts = (records, requestKey, submitted = 0, invalidTokensRemoved = 0) => ({
  requestKey,
  sent: records.length,
  submitted,
  accepted: records.filter((record) => record.ticketStatus === 'accepted').length,
  failed: records.filter((record) => record.ticketStatus === 'failed' || record.receiptStatus === 'failed').length,
  skipped: records.filter((record) => record.ticketStatus === 'skipped' || record.receiptStatus === 'skipped').length,
  receiptOk: records.filter((record) => record.receiptStatus === 'delivered').length,
  receiptFailed: records.filter((record) => record.receiptStatus === 'failed').length,
  receiptUnavailable: records.filter((record) => record.ticketStatus === 'accepted' && record.receiptStatus === 'pending').length,
  pendingReceipts: records.filter((record) => record.ticketStatus === 'accepted' && record.receiptStatus === 'pending').length,
  invalidTokensRemoved,
  idempotent: submitted === 0 && records.length > 0,
  attemptIds: records.map((record) => String(record._id))
});

const ensurePushDeliveryRequest = async (recipientId, notification, requestKey) => {
  const PushDeliveryRequest = require('../models/PushDeliveryRequest');
  const notificationId = toId(notification?._id);
  const canReferenceNotification = /^[a-f\d]{24}$/i.test(notificationId);
  const now = new Date();
  return PushDeliveryRequest.findOneAndUpdate(
    { requestKey },
    {
      $setOnInsert: {
        requestKey,
        recipient: recipientId,
        ...(canReferenceNotification ? { notification: notificationId } : {}),
        source: getPushSource(notification),
        notificationType: sanitizeString(notification?.type, 'system').slice(0, 80),
        provider: 'expo',
        payload: {
          title: sanitizeString(notification?.title).slice(0, 200),
          body: sanitizeString(notification?.message).slice(0, 2000),
          type: sanitizeString(notification?.type, 'system').slice(0, 80),
          data: buildPushData(notification),
          notificationData: notification?.data || {}
        },
        status: 'created',
        firstAttemptAt: now
      },
      $set: { lastAttemptAt: now }
    },
    { upsert: true, new: true, runValidators: true }
  );
};

const updatePushDeliveryRequest = (requestKey, update) => {
  const PushDeliveryRequest = require('../models/PushDeliveryRequest');
  return PushDeliveryRequest.updateOne({ requestKey }, update);
};

const refreshPushDeliveryRequests = async (requestKeys) => {
  const PushDeliveryAttempt = require('../models/PushDeliveryAttempt');
  const PushDeliveryRequest = require('../models/PushDeliveryRequest');
  const keys = Array.from(new Set((requestKeys || []).map((value) => sanitizeString(value)).filter(Boolean)));
  if (!keys.length) return;
  const records = await PushDeliveryAttempt.find({ requestKey: { $in: keys } }).lean();
  const grouped = records.reduce((map, record) => {
    if (!map.has(record.requestKey)) map.set(record.requestKey, []);
    map.get(record.requestKey).push(record);
    return map;
  }, new Map());
  const operations = keys.map((requestKey) => {
    const attempts = grouped.get(requestKey) || [];
    const retrying = attempts.some((record) => record.retryable === true || ['queued', 'sending'].includes(record.ticketStatus));
    const pendingReceipts = attempts.filter((record) => record.ticketStatus === 'accepted' && record.receiptStatus === 'pending').length;
    const clientDelivered = attempts.filter((record) => record.deliveryStatus === 'client_delivered').length;
    const providerDelivered = attempts.filter((record) => ['provider_delivered', 'client_delivered'].includes(record.deliveryStatus)).length;
    const accepted = attempts.filter((record) => record.ticketStatus === 'accepted').length;
    const failed = attempts.filter((record) => record.ticketStatus === 'failed' || record.receiptStatus === 'failed').length;
    const skipped = attempts.filter((record) => record.ticketStatus === 'skipped' || record.receiptStatus === 'skipped').length;
    let status = 'created';
    if (retrying) status = 'retrying';
    else if (pendingReceipts) status = 'provider_accepted';
    else if (providerDelivered) status = clientDelivered ? 'client_delivered' : 'provider_delivered';
    else if (attempts.length && failed > 0) status = 'failed';
    else if (attempts.length && skipped === attempts.length) status = 'skipped';
    const failure = attempts.find((record) => record.providerErrorCode || record.providerErrorMessage);
    const terminal = ['provider_delivered', 'client_delivered', 'skipped', 'failed'].includes(status);
    return {
      updateOne: {
        filter: { requestKey },
        update: {
          $set: {
            status,
            targetedInstallations: attempts.length,
            accepted,
            failed,
            skipped,
            pendingReceipts,
            retryCount: Math.max(0, ...attempts.map((record) => Number(record.sendAttempts || 0) - 1)),
            reasonCode: sanitizeString(failure?.providerErrorCode).slice(0, 200),
            reasonMessage: sanitizeString(failure?.providerErrorMessage).slice(0, 1000),
            ...(terminal ? { completedAt: new Date() } : {})
          },
          ...(!terminal ? { $unset: { completedAt: 1 } } : {})
        }
      }
    };
  });
  if (operations.length) await PushDeliveryRequest.bulkWrite(operations, { ordered: false });
};

const createAndClaimPushAttempts = async (recipientId, notification, devices, requestKey) => {
  const PushDeliveryAttempt = require('../models/PushDeliveryAttempt');
  const targetTokenHashes = devices.map((device) => device.tokenHash || hashPushToken(device.token));
  const notificationId = toId(notification?._id);
  const canReferenceNotification = /^[a-f\d]{24}$/i.test(notificationId);
  const source = getPushSource(notification);
  const operations = devices.map((device) => ({
    updateOne: {
      filter: { requestKey, tokenHash: device.tokenHash || hashPushToken(device.token) },
      update: {
        $setOnInsert: {
          requestKey,
          recipient: recipientId,
          ...(canReferenceNotification ? { notification: notificationId } : {}),
          source,
          notificationType: sanitizeString(notification?.type, 'system').slice(0, 80),
          payload: {
            title: sanitizeString(notification?.title).slice(0, 200),
            body: sanitizeString(notification?.message).slice(0, 2000),
            type: sanitizeString(notification?.type, 'system').slice(0, 80),
            data: buildPushData(notification),
            notificationData: notification?.data || {}
          },
          provider: 'expo',
          tokenHash: device.tokenHash || hashPushToken(device.token),
          tokenPreview: previewPushToken(device.token),
          installationId: sanitizeString(device.installationId).slice(0, 200),
          platform: ['ios', 'android', 'web'].includes(device.platform) ? device.platform : 'unknown',
          appVersion: sanitizeString(device.appVersion).slice(0, 40),
          deviceName: sanitizeString(device.deviceName).slice(0, 120),
          ticketStatus: 'queued',
          receiptStatus: 'pending',
          deliveryStatus: 'queued',
          retryable: true,
          nextSendAt: new Date()
        }
      },
      upsert: true
    }
  }));
  if (operations.length) {
    await PushDeliveryAttempt.bulkWrite(operations, { ordered: false }).catch((error) => {
      if (error?.code !== 11000) throw error;
    });
  }
  const leaseKey = `generic-send-${randomUUID()}`;
  const staleLease = new Date(Date.now() - PROVIDER_LEASE_MS);
  await PushDeliveryAttempt.updateMany(
    {
      requestKey,
      tokenHash: { $in: targetTokenHashes },
      sendAttempts: { $lt: EXPO_GENERIC_SEND_MAX_ATTEMPTS },
      $and: [
        { $or: [
          { ticketStatus: 'queued' },
          { ticketStatus: 'failed', retryable: true },
          { ticketStatus: 'sending', sendLeaseAt: { $lt: staleLease } }
        ] },
        { $or: [{ nextSendAt: null }, { nextSendAt: { $lte: new Date() } }] }
      ]
    },
    {
      $set: {
        ticketStatus: 'sending',
        receiptStatus: 'pending',
        sendLeaseAt: new Date(),
        sendLeaseKey: leaseKey,
        retryable: false,
        providerErrorCode: '',
        providerErrorMessage: ''
      },
      $inc: { sendAttempts: 1 },
      $unset: { providerTicketId: 1, receiptCheckedAt: 1, nextReceiptAt: 1, nextSendAt: 1 }
    }
  );
  const [allRecords, claimed] = await Promise.all([
    PushDeliveryAttempt.find({ requestKey }).lean(),
    PushDeliveryAttempt.find({ requestKey, sendLeaseKey: leaseKey })
  ]);
  return { allRecords, claimed, leaseKey };
};

const markProviderRequestFailure = async (records, leaseKey, error) => {
  if (!records.length) return;
  const PushDeliveryAttempt = require('../models/PushDeliveryAttempt');
  const transient = isRetryableExpoRequestError(error);
  const operations = records.map((record) => {
    const retryable = transient && Number(record.sendAttempts || 0) < EXPO_GENERIC_SEND_MAX_ATTEMPTS;
    const nextSendAt = retryable
      ? new Date(Date.now() + getExpoRetryDelayMs(error, Number(record.sendAttempts || 1)))
      : null;
    return {
      updateOne: {
        filter: { _id: record._id, sendLeaseKey: leaseKey },
        update: {
          $set: {
            ticketStatus: 'failed',
            receiptStatus: 'failed',
            deliveryStatus: 'failed',
            retryable,
            providerErrorCode: sanitizeString(error?.code || String(error?.statusCode || ''), 'ProviderRequestFailed').slice(0, 200),
            providerErrorMessage: sanitizeString(error?.message, 'Expo provider request failed').slice(0, 1000),
            providerResponse: {
              status: 'request_failed',
              code: sanitizeString(error?.code || String(error?.statusCode || '')),
              message: sanitizeString(error?.message)
            },
            ...(nextSendAt ? { nextSendAt } : {}),
            receiptCheckedAt: new Date()
          },
          $unset: {
            sendLeaseAt: 1,
            sendLeaseKey: 1,
            nextReceiptAt: 1,
            ...(nextSendAt ? {} : { nextSendAt: 1 })
          }
        }
      }
    };
  });
  await PushDeliveryAttempt.bulkWrite(operations, { ordered: false });
};

const submitClaimedPushAttempts = async (claimed, devices, notification, unreadCount, leaseKey) => {
  const PushDeliveryAttempt = require('../models/PushDeliveryAttempt');
  const PushDevice = require('../models/PushDevice');
  const { invalidatePushDevicesByHash } = require('../services/pushDeviceService');
  // Revalidate canonical ownership after claiming and immediately before the
  // provider boundary. A logout/account switch can happen between recipient
  // discovery and this point; never send the former user's payload from a
  // stale in-memory token snapshot.
  const claimedTokenHashes = claimed.map((record) => record.tokenHash);
  const claimedRecipients = Array.from(new Set(claimed.map((record) => String(record.recipient))));
  const liveDevices = await PushDevice.find({
    user: { $in: claimedRecipients },
    tokenHash: { $in: claimedTokenHashes },
    status: 'active'
  }).select('+token').lean();
  const deviceByOwnership = new Map(liveDevices.map((device) => [
    `${String(device.user)}:${device.tokenHash}:${device.installationId}`,
    device
  ]));
  const pairs = [];
  const missing = [];
  for (const record of claimed) {
    const device = deviceByOwnership.get(
      `${String(record.recipient)}:${record.tokenHash}:${record.installationId}`
    );
    if (!device?.token) {
      missing.push(record);
      continue;
    }
    try {
      const notificationBase = typeof notification?.toObject === 'function'
        ? notification.toObject()
        : notification;
      const deliveryNotification = {
        ...notificationBase,
        data: {
          ...(notificationBase?.data || {}),
          customData: {
            ...(notificationBase?.data?.customData || {}),
            pushDeliveryAttemptId: String(record._id)
          }
        }
      };
      pairs.push({ record, message: buildExpoMessages([device], deliveryNotification, unreadCount)[0] });
    } catch (error) {
      await markProviderRequestFailure([record], leaseKey, error);
      throw error;
    }
  }
  if (missing.length) {
    await PushDeliveryAttempt.updateMany(
      { _id: { $in: missing.map((record) => record._id) }, sendLeaseKey: leaseKey },
      {
        $set: {
          ticketStatus: 'skipped', receiptStatus: 'skipped', deliveryStatus: 'skipped', retryable: false,
          providerErrorCode: 'InstallationOwnershipChanged',
          providerErrorMessage: 'Push installation ownership changed before provider submission',
          receiptCheckedAt: new Date()
        },
        $unset: { sendLeaseAt: 1, sendLeaseKey: 1, nextReceiptAt: 1 }
      }
    );
  }

  const acceptedIds = [];
  const invalidRecords = [];
  let submitted = 0;
  for (const pairBatch of chunk(pairs, EXPO_MAX_BATCH_SIZE)) {
    let pending = pairBatch;
    for (let round = 1; pending.length && round <= EXPO_GENERIC_INLINE_SEND_ATTEMPTS; round += 1) {
      if (round > 1) {
        await delay(EXPO_GENERIC_RETRY_BASE_MS * (2 ** (round - 2)) + Math.floor(Math.random() * 100));
        await PushDeliveryAttempt.updateMany(
          { _id: { $in: pending.map(({ record }) => record._id) }, sendLeaseKey: leaseKey },
          { $inc: { sendAttempts: 1 } }
        );
      }
      let response;
      try {
        response = await getPushProvider().send(pending.map(({ message }) => message));
        submitted += pending.length;
      } catch (error) {
        if (isRetryableExpoRequestError(error) && round < EXPO_GENERIC_INLINE_SEND_ATTEMPTS) continue;
        await markProviderRequestFailure(
          pending.map(({ record }) => ({
            ...record.toObject(),
            sendAttempts: Number(record.sendAttempts || 0) + round - 1
          })),
          leaseKey,
          error
        );
        pending = [];
        break;
      }
      const tickets = Array.isArray(response?.data) ? response.data : [];
      const retryPairs = [];
      const operations = [];
      for (let index = 0; index < pending.length; index += 1) {
        const pair = pending[index];
        const ticket = tickets[index];
        const effectiveSendAttempts = Number(pair.record.sendAttempts || 0) + round - 1;
        if (ticket?.status === 'ok' && ticket.id) {
          acceptedIds.push(pair.record._id);
          operations.push({
            updateOne: {
              filter: { _id: pair.record._id, sendLeaseKey: leaseKey },
              update: {
                $set: {
                  ticketStatus: 'accepted', receiptStatus: 'pending', deliveryStatus: 'provider_accepted', providerTicketId: ticket.id,
                  sentAt: new Date(), nextReceiptAt: new Date(Date.now() + EXPO_GENERIC_RECEIPT_DELAY_MS),
                  retryable: false, receiptAttempts: 0, providerErrorCode: '', providerErrorMessage: '',
                  providerResponse: { status: 'ok', ticketId: ticket.id }
                },
                $unset: { sendLeaseAt: 1, sendLeaseKey: 1, receiptLeaseAt: 1, receiptLeaseKey: 1, nextSendAt: 1 }
              }
            }
          });
          continue;
        }
        const errorCode = sanitizeString(ticket?.details?.error, ticket ? 'ExpoTicketRejected' : 'ExpoTicketMissing');
        const transient = isTransientExpoError(errorCode) || !ticket;
        if (transient && round < EXPO_GENERIC_INLINE_SEND_ATTEMPTS) {
          retryPairs.push(pair);
          continue;
        }
        if (errorCode === 'DeviceNotRegistered') invalidRecords.push(pair.record);
        const canRetryLater = transient && effectiveSendAttempts < EXPO_GENERIC_SEND_MAX_ATTEMPTS;
        const nextSendAt = canRetryLater
          ? new Date(Date.now() + getExpoRetryDelayMs(null, Math.max(1, effectiveSendAttempts)))
          : null;
        operations.push({
          updateOne: {
            filter: { _id: pair.record._id, sendLeaseKey: leaseKey },
            update: {
              $set: {
                ticketStatus: 'failed', receiptStatus: 'failed', deliveryStatus: 'failed', retryable: canRetryLater,
                ...(nextSendAt ? { nextSendAt } : {}),
                providerErrorCode: errorCode.slice(0, 200),
                providerErrorMessage: sanitizeString(ticket?.message, 'Expo rejected the push ticket').slice(0, 1000),
                providerResponse: {
                  status: sanitizeString(ticket?.status, 'error'),
                  code: errorCode,
                  message: sanitizeString(ticket?.message)
                },
                receiptCheckedAt: new Date()
              },
              $unset: { sendLeaseAt: 1, sendLeaseKey: 1, nextReceiptAt: 1, ...(nextSendAt ? {} : { nextSendAt: 1 }) }
            }
          }
        });
      }
      if (operations.length) await PushDeliveryAttempt.bulkWrite(operations, { ordered: false });
      pending = retryPairs;
    }
  }
  const invalidTokensRemoved = await invalidatePushDevicesByHash(invalidRecords, 'DeviceNotRegistered');
  return { acceptedIds, submitted, invalidTokensRemoved };
};

const terminalizeUnsendablePushRequest = async (requestKey, reasonCode, reasonMessage) => {
  const PushDeliveryAttempt = require('../models/PushDeliveryAttempt');
  await PushDeliveryAttempt.updateMany(
    { requestKey, ticketStatus: { $in: ['queued', 'sending', 'failed'] } },
    {
      $set: {
        ticketStatus: 'skipped', receiptStatus: 'skipped', deliveryStatus: 'skipped', retryable: false,
        providerErrorCode: reasonCode, providerErrorMessage: reasonMessage
      },
      $unset: { sendLeaseAt: 1, sendLeaseKey: 1, nextSendAt: 1, nextReceiptAt: 1 }
    }
  );
  const records = await PushDeliveryAttempt.find({ requestKey }).lean();
  await refreshPushDeliveryRequests([requestKey]);
  await updatePushDeliveryRequest(requestKey, {
    $set: { status: 'skipped', reasonCode, reasonMessage, completedAt: new Date() }
  });
  return records;
};

const sendPushNotification = async (recipientId, notification) => {
  const resolvedRecipientId = toId(recipientId || notification?.recipient);
  if (!resolvedRecipientId || !notification) return { sent: 0, accepted: 0, failed: 0 };

  const requestKey = getPushRequestKey(resolvedRecipientId, notification);
  const PushDeliveryAttempt = require('../models/PushDeliveryAttempt');
  await ensurePushDeliveryRequest(resolvedRecipientId, notification, requestKey);
  const callDeadline = getIncomingCallDeadline(notification);
  if (callDeadline && callDeadline <= new Date()) {
    const records = await terminalizeUnsendablePushRequest(
      requestKey,
      'CALL_EXPIRED',
      'Incoming call stopped ringing before provider submission'
    );
    log.info('Expo call push skipped after deadline', { recipientId: resolvedRecipientId, requestKey: requestKey.slice(0, 16) });
    return summarizePushAttempts(records, requestKey, 0, 0);
  }
  const callData = notification?.data?.customData || {};
  if (
    sanitizeString(callData.eventType).toLowerCase() === 'call_state_update' &&
    sanitizeString(callData.callId)
  ) {
    const CallSession = require('../models/CallSession');
    const session = await CallSession.findOne({ callId: sanitizeString(callData.callId) })
      .select('status').lean();
    const expectedStatus = sanitizeString(callData.status || callData.callStatus).toLowerCase();
    if (!session || !expectedStatus || session.status !== expectedStatus) {
      const records = await terminalizeUnsendablePushRequest(
        requestKey,
        'CALL_STATE_SUPERSEDED',
        'A newer durable call state superseded this reconciliation push'
      );
      return summarizePushAttempts(records, requestKey, 0, 0);
    }
  }
  if (callDeadline && sanitizeString(callData.nativeCallId) && sanitizeString(callData.callId)) {
    const CallSession = require('../models/CallSession');
    const session = await CallSession.findOne({ callId: sanitizeString(callData.callId) })
      .select('status expiresAt').lean();
    if (!session || session.status !== 'ringing' || new Date(session.expiresAt) <= new Date()) {
      const records = await terminalizeUnsendablePushRequest(
        requestKey,
        'CALL_NOT_RINGING',
        'Durable call session is no longer ringing'
      );
      log.info('Expo call push skipped after call state changed', {
        recipientId: resolvedRecipientId,
        requestKey: requestKey.slice(0, 16),
        callStatus: session?.status || 'missing'
      });
      return summarizePushAttempts(records, requestKey, 0, 0);
    }
  }

  const { devices, unreadCount, suppressionReason } = await getRecipientPushState(resolvedRecipientId, notification);
  if (!devices.length) {
    const reasonCode = suppressionReason || 'NO_ACTIVE_INSTALLATION';
    const reasonMessage = {
      RECIPIENT_INACTIVE: 'Recipient is missing or inactive',
      PUSH_DISABLED: 'Recipient disabled push notifications',
      CATEGORY_MUTED: 'Recipient muted this notification category',
      NO_MATCHING_INSTALLATION: 'No active installation matched the requested device filters',
      NO_ACTIVE_INSTALLATION: 'No active push installation is registered for this recipient'
    }[reasonCode] || 'No active push installation remained for delivery';
    const requestedTokenHashes = (Array.isArray(notification?.pushTargetTokenHashes)
      ? notification.pushTargetTokenHashes
      : [])
      .map((value) => sanitizeString(value).toLowerCase())
      .filter((value) => /^[a-f\d]{64}$/.test(value));
    const scopedNoMatch = reasonCode === 'NO_MATCHING_INSTALLATION' && requestedTokenHashes.length > 0;
    const skippedResult = await PushDeliveryAttempt.updateMany(
      {
        requestKey,
        ...(scopedNoMatch ? { tokenHash: { $in: requestedTokenHashes } } : {}),
        ticketStatus: { $in: ['queued', 'sending', 'failed'] }
      },
      {
        $set: {
          ticketStatus: 'skipped', receiptStatus: 'skipped', deliveryStatus: 'skipped', retryable: false,
          providerErrorCode: reasonCode, providerErrorMessage: reasonMessage
        },
        $unset: { sendLeaseAt: 1, sendLeaseKey: 1, nextSendAt: 1, nextReceiptAt: 1 }
      }
    );
    log.info('Expo push skipped before provider submission', {
      recipientId: resolvedRecipientId,
      notificationId: toId(notification._id),
      type: notification?.type || 'system',
      reasonCode
    });
    await refreshPushDeliveryRequests([requestKey]);
    if (!scopedNoMatch) {
      await updatePushDeliveryRequest(requestKey, {
        $set: {
          status: 'skipped', reasonCode,
          reasonMessage, completedAt: new Date()
        }
      });
    }
    return {
      requestKey,
      reasonCode,
      reasonMessage,
      sent: 0,
      submitted: 0,
      accepted: 0,
      failed: 0,
      skipped: Number(skippedResult.modifiedCount || skippedResult.matchedCount || 0)
    };
  }
  await updatePushDeliveryRequest(requestKey, {
    $set: { status: 'submitting', targetedInstallations: devices.length, reasonCode: '', reasonMessage: '' },
    $unset: { completedAt: 1 }
  });
  const { claimed, leaseKey } = await createAndClaimPushAttempts(
    resolvedRecipientId, notification, devices, requestKey
  );
  let outcome = { acceptedIds: [], submitted: 0, invalidTokensRemoved: 0 };
  if (claimed.length) {
    const customData = notification?.data?.customData || {};
    const notificationBase = typeof notification?.toObject === 'function'
      ? notification.toObject()
      : notification;
    const deliveryNotification = {
      ...notificationBase,
      data: {
        ...(notificationBase?.data || {}),
        customData: {
          ...customData,
          pushRequestId: customData.pushRequestId || requestKey,
          pushOptions: {
            ...(customData.pushOptions || {}),
            collapseKey: customData.pushOptions?.collapseKey || `push-${requestKey.slice(0, 40)}`
          }
        }
      }
    };
    try {
      outcome = await submitClaimedPushAttempts(claimed, devices, deliveryNotification, unreadCount, leaseKey);
    } catch (error) {
      await updatePushDeliveryRequest(requestKey, {
        $set: {
          status: 'failed', reasonCode: sanitizeString(error?.code, 'PUSH_SUBMISSION_FAILED').slice(0, 200),
          reasonMessage: sanitizeString(error?.message, 'Push provider submission failed').slice(0, 1000),
          completedAt: new Date()
        }
      });
      throw error;
    }
  }
  if (outcome.acceptedIds.length) {
    try {
      const { enqueuePushReceipts } = require('./jobQueue');
      await enqueuePushReceipts(
        outcome.acceptedIds.map(String),
        new Date(Date.now() + EXPO_GENERIC_RECEIPT_DELAY_MS),
        requestKey.slice(0, 24)
      );
    } catch (error) {
      log.warn('Generic push receipt enqueue failed; recovery scan will retry', {
        requestKey: requestKey.slice(0, 16), error: String(error)
      });
    }
  }
  const records = await PushDeliveryAttempt.find({ requestKey }).lean();
  const retryRecords = records.filter((record) =>
    record.ticketStatus === 'failed' && record.retryable === true &&
    Number(record.sendAttempts || 0) < EXPO_GENERIC_SEND_MAX_ATTEMPTS
  );
  if (retryRecords.length) {
    try {
      const { enqueuePushSend } = require('./jobQueue');
      const runAt = retryRecords.reduce((latest, record) => {
        const value = record.nextSendAt ? new Date(record.nextSendAt) : new Date(Date.now() + EXPO_GENERIC_RETRY_BASE_MS);
        return !latest || value > latest ? value : latest;
      }, null);
      const retryRound = Math.max(...retryRecords.map((record) => Number(record.sendAttempts || 0)));
      await enqueuePushSend(
        retryRecords.map((record) => String(record._id)),
        runAt,
        `${requestKey.slice(0, 20)}-${retryRound}`
      );
    } catch (error) {
      log.warn('Generic push retry enqueue failed; recovery scan will retry', {
        requestKey: requestKey.slice(0, 16), error: String(error)
      });
    }
  }
  const summary = summarizePushAttempts(records, requestKey, outcome.submitted, outcome.invalidTokensRemoved);
  await refreshPushDeliveryRequests([requestKey]);
  await updatePushDeliveryRequest(requestKey, {
    $set: {
      accepted: summary.accepted,
      failed: summary.failed,
      skipped: summary.skipped,
      pendingReceipts: summary.pendingReceipts,
      retryCount: Math.max(0, ...records.map((record) => Number(record.sendAttempts || 0) - 1))
    },
    // Idempotent replays submit zero new tickets; never erase the historical
    // provider submission count recorded by the original attempt.
    $max: { submitted: summary.submitted }
  });
  log.info('Expo push request persisted', {
    recipientId: resolvedRecipientId,
    notificationId: toId(notification._id),
    requestKey: requestKey.slice(0, 16),
    sent: summary.sent,
    accepted: summary.accepted,
    failed: summary.failed,
    pendingReceipts: summary.pendingReceipts
  });
  return summary;
};

const retryPushDeliveryAttempts = async (attemptIds) => {
  const PushDeliveryAttempt = require('../models/PushDeliveryAttempt');
  const ids = Array.from(new Set((attemptIds || []).map(toId).filter(Boolean)));
  const attempts = ids.length ? await PushDeliveryAttempt.find({
    _id: { $in: ids },
    ticketStatus: 'failed',
    retryable: true,
    sendAttempts: { $lt: EXPO_GENERIC_SEND_MAX_ATTEMPTS }
  }).lean() : [];
  const groups = Array.from(attempts.reduce((map, attempt) => {
    if (!map.has(attempt.requestKey)) map.set(attempt.requestKey, []);
    map.get(attempt.requestKey).push(attempt);
    return map;
  }, new Map()).values());
  const results = [];
  for (const group of groups) {
    const attempt = group[0];
    const payload = attempt.payload || {};
    results.push(await sendPushNotification(attempt.recipient, {
      ...(attempt.notification ? { _id: attempt.notification } : {}),
      pushRequestKey: attempt.requestKey,
      pushTargetTokenHashes: group.map((record) => record.tokenHash),
      title: payload.title || 'SquadHunt',
      message: payload.body || 'You have a new notification',
      type: payload.type || attempt.notificationType || 'system',
      data: payload.notificationData || {}
    }));
  }
  return results;
};

const recoverPendingNotificationPushes = async (limit = 200) => {
  const Notification = require('../models/Notification');
  const PushDeliveryAttempt = require('../models/PushDeliveryAttempt');
  const PushDeliveryRequest = require('../models/PushDeliveryRequest');
  const staleLease = new Date(Date.now() - PROVIDER_LEASE_MS);
  const now = new Date();
  const exhaustedResult = await Notification.updateMany(
    {
      pushDeliveryAttempts: { $gte: NOTIFICATION_PUSH_OUTBOX_MAX_ATTEMPTS },
      $or: [
        {
          pushDeliveryState: 'pending',
          $or: [{ pushDeliveryNextAttemptAt: null }, { pushDeliveryNextAttemptAt: { $lte: now } }]
        },
        { pushDeliveryState: 'processing', pushDeliveryLeaseAt: { $lte: staleLease } }
      ]
    },
    {
      $set: {
        pushDeliveryState: 'failed',
        pushDeliveryLastError: 'Notification push outbox exhausted its retry budget'
      },
      $unset: { pushDeliveryLeaseAt: 1, pushDeliveryLeaseKey: 1, pushDeliveryNextAttemptAt: 1 }
    }
  );
  if (Number(exhaustedResult.modifiedCount || 0) > 0) {
    log.error('Notification push outbox retry budget exhausted', {
      count: Number(exhaustedResult.modifiedCount || 0)
    });
  }
  const candidates = await Notification.find({
    pushDeliveryAttempts: { $lt: NOTIFICATION_PUSH_OUTBOX_MAX_ATTEMPTS },
    $or: [
      {
        pushDeliveryState: 'pending',
        $or: [{ pushDeliveryNextAttemptAt: null }, { pushDeliveryNextAttemptAt: { $lte: now } }]
      },
      { pushDeliveryState: 'processing', pushDeliveryLeaseAt: { $lte: staleLease } }
    ]
  }).select('_id').sort({ pushDeliveryNextAttemptAt: 1, createdAt: 1 }).limit(Math.max(1, Math.min(1000, limit))).lean();

  let completed = 0;
  let retried = 0;
  let failed = Number(exhaustedResult.modifiedCount || 0);
  for (const candidate of candidates) {
    const leaseKey = `notification-outbox-${randomUUID()}`;
    const notification = await Notification.findOneAndUpdate(
      {
        _id: candidate._id,
        pushDeliveryAttempts: { $lt: NOTIFICATION_PUSH_OUTBOX_MAX_ATTEMPTS },
        $or: [
          {
            pushDeliveryState: 'pending',
            $or: [{ pushDeliveryNextAttemptAt: null }, { pushDeliveryNextAttemptAt: { $lte: new Date() } }]
          },
          { pushDeliveryState: 'processing', pushDeliveryLeaseAt: { $lte: staleLease } }
        ]
      },
      {
        $set: { pushDeliveryState: 'processing', pushDeliveryLeaseAt: new Date(), pushDeliveryLeaseKey: leaseKey },
        $inc: { pushDeliveryAttempts: 1 },
        $unset: { pushDeliveryNextAttemptAt: 1 }
      },
      { new: true }
    ).select('+pushDeliveryAttempts +pushDeliveryLeaseKey');
    if (!notification) continue;
    try {
      const requestKey = getPushRequestKey(notification.recipient, notification);
      const [existingAttempt, existingRequest] = await Promise.all([
        PushDeliveryAttempt.exists({ requestKey }),
        PushDeliveryRequest.findOne({ requestKey }).select('status').lean()
      ]);
      // Once a token-scoped attempt exists, its send/receipt leases are the
      // sole recovery authority. Re-entering sendPushNotification from the
      // notification outbox after an ambiguous provider submission could send
      // a duplicate. A terminal no-device/request outcome is likewise done.
      if (existingAttempt || (existingRequest && [
        'provider_accepted', 'provider_delivered', 'client_delivered',
        'failed', 'skipped'
      ].includes(existingRequest.status))) {
        await Notification.updateOne(
          { _id: notification._id, pushDeliveryLeaseKey: leaseKey },
          {
            $set: { pushDeliveryState: 'completed', pushDeliveryCompletedAt: new Date(), pushDeliveryLastError: '' },
            $unset: { pushDeliveryLeaseAt: 1, pushDeliveryLeaseKey: 1, pushDeliveryNextAttemptAt: 1 }
          }
        );
        completed += 1;
        continue;
      }
      await sendPushNotification(notification.recipient, notification);
      await Notification.updateOne(
        { _id: notification._id, pushDeliveryLeaseKey: leaseKey },
        {
          $set: { pushDeliveryState: 'completed', pushDeliveryCompletedAt: new Date(), pushDeliveryLastError: '' },
          $unset: { pushDeliveryLeaseAt: 1, pushDeliveryLeaseKey: 1, pushDeliveryNextAttemptAt: 1 }
        }
      );
      completed += 1;
    } catch (error) {
      const exhausted = Number(notification.pushDeliveryAttempts || 0) >= NOTIFICATION_PUSH_OUTBOX_MAX_ATTEMPTS;
      const retryAt = new Date(Date.now() + Math.min(60 * 60 * 1000, 10000 * (2 ** Math.max(0, Number(notification.pushDeliveryAttempts || 1) - 1))));
      await Notification.updateOne(
        { _id: notification._id, pushDeliveryLeaseKey: leaseKey },
        {
          $set: {
            pushDeliveryState: exhausted ? 'failed' : 'pending',
            pushDeliveryLastError: String(error?.message || error).slice(0, 1000),
            ...(exhausted ? {} : { pushDeliveryNextAttemptAt: retryAt })
          },
          $unset: {
            pushDeliveryLeaseAt: 1,
            pushDeliveryLeaseKey: 1,
            ...(exhausted ? { pushDeliveryNextAttemptAt: 1 } : {})
          }
        }
      );
      if (exhausted) failed += 1; else retried += 1;
    }
  }
  return { scanned: candidates.length, completed, retried, failed };
};

// Repairs the only safe request-level crash gap: a logical request was
// persisted but the process exited before any device attempt was inserted.
// Requests with an existing attempt are left to the token-scoped lease/receipt
// recovery so an ambiguous provider submission is never duplicated here.
const recoverInterruptedPushRequests = async (limit = 200) => {
  const PushDeliveryRequest = require('../models/PushDeliveryRequest');
  const PushDeliveryAttempt = require('../models/PushDeliveryAttempt');
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
  const exhaustedCandidates = await PushDeliveryRequest.find({
    provider: 'expo',
    status: { $in: ['created', 'submitting', 'retrying'] },
    lastAttemptAt: { $lte: staleBefore },
    recoveryAttempts: { $gte: PUSH_REQUEST_RECOVERY_MAX_ATTEMPTS }
  }).select('_id requestKey').limit(Math.max(1, Math.min(1000, limit))).lean();
  for (const candidate of exhaustedCandidates) {
    if (await PushDeliveryAttempt.exists({ requestKey: candidate.requestKey })) {
      await refreshPushDeliveryRequests([candidate.requestKey]);
      continue;
    }
    await PushDeliveryRequest.updateOne(
      {
        _id: candidate._id,
        recoveryAttempts: { $gte: PUSH_REQUEST_RECOVERY_MAX_ATTEMPTS },
        status: { $in: ['created', 'submitting', 'retrying'] },
        lastAttemptAt: { $lte: staleBefore }
      },
      {
        $set: {
          status: 'failed',
          reasonCode: 'REQUEST_RECOVERY_EXHAUSTED',
          reasonMessage: 'Push request recovery exhausted before a device attempt was persisted',
          completedAt: new Date()
        }
      }
    );
    log.error('Push request recovery budget exhausted before attempt persistence', {
      requestKey: String(candidate.requestKey).slice(0, 16)
    });
  }
  const candidates = await PushDeliveryRequest.find({
    provider: 'expo',
    status: { $in: ['created', 'submitting', 'retrying'] },
    lastAttemptAt: { $lte: staleBefore },
    recoveryAttempts: { $lt: PUSH_REQUEST_RECOVERY_MAX_ATTEMPTS }
  }).select('_id requestKey').sort({ lastAttemptAt: 1 }).limit(Math.max(1, Math.min(1000, limit))).lean();
  const results = [];
  for (const candidate of candidates) {
    const hasAttempt = await PushDeliveryAttempt.exists({ requestKey: candidate.requestKey });
    if (hasAttempt) {
      await refreshPushDeliveryRequests([candidate.requestKey]);
      continue;
    }
    const request = await PushDeliveryRequest.findOneAndUpdate(
      {
        _id: candidate._id,
        lastAttemptAt: { $lte: staleBefore },
        recoveryAttempts: { $lt: PUSH_REQUEST_RECOVERY_MAX_ATTEMPTS }
      },
      {
        $set: { status: 'retrying', lastAttemptAt: new Date() },
        $inc: { recoveryAttempts: 1 },
        $unset: { completedAt: 1 }
      },
      { new: true }
    ).lean();
    if (!request) continue;
    const payload = request.payload || {};
    try {
      results.push(await sendPushNotification(request.recipient, {
        ...(request.notification ? { _id: request.notification } : {}),
        pushRequestKey: request.requestKey,
        title: payload.title || 'SquadHunt',
        message: payload.body || 'You have a new notification',
        type: payload.type || request.notificationType || 'system',
        data: payload.notificationData || { customData: payload.data || {} }
      }));
    } catch (error) {
      const exhausted = Number(request.recoveryAttempts || 0) >= PUSH_REQUEST_RECOVERY_MAX_ATTEMPTS;
      await PushDeliveryRequest.updateOne(
        { _id: request._id },
        {
          $set: {
            status: exhausted ? 'failed' : 'retrying',
            reasonCode: sanitizeString(error?.code, 'REQUEST_RECOVERY_FAILED').slice(0, 200),
            reasonMessage: sanitizeString(error?.message, 'Push request recovery failed').slice(0, 1000),
            lastAttemptAt: new Date(),
            ...(exhausted ? { completedAt: new Date() } : {})
          }
        }
      );
    }
  }
  return results;
};

const reconcilePushDeliveryReceipts = async (recordIds, processingKey) => {
  const PushDeliveryAttempt = require('../models/PushDeliveryAttempt');
  const { invalidatePushDevicesByHash, recordPushDeviceOutcome } = require('../services/pushDeviceService');
  const ids = Array.from(new Set((recordIds || []).map(toId).filter(Boolean)));
  if (!ids.length) return { pendingRecordIds: [], delivered: 0, failed: 0 };
  const leaseKey = sanitizeString(processingKey, `generic-receipt-${randomUUID()}`).slice(0, 250);
  const staleLease = new Date(Date.now() - PROVIDER_LEASE_MS);

  const exhausted = await PushDeliveryAttempt.find({
    _id: { $in: ids }, ticketStatus: 'accepted', receiptStatus: 'pending',
    receiptAttempts: { $gte: EXPO_GENERIC_RECEIPT_MAX_ATTEMPTS },
    $or: [{ receiptLeaseAt: null }, { receiptLeaseAt: { $lt: staleLease } }]
  }).lean();
  if (exhausted.length) {
    await PushDeliveryAttempt.updateMany(
      { _id: { $in: exhausted.map((record) => record._id) }, receiptStatus: 'pending' },
      {
        $set: {
          receiptStatus: 'failed', receiptCheckedAt: new Date(), retryable: false,
          providerErrorCode: 'ReceiptRetryExhausted',
          providerErrorMessage: 'Expo receipt reconciliation exhausted its retry budget'
        },
        $unset: { receiptLeaseAt: 1, receiptLeaseKey: 1, nextReceiptAt: 1 }
      }
    );
  }
  await PushDeliveryAttempt.updateMany(
    {
      _id: { $in: ids }, ticketStatus: 'accepted', receiptStatus: 'pending',
      receiptAttempts: { $lt: EXPO_GENERIC_RECEIPT_MAX_ATTEMPTS },
      $or: [{ receiptLeaseAt: null }, { receiptLeaseAt: { $lt: staleLease } }, { receiptLeaseKey: leaseKey }]
    },
    { $set: { receiptLeaseAt: new Date(), receiptLeaseKey: leaseKey }, $inc: { receiptAttempts: 1 } }
  );
  const claimed = await PushDeliveryAttempt.find({ _id: { $in: ids }, receiptLeaseKey: leaseKey, receiptStatus: 'pending' });
  const invalid = [];
  const delivered = [];
  const failed = [...exhausted];
  const resend = [];

  for (const batch of chunk(claimed, EXPO_MAX_RECEIPT_BATCH_SIZE)) {
    let receiptMap;
    try {
      const payload = await getPushProvider().getReceipts(batch.map((record) => record.providerTicketId));
      receiptMap = payload?.data || {};
    } catch (error) {
      const operations = batch.map((record) => {
        const terminal = record.receiptAttempts >= EXPO_GENERIC_RECEIPT_MAX_ATTEMPTS;
        const retryDelay = Math.min(60 * 60 * 1000, 30000 * (2 ** Math.max(0, record.receiptAttempts - 1)));
        if (terminal) failed.push(record);
        return {
          updateOne: {
            filter: { _id: record._id, receiptLeaseKey: leaseKey, receiptStatus: 'pending' },
            update: {
              $set: {
                receiptStatus: terminal ? 'failed' : 'pending',
                receiptCheckedAt: new Date(),
                ...(terminal ? {} : { nextReceiptAt: new Date(Date.now() + retryDelay) }),
                providerErrorCode: sanitizeString(error?.code, 'ReceiptProviderUnavailable').slice(0, 200),
                providerErrorMessage: sanitizeString(error?.message, 'Expo receipt provider unavailable').slice(0, 1000)
              },
              $unset: { receiptLeaseAt: 1, receiptLeaseKey: 1, ...(terminal ? { nextReceiptAt: 1 } : {}) }
            }
          }
        };
      });
      if (operations.length) await PushDeliveryAttempt.bulkWrite(operations, { ordered: false });
      continue;
    }

    const operations = [];
    for (const record of batch) {
      const receipt = receiptMap[record.providerTicketId];
      if (receipt?.status === 'ok') {
        delivered.push(record);
        operations.push({
          updateOne: {
            filter: { _id: record._id, receiptLeaseKey: leaseKey, receiptStatus: 'pending' },
            update: [
              {
                $set: {
                  receiptStatus: 'delivered',
                  deliveryStatus: {
                    $cond: [
                      { $ne: [{ $ifNull: ['$clientDeliveredAt', null] }, null] },
                      'client_delivered',
                      'provider_delivered'
                    ]
                  },
                  receiptCheckedAt: new Date(), providerDeliveredAt: new Date(),
                  providerErrorCode: '', providerErrorMessage: '',
                  providerResponse: { status: 'ok' }
                }
              },
              { $unset: ['receiptLeaseAt', 'receiptLeaseKey', 'nextReceiptAt'] }
            ]
          }
        });
        continue;
      }
      const errorCode = sanitizeString(receipt?.details?.error);
      const transientReceiptError = Boolean(receipt) && isTransientExpoError(errorCode);
      const canResend = transientReceiptError && !record.clientDeliveredAt &&
        Number(record.sendAttempts || 0) < EXPO_GENERIC_SEND_MAX_ATTEMPTS;
      const terminalError = Boolean(receipt) && !transientReceiptError;
      const terminal = terminalError || (transientReceiptError && !canResend) ||
        (!receipt && record.receiptAttempts >= EXPO_GENERIC_RECEIPT_MAX_ATTEMPTS);
      const nextSendAt = canResend
        ? new Date(Date.now() + getExpoRetryDelayMs(null, Number(record.sendAttempts || 1)))
        : null;
      const retryDelay = Math.min(60 * 60 * 1000, 30000 * (2 ** Math.max(0, record.receiptAttempts - 1)));
      if (terminal) failed.push(record);
      if (canResend) resend.push({ ...record.toObject(), nextSendAt });
      if (errorCode === 'DeviceNotRegistered') invalid.push(record);
      operations.push({
        updateOne: {
          filter: { _id: record._id, receiptLeaseKey: leaseKey, receiptStatus: 'pending' },
          update: {
            $set: {
              ticketStatus: canResend ? 'failed' : record.ticketStatus,
              receiptStatus: terminal || canResend ? 'failed' : 'pending',
              deliveryStatus: canResend ? 'failed' : record.deliveryStatus,
              retryable: canResend,
              receiptCheckedAt: new Date(),
              ...(canResend
                ? { nextSendAt }
                : terminal ? {} : { nextReceiptAt: new Date(Date.now() + retryDelay) }),
              providerErrorCode: (errorCode || (receipt ? 'ReceiptRejected' : 'ReceiptUnavailable')).slice(0, 200),
              providerErrorMessage: sanitizeString(receipt?.message, receipt ? 'Expo receipt failed' : 'Expo receipt is not available yet').slice(0, 1000),
              providerResponse: receipt ? {
                status: sanitizeString(receipt.status, 'error'),
                code: errorCode,
                message: sanitizeString(receipt.message)
              } : { status: 'unavailable' }
            },
            $unset: {
              receiptLeaseAt: 1,
              receiptLeaseKey: 1,
              ...(terminal || canResend ? { nextReceiptAt: 1 } : {}),
              ...(canResend ? { providerTicketId: 1 } : {})
            }
          }
        }
      });
    }
    if (operations.length) await PushDeliveryAttempt.bulkWrite(operations, { ordered: false });
  }
  await Promise.all([
    invalidatePushDevicesByHash(invalid, 'DeviceNotRegistered'),
    recordPushDeviceOutcome(delivered, true),
    recordPushDeviceOutcome(failed, false)
  ]);
  if (failed.length) {
    await PushDeliveryAttempt.updateMany(
      { _id: { $in: failed.map((record) => record._id) }, clientDeliveredAt: null },
      { $set: { deliveryStatus: 'failed' } }
    );
  }
  await refreshPushDeliveryRequests(Array.from(new Set([...claimed, ...exhausted].map((record) => record.requestKey))));
  const pending = await PushDeliveryAttempt.find({ _id: { $in: ids }, receiptStatus: 'pending' })
    .select('_id nextReceiptAt').lean();
  const nextRunAt = pending.reduce((latest, record) => {
    const value = record.nextReceiptAt ? new Date(record.nextReceiptAt) : new Date(Date.now() + 30000);
    return !latest || value > latest ? value : latest;
  }, null);
  const nextSendAt = resend.reduce((latest, record) =>
    !latest || record.nextSendAt > latest ? record.nextSendAt : latest, null);
  return {
    pendingRecordIds: pending.map((record) => String(record._id)),
    retryRecordIds: resend.map((record) => String(record._id)),
    nextRunAt,
    nextSendAt,
    delivered: delivered.length,
    failed: failed.length
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
    const invalidRecords = [];
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
      if (errorCode === 'DeviceNotRegistered') {
        invalidRecords.push({ recipient: item.entry.recipientId, tokenHash: item.tokenHash });
      }
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
    if (invalidRecords.length) await removeInvalidHashedTokens(invalidRecords);
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
  const { invalidatePushDevicesByHash } = require('../services/pushDeviceService');
  return invalidatePushDevicesByHash(records, 'DeviceNotRegistered');
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
  retryPushDeliveryAttempts,
  recoverPendingNotificationPushes,
  recoverInterruptedPushRequests,
  sendBulkPushNotification,
  sendBroadcastPushBatch,
  reconcilePushDeliveryReceipts,
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
  shouldSendPushNotification,
  getPushRequestKey,
  isRetryableExpoRequestError,
  getExpoRetryDelayMs,
  refreshPushDeliveryRequests
};
