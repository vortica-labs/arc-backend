const mongoose = require('mongoose');

const retentionDays = Math.max(7, Math.min(3650, Number(process.env.PUSH_DELIVERY_LOG_RETENTION_DAYS || 90)));
const isSensitiveKey = (key) => /(token|authorization|cookie|secret|password|api.?key|credential|private.?key|access.?key|session.?key)/i
  .test(String(key).replace(/[^a-z0-9]/gi, ''));

const redactBounded = (value, maxBytes = 12000) => {
  const walk = (current, depth = 0) => {
    if (depth > 6) return '[TRUNCATED_DEPTH]';
    if (current instanceof Date) return current.toISOString();
    if (current && typeof current.toHexString === 'function') return current.toHexString();
    if (Array.isArray(current)) return current.slice(0, 100).map((item) => walk(item, depth + 1));
    if (!current || typeof current !== 'object') return current;
    return Object.fromEntries(Object.entries(current).slice(0, 100).map(([key, nested]) => [
      key,
      key === 'to' || isSensitiveKey(key)
        ? '[REDACTED]'
        : walk(nested, depth + 1)
    ]));
  };
  const sanitized = walk(value);
  const serialized = JSON.stringify(sanitized);
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) return sanitized;
  return { truncated: true, preview: serialized.slice(0, maxBytes) };
};

// Durable, token-redacted provider ledger for non-broadcast push delivery.
// Broadcasts retain their specialized BroadcastPushReceipt state machine.
const pushDeliveryAttemptSchema = new mongoose.Schema({
  requestKey: { type: String, required: true, maxlength: 64 },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  notification: { type: mongoose.Schema.Types.ObjectId, ref: 'Notification', default: null },
  source: {
    type: String,
    enum: ['generic', 'diagnostic', 'admin_test', 'bulk'],
    default: 'generic',
    index: true
  },
  notificationType: { type: String, default: 'system', maxlength: 80 },
  payload: { type: mongoose.Schema.Types.Mixed, default: {}, set: (value) => redactBounded(value) },
  providerResponse: { type: mongoose.Schema.Types.Mixed, default: {}, set: (value) => redactBounded(value) },
  provider: { type: String, enum: ['expo'], default: 'expo' },
  tokenHash: { type: String, required: true, maxlength: 64 },
  tokenPreview: { type: String, default: '', maxlength: 80 },
  installationId: { type: String, default: '', maxlength: 200 },
  platform: { type: String, enum: ['ios', 'android', 'web', 'unknown'], default: 'unknown' },
  appVersion: { type: String, default: '', maxlength: 40 },
  deviceName: { type: String, default: '', maxlength: 120 },
  ticketStatus: {
    type: String,
    enum: ['queued', 'sending', 'accepted', 'failed', 'skipped'],
    default: 'queued',
    index: true
  },
  providerTicketId: { type: String, default: undefined, maxlength: 500 },
  receiptStatus: {
    type: String,
    enum: ['pending', 'delivered', 'failed', 'skipped'],
    default: 'pending',
    index: true
  },
  deliveryStatus: {
    type: String,
    enum: ['queued', 'provider_accepted', 'provider_delivered', 'client_delivered', 'failed', 'skipped'],
    default: 'queued',
    index: true
  },
  providerErrorCode: { type: String, default: '', maxlength: 200 },
  providerErrorMessage: { type: String, default: '', maxlength: 1000 },
  retryable: { type: Boolean, default: false },
  sendAttempts: { type: Number, default: 0, min: 0 },
  sendLeaseAt: { type: Date, default: null },
  sendLeaseKey: { type: String, default: '', maxlength: 250 },
  nextSendAt: { type: Date, default: null },
  receiptAttempts: { type: Number, default: 0, min: 0 },
  receiptLeaseAt: { type: Date, default: null },
  receiptLeaseKey: { type: String, default: '', maxlength: 250 },
  nextReceiptAt: { type: Date, default: null },
  sentAt: { type: Date, default: null },
  providerDeliveredAt: { type: Date, default: null },
  clientDeliveredAt: { type: Date, default: null },
  openedAt: { type: Date, default: null },
  clickedAt: { type: Date, default: null },
  receiptCheckedAt: { type: Date, default: null },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000)
  }
}, { timestamps: true });

pushDeliveryAttemptSchema.index({ requestKey: 1, tokenHash: 1 }, { unique: true });
pushDeliveryAttemptSchema.index({ providerTicketId: 1 }, { unique: true, sparse: true });
pushDeliveryAttemptSchema.index({ receiptStatus: 1, nextReceiptAt: 1, receiptLeaseAt: 1 });
pushDeliveryAttemptSchema.index({ ticketStatus: 1, retryable: 1, nextSendAt: 1, sendLeaseAt: 1 });
pushDeliveryAttemptSchema.index({ recipient: 1, createdAt: -1 });
pushDeliveryAttemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.PushDeliveryAttempt ||
  mongoose.model('PushDeliveryAttempt', pushDeliveryAttemptSchema);
