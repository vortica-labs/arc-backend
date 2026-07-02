const mongoose = require('mongoose');

const AUTH_METHODS = ['password', 'otp', 'google_token', 'apple_mobile', 'google_passport'];
const PLATFORMS = ['web', 'android', 'ios', 'unknown'];
const RETENTION_SECONDS = 180 * 24 * 60 * 60;

const userLoginEventSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true,
    index: true,
  },
  authMethod: {
    type: String,
    enum: AUTH_METHODS,
    required: true,
    immutable: true,
    index: true,
  },
  timestamp: {
    type: Date,
    required: true,
    default: Date.now,
    immutable: true,
  },
  ip: {
    type: String,
    trim: true,
    maxlength: 64,
    default: '',
    immutable: true,
  },
  userAgent: {
    type: String,
    trim: true,
    maxlength: 512,
    default: '',
    immutable: true,
  },
  platform: {
    type: String,
    enum: PLATFORMS,
    default: 'unknown',
    immutable: true,
    index: true,
  },
  device: {
    type: String,
    trim: true,
    maxlength: 120,
    default: '',
    immutable: true,
  },
}, {
  strict: 'throw',
  versionKey: false,
});

userLoginEventSchema.index({ user: 1, timestamp: -1 }, { name: 'user_login_events_user_timeline' });
userLoginEventSchema.index({ authMethod: 1, timestamp: -1 }, { name: 'user_login_events_method_timeline' });
userLoginEventSchema.index(
  { timestamp: 1 },
  { expireAfterSeconds: RETENTION_SECONDS, name: 'user_login_events_ttl_180d' },
);

const immutableError = () => new Error('User login events are immutable');
const rejectMutation = function rejectMutation(next) { next(immutableError()); };
[
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
].forEach((operation) => userLoginEventSchema.pre(operation, rejectMutation));
userLoginEventSchema.pre('deleteOne', { document: true, query: false }, rejectMutation);
userLoginEventSchema.pre('save', function rejectExistingSave(next) {
  if (!this.isNew) return next(immutableError());
  return next();
});
userLoginEventSchema.pre('bulkWrite', function rejectBulkMutation(next, operations) {
  if ((operations || []).some((operation) => !operation.insertOne)) return next(immutableError());
  return next();
});

const UserLoginEvent = mongoose.models.UserLoginEvent
  || mongoose.model('UserLoginEvent', userLoginEventSchema);

module.exports = UserLoginEvent;
module.exports.AUTH_METHODS = AUTH_METHODS;
module.exports.PLATFORMS = PLATFORMS;
module.exports.RETENTION_SECONDS = RETENTION_SECONDS;
