const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const provider = require('./razorpayPremiumProvider');
const service = require('./premiumMembershipService');
const PremiumMembership = require('../models/PremiumMembership');
const PremiumMembershipEvent = require('../models/PremiumMembershipEvent');
const PremiumMutationClaim = require('../models/PremiumMutationClaim');
const PaymentTransaction = require('../models/PaymentTransaction');

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
};

test('signature checks require exact SHA-256 hex and use documented checkout order', () => {
  const previous = process.env.RAZORPAY_KEY_SECRET;
  process.env.RAZORPAY_KEY_SECRET = 'test-secret';
  const orderId = 'order_contract';
  const paymentId = 'pay_contract';
  const orderSignature = crypto.createHmac('sha256', 'test-secret').update(`${orderId}|${paymentId}`).digest('hex');
  const subscriptionSignature = crypto.createHmac('sha256', 'test-secret').update(`${paymentId}|sub_contract`).digest('hex');
  assert.strictEqual(provider.verifyOrderSignature({ orderId, paymentId, signature: orderSignature }), true);
  assert.strictEqual(provider.verifySubscriptionSignature({ subscriptionId: 'sub_contract', paymentId, signature: subscriptionSignature }), true);
  assert.strictEqual(provider.timingSafeHexEqual('a'.repeat(64), `${'a'.repeat(63)}0`), false);
  assert.strictEqual(provider.timingSafeHexEqual('aa', 'aa0'), false);
  if (previous === undefined) delete process.env.RAZORPAY_KEY_SECRET;
  else process.env.RAZORPAY_KEY_SECRET = previous;
});

test('provider snapshot redaction truncates depth and removes credential-shaped fields', () => {
  const snapshot = provider.sanitizeProviderSnapshot({
    payment: { card: { number: '4111111111111111' } },
    a: { b: { c: { d: { e: { f: { token: 'secret' } } } } } }
  });
  assert.strictEqual(snapshot.payment.card, '[REDACTED]');
  assert.strictEqual(snapshot.a.b.c.d.e.f, '[TRUNCATED]');
});

test('billing terms derive clamped expiries and enforce lifetime invariants', () => {
  const january31 = new Date('2026-01-31T12:00:00.000Z');
  assert.strictEqual(service.deriveExpiry(january31, 'monthly').toISOString(), '2026-02-28T12:00:00.000Z');
  assert.strictEqual(service.deriveExpiry(january31, 'lifetime'), null);
  assert.throws(
    () => service.validateMembershipDates({ startAt: january31, expiresAt: new Date('2027-01-01'), billingPeriod: 'lifetime' }),
    /cannot have an expiry/
  );
  assert.throws(
    () => service.validateMembershipDates({ startAt: new Date(Date.now() + 60000), expiresAt: new Date(Date.now() + 120000), billingPeriod: 'monthly', immediateGrant: true }),
    /cannot be in the future/
  );
});

test('hardcoded admin actors retain deterministic identity and audit context', () => {
  const actor = service.actorFromRequestUser(
    { _id: null, username: 'RootAdmin', adminRole: 'super_admin', adminPermissions: ['*'] },
    'admin',
    { ip: '127.0.0.1', userAgent: 'contract-test', correlationId: 'correlation-1' }
  );
  assert.strictEqual(actor.actorKey, 'hardcoded:rootadmin');
  assert.strictEqual(actor.adminId, null);
  assert.strictEqual(actor.correlationId, 'correlation-1');
  assert.deepStrictEqual(actor.permissions, ['*']);
});

test('provider terminal states cannot preserve or reactivate access', () => {
  const future = new Date(Date.now() + 86400000);
  assert.strictEqual(service.providerStatusToMembership('pending', future), 'active');
  assert.strictEqual(service.providerStatusToMembership('halted', future), 'active');
  assert.strictEqual(service.providerStatusToMembership('cancelled', future), 'cancelled');
  assert.strictEqual(service.providerStatusToMembership('completed', future), 'expired');
  assert.strictEqual(service.providerBoolean(undefined, true), true);
  assert.strictEqual(service.providerBoolean(0, true), false);
});

