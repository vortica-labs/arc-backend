const { createAndEmitNotification } = require('./notificationEmitter');
const log = require('./logger');

// Create like notification
const createLikeNotification = async (recipientId, senderId, postId) => {
  try {
    const sender = await require('../models/User').findById(senderId).select('username profile.displayName profile.avatar');
    const post = await require('../models/Post').findById(postId).select('content.text');
    
    const notificationData = {
      recipient: recipientId,
      sender: senderId,
      type: 'like',
      title: 'New Like',
      message: `${sender.username} liked your post${post?.content?.text ? `: "${post.content.text.substring(0, 50)}${post.content.text.length > 50 ? '...' : ''}"` : ''}`,
      data: {
        postId: postId
      }
    };

    return await createAndEmitNotification(notificationData);
  } catch (error) {
    log.error('Error creating notification', { error: String(error) });
    throw error;
  }
};

// Create comment notification
const createCommentNotification = async (recipientId, senderId, postId, commentText) => {
  try {
    const sender = await require('../models/User').findById(senderId).select('username profile.displayName profile.avatar');
    const post = await require('../models/Post').findById(postId).select('content.text');
    
    const notificationData = {
      recipient: recipientId,
      sender: senderId,
      type: 'comment',
      title: 'New Comment',
      message: `${sender.username} commented on your post${post?.content?.text ? `: "${post.content.text.substring(0, 50)}${post.content.text.length > 50 ? '...' : ''}"` : ''}`,
      data: {
        postId: postId
      }
    };

    return await createAndEmitNotification(notificationData);
  } catch (error) {
    log.error('Notification error', { error: String(error) });
    throw error;
  }
};

// Create follow notification
const createFollowNotification = async (recipientId, senderId) => {
  try {
    const sender = await require('../models/User').findById(senderId).select('username profile.displayName profile.avatar');
    
    const notificationData = {
      recipient: recipientId,
      sender: senderId,
      type: 'follow',
      title: 'New Follower',
      message: `${sender.username} started following you`,
      data: {}
    };

    return await createAndEmitNotification(notificationData);
  } catch (error) {
    log.error('Notification error', { error: String(error) });
    throw error;
  }
};

// Create message notification
const createMessageNotification = async (recipientId, senderId, messageId) => {
  try {
    const Notification = require('../models/Notification');
    const sender = await require('../models/User').findById(senderId).select('username profile.displayName profile.avatar');

    // If an unread message notification from this sender already exists, just update it
    // instead of stacking a new one per message. This prevents notification spam and
    // ensures marking-read clears all messages from that sender in one shot.
    const existing = await Notification.findOneAndUpdate(
      { recipient: recipientId, sender: senderId, type: 'message', isRead: false },
      { $set: { 'data.messageId': messageId, updatedAt: new Date() } },
      { new: true }
    );
    if (existing) {
      const { sendPushNotification } = require('./pushNotificationService');
      sendPushNotification(recipientId, existing).catch((pushError) => {
        log.error('Message push notification error', { error: String(pushError) });
      });
      return existing;
    }

    const notificationData = {
      recipient: recipientId,
      sender: senderId,
      type: 'message',
      title: 'New Message',
      message: `${sender.username} sent you a message`,
      data: {
        messageId: messageId
      }
    };

    return await createAndEmitNotification(notificationData);
  } catch (error) {
    log.error('Notification error', { error: String(error) });
    throw error;
  }
};

// Create tournament notification
const createTournamentNotification = async (recipientId, tournamentId, title, message) => {
  try {
    const notificationData = {
      recipient: recipientId,
      type: 'tournament',
      title: title,
      message: message,
      data: {
        tournamentId: tournamentId
      }
    };

    return await createAndEmitNotification(notificationData);
  } catch (error) {
    log.error('Notification error', { error: String(error) });
    throw error;
  }
};

// Create mention notification
const createMentionNotification = async (recipientId, senderId, postId) => {
  try {
    const sender = await require('../models/User').findById(senderId).select('username profile.displayName profile.avatar');
    const post = await require('../models/Post').findById(postId).select('content.text');
    
    const notificationData = {
      recipient: recipientId,
      sender: senderId,
      type: 'mention',
      title: 'You were mentioned',
      message: `${sender.username} mentioned you in a post${post?.content?.text ? `: "${post.content.text.substring(0, 50)}${post.content.text.length > 50 ? '...' : ''}"` : ''}`,
      data: {
        postId: postId
      }
    };

    return await createAndEmitNotification(notificationData);
  } catch (error) {
    log.error('Notification error', { error: String(error) });
    throw error;
  }
};

// Create system notification
const createSystemNotification = async (recipientId, title, message, data = {}) => {
  try {
    const notificationData = {
      recipient: recipientId,
      type: 'system',
      title: title,
      message: message,
      data: data
    };

    return await createAndEmitNotification(notificationData);
  } catch (error) {
    log.error('Notification error', { error: String(error) });
    throw error;
  }
};

module.exports = {
  createLikeNotification,
  createCommentNotification,
  createFollowNotification,
  createMessageNotification,
  createTournamentNotification,
  createSystemNotification,
  createMentionNotification
};
