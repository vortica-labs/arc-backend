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
  type: {
    type: String,
    enum: [
      'like',
      'comment', 
      'follow',
      'message',
      'tournament',
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
    maxlength: [300, 'Message cannot exceed 300 characters']
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
    customData: mongoose.Schema.Types.Mixed
  },
  isRead: {
    type: Boolean,
    default: false
  },
  readAt: Date
}, {
  timestamps: true
});

// Indexes for better performance
notificationSchema.index({ recipient: 1, createdAt: -1 });
notificationSchema.index({ recipient: 1, isRead: 1 });
notificationSchema.index({ type: 1, createdAt: -1 });

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
