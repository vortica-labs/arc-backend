const mongoose = require('mongoose');

const boostCampaignSchema = new mongoose.Schema({
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
  campaignType: {
    type: String,
    enum: ['post', 'clip'],
    default: 'post',
    index: true
  },
  pricingTier: {
    type: String,
    enum: ['starter', 'growth', 'pro', 'custom'],
    default: 'custom',
    index: true
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'failed', 'refunded'],
    default: 'pending',
    index: true
  },
  status: {
    type: String,
    enum: ['pending', 'running', 'paused', 'completed', 'cancelled', 'rejected'],
    default: 'pending',
    index: true
  },
  budget: {
    type: Number,
    required: true,
    min: 0
  },
  currency: {
    type: String,
    default: 'INR',
    uppercase: true
  },
  frequency: {
    type: String,
    enum: ['daily', 'weekly', 'monthly'],
    default: 'weekly'
  },
  estimatedReach: {
    type: Number,
    default: 0,
    min: 0
  },
  purchasedReach: {
    type: Number,
    default: 0,
    min: 0
  },
  remainingReach: {
    type: Number,
    default: 0,
    min: 0
  },
  dailySpend: {
    type: Number,
    default: 0,
    min: 0
  },
  totalSpend: {
    type: Number,
    default: 0,
    min: 0
  },
  startTime: Date,
  endTime: Date,
  targetAudience: {
    players: { type: Boolean, default: true },
    teams: { type: Boolean, default: true },
    tags: [{ type: String, trim: true, lowercase: true }],
    regions: [{ type: String, trim: true }],
    minAge: Number,
    maxAge: Number
  },
  deliveryMode: {
    type: String,
    enum: ['ranking', 'manual'],
    default: 'ranking',
    index: true
  },
  manualDelivery: {
    enabled: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['not_configured', 'scheduled', 'running', 'paused', 'stopped', 'completed', 'cancelled'],
      default: 'not_configured',
      index: true
    },
    durationHours: { type: Number, default: 0, min: 0 },
    durationMinutes: { type: Number, default: 0, min: 0 },
    scheduledStartAt: Date,
    startedAt: Date,
    endsAt: Date,
    actualCompletedAt: Date,
    pausedAt: Date,
    pausedAccumulatedMs: { type: Number, default: 0, min: 0 },
    lastAppliedAt: Date,
    lastDeliveryBucket: String,
    deliveredViews: { type: Number, default: 0, min: 0 },
    targetViews: { type: Number, default: 0, min: 0 },
    remainingViews: { type: Number, default: 0, min: 0 },
    deliveryPercent: { type: Number, default: 0, min: 0, max: 100 },
    deliverySpeedPerHour: { type: Number, default: 0, min: 0 },
    estimatedCompletionAt: Date,
    timeline: [{
      type: {
        type: String,
        enum: ['configured', 'scheduled', 'started', 'batch', 'paused', 'resumed', 'adjusted', 'stopped', 'cancelled', 'completed', 'restarted'],
        required: true
      },
      views: { type: Number, default: 0 },
      deliveredViews: { type: Number, default: 0 },
      remainingViews: { type: Number, default: 0 },
      progress: { type: Number, default: 0 },
      message: { type: String, default: '' },
      reason: { type: String, default: '', maxlength: 500 },
      previousValue: { type: mongoose.Schema.Types.Mixed, default: null },
      newValue: { type: mongoose.Schema.Types.Mixed, default: null },
      createdAt: { type: Date, default: Date.now },
      actor: {
        username: { type: String, default: 'system' },
        role: { type: String, default: 'system' }
      }
    }]
  },
  razorpayOrderId: {
    type: String,
    index: true,
    unique: true,
    sparse: true
  },
  razorpayPaymentId: {
    type: String,
    index: true,
    unique: true,
    sparse: true
  },
  analytics: {
    organicViews: { type: Number, default: 0 },
    boostViews: { type: Number, default: 0 },
    organicLikes: { type: Number, default: 0 },
    boostLikes: { type: Number, default: 0 },
    organicComments: { type: Number, default: 0 },
    boostComments: { type: Number, default: 0 },
    organicShares: { type: Number, default: 0 },
    boostShares: { type: Number, default: 0 },
    organicSaves: { type: Number, default: 0 },
    boostSaves: { type: Number, default: 0 },
    organicReach: { type: Number, default: 0 },
    boostReach: { type: Number, default: 0 },
    organicWatchTimeMs: { type: Number, default: 0 },
    boostWatchTimeMs: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    profileVisits: { type: Number, default: 0 },
    followerConversions: { type: Number, default: 0 },
    impressions: { type: Number, default: 0 }
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

boostCampaignSchema.index({ post: 1, status: 1, endTime: 1 });
boostCampaignSchema.index({ user: 1, createdAt: -1 });
boostCampaignSchema.index({ status: 1, endTime: 1 });
boostCampaignSchema.index({ deliveryMode: 1, 'manualDelivery.status': 1, 'manualDelivery.scheduledStartAt': 1 });
boostCampaignSchema.index({ paymentStatus: 1, createdAt: -1 });

module.exports = mongoose.model('BoostCampaign', boostCampaignSchema);
