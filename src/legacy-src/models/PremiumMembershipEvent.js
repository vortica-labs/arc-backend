const mongoose = require('mongoose');

const ACTIONS = [
  'purchase', 'activation', 'renewal', 'plan_change', 'cancellation', 'expiration',
  'access_removal', 'resume', 'auto_renew_change', 'refund', 'synchronization',
  'notification_outcome', 'subscription_created', 'subscription_authenticated',
  'subscription_pending', 'subscription_halted', 'subscription_paused',
  'subscription_completed', 'mutation_intent', 'mutation_outcome', 'mutation_failed'
];

const premiumMembershipEventSchema = new mongoose.Schema({
  membership: { type: mongoose.Schema.Types.ObjectId, ref: 'PremiumMembership', required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  action: { type: String, enum: ACTIONS, required: true, index: true },
  source: {
    type: String,
    enum: ['razorpay_subscription', 'razorpay_order', 'webhook', 'admin', 'customer', 'lifecycle_job', 'migration', 'system'],
    required: true,
    index: true
  },
  actor: {
    actorKey: { type: String, required: true, trim: true, maxlength: 200 },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    adminName: { type: String, trim: true, maxlength: 200, default: '' },
    role: { type: String, trim: true, maxlength: 100, default: '' },
    permissions: [{ type: String, maxlength: 150 }]
  },
  previousPlan: { type: String, default: '' },
  newPlan: { type: String, default: '' },
  previousExpiry: { type: Date, default: null },
  newExpiry: { type: Date, default: null },
  previousState: { type: mongoose.Schema.Types.Mixed, default: {} },
  newState: { type: mongoose.Schema.Types.Mixed, default: {} },
  amount: { type: Number, min: 0, default: null },
  currency: { type: String, uppercase: true, maxlength: 3, default: 'INR' },
  razorpay: {
    customerId: { type: String, default: '' },
    subscriptionId: { type: String, default: '' },
    planId: { type: String, default: '' },
    paymentId: { type: String, default: '' },
    orderId: { type: String, default: '' },
    invoiceId: { type: String, default: '' },
    refundId: { type: String, default: '' }
  },
  reason: { type: String, trim: true, maxlength: 1000, default: '' },
  ip: { type: String, maxlength: 200, default: '' },
  userAgent: { type: String, maxlength: 1000, default: '' },
  correlationId: { type: String, maxlength: 200, default: '', index: true },
  dedupeKey: { type: String, maxlength: 128, default: undefined },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  timestamp: { type: Date, default: Date.now, immutable: true, index: true }
}, { timestamps: { createdAt: true, updatedAt: false }, strict: true });

premiumMembershipEventSchema.index({ membership: 1, timestamp: -1, _id: -1 });
premiumMembershipEventSchema.index({ user: 1, timestamp: -1, _id: -1 });
premiumMembershipEventSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });

const immutableError = () => new Error('Premium membership events are immutable');
const rejectMutation = function(next) { next(immutableError()); };
[
  'updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace',
  'deleteOne', 'deleteMany', 'findOneAndDelete'
].forEach((hook) => premiumMembershipEventSchema.pre(hook, rejectMutation));
premiumMembershipEventSchema.pre('deleteOne', { document: true, query: false }, rejectMutation);
premiumMembershipEventSchema.pre('save', function(next) {
  if (!this.isNew) return next(immutableError());
  return next();
});
premiumMembershipEventSchema.pre('bulkWrite', function(next, operations) {
  if ((operations || []).some((operation) => !operation.insertOne)) return next(immutableError());
  return next();
});

module.exports = mongoose.models.PremiumMembershipEvent || mongoose.model('PremiumMembershipEvent', premiumMembershipEventSchema);
