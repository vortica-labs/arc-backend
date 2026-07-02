const mongoose = require('mongoose');

const retentionDays = Math.max(7, Math.min(365, Number(process.env.PUSH_DELIVERY_LOG_RETENTION_DAYS || 90)));
const isSensitiveKey = (key) => /(token|authorization|cookie|secret|password|api.?key|credential|private.?key|access.?key|session.?key)/i
  .test(String(key).replace(/[^a-z0-9]/gi, ''));
const redact = (value) => {
  if (Array.isArray(value)) return value.slice(0, 50).map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, nested]) => [
    key,
    isSensitiveKey(key) ? '[REDACTED]' : redact(nested)
  ]));
};

const callVoipPushAttemptSchema = new mongoose.Schema({
  requestKey: { type: String, required: true, maxlength: 64 },
  callSession: { type: mongoose.Schema.Types.ObjectId, ref: 'CallSession', required: true, index: true },
  callId: { type: String, required: true, maxlength: 160 },
  nativeCallId: { type: String, required: true, maxlength: 64 },
  providerRequestId: { type: String, required: true, maxlength: 64 },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  installationId: { type: String, required: true, maxlength: 200 },
  voipTokenHash: { type: String, required: true, maxlength: 64 },
  tokenPreview: { type: String, default: '', maxlength: 80 },
  platform: { type: String, enum: ['ios'], default: 'ios' },
  provider: { type: String, enum: ['apns_voip'], default: 'apns_voip' },
  environment: { type: String, enum: ['sandbox', 'production'], required: true },
  payload: { type: mongoose.Schema.Types.Mixed, default: {}, set: redact },
  providerResponse: { type: mongoose.Schema.Types.Mixed, default: {}, set: redact },
  status: { type: String, enum: ['queued', 'sending', 'accepted', 'failed'], default: 'queued', index: true },
  retryable: { type: Boolean, default: true },
  attempts: { type: Number, default: 0, min: 0 },
  leaseAt: { type: Date, default: null },
  leaseKey: { type: String, default: '', maxlength: 120 },
  nextAttemptAt: { type: Date, default: Date.now },
  apnsId: { type: String, default: '', maxlength: 64 },
  errorCode: { type: String, default: '', maxlength: 200 },
  errorMessage: { type: String, default: '', maxlength: 1000 },
  acceptedAt: { type: Date, default: null },
  failedAt: { type: Date, default: null },
  clientDeliveredAt: { type: Date, default: null },
  openedAt: { type: Date, default: null },
  clickedAt: { type: Date, default: null },
  fallbackSentAt: { type: Date, default: null },
  fallbackProvider: { type: String, enum: ['', 'expo'], default: '' },
  expiresAt: { type: Date, default: () => new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000) }
}, { timestamps: true });

callVoipPushAttemptSchema.index({ requestKey: 1, voipTokenHash: 1 }, { unique: true });
callVoipPushAttemptSchema.index({ status: 1, retryable: 1, nextAttemptAt: 1, leaseAt: 1 });
callVoipPushAttemptSchema.index({ recipient: 1, createdAt: -1 });
callVoipPushAttemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.CallVoipPushAttempt ||
  mongoose.model('CallVoipPushAttempt', callVoipPushAttemptSchema);
