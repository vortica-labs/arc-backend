const mongoose = require('mongoose');

// Canonical ownership record for one app/browser installation. The legacy
// User.pushTokens array remains a denormalized targeting cache, while this
// collection provides atomic cross-account ownership and token rotation.
const pushDeviceSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  installationId: { type: String, required: true, maxlength: 200 },
  provider: { type: String, enum: ['expo'], default: 'expo' },
  token: { type: String, required: true, maxlength: 512, select: false },
  tokenHash: { type: String, required: true, maxlength: 64 },
  tokenPreview: { type: String, default: '', maxlength: 80 },
  platform: { type: String, enum: ['ios', 'android', 'web', 'unknown'], default: 'unknown' },
  deviceName: { type: String, default: '', maxlength: 120 },
  deviceModel: { type: String, default: '', maxlength: 120 },
  deviceBrand: { type: String, default: '', maxlength: 120 },
  manufacturer: { type: String, default: '', maxlength: 120 },
  deviceType: { type: String, default: '', maxlength: 40 },
  osName: { type: String, default: '', maxlength: 40 },
  osVersion: { type: String, default: '', maxlength: 40 },
  projectId: { type: String, default: '', maxlength: 120 },
  appVersion: { type: String, default: '', maxlength: 40 },
  buildVersion: { type: String, default: '', maxlength: 40 },
  nativeTokenType: { type: String, default: '', maxlength: 40 },
  nativeToken: { type: String, default: '', maxlength: 2048, select: false },
  nativeTokenHash: { type: String, default: '', maxlength: 64 },
  nativeTokenPreview: { type: String, default: '', maxlength: 80 },
  fcmToken: { type: String, default: undefined, maxlength: 2048, select: false },
  fcmTokenHash: { type: String, default: undefined, maxlength: 64 },
  fcmTokenPreview: { type: String, default: '', maxlength: 80 },
  fcmTokenUpdatedAt: { type: Date, default: null },
  apnsToken: { type: String, default: undefined, maxlength: 2048, select: false },
  apnsTokenHash: { type: String, default: undefined, maxlength: 64 },
  apnsTokenPreview: { type: String, default: '', maxlength: 80 },
  apnsTokenUpdatedAt: { type: Date, default: null },
  voipToken: { type: String, default: undefined, maxlength: 512, select: false },
  voipTokenHash: { type: String, default: undefined, maxlength: 64 },
  voipTokenPreview: { type: String, default: '', maxlength: 80 },
  voipTokenUpdatedAt: { type: Date, default: null },
  status: { type: String, enum: ['active', 'invalid', 'disabled'], default: 'active', index: true },
  failureCount: { type: Number, default: 0, min: 0 },
  lastRegisteredAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  lastDeliveredAt: { type: Date, default: null },
  lastFailedAt: { type: Date, default: null },
  invalidatedAt: { type: Date, default: null },
  invalidReason: { type: String, default: '', maxlength: 300 },
  purgeAt: { type: Date, default: null }
}, { timestamps: true });

pushDeviceSchema.index({ installationId: 1 }, { unique: true });
pushDeviceSchema.index({ tokenHash: 1 }, { unique: true });
pushDeviceSchema.index(
  { fcmTokenHash: 1 },
  { unique: true, partialFilterExpression: { fcmTokenHash: { $type: 'string', $gt: '' } } }
);
pushDeviceSchema.index(
  { apnsTokenHash: 1 },
  { unique: true, partialFilterExpression: { apnsTokenHash: { $type: 'string', $gt: '' } } }
);
pushDeviceSchema.index(
  { voipTokenHash: 1 },
  { unique: true, partialFilterExpression: { voipTokenHash: { $type: 'string', $gt: '' } } }
);
pushDeviceSchema.index({ user: 1, status: 1, lastSeenAt: -1 });
pushDeviceSchema.index({ status: 1, lastFailedAt: -1 });
pushDeviceSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.PushDevice || mongoose.model('PushDevice', pushDeviceSchema);
