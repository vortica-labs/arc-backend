const mongoose = require('mongoose');

// Durable dead-letter record for terminal broadcast failures. The delivery
// models remain the operational source of truth; this collection is the
// append/update-safe index used by operators to investigate and retry poison
// work without depending on BullMQ's retention window.
const notificationFailureSchema = new mongoose.Schema({
  broadcast: { type: mongoose.Schema.Types.ObjectId, ref: 'Broadcast', required: true },
  broadcastRecipient: { type: mongoose.Schema.Types.ObjectId, ref: 'BroadcastRecipient', default: null },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  occurrenceKey: { type: String, required: true, maxlength: 100 },
  channel: { type: String, enum: ['queue', 'push', 'in_app'], required: true },
  stage: { type: String, required: true, maxlength: 100 },
  code: { type: String, default: '', maxlength: 200 },
  reason: { type: String, required: true, maxlength: 1000 },
  attempts: { type: Number, default: 0, min: 0 },
  status: { type: String, enum: ['open', 'retrying', 'resolved'], default: 'open', index: true },
  firstFailedAt: { type: Date, default: Date.now },
  lastFailedAt: { type: Date, default: Date.now },
  retryRequestedAt: { type: Date, default: null },
  resolvedAt: { type: Date, default: null }
}, { timestamps: true });

notificationFailureSchema.index(
  { broadcast: 1, occurrenceKey: 1, broadcastRecipient: 1, channel: 1, stage: 1 },
  { unique: true }
);
notificationFailureSchema.index({ status: 1, lastFailedAt: -1 });
notificationFailureSchema.index({ broadcast: 1, lastFailedAt: -1 });

module.exports = mongoose.models.NotificationFailure ||
  mongoose.model('NotificationFailure', notificationFailureSchema);
