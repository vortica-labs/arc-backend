const mongoose = require('mongoose');

const followRequestSchema = new mongoose.Schema({
  requester: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  target: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'rejected', 'cancelled'],
    default: 'pending',
    index: true
  },
  resolvedAt: { type: Date, default: null }
}, { timestamps: true });

followRequestSchema.index(
  { requester: 1, target: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } }
);
followRequestSchema.index({ target: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('FollowRequest', followRequestSchema);
