const mongoose = require('mongoose');

const broadcastChunkSchema = new mongoose.Schema({
  broadcast: { type: mongoose.Schema.Types.ObjectId, ref: 'Broadcast', required: true },
  occurrenceKey: { type: String, required: true, maxlength: 100 },
  chunkIndex: { type: Number, required: true, min: 0 },
  recipientIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
  processingLeaseAt: { type: Date, default: null },
  workerJobId: { type: String, default: '', maxlength: 250 },
  attempts: { type: Number, default: 0, min: 0 },
  lastError: { type: String, default: '', maxlength: 1000 },
  completedAt: { type: Date, default: null }
}, { timestamps: true });

broadcastChunkSchema.index(
  { broadcast: 1, occurrenceKey: 1, chunkIndex: 1 },
  { unique: true }
);
broadcastChunkSchema.index({ status: 1, processingLeaseAt: 1 });

module.exports = mongoose.models.BroadcastChunk || mongoose.model('BroadcastChunk', broadcastChunkSchema);
