const mongoose = require('mongoose');

const channelStateSchema = new mongoose.Schema({
  status: {
    type: String,
    enum: ['pending', 'processing', 'delivered', 'failed', 'skipped'],
    default: 'pending'
  },
  attemptedAt: { type: Date, default: null },
  deliveredAt: { type: Date, default: null },
  providerMessageIds: [{ type: String }],
  failureReason: { type: String, default: '', maxlength: 1000 }
}, { _id: false });

const broadcastRecipientSchema = new mongoose.Schema({
  broadcast: { type: mongoose.Schema.Types.ObjectId, ref: 'Broadcast', required: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  occurrenceKey: { type: String, required: true, maxlength: 100 },
  notification: { type: mongoose.Schema.Types.ObjectId, ref: 'Notification', default: null },
  recipientSnapshot: {
    username: { type: String, default: '' },
    displayName: { type: String, default: '' },
    userType: { type: String, default: '' },
    isPremium: { type: Boolean, default: false },
    premiumPlan: { type: String, default: 'free' },
    location: { type: String, default: '' },
    country: { type: String, default: '', maxlength: 100 },
    platforms: [{ type: String }]
  },
  requestedDeliveryType: { type: String, enum: ['push', 'in_app', 'both'], required: true },
  overallStatus: {
    type: String,
    enum: ['pending', 'processing', 'delivered', 'partial', 'failed', 'skipped'],
    default: 'pending',
    index: true
  },
  push: { type: channelStateSchema, default: () => ({}) },
  inApp: { type: channelStateSchema, default: () => ({}) },
  processingLeaseAt: { type: Date, default: null },
  processingKey: { type: String, default: '', maxlength: 250 },
  attempts: { type: Number, default: 0, min: 0 },
  webPushEmittedAt: { type: Date, default: null },
  webPushAckDeadlineAt: { type: Date, default: null },
  webPushRetryRequestedAt: { type: Date, default: null },
  webPushAcknowledgedAt: { type: Date, default: null },
  webPushAcknowledgedPlatform: {
    type: String,
    enum: ['web', 'unknown'],
    default: 'unknown'
  },
  openedAt: { type: Date, default: null },
  clickedAt: { type: Date, default: null },
  clickedUrl: { type: String, default: '', maxlength: 2048 },
  lastError: { type: String, default: '', maxlength: 1000 }
}, { timestamps: true });

broadcastRecipientSchema.index(
  { broadcast: 1, recipient: 1, occurrenceKey: 1 },
  { unique: true }
);
broadcastRecipientSchema.index({ broadcast: 1, createdAt: -1 });
broadcastRecipientSchema.index({ broadcast: 1, overallStatus: 1 });
broadcastRecipientSchema.index({ recipient: 1, createdAt: -1 });
broadcastRecipientSchema.index({ createdAt: -1 });
broadcastRecipientSchema.index({ overallStatus: 1, createdAt: -1 });
broadcastRecipientSchema.index({ 'recipientSnapshot.platforms': 1, createdAt: -1 });
broadcastRecipientSchema.index({ broadcast: 1, openedAt: 1, clickedAt: 1 });
broadcastRecipientSchema.index({ openedAt: 1, createdAt: 1 });
broadcastRecipientSchema.index({ webPushAcknowledgedAt: 1, webPushAckDeadlineAt: 1, 'push.status': 1 });
broadcastRecipientSchema.index({ webPushRetryRequestedAt: 1, 'push.status': 1 });

module.exports = mongoose.models.BroadcastRecipient || mongoose.model('BroadcastRecipient', broadcastRecipientSchema);
