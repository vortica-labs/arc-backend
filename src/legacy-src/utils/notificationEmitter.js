const log = require('./logger');
const { randomUUID } = require('crypto');
const { evaluateNotificationEmailPolicy } = require('./notificationChannelPolicy');

let io;

const setIoInstance = (ioInstance) => {
  io = ioInstance;
};

const emitNotification = (userId, notification) => {
  if (io) {
    io.to(`user-${userId}`).emit('new-notification', notification);
  }
};

const emitBroadcastNotification = (userId, notification) => {
  if (io) {
    io.to(`user-${userId}`).emit('broadcast-notification', notification);
  }
};

// Push-only Web broadcasts use a separate ephemeral event so they can invoke
// the browser Notification API without creating an inbox row. The payload
// carries targetPlatforms/targetAppVersions for installation-side suppression.
const emitBroadcastPushNotification = (userId, notification) => {
  if (!io) return false;
  const room = `user-${userId}`;
  // Emit through the configured Socket.IO adapter without consulting the
  // process-local room map. Cross-node delivery is acknowledged by the Web
  // client; a missing ACK expires durably in the broadcast recovery worker.
  io.to(room).emit('broadcast-push-notification', notification);
  return true;
};

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

// Mongoose's Notification.data schema is intentionally narrow. Legacy
// producers still pass event-specific fields (applicationId, teamId, round,
// status, etc.) at data's top level; without normalization Mongoose silently
// drops them and the resulting push cannot deep-link or hydrate its event.
const PERSISTED_NOTIFICATION_DATA_KEYS = new Set([
  'postId',
  'messageId',
  'tournamentId',
  'broadcastId',
  'deliveryLogId',
  'deepLink',
  'deliveryType',
  'channels',
  'targetPlatforms',
  'targetAppVersions',
  'bannerImage',
  'thumbnail',
  'cta'
]);

const normalizeNotificationPayload = (notificationData = {}) => {
  const rawData = notificationData?.data && typeof notificationData.data === 'object'
    ? notificationData.data
    : {};
  const normalizedData = {};
  const customData = rawData.customData && typeof rawData.customData === 'object' && !Array.isArray(rawData.customData)
    ? { ...rawData.customData }
    : {};

  Object.entries(rawData).forEach(([key, value]) => {
    if (key === 'customData') return;
    if (PERSISTED_NOTIFICATION_DATA_KEYS.has(key)) normalizedData[key] = value;
    else customData[key] = value;
  });
  if (Object.keys(customData).length > 0) normalizedData.customData = customData;

  return { ...notificationData, data: normalizedData };
};

const getPreferenceKeyForNotification = (notificationData) => {
  switch (notificationData?.type) {
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
      return notificationData?.data?.customData?.scrimId || notificationData?.data?.customData?.scrimCode
        ? 'scrimUpdates'
        : 'tournamentUpdates';
    case 'system':
    case 'achievement':
      return 'systemAlerts';
    default:
      return null;
  }
};

const resolveNotificationChannels = (notificationData, notificationSettings = {}) => {
  const preferenceKey = getPreferenceKeyForNotification(notificationData);
  const settings = { ...NOTIFICATION_SETTING_DEFAULTS, ...(notificationSettings || {}) };
  const categoryAllowed = !preferenceKey || settings[preferenceKey] !== false;
  return {
    preferenceKey,
    categoryAllowed,
    inApp: notificationData?.sendInApp !== false && settings.inAppEnabled !== false && categoryAllowed,
    push: notificationData?.sendPush !== false && settings.pushEnabled !== false && categoryAllowed
  };
};

const getRecipientDeliveryContext = async (notificationData) => {
  const User = require('../models/User');
  const user = await User.findById(notificationData.recipient)
    .select('email notificationSettings isActive')
    .lean();
  if (!user || user.isActive === false) {
    return {
      user,
      channels: { preferenceKey: getPreferenceKeyForNotification(notificationData), categoryAllowed: false, inApp: false, push: false }
    };
  }
  return {
    user,
    channels: resolveNotificationChannels(notificationData, user?.notificationSettings)
  };
};