test('immediate escalation reuses an existing provider cancellation request', () => {
  const source = fs.readFileSync(__filename.replace(/\.test\.js$/, '.js'), 'utf8');
  const cancellation = source.slice(source.indexOf('const cancelMembership ='), source.indexOf('const removeMembership ='));
  assert(cancellation.includes('providerCancellationAlreadyScheduled'));
  assert(cancellation.includes("mode === 'immediate' && providerCancellationAlreadyScheduled"));
  assert.strictEqual(service.shouldPreserveTerminalReconciliationState({ membershipStatus: 'cancelled', subscriptionStatus: 'cancelled' }, 'active'), true);
  assert.strictEqual(service.shouldPreserveTerminalReconciliationState({ membershipStatus: 'cancelled', subscriptionStatus: 'cancelled' }, 'cancelled'), false);
  assert.strictEqual(service.shouldPreserveTerminalReconciliationState({ membershipStatus: 'active', subscriptionStatus: 'active' }, 'active'), false);
  assert.strictEqual(service.shouldPreserveImmediateCancellationEnd({ membershipStatus: 'cancelled', subscriptionStatus: 'cancelled', cancelAtCycleEnd: false, endedAt: new Date() }), true);
});

test('canonical schemas declare one-current, provider, payment, and mutation uniqueness', () => {
  const membershipIndexes = PremiumMembership.schema.indexes();
  const current = membershipIndexes.find(([key, options]) => key.user === 1 && Object.keys(key).length === 1 && options.unique);
  assert(current?.[1]?.unique);
  assert.deepStrictEqual(current[1].partialFilterExpression, { isCurrent: true });
  const subscription = membershipIndexes.find(([key]) => key['razorpay.subscriptionId'] === 1);
  assert(subscription?.[1]?.unique);
  assert.strictEqual(subscription[1].partialFilterExpression['razorpay.subscriptionId'].$gt, '');
  const paymentIndex = PaymentTransaction.schema.indexes().find(([key]) => key.providerPaymentId === 1);
  assert(paymentIndex?.[1]?.unique);
  const mutationIndex = PremiumMutationClaim.schema.indexes().find(([key]) => key.actorKey === 1 && key.operation === 1 && key.keyHash === 1);
  assert(mutationIndex?.[1]?.unique);
});

test('immutable event and admin audit models reject query, document, and bulk mutations', () => {
  const backendRoot = path.resolve(__dirname, '..', '..');
  const eventSource = fs.readFileSync(path.join(backendRoot, 'legacy-src', 'models', 'PremiumMembershipEvent.js'), 'utf8');
  const auditSource = fs.readFileSync(path.join(backendRoot, 'legacy-src', 'models', 'AdminAuditLog.js'), 'utf8');
  for (const source of [eventSource, auditSource]) {
    assert(source.includes("pre('deleteOne', { document: true, query: false }"));
    assert(source.includes("pre('bulkWrite'"));
    assert(source.includes('!operation.insertOne'));
  }
  assert(PremiumMembershipEvent.schema.path('timestamp').options.immutable);
});

test('admin routes enforce premium RBAC, mutation idempotency audit, and legacy delegation', () => {
  const backendRoot = path.resolve(__dirname, '..', '..');
  const routes = fs.readFileSync(path.join(backendRoot, 'modules', 'admin', 'premium-membership.routes.ts'), 'utf8');
  const adminRoutes = fs.readFileSync(path.join(backendRoot, 'modules', 'admin', 'admin.routes.ts'), 'utf8');
  const auth = fs.readFileSync(path.join(backendRoot, 'legacy-src', 'middleware', 'adminAuth.js'), 'utf8');
  assert(routes.includes('requireAdminPermission("premium:read")'));
  assert(routes.includes('requireAdminPermission("premium:cancel")'));
  assert(routes.includes('requireAdminPermission("premium:refund")'));
  assert(routes.includes('durableMutationAudit'));
  assert(adminRoutes.includes('premiumMembershipController.legacyGrant'));
  assert(adminRoutes.includes('premiumMembershipController.legacyRemove'));
  assert(!adminRoutes.includes('requireAdminPermission("users:manage"), adminController.grantPremium'));
  assert(auth.includes("'premium:read'"));
});

test('raw webhook capture and customer route aliases preserve the signed byte contract', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const app = fs.readFileSync(path.join(root, 'src', 'app.ts'), 'utf8');
  const paymentRoutes = fs.readFileSync(path.join(root, 'src', 'modules', 'payments', 'payments.routes.ts'), 'utf8');
  const membershipRoutes = fs.readFileSync(path.join(root, 'src', 'modules', 'membership', 'membership.routes.ts'), 'utf8');
  assert(app.includes('/api/payments/razorpay/webhook'));
  assert(app.includes('rawBody = Buffer.from(buffer)'));
  assert(paymentRoutes.indexOf('/razorpay/webhook') < paymentRoutes.indexOf('/history'));
  assert(paymentRoutes.includes('/subscription/verify-recurring'));
  assert(membershipRoutes.includes('/subscription/verify'));
  assert(paymentRoutes.includes('customerPaymentLimiter'));
  assert(membershipRoutes.includes('paymentMutationLimiter'));
});

