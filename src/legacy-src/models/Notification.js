const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Notification recipient is required']
  },
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  broadcastRecipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BroadcastRecipient',
    default: null
  },
  type: {
    type: String,
    enum: [
      'like',
      'comment', 
      'follow',
      'message',
      'tournament',
      'recruitment',
      'story',
      'clip',
      'call',
      'mention',
      'achievement',
      'system'
    ],
    required: [true, 'Notification type is required']
  },
  title: {
    type: String,
    required: [true, 'Notification title is required'],
    maxlength: [100, 'Title cannot exceed 100 characters']
  },
  message: {
    type: String,
    required: [true, 'Notification message is required'],
    maxlength: [1000, 'Message cannot exceed 1000 characters']
  },
  data: {
    postId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Post'
    },
    messageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message'
    },
    tournamentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tournament'
    },
    broadcastId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Broadcast'
    },
    deliveryLogId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'BroadcastRecipient'
    },
    deepLink: String,
    deliveryType: {
      type: String,
      enum: ['push', 'in_app', 'both']
    },
    channels: {
      push: Boolean,
      inApp: Boolean
    },
    // Device-scoped broadcast constraints. Notification list clients pass
    // their current platform/appVersion so a row targeted at one installation
    // is not surfaced or counted unread on another installation.
    targetPlatforms: [{ type: String, enum: ['android', 'ios', 'web'] }],
    targetAppVersions: [{ type: String, maxlength: 40 }],
    bannerImage: String,
    thumbnail: String,
    cta: {
      text: String,
      url: String,
      type: String
    },
    customData: mongoose.Schema.Types.Mixed
  },
  isRead: {
    type: Boolean,
    default: false
  },
  readAt: Date,
  archivedAt: { type: Date, default: null },
  deletedAt: { type: Date, default: null }
}, {
  timestamps: true
});

// Indexes for better performance
notificationSchema.index({ recipient: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, isRead: 1 });
notificationSchema.index({ recipient: 1, deletedAt: 1, archivedAt: 1, createdAt: -1 });
notificationSchema.index({ type: 1, createdAt: -1 });
notificationSchema.index({ broadcastRecipient: 1 }, { unique: true, sparse: true });
notificationSchema.index({ 'data.broadcastId': 1, createdAt: -1 });

// Static method to create notification
notificationSchema.statics.createNotification = async function(data) {
  try {
    const notification = new this(data);
    await notification.save();
    
    // Populate sender info for real-time sending
    if (data.sender) {
      try {
        await notification.populate('sender', 'username profile.displayName profile.avatar');
      } catch (populateError) {
        console.warn('Could not populate sender info:', populateError.message);
      }
    }

    if (data.sendPush !== false) {
      try {
        const { sendPushNotification } = require('../utils/pushNotificationService');
        sendPushNotification(notification.recipient, notification).catch((pushError) => {
          console.error('Push notification delivery failed:', pushError.message);
        });
      } catch (pushError) {
        console.error('Could not enqueue push notification:', pushError.message);
      }
    }
    
    return notification;
  } catch (error) {
    console.error('Error in createNotification:', error);
    throw new Error(`Failed to create notification: ${error.message}`);
  }
};

// Method to mark as read
notificationSchema.methods.markAsRead = async function() {
  this.isRead = true;
  this.readAt = new Date();
  return await this.save();
};

module.exports = mongoose.model('Notification', notificationSchema);