const createAndEmitNotification = async (notificationData) => {
  try {
    const normalizedNotificationData = normalizeNotificationPayload(notificationData);
    // Preference lookup is a delivery precondition. Failing open here would
    // bypass an explicit opt-out whenever the user lookup has a transient
    // failure, so surface the error to the producer instead.
    const delivery = await getRecipientDeliveryContext(normalizedNotificationData);
    const { user, channels } = delivery;
    const emailPolicy = evaluateNotificationEmailPolicy(normalizedNotificationData);
    let notification = null;

    if (channels.inApp || channels.push) {
      const Notification = require('../models/Notification');
      const dedupeKey = String(normalizedNotificationData?.data?.customData?.notificationDedupeKey || '').trim().slice(0, 250);
      if (dedupeKey) {
        notification = await Notification.findOne({
          recipient: normalizedNotificationData.recipient,
          'data.customData.notificationDedupeKey': dedupeKey
        });
      }
      let created = false;
      if (!notification) {
        try {
          notification = await Notification.createNotification({
            ...normalizedNotificationData,
            sendPush: false,
            pushDeliveryState: channels.push ? 'pending' : 'not_requested',
            ...(!channels.inApp ? {
              isRead: true,
              readAt: new Date(),
              archivedAt: new Date(),
              deletedAt: new Date()
            } : {})
          });
          created = true;
        } catch (error) {
          if (dedupeKey && error?.code === 11000) {
            notification = await Notification.findOne({
              recipient: normalizedNotificationData.recipient,
              'data.customData.notificationDedupeKey': dedupeKey
            });
          } else {
            throw error;
          }
        }
      }
      if (created && notification && channels.inApp) emitNotification(notification.recipient, notification);
    }

    if (channels.push) {
      const leaseKey = `notification-outbox-${randomUUID()}`;
      try {
        const { sendPushNotification } = require('./pushNotificationService');
        let deliveryNotification = normalizedNotificationData;
        if (notification) {
          const Notification = require('../models/Notification');
          deliveryNotification = await Notification.claimPushDelivery(notification._id, leaseKey);
        }
        if (deliveryNotification) {
          await sendPushNotification(
            normalizedNotificationData.recipient,
            deliveryNotification
          );
          if (notification) {
            const Notification = require('../models/Notification');
            await Notification.completePushDelivery(notification._id, leaseKey);
          }
        }
      } catch (pushError) {
        if (notification) {
          const Notification = require('../models/Notification');
          await Notification.retryPushDelivery(notification._id, leaseKey, pushError).catch(() => undefined);
        }
        log.error('Push notification delivery failed', { error: String(pushError) });
      }
    }

    // Email is opt-in and independently policy-gated. Routine engagement
    // notifications are structurally blocked before reaching the queue.
    if (emailPolicy.allowed && user?.email && process.env.SMTP_USER && process.env.SMTP_PASS) {
      try {
        const { enqueueEmail } = require('./jobQueue');
        const link = process.env.CLIENT_URL ? `${process.env.CLIENT_URL}/notifications` : '';
        await enqueueEmail(
          user.email,
          notificationData.title,
          notificationData.message,
          link,
          {
            intent: emailPolicy.intent,
            eventType: normalizedNotificationData.email?.eventType || normalizedNotificationData.emailEventType,
            notificationType: normalizedNotificationData.type,
            broadcastId: normalizedNotificationData.data?.broadcastId || normalizedNotificationData.data?.customData?.broadcastId,
            broadcastRecipientId: normalizedNotificationData.data?.deliveryLogId || normalizedNotificationData.data?.customData?.broadcastRecipientId
          }
        );
      } catch (emailError) {
        log.error('Notification email enqueue failed', { error: String(emailError), intent: emailPolicy.intent });
      }
    }
    
    return notification || (channels.push ? normalizedNotificationData : null);
  } catch (error) {
    log.error('Notification emit error', { error: String(error) });
    throw error;
  }
};

/**
 * Emit notifications to multiple users via socket.
 * @param {string[]} userIds
 * @param {object} notification
 */
const emitNotificationToMultiple = (userIds, notification) => {
  if (!io || !Array.isArray(userIds)) return;
  for (const userId of userIds) {
    io.to(`user-${userId}`).emit('new-notification', notification);
  }
};

module.exports = {
  setIoInstance,
  emitNotification,
  emitBroadcastNotification,
  emitBroadcastPushNotification,
  emitNotificationToMultiple,
  createAndEmitNotification,
  getPreferenceKeyForNotification,
  resolveNotificationChannels,
  getRecipientDeliveryContext,
  normalizeNotificationPayload
};
