const mongoose = require('mongoose');

const broadcastEventSchema = new mongoose.Schema({
  broadcast: { type: mongoose.Schema.Types.ObjectId, ref: 'Broadcast', required: true },
  broadcastRecipient: { type: mongoose.Schema.Types.ObjectId, ref: 'BroadcastRecipient', required: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  notification: { type: mongoose.Schema.Types.ObjectId, ref: 'Notification', default: null },
  eventType: { type: String, enum: ['delivered', 'open', 'click'], required: true },
  url: { type: String, default: '', maxlength: 2048 },
  platform: { type: String, enum: ['android', 'ios', 'web', 'unknown'], default: 'unknown' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

broadcastEventSchema.index(
  { broadcastRecipient: 1, eventType: 1 },
  { unique: true }
);
broadcastEventSchema.index({ broadcast: 1, eventType: 1, createdAt: -1 });
broadcastEventSchema.index({ recipient: 1, createdAt: -1 });

module.exports = mongoose.models.BroadcastEvent || mongoose.model('BroadcastEvent', broadcastEventSchema);
