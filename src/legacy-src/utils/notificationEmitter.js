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

const sendExpoPushNotifications = async (userId, notification) => {
  try {
    const User = require('../models/User');
    const user = await User.findById(userId).select('pushTokens').lean();
    const tokens = Array.from(new Set((user?.pushTokens || []).map((entry) => entry.token).filter(Boolean)));
    if (tokens.length === 0) return;

    const messages = tokens.map((token) => ({
      to: token,
      sound: 'default',
      title: notification.title || 'SquadHunt',
      body: notification.message || '',
      data: {
        notificationId: String(notification._id || ''),
        type: notification.type,
        postId: notification.data?.postId ? String(notification.data.postId) : undefined,
        tournamentId: notification.data?.tournamentId ? String(notification.data.tournamentId) : undefined,
        chatId: notification.data?.chatId ? String(notification.data.chatId) : undefined,
        userId: notification.sender ? String(notification.sender) : undefined
      },
      channelId: 'default',
      priority: 'high'
    }));

    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(messages)
    });
  } catch (error) {
    const log = require('./logger');
    log.error('Expo push notification error', { error: String(error) });
  }
};

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
      return 'messages';
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
  if (!preferenceKey) return true;

  const User = require('../models/User');
  const user = await User.findById(notificationData.recipient).select('notificationSettings').lean();
  const settings = { ...NOTIFICATION_SETTING_DEFAULTS, ...(user?.notificationSettings || {}) };
  return settings[preferenceKey] !== false;
};

const createAndEmitNotification = async (notificationData) => {
  try {
    const allowed = await shouldDeliverNotification(notificationData).catch(() => true);
    if (!allowed) return null;

    const Notification = require('../models/Notification');
    const notification = await Notification.createNotification(notificationData);
    
    // Emit real-time notification
    emitNotification(notification.recipient, notification);
    sendExpoPushNotifications(notification.recipient, notification).catch(() => {});
    
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
  emitNotificationToMultiple,
  createAndEmitNotification
};
