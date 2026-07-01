const log = require('./logger');

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

const shouldDeliverNotification = async (notificationData) => {
  const preferenceKey = getPreferenceKeyForNotification(notificationData);
  const User = require('../models/User');
  const user = await User.findById(notificationData.recipient).select('notificationSettings').lean();
  const settings = { ...NOTIFICATION_SETTING_DEFAULTS, ...(user?.notificationSettings || {}) };
  return settings.inAppEnabled !== false && (!preferenceKey || settings[preferenceKey] !== false);
};

const createAndEmitNotification = async (notificationData) => {
  try {
    const allowed = await shouldDeliverNotification(notificationData).catch(() => true);
    if (!allowed) return null;

    const Notification = require('../models/Notification');
    const notification = await Notification.createNotification(notificationData);
    
    // Emit real-time notification
    emitNotification(notification.recipient, notification);
    
    // Send email via background job queue (non-blocking)
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      const { enqueueEmail } = require('./jobQueue');
      const User = require('../models/User');
      User.findById(notificationData.recipient).select('email').lean().then((recipient) => {
        if (recipient?.email) {
          const link = process.env.CLIENT_URL ? `${process.env.CLIENT_URL}/notifications` : '';
          enqueueEmail(recipient.email, notificationData.title, notificationData.message, link).catch(() => {});
        }
      }).catch(() => {});
    }
    
    return notification;
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
  createAndEmitNotification
};
