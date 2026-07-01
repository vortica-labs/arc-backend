const mongoose = require('mongoose');

const broadcastPushReceiptSchema = new mongoose.Schema({
  broadcast: { type: mongoose.Schema.Types.ObjectId, ref: 'Broadcast', required: true },
  broadcastRecipient: { type: mongoose.Schema.Types.ObjectId, ref: 'BroadcastRecipient', required: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  notification: { type: mongoose.Schema.Types.ObjectId, ref: 'Notification', default: null },
  occurrenceKey: { type: String, required: true, maxlength: 100 },
  provider: { type: String, enum: ['expo'], default: 'expo' },
  tokenHash: { type: String, required: true, maxlength: 64 },
  tokenPreview: { type: String, default: '', maxlength: 80 },
  platform: { type: String, enum: ['ios', 'android', 'web', 'unknown'], default: 'unknown' },
  appVersion: { type: String, default: '', maxlength: 40 },
  deviceName: { type: String, default: '', maxlength: 200 },
  ticketStatus: {
    type: String,
    enum: ['queued', 'sending', 'accepted', 'failed', 'skipped', 'cancelled'],
    default: 'queued',
    index: true
  },
  providerTicketId: { type: String, default: undefined, maxlength: 500 },
  receiptStatus: {
    type: String,
    enum: ['pending', 'delivered', 'failed', 'skipped', 'cancelled'],
    default: 'pending',
    index: true
  },
  providerErrorCode: { type: String, default: '', maxlength: 200 },
  providerErrorMessage: { type: String, default: '', maxlength: 1000 },
  sendLeaseAt: { type: Date, default: null },
  sendLeaseKey: { type: String, default: '', maxlength: 250 },
  sendAttempts: { type: Number, default: 0, min: 0 },
  manualRetryCount: { type: Number, default: 0, min: 0 },
  receiptLeaseAt: { type: Date, default: null },
  receiptLeaseKey: { type: String, default: '', maxlength: 250 },
  receiptAttempts: { type: Number, default: 0, min: 0 },
  nextReceiptAt: { type: Date, default: null },
  sentAt: { type: Date, default: null },
  receiptCheckedAt: { type: Date, default: null }
}, { timestamps: true });

// A broadcast occurrence may submit at most one provider request per recipient
// device token. Retried chunk jobs reuse this record instead of fan-out again.
broadcastPushReceiptSchema.index(
  { broadcastRecipient: 1, tokenHash: 1 },
  { unique: true }
);
broadcastPushReceiptSchema.index({ receiptStatus: 1, nextReceiptAt: 1, receiptLeaseAt: 1 });
broadcastPushReceiptSchema.index({ broadcast: 1, occurrenceKey: 1, createdAt: -1 });
broadcastPushReceiptSchema.index({ providerTicketId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.models.BroadcastPushReceipt ||
  mongoose.model('BroadcastPushReceipt', broadcastPushReceiptSchema);
