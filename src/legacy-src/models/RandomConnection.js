const mongoose = require('mongoose');

const randomConnectionSchema = new mongoose.Schema({
  roomId: {
    type: String,
    required: true,
    unique: true
  },
  participants: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    username: String,
    displayName: String,
    avatar: String,
    videoEnabled: {
      type: Boolean,
      default: true
    },
    isPremium: {
      type: Boolean,
      default: false
    },
    membershipTier: {
      type: String,
      default: 'free'
    },
    joinedAt: {
      type: Date,
      default: Date.now
    },
    readyAt: Date,
    leftAt: Date
  }],
  selectedGame: {
    type: String,
    required: false // Made optional to support tags-only matching
  },
  tags: {
    type: [String],
    default: []
  },
  status: {
    type: String,
    enum: ['waiting', 'active', 'ended', 'disconnected'],
    default: 'waiting'
  },
  startTime: {
    type: Date,
    default: Date.now
  },
  connectedAt: Date,
  timerStartedAt: Date,
  timerWarningSentAt: Date,
  durationLimitSeconds: {
    type: Number,
    default: null
  },
  expiresAt: Date,
  endTime: Date,
  duration: Number, // in seconds
  endReason: {
    type: String,
    enum: ['user_left', 'timeout', 'cleanup', 'system', 'partner_left', null],
    default: null
  },
  messages: [{
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    message: String,
    timestamp: {
      type: Date,
      default: Date.now
    }
  }],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  usedGenderFilter: {
    type: Boolean,
    default: false
  },
  matchQuality: {
    type: String,
    enum: ['exact_tag', 'partial_tag', 'same_game', 'expanded', 'random', 'unknown'],
    default: 'unknown'
  },
  matchedTags: {
    type: [String],
    default: []
  }
}, {
  timestamps: true
});

// Index for better query performance
randomConnectionSchema.index({ status: 1, selectedGame: 1 });
randomConnectionSchema.index({ 'participants.userId': 1 });
randomConnectionSchema.index({ status: 1, expiresAt: 1 });
randomConnectionSchema.index({ status: 1, timerStartedAt: 1 });
randomConnectionSchema.index({ 'participants.userId': 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('RandomConnection', randomConnectionSchema);
