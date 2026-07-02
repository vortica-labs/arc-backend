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

// One aggregate record exists even when a user has no registered device. The
// token-scoped PushDeliveryAttempt rows remain the detailed provider ledger.
const pushDeliveryRequestSchema = new mongoose.Schema({
  requestKey: { type: String, required: true, maxlength: 64 },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  notification: { type: mongoose.Schema.Types.ObjectId, ref: 'Notification', default: null },
  source: { type: String, enum: ['generic', 'diagnostic', 'admin_test', 'bulk', 'call'], default: 'generic', index: true },
  notificationType: { type: String, default: 'system', maxlength: 80 },
  provider: { type: String, enum: ['expo', 'apns_voip'], default: 'expo' },
  payload: { type: mongoose.Schema.Types.Mixed, default: {}, set: (value) => redactBounded(value) },
  status: {
    type: String,
    enum: [
      'created', 'submitting', 'retrying', 'provider_accepted',
      'provider_delivered', 'client_delivered', 'skipped', 'failed'
    ],
    default: 'created',
    index: true
  },
  targetedInstallations: { type: Number, default: 0, min: 0 },
  submitted: { type: Number, default: 0, min: 0 },
  accepted: { type: Number, default: 0, min: 0 },
  failed: { type: Number, default: 0, min: 0 },
  skipped: { type: Number, default: 0, min: 0 },
  pendingReceipts: { type: Number, default: 0, min: 0 },
  retryCount: { type: Number, default: 0, min: 0 },
  recoveryAttempts: { type: Number, default: 0, min: 0 },
  reasonCode: { type: String, default: '', maxlength: 200 },
  reasonMessage: { type: String, default: '', maxlength: 1000 },
  firstAttemptAt: { type: Date, default: null },
  lastAttemptAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000)
  }
}, { timestamps: true });

pushDeliveryRequestSchema.index({ requestKey: 1 }, { unique: true });
pushDeliveryRequestSchema.index({ recipient: 1, createdAt: -1 });
pushDeliveryRequestSchema.index({ status: 1, updatedAt: -1 });
pushDeliveryRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.PushDeliveryRequest ||
  mongoose.model('PushDeliveryRequest', pushDeliveryRequestSchema);
