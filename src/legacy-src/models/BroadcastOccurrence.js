const mongoose = require('mongoose');

const broadcastOccurrenceSchema = new mongoose.Schema({
  broadcast: { type: mongoose.Schema.Types.ObjectId, ref: 'Broadcast', required: true },
  occurrenceKey: { type: String, required: true, maxlength: 100 },
  // Immutable normalized content, push options, audience/token intent, and
  // delivery type used by this occurrence. Recurring broadcasts may be edited
  // for their next run without changing retries already in flight.
  snapshot: { type: mongoose.Schema.Types.Mixed, required: true }
}, { timestamps: { createdAt: true, updatedAt: false } });

broadcastOccurrenceSchema.index({ broadcast: 1, occurrenceKey: 1 }, { unique: true });
broadcastOccurrenceSchema.index({ createdAt: -1 });

const rejectExistingMutation = function(next) {
  next(new Error('Broadcast occurrence snapshots are immutable'));
};

broadcastOccurrenceSchema.pre('updateOne', rejectExistingMutation);
broadcastOccurrenceSchema.pre('updateMany', rejectExistingMutation);
broadcastOccurrenceSchema.pre('findOneAndUpdate', function(next) {
  // Only $setOnInsert upserts used by dispatch are allowed.
  const update = this.getUpdate() || {};
  if (this.getOptions()?.upsert && update.$setOnInsert && Object.keys(update).every((key) => key === '$setOnInsert')) {
    return next();
  }
  return rejectExistingMutation(next);
});
broadcastOccurrenceSchema.pre('replaceOne', rejectExistingMutation);
broadcastOccurrenceSchema.pre('deleteOne', rejectExistingMutation);
broadcastOccurrenceSchema.pre('deleteMany', rejectExistingMutation);
broadcastOccurrenceSchema.pre('save', function(next) {
  if (!this.isNew) return next(new Error('Broadcast occurrence snapshots are immutable'));
  return next();
});

module.exports = mongoose.models.BroadcastOccurrence ||
  mongoose.model('BroadcastOccurrence', broadcastOccurrenceSchema);