test('webhook validates captured subscription bindings before membership mutation', () => {
  const source = fs.readFileSync(__filename.replace(/\.test\.js$/, '.js'), 'utf8');
  const block = source.slice(source.indexOf('const applySubscriptionEvent ='), source.indexOf('const applyRefundEvent ='));
  assert(block.indexOf('assertProviderAmount') < block.indexOf('await safeMembershipUpdate'));
  assert(block.includes("payment.subscription_id !== subscription.id"));
  assert(block.includes('pendingActivated'));
  assert(block.includes("expired: 'expiration'"));
});

test('refund flow reserves balance, reconciles stale/pending work, and protects newer funding', () => {
  const source = fs.readFileSync(__filename.replace(/\.test\.js$/, '.js'), 'utf8');
  const refund = source.slice(source.indexOf('const refundMembershipPayment ='), source.indexOf('const providerStatusToMembership ='));
  assert(refund.includes('refundReservedAmount'));
  assert(refund.includes('refundLockReceipt'));
  assert(refund.includes('newerFundingExists'));
  assert(refund.includes('processed && fullRefund'));
  assert(refund.includes('transitionRefundTransaction'));
  assert(refund.includes('transactionOwnsCurrentProviderEntitlement'));
  assert(!refund.includes('racedEntry'));
  assert(source.includes('const reconcileStaleRefundLocks ='));
  assert(source.includes('const reconcilePendingRefunds ='));
  assert(source.includes('fetchPaymentRefunds'));
  const subscriptionWebhook = source.slice(source.indexOf('const applySubscriptionEvent ='), source.indexOf('const recomputeRefundSummary ='));
  assert(subscriptionWebhook.includes("membership.source !== 'razorpay_subscription'"));
  assert(subscriptionWebhook.includes('membership.razorpay?.subscriptionId !== subscription.id'));
});

test('entitlement projection does not mint credits during reconciliation', () => {
  const source = fs.readFileSync(__filename.replace(/\.test\.js$/, '.js'), 'utf8');
  const projection = source.slice(source.indexOf('const projectEntitlement ='), source.indexOf('const grantPeriodCredits ='));
  assert(!projection.includes("'membership.credits': credits"));
  const grants = source.slice(source.indexOf('const grantPeriodCredits ='), source.indexOf('const safeMembershipUpdate ='));
  assert(grants.indexOf("User.updateOne") < grants.lastIndexOf("'metadata.lastCreditGrantKey'"));
  assert(source.includes('`payment:${paymentId}:credits`'));
});

test('list, dashboard, detail and payment serializers are allowlisted for admin consumers', () => {
  const source = fs.readFileSync(__filename.replace(/\.test\.js$/, '.js'), 'utf8');
  for (const key of ['totalPremiumUsers', 'activePremiumUsers', 'expiredPremiumUsers', 'cancelledSubscriptions', 'premiumPurchasedToday', 'lifetimePremiumRevenue']) {
    assert(source.includes(key));
  }
  const dashboard = source.slice(source.indexOf('const getDashboard ='), source.indexOf('const getMembershipDetails ='));
  assert(dashboard.includes("{ paidAt: { $gte: since } }"), 'revenue windows must use payment time rather than processing time');
  const serializer = source.slice(source.indexOf('const serializeMembership ='), source.indexOf('const snapshotState ='));
  assert(!serializer.includes('providerSnapshot:'));
  assert(!serializer.includes('metadata:'));
  const paymentSerializer = source.slice(source.indexOf('const serializePaymentTransaction ='), source.indexOf('const listPayments ='));
  assert(!paymentSerializer.includes('refundLockToken'));
  assert(!paymentSerializer.includes('refundLockReceipt'));
  assert(!paymentSerializer.includes('refundStateVersion'));
  assert(!paymentSerializer.includes('metadata:'));
  const serializedPayment = service.serializePaymentTransaction({
    _id: new mongoose.Types.ObjectId(),
    amount: 99,
    currency: 'INR',
    status: 'completed',
    refundHistory: [],
    refundLockToken: 'internal-token',
    refundLockReceipt: 'internal-receipt',
    refundStateVersion: 12,
    metadata: { secret: true },
    user: new mongoose.Types.ObjectId(),
  });
  for (const forbidden of ['refundLockToken', 'refundLockReceipt', 'refundStateVersion', 'metadata', 'user']) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(serializedPayment, forbidden), false);
  }
  const controller = fs.readFileSync(path.resolve(__dirname, '..', 'controllers', 'premiumMembershipController.js'), 'utf8');
  assert(controller.includes('service.serializePaymentTransaction(value.transaction)'));
  assert(!controller.includes('{ ...value, membership:'));
  const listing = source.slice(source.indexOf('const listMemberships ='), source.indexOf('const getDashboard ='));
  assert(listing.includes('PaymentTransaction.find'));
  for (const identifier of ['paymentId', 'orderId', 'providerPaymentId', 'providerOrderId', 'providerSubscriptionId', 'providerRefundId']) {
    assert(listing.includes(`{ ${identifier}: pattern }`));
  }
  assert(listing.includes(".select('user membership')"));
  assert(source.includes('loginHistory: {'));
  assert(source.includes('available: true'));
  assert(source.includes('/login-history`'));
});

