const mongoose = require('mongoose');

const postEngagementSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  post: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Post',
    required: true,
    index: true
  },
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  eventType: {
    type: String,
    enum: [
      'view',
      'watch',
      'like',
      'unlike',
      'comment',
      'share',
      'save',
      'unsave',
      'skip',
      'dwell'
    ],
    required: true,
    index: true
  },
  context: {
    type: String,
    enum: ['feed', 'clips', 'profile', 'search', 'post', 'unknown'],
    default: 'unknown',
    index: true
  },
  durationMs: {
    type: Number,
    default: 0,
    min: 0
  },
  completionRate: {
    type: Number,
    default: 0,
    min: 0,
    max: 1
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

postEngagementSchema.index({ user: 1, createdAt: -1 });
postEngagementSchema.index({ post: 1, eventType: 1, createdAt: -1 });
postEngagementSchema.index({ author: 1, eventType: 1, createdAt: -1 });
postEngagementSchema.index(
  { user: 1, post: 1, eventType: 1, context: 1 },
  {
    unique: true,
    partialFilterExpression: { eventType: 'view' }
  }
);

module.exports = mongoose.model('PostEngagement', postEngagementSchema);
