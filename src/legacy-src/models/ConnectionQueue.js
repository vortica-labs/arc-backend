const mongoose = require('mongoose');

const connectionQueueSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  username: String,
  displayName: String,
  avatar: String,
  selectedGame: {
    type: String,
    required: false // Made optional to support tags-only matching
  },
  tags: {
    type: [String],
    default: [],
    index: true // Index for faster tag-based queries
  },
  videoEnabled: {
    type: Boolean,
    default: true
  },
  gender: {
    type: String,
    default: ''
  },
  preferredGender: {
    type: String,
    enum: ['', 'male', 'female'],
    default: ''
  },
  region: {
    type: String,
    default: ''
  },
  lastMatchedUserIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  status: {
    type: String,
    enum: ['waiting', 'matched', 'cancelled'],
    default: 'waiting'
  },
  joinedAt: {
    type: Date,
    default: Date.now
  },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 30 * 60 * 1000) // 30 minutes
  }
}, {
  timestamps: true
});

// Index for better query performance
connectionQueueSchema.index({ userId: 1 });
connectionQueueSchema.index(
  { userId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'waiting' } }
);
connectionQueueSchema.index({ status: 1, selectedGame: 1 });
connectionQueueSchema.index({ status: 1, tags: 1 }); // For tag-based matching
connectionQueueSchema.index({ status: 1, selectedGame: 1, tags: 1 }); // Combined matching
connectionQueueSchema.index({ status: 1, joinedAt: 1 });
connectionQueueSchema.index({ status: 1, gender: 1, joinedAt: 1 });

// TTL index to automatically remove expired entries
connectionQueueSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('ConnectionQueue', connectionQueueSchema);
