const mongoose = require('mongoose');

const callSessionSchema = new mongoose.Schema({
  callId: { type: String, required: true, maxlength: 160 },
  nativeCallId: { type: String, required: true, maxlength: 64 },
  caller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  callee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  participantLeaseKeys: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  participantLeaseActive: { type: Boolean, default: true },
  callType: { type: String, enum: ['voice', 'video'], required: true },
  source: { type: String, enum: ['socket', 'rest', 'random_connect'], default: 'socket' },
  randomRoomId: { type: String, default: '', maxlength: 160 },
  callerSnapshot: {
    username: { type: String, default: '', maxlength: 100 },
    displayName: { type: String, default: '', maxlength: 120 },
    avatar: { type: String, default: '', maxlength: 2048 }
  },
  status: {
    type: String,
    enum: ['ringing', 'accepted', 'declined', 'missed', 'cancelled', 'ended'],
    default: 'ringing',
    index: true
  },
  expiresAt: { type: Date, required: true, index: true },
  acceptedAt: { type: Date, default: null },
  acceptedInstallationId: { type: String, default: '', maxlength: 200 },
  activeUntil: { type: Date, default: null, index: true },
  declinedAt: { type: Date, default: null },
  missedAt: { type: Date, default: null },
  endedAt: { type: Date, default: null },
  endedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  endReason: { type: String, default: '', maxlength: 80 },
  initialVoipPushStatus: {
    type: String,
    enum: ['idle', 'pending', 'processing', 'completed', 'failed'],
    default: 'idle'
  },
  initialVoipPushAttempts: { type: Number, default: 0, min: 0 },
  initialVoipPushNextAttemptAt: { type: Date, default: null },
  initialVoipPushLeaseAt: { type: Date, default: null },
  initialVoipPushLeaseKey: { type: String, default: '', maxlength: 120 },
  initialVoipPushLastError: { type: String, default: '', maxlength: 1000 },
  initialVoipPushCompletedAt: { type: Date, default: null },
  initialVoipFallbackSentAt: { type: Date, default: null },
  statePushStatus: {
    type: String,
    enum: ['idle', 'pending', 'processing', 'completed', 'failed'],
    default: 'idle'
  },
  statePushRevision: { type: String, default: '', maxlength: 64 },
  statePushExcludeInstallationId: { type: String, default: '', maxlength: 200 },
  statePushAttempts: { type: Number, default: 0, min: 0 },
  statePushNextAttemptAt: { type: Date, default: null },
  statePushLeaseAt: { type: Date, default: null },
  statePushLeaseKey: { type: String, default: '', maxlength: 120 },
  statePushLastError: { type: String, default: '', maxlength: 1000 },
  statePushCompletedAt: { type: Date, default: null },
  purgeAt: {
    type: Date,
    default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  }
}, { timestamps: true });

callSessionSchema.index({ callId: 1 }, { unique: true });
callSessionSchema.index({ nativeCallId: 1 }, { unique: true });
callSessionSchema.index(
  { participantLeaseKeys: 1 },
  { unique: true, partialFilterExpression: { participantLeaseActive: true } }
);
callSessionSchema.index({ callee: 1, status: 1, expiresAt: -1 });
callSessionSchema.index({ caller: 1, status: 1, createdAt: -1 });
callSessionSchema.index({ initialVoipPushStatus: 1, initialVoipPushNextAttemptAt: 1, initialVoipPushLeaseAt: 1 });
callSessionSchema.index({ statePushStatus: 1, statePushNextAttemptAt: 1, statePushLeaseAt: 1 });
callSessionSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.CallSession || mongoose.model('CallSession', callSessionSchema);
