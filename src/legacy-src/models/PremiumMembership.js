const mongoose = require('mongoose');

const PLAN_KEYS = ['player_pro', 'player_pro_plus', 'team_pro', 'team_org'];
const BILLING_PERIODS = ['monthly', 'quarterly', 'yearly', 'lifetime'];
const MEMBERSHIP_STATUSES = ['trial', 'active', 'expired', 'cancelled', 'refunded', 'removed'];
const SUBSCRIPTION_STATUSES = [
  'not_applicable', 'created', 'authenticated', 'active', 'pending', 'halted',
  'paused', 'resumed', 'cancelled', 'completed', 'expired', 'unknown'
];

const premiumMembershipSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  isCurrent: { type: Boolean, default: true, index: true },
  accountType: { type: String, enum: ['player', 'team', 'creator', 'admin', 'unknown'], default: 'unknown', index: true },
  planKey: { type: String, enum: PLAN_KEYS, required: true, index: true },
  planTier: { type: String, enum: PLAN_KEYS, required: true, index: true },
  billingPeriod: { type: String, enum: BILLING_PERIODS, required: true, index: true },
  source: {
    type: String,
    enum: ['razorpay_subscription', 'razorpay_order', 'manual', 'migration'],
    required: true,
    index: true
  },
  platform: { type: String, enum: ['web', 'android', 'ios', 'admin', 'unknown'], default: 'unknown', index: true },
  membershipStatus: { type: String, enum: MEMBERSHIP_STATUSES, required: true, default: 'trial', index: true },
  subscriptionStatus: { type: String, enum: SUBSCRIPTION_STATUSES, default: 'not_applicable', index: true },
  autoRenew: { type: Boolean, default: false, index: true },
  cancelAtCycleEnd: { type: Boolean, default: false },
  startedAt: { type: Date, default: null },
  currentPeriodStart: { type: Date, default: null },
  currentPeriodEnd: { type: Date, default: null, index: true },
  expiresAt: { type: Date, default: null, index: true },
  cancelledAt: { type: Date, default: null },
  endedAt: { type: Date, default: null },
  lastPaymentAt: { type: Date, default: null },
  amount: { type: Number, min: 0, default: 0 },
  currency: { type: String, uppercase: true, trim: true, maxlength: 3, default: 'INR' },
  razorpay: {
    customerId: { type: String, trim: true, default: undefined },
    subscriptionId: { type: String, trim: true, default: undefined },
    planId: { type: String, trim: true, default: undefined },
    paymentId: { type: String, trim: true, default: undefined },
    orderId: { type: String, trim: true, default: undefined },
    invoiceId: { type: String, trim: true, default: '' }
  },
  manual: {
    actorKey: { type: String, trim: true, maxlength: 200, default: '' },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    adminName: { type: String, trim: true, maxlength: 200, default: '' },
    role: { type: String, trim: true, maxlength: 100, default: '' },
    reason: { type: String, trim: true, maxlength: 1000, default: '' }
  },
  providerSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
  scheduledChange: {
    planKey: { type: String, enum: PLAN_KEYS, default: undefined },
    planId: { type: String, default: undefined },
    billingPeriod: { type: String, enum: BILLING_PERIODS, default: undefined },
    effectiveAt: { type: Date, default: null }
  },
  providerLastEventAt: { type: Date, default: null, index: true },
  providerLastEventId: { type: String, trim: true, maxlength: 200, default: '' },
  reconciliation: {
    lastCheckedAt: { type: Date, default: null },
    lastDriftAt: { type: Date, default: null },
    claimedAt: { type: Date, default: null },
    claimToken: { type: String, default: '' },
    error: { type: String, maxlength: 500, default: '' }
  },
  version: { type: Number, min: 0, default: 1 },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true, optimisticConcurrency: true });

premiumMembershipSchema.index(
  { user: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true }, name: 'one_current_premium_membership_per_user' }
);
premiumMembershipSchema.index({ membershipStatus: 1, expiresAt: 1, _id: 1 });
premiumMembershipSchema.index({ planKey: 1, billingPeriod: 1, membershipStatus: 1, createdAt: -1 });
premiumMembershipSchema.index({ platform: 1, accountType: 1, createdAt: -1 });
premiumMembershipSchema.index(
  { 'razorpay.subscriptionId': 1 },
  { unique: true, partialFilterExpression: { 'razorpay.subscriptionId': { $type: 'string', $gt: '' } } }
);
premiumMembershipSchema.index(
  { 'razorpay.paymentId': 1 },
  { unique: true, partialFilterExpression: { 'razorpay.paymentId': { $type: 'string', $gt: '' } } }
);
premiumMembershipSchema.index(
  { 'razorpay.orderId': 1 },
  { unique: true, partialFilterExpression: { 'razorpay.orderId': { $type: 'string', $gt: '' } } }
);

premiumMembershipSchema.pre('save', function(next) {
  if (this.billingPeriod === 'lifetime' && this.expiresAt) {
    return next(new Error('Lifetime memberships cannot have an expiry'));
  }
  if (this.startedAt && this.expiresAt && this.expiresAt <= this.startedAt) {
    return next(new Error('Membership expiry must be after its start'));
  }
  return next();
});

premiumMembershipSchema.statics.PLAN_KEYS = PLAN_KEYS;
premiumMembershipSchema.statics.BILLING_PERIODS = BILLING_PERIODS;

module.exports = mongoose.models.PremiumMembership || mongoose.model('PremiumMembership', premiumMembershipSchema);
