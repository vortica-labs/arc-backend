const mongoose = require('mongoose');

const premiumMutationClaimSchema = new mongoose.Schema({
  actorKey: { type: String, required: true, trim: true, maxlength: 200 },
  operation: { type: String, required: true, trim: true, maxlength: 100 },
  keyHash: { type: String, required: true, maxlength: 64 },
  requestHash: { type: String, required: true, maxlength: 64 },
  membership: { type: mongoose.Schema.Types.ObjectId, ref: 'PremiumMembership', default: null },
  status: { type: String, enum: ['claimed', 'completed', 'failed'], default: 'claimed', index: true },
  claimedAt: { type: Date, default: Date.now, index: true },
  leaseExpiresAt: { type: Date, default: () => new Date(Date.now() + 10 * 60 * 1000), index: true },
  attempts: { type: Number, min: 1, default: 1 },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  errorCode: { type: String, maxlength: 100, default: '' },
  completedAt: { type: Date, default: null }
}, { timestamps: true });

premiumMutationClaimSchema.index(
  { actorKey: 1, operation: 1, keyHash: 1 },
  { unique: true, name: 'premium_mutation_idempotency' }
);
premiumMutationClaimSchema.index({ status: 1, leaseExpiresAt: 1 });

module.exports = mongoose.models.PremiumMutationClaim || mongoose.model('PremiumMutationClaim', premiumMutationClaimSchema);
