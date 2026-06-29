const mongoose = require('mongoose');

/**
 * Cached eligibility result per user. Updated on profile load and daily cron.
 * Eligibility ≠ approval; this only determines if user can apply.
 */
const monetizationEligibilitySchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true
  },
  isEligible: {
    type: Boolean,
    default: false
  },
  progressPercent: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  failedConditions: [{
    condition: { type: String, required: true },
    current: { type: mongoose.Schema.Types.Mixed },
    required: { type: mongoose.Schema.Types.Mixed },
    progressPercent: { type: Number, default: 0 }
  }],
  /** Snapshot of raw metrics used for eligibility (for display/debug) */
  metrics: {
    followersCount: { type: Number, default: 0 },
    hasActivePremiumMembership: { type: Boolean, default: false },
    totalOrganicClipViews45d: { type: Number, default: 0 },
    totalClipViews45d: { type: Number, default: 0 },
    clipsWith3kOrganicViews45d: { type: Number, default: 0 },
    clipsWith3kViews45d: { type: Number, default: 0 },
    activeDays45d: { type: Number, default: 0 },
    creatorHealthScore: { type: Number, default: 0 },
    suspiciousViewSpike: { type: Boolean, default: false },
    policyViolations: { type: Number, default: 0 },
    lowQualityRatio: { type: Number, default: 0 },
    duplicateRatio: { type: Number, default: 0 }
  },
  lastCalculatedAt: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

monetizationEligibilitySchema.index({ lastCalculatedAt: 1 });
module.exports = mongoose.model('MonetizationEligibility', monetizationEligibilitySchema);
