const https = require('https');
const log = require('./logger');

const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_PUSH_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const EXPO_PUSH_TOKEN_PATTERN = /^ExponentPushToken\[[\w-]+\]$|^ExpoPushToken\[[\w-]+\]$/;
const EXPO_MAX_BATCH_SIZE = 100;
const EXPO_MAX_RECEIPT_BATCH_SIZE = 300;
const EXPO_RECEIPT_DELAY_MS = Number(process.env.EXPO_PUSH_RECEIPT_DELAY_MS || 2000);

const NOTIFICATION_SETTING_DEFAULTS = {
  likes: true,
  comments: true,
  follows: true,
  messages: true,
  tournamentUpdates: true,
  scrimUpdates: true,
  recruitmentApps: true,
  systemAlerts: true
};

const getChannelIdForNotification = (notification) => {
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
  return settings[preferenceKey] !== false;
};

const buildRouteFromNotification = (notification) => {
  const data = notification?.data || {};
  const customData = data.customData || {};
  const explicitUrl = sanitizeString(customData.url || customData.deepLink || data.url || data.deepLink);
  if (explicitUrl.startsWith('/')) return explicitUrl;

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

  return {
    url: route,
    route,
    notificationId: toId(notification?._id),
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

const postJson = async (url, body) => {
  if (typeof fetch === 'function') {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
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
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
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
    req.on('error', reject);
    req.write(requestBody);
    req.end();
  });
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
      token,
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
      payload = await postJson(EXPO_PUSH_RECEIPTS_URL, { ids });
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
        token: receiptRequest.token,
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
  const [user, unreadCount, allowed] = await Promise.all([
    User.findById(recipientId).select('pushTokens notificationSettings').lean(),
    Notification.countDocuments({ recipient: recipientId, isRead: false }).catch(() => 0),
    shouldSendPushNotification(recipientId, notification).catch(() => true)
  ]);

  if (!allowed) return { tokens: [], unreadCount };
  const tokens = Array.from(new Set(
    (user?.pushTokens || [])
      .map((entry) => entry?.token)
      .filter((token) => typeof token === 'string' && EXPO_PUSH_TOKEN_PATTERN.test(token))
  ));
  return { tokens, unreadCount };
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

  const title = sanitizeString(notification.title, 'SquadHunt');
  const body = sanitizeString(notification.message, 'You have a new notification');
  const data = buildPushData(notification);
  const image = sanitizeString(notification?.data?.image || notification?.data?.customData?.image);
  const channelId = getChannelIdForNotification(notification);

  const messages = tokens.map((token) => ({
    to: token,
    title,
    body,
    sound: 'default',
    priority: 'high',
    channelId,
    badge: unreadCount,
    ttl: 2419200,
    expiration: Math.floor(Date.now() / 1000) + 2419200,
    data,
    ...(image ? { richContent: { image } } : {})
  }));

  let accepted = 0;
  let failed = 0;
  let invalidTokensRemoved = 0;
  let receiptOk = 0;
  let receiptFailed = 0;
  let receiptUnavailable = 0;
  let receiptInvalidTokensRemoved = 0;

  for (const batch of chunk(messages, EXPO_MAX_BATCH_SIZE)) {
    const response = await postJson(EXPO_PUSH_SEND_URL, batch);
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
  buildPushData,
  shouldSendPushNotification
};