test('lifecycle worker avoids expiring auto-renew subscriptions and uses provider claims', () => {
  const source = fs.readFileSync(__filename.replace(/\.test\.js$/, '.js'), 'utf8');
  const lifecycle = source.slice(source.indexOf('const processLifecycleBatch ='));
  assert(lifecycle.includes("source: { $ne: 'razorpay_subscription' }"));
  assert(lifecycle.includes('{ autoRenew: false }'));
  assert(lifecycle.includes("'reconciliation.claimToken': claimToken"));
  assert(lifecycle.includes('refundLocksReconciled'));
});

test('signed payment events recover captured checkout and record failures without access grants', () => {
  const source = fs.readFileSync(__filename.replace(/\.test\.js$/, '.js'), 'utf8');
  const failed = source.slice(source.indexOf('const recordFailedWebhookPayment ='), source.indexOf('const createRecurringSubscription ='));
  assert(failed.includes("status: 'failed'"));
  assert(!failed.includes('projectEntitlement('));
  assert(source.includes("eventType === 'payment.captured'"));
  assert(source.includes("eventType === 'payment.failed'"));
  assert(source.includes("reason: 'non_premium_payment'"));
});

test('recurring checkout preflights provider configuration and refund reconciliation precedes projection', () => {
  const source = fs.readFileSync(__filename.replace(/\.test\.js$/, '.js'), 'utf8');
  const recurring = source.slice(source.indexOf('const createRecurringSubscription ='), source.indexOf('const verifyRecurringSubscription ='));
  assert(recurring.indexOf('provider.getConfiguredPlanId') < recurring.indexOf('upsertCurrentMembership'));
  assert(recurring.indexOf('provider.getClient()') < recurring.indexOf('upsertCurrentMembership'));

  const reconciliation = source.slice(source.indexOf('const reconcileMembership ='), source.indexOf('const processLifecycleBatch ='));
  assert(reconciliation.indexOf('reconcilePendingRefunds') < reconciliation.indexOf('projectEntitlement'));
  assert(reconciliation.includes('PremiumMembership.findById(membership._id)'));
});

test('production scripts cover explicit indexes, dry-run migration, and lifecycle startup', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert(packageJson.scripts['migrate:premium-indexes']);
  assert(packageJson.scripts['verify:premium-indexes']);
  assert(packageJson.scripts['backfill:premium']);
  assert(packageJson.scripts['test:premium']);
  const server = fs.readFileSync(path.join(root, 'src', 'server.ts'), 'utf8');
  assert(server.includes('startPremiumMembershipCron'));
  assert(server.includes('stopPremiumMembershipCron'));
});

test('operator premium scripts delegate entitlement changes to the canonical service', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  for (const relative of [
    'src/legacy-src/scripts/assign-premium.js',
    'src/legacy-src/scripts/remove-premium.js',
    'src/legacy-src/scripts/seed-premium-user.js',
  ]) {
    const script = fs.readFileSync(path.join(root, relative), 'utf8');
    assert(script.includes("require('../services/premiumMembershipService')"));
    assert(!script.includes('user.isPremium = true'));
    assert(!script.includes('user.isPremium = false'));
    assert(!script.includes("user.membership.tier = 'free'"));
  }
});

console.log(`Premium membership backend contracts passed (${passed})`);
