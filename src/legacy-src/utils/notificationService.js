const {
  createAndEmitNotification,
  emitNotification,
  resolveNotificationChannels
} = require('./notificationEmitter');
const { createHash, randomUUID } = require('crypto');
const log = require('./logger');

const buildMessageNotificationBody = (senderName, messageKind = 'text', primaryMediaType = '') => {
  const sender = String(senderName || 'Someone');
  const mediaType = String(primaryMediaType || '').toLowerCase();
  if (messageKind === 'media') {
    if (mediaType === 'audio' || mediaType === 'voice') return `You received a voice message from ${sender}`;
    if (mediaType === 'image' || mediaType === 'photo') return `You received an image from ${sender}`;
    if (mediaType === 'video') return `You received a video from ${sender}`;
    return `You received a media message from ${sender}`;
  }
  if (messageKind === 'shared_post') return `${sender} shared a post with you`;
  if (messageKind === 'shared_profile') return `${sender} shared a profile with you`;
  if (messageKind === 'reply') return `You received a reply from ${sender}`;
  return `You received a new message from ${sender}`;
};

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
const createMessageNotification = async (recipientId, senderId, messageId, options = {}) => {
  try {
    const Notification = require('../models/Notification');
    const User = require('../models/User');
    const [sender, recipient] = await Promise.all([
      User.findById(senderId).select('username profile.displayName profile.avatar'),
      User.findById(recipientId).select('notificationSettings mutedChats isActive').lean()
    ]);
    if (!recipient || recipient.isActive === false) return null;
    const conversationId = String(options.conversationId || options.chatId || `direct_${senderId}`);
    const notificationCoalesceKey = `message-thread:${createHash('sha256')
      .update(`${String(recipientId)}:${String(senderId)}:${conversationId}`)
      .digest('hex')}`;
    const muteKey = String(options.muteKey || senderId);
    if ((recipient?.mutedChats || []).some((entry) => String(entry) === muteKey)) return null;
    const messageKind = String(options.messageKind || 'text');
    const hasMedia = options.hasMedia === true;
    const primaryMediaType = options.primaryMediaType ? String(options.primaryMediaType) : undefined;
    const notificationDataFields = {
      messageId,
      deepLink: options.deepLink || `/conversation/${conversationId}`,
      customData: {
        conversationId,
        chatId: String(options.chatId || conversationId),
        messageKind,
        media: { hasMedia, ...(primaryMediaType ? { primaryType: primaryMediaType } : {}) },
        pushRequestId: `message:${String(messageId)}`,
        notificationCoalesceKey,
        ...(options.groupName ? { groupName: String(options.groupName) } : {})
      }
    };
    const notificationTitle = options.title || 'New Message';
    const notificationMessage = options.message || buildMessageNotificationBody(
      sender?.username,
      messageKind,
      primaryMediaType
    );
    const channels = resolveNotificationChannels(
      { type: 'message', data: notificationDataFields },
      recipient?.notificationSettings
    );

    // If an unread message notification from this sender already exists, just update it
    // instead of stacking a new one per message. This prevents notification spam and
    // ensures marking-read clears all messages from that sender in one shot.
    const existing = await Notification.findOneAndUpdate(
      {
        recipient: recipientId,
        sender: senderId,
        type: 'message',
        isRead: false,
        deletedAt: null,
        archivedAt: null,
        $or: [
          { 'data.customData.notificationCoalesceKey': notificationCoalesceKey },
          { 'data.customData.conversationId': conversationId }
        ]
      },
      {
        $set: {
          title: notificationTitle,
          message: notificationMessage,
          data: notificationDataFields,
          updatedAt: new Date(),
          pushDeliveryState: channels.push ? 'pending' : 'not_requested',
          pushDeliveryAttempts: 0,
          pushDeliveryNextAttemptAt: channels.push ? new Date() : null,
          pushDeliveryLastError: ''
        },
        $unset: { pushDeliveryLeaseAt: 1, pushDeliveryLeaseKey: 1, pushDeliveryCompletedAt: 1 }
      },
      { new: true }
    );
    if (existing) {
      try {
        await existing.populate('sender', 'username profile.displayName profile.avatar');
      } catch (populateError) {
        log.warn('Message notification sender population failed', { error: String(populateError) });
      }
      if (channels.inApp) emitNotification(recipientId, existing);
      if (channels.push) {
        const { sendPushNotification } = require('./pushNotificationService');
        const leaseKey = `notification-outbox-${randomUUID()}`;
        try {
          const claimed = await Notification.claimPushDelivery(existing._id, leaseKey);
          if (claimed) {
            // Another message can replace this coalesced row between the
            // update and the claim. The claimed document is the authoritative
            // revision; sending the earlier snapshot can lose the newer push.
            await sendPushNotification(recipientId, claimed);
            await Notification.completePushDelivery(existing._id, leaseKey);
          }
        } catch (pushError) {
          await Notification.retryPushDelivery(existing._id, leaseKey, pushError).catch(() => undefined);
          log.error('Message push notification error', { error: String(pushError) });
        }
      }
      return existing;
    }

    const notificationData = {
      recipient: recipientId,
      sender: senderId,
      type: 'message',
      title: notificationTitle,
      message: notificationMessage,
      data: notificationDataFields
    };

    try {
      return await createAndEmitNotification(notificationData);
    } catch (error) {
      // The partial unique coalescing index closes the two-first-messages race.
      // The duplicate-key loser re-enters once, updates the winner to its newer
      // message revision, and claims that exact revision for push delivery.
      if (error?.code === 11000 && options.__coalesceConflictRetried !== true) {
        return createMessageNotification(recipientId, senderId, messageId, {
          ...options,
          __coalesceConflictRetried: true
        });
      }
      throw error;
    }
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
    const User = require('../models/User');
    const Post = require('../models/Post');
    const { resolvePostAccess } = require('./privacyPolicy');
    const [sender, post, recipient] = await Promise.all([
      User.findById(senderId).select('username profile.displayName profile.avatar'),
      Post.findById(postId).select('author content.text visibility isActive hiddenByAdmin'),
      User.findById(recipientId).select('username userType privacySettings blockedUsers isActive').lean()
    ]);
    if (!sender || !post || !recipient || recipient.isActive === false) return null;
    const access = await resolvePostAccess({ post, viewer: recipient });
    if (!access.allowed) {
      log.info('Mention notification suppressed by current post privacy', {
        recipientId: String(recipientId),
        senderId: String(senderId),
        postId: String(postId),
        reason: access.reason
      });
      return null;
    }
    
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
const createSystemNotification = async (recipientId, title, message, data = {}, options = {}) => {
  try {
    const email = options?.email && typeof options.email === 'object'
      ? {
          intent: options.email.intent,
          eventType: options.email.eventType,
          templateKey: options.email.templateKey,
          triggerSource: options.email.triggerSource
        }
      : undefined;
    const notificationData = {
      recipient: recipientId,
      type: 'system',
      title: title,
      message: message,
      data: data,
      ...(email ? { email } : {})
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
  createMentionNotification,
  buildMessageNotificationBody
};
