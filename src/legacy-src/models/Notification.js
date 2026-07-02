const mongoose = require('mongoose');
const { randomUUID } = require('crypto');

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
  deletedAt: { type: Date, default: null },
  pushDeliveryState: {
    type: String,
    enum: ['not_requested', 'pending', 'processing', 'completed', 'failed'],
    default: 'not_requested',
    select: false
  },
  pushDeliveryAttempts: { type: Number, default: 0, min: 0, select: false },
  pushDeliveryNextAttemptAt: { type: Date, default: null, select: false },
  pushDeliveryLeaseAt: { type: Date, default: null, select: false },
  pushDeliveryLeaseKey: { type: String, default: '', maxlength: 120, select: false },
  pushDeliveryLastError: { type: String, default: '', maxlength: 1000, select: false },
  pushDeliveryCompletedAt: { type: Date, default: null, select: false }
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
notificationSchema.index({ pushDeliveryState: 1, pushDeliveryNextAttemptAt: 1, pushDeliveryLeaseAt: 1 });
notificationSchema.index(
  { recipient: 1, 'data.customData.notificationDedupeKey': 1 },
  {
    unique: true,
    partialFilterExpression: { 'data.customData.notificationDedupeKey': { $type: 'string' } }
  }
);
notificationSchema.index(
  { recipient: 1, 'data.customData.notificationCoalesceKey': 1 },
  {
    unique: true,
    partialFilterExpression: {
      'data.customData.notificationCoalesceKey': { $type: 'string' },
      isRead: false,
      deletedAt: null,
      archivedAt: null
    }
  }
);

notificationSchema.statics.claimPushDelivery = function(notificationId, leaseKey = `notification-outbox-${randomUUID()}`) {
  return this.findOneAndUpdate(
    {
      _id: notificationId,
      pushDeliveryState: 'pending',
      $or: [{ pushDeliveryNextAttemptAt: null }, { pushDeliveryNextAttemptAt: { $lte: new Date() } }]
    },
    {
      $set: { pushDeliveryState: 'processing', pushDeliveryLeaseAt: new Date(), pushDeliveryLeaseKey: leaseKey },
      $inc: { pushDeliveryAttempts: 1 },
      $unset: { pushDeliveryNextAttemptAt: 1 }
    },
    { new: true }
  ).select('+pushDeliveryAttempts +pushDeliveryLeaseKey');
};

notificationSchema.statics.completePushDelivery = function(notificationId, leaseKey) {
  return this.updateOne(
    { _id: notificationId, pushDeliveryLeaseKey: leaseKey },
    {
      $set: { pushDeliveryState: 'completed', pushDeliveryCompletedAt: new Date(), pushDeliveryLastError: '' },
      $unset: { pushDeliveryNextAttemptAt: 1, pushDeliveryLeaseAt: 1, pushDeliveryLeaseKey: 1 }
    }
  );
};

notificationSchema.statics.retryPushDelivery = function(notificationId, leaseKey, error, delayMs = 10000) {
  return this.updateOne(
    { _id: notificationId, pushDeliveryLeaseKey: leaseKey },
    {
      $set: {
        pushDeliveryState: 'pending',
        pushDeliveryNextAttemptAt: new Date(Date.now() + delayMs),
        pushDeliveryLastError: String(error?.message || error).slice(0, 1000)
      },
      $unset: { pushDeliveryLeaseAt: 1, pushDeliveryLeaseKey: 1 }
    }
  );
};

// Static method to create notification
notificationSchema.statics.createNotification = async function(data) {
  try {
    const pushRequested = data.sendPush !== false || data.pushDeliveryState === 'pending';
    const notification = new this({
      ...data,
      pushDeliveryState: pushRequested ? 'pending' : 'not_requested',
      pushDeliveryNextAttemptAt: pushRequested ? new Date() : null
    });
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
      const leaseKey = `notification-outbox-${randomUUID()}`;
      try {
        const claimed = await this.claimPushDelivery(notification._id, leaseKey);
        if (!claimed) return notification;
        const { sendPushNotification } = require('../utils/pushNotificationService');
        // Persist/claim the durable delivery attempt before returning from the
        // notification write. Provider failures remain isolated from the
        // in-app record, but a process exit cannot silently lose the push.
        await sendPushNotification(notification.recipient, claimed);
        await this.completePushDelivery(notification._id, leaseKey);
      } catch (pushError) {
        await this.retryPushDelivery(notification._id, leaseKey, pushError).catch(() => undefined);
        console.error('Could not persist or enqueue push notification:', pushError.message);
      }
    }
    
    return notification;
  } catch (error) {
    console.error('Error in createNotification:', error);
    const wrapped = new Error(`Failed to create notification: ${error.message}`);
    wrapped.code = error.code;
    wrapped.cause = error;
    throw wrapped;
  }
};

// Method to mark as read
notificationSchema.methods.markAsRead = async function() {
  this.isRead = true;
  this.readAt = new Date();
  return await this.save();
};

module.exports = mongoose.model('Notification', notificationSchema);
