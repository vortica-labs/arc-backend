const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const PremiumMembership = require('../models/PremiumMembership');
const PremiumMembershipEvent = require('../models/PremiumMembershipEvent');
const PremiumMutationClaim = require('../models/PremiumMutationClaim');
const PaymentTransaction = require('../models/PaymentTransaction');
const AdminAuditLog = require('../models/AdminAuditLog');
const {
  deriveExpiry,
  validateMembershipDates,
} = require('./premiumMembershipService');

const userId = new mongoose.Types.ObjectId();

const membership = new PremiumMembership({
  user: userId,
  accountType: 'player',
  planKey: 'player_pro',
  planTier: 'player_pro',
  billingPeriod: 'monthly',
  source: 'manual',
  membershipStatus: 'active',
  startedAt: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: new Date('2026-02-01T00:00:00.000Z'),
});
assert.equal(membership.razorpay.subscriptionId, undefined);
assert.equal(membership.razorpay.paymentId, undefined);
assert.equal(membership.razorpay.orderId, undefined);

const transaction = new PaymentTransaction({
  user: userId,
  type: 'subscription',
  amount: 0,
});
assert.equal(transaction.providerPaymentId, undefined);
assert.equal(transaction.providerSubscriptionId, undefined);

const paymentIdIndex = PaymentTransaction.schema.indexes().find(
  ([keys, options]) => keys.providerPaymentId === 1 && options.unique,
);
assert.ok(paymentIdIndex, 'provider payment IDs must have a unique index');
assert.equal(
  paymentIdIndex[1].partialFilterExpression.providerPaymentId.$gt,
  '',
  'empty provider IDs must not participate in the unique index',
);

const eventHooks = PremiumMembershipEvent.schema.s.hooks._pres;
for (const operation of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
  'bulkWrite',
]) {
  assert.ok(eventHooks.get(operation)?.length, `${operation} must be blocked for immutable events`);
}
assert.ok(
  eventHooks.get('deleteOne').some((hook) => hook.document === true && hook.query === false),
  'document.deleteOne must be blocked in addition to query deletes',
);

const auditHooks = AdminAuditLog.schema.s.hooks._pres;
assert.ok(
  auditHooks.get('deleteOne').some((hook) => hook.document === true && hook.query === false),
  'durable admin audit intents/outcomes must block document.deleteOne',
);
assert.ok(auditHooks.get('bulkWrite')?.length, 'durable admin audit records must block mutating bulk writes');

const claim = new PremiumMutationClaim({
  actorKey: 'admin:test',
  operation: 'grant',
  keyHash: 'a'.repeat(64),
  requestHash: 'b'.repeat(64),
});
assert.ok(claim.leaseExpiresAt instanceof Date);
assert.ok(claim.leaseExpiresAt > claim.claimedAt, 'mutation claims need a recoverable lease');

assert.equal(
  deriveExpiry(new Date('2024-01-31T12:00:00.000Z'), 'monthly').toISOString(),
  '2024-02-29T12:00:00.000Z',
  'monthly expiry must clamp at the end of shorter months',
);
assert.throws(
  () => validateMembershipDates({
    startAt: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: new Date('2026-02-01T00:00:00.000Z'),
    billingPeriod: 'lifetime',
  }),
  /cannot have an expiry/i,
);
assert.throws(
  () => validateMembershipDates({
    startAt: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: null,
    billingPeriod: 'monthly',
  }),
  /require an expiry/i,
);

console.log('Premium membership model security tests passed');
