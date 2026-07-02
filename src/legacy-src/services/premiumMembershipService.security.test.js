const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const PremiumMembership = require('../models/PremiumMembership');
const PaymentTransaction = require('../models/PaymentTransaction');
const provider = require('./razorpayPremiumProvider');
const service = require('./premiumMembershipService');

const originals = {
  membershipFindOne: PremiumMembership.findOne,
  membershipFindById: PremiumMembership.findById,
  transactionFindOne: PaymentTransaction.findOne,
  transactionFindById: PaymentTransaction.findById,
  transactionUpdateOne: PaymentTransaction.updateOne,
  verifySubscriptionSignature: provider.verifySubscriptionSignature,
  fetchSubscription: provider.fetchSubscription,
  fetchPayment: provider.fetchPayment,
  getConfiguredPlanId: provider.getConfiguredPlanId,
};

const makeMembership = () => {
  const membership = new PremiumMembership({
    _id: new mongoose.Types.ObjectId(),
    user: new mongoose.Types.ObjectId(),
    isCurrent: true,
    accountType: 'player',
    planKey: 'player_pro',
    planTier: 'player_pro',
    billingPeriod: 'monthly',
    source: 'razorpay_subscription',
    membershipStatus: 'trial',
    subscriptionStatus: 'created',
    startedAt: new Date('2026-07-01T00:00:00.000Z'),
    currentPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-08-01T00:00:00.000Z'),
    expiresAt: new Date('2026-08-01T00:00:00.000Z'),
    razorpay: {
      subscriptionId: 'sub_security123',
      planId: 'plan_security123',
    },
  });
  let saveCalls = 0;
  membership.save = async () => {
    saveCalls += 1;
    return membership;
  };
  return { membership, saveCalls: () => saveCalls };
};

async function run() {
  provider.verifySubscriptionSignature = () => true;
  provider.getConfiguredPlanId = () => 'plan_security123';
  PaymentTransaction.findOne = async () => null;

  {
    const fixture = makeMembership();
    PremiumMembership.findOne = async () => fixture.membership;
    provider.fetchSubscription = async () => ({
      id: 'sub_security123',
      plan_id: 'plan_security123',
      status: 'cancelled',
      notes: {
        userId: String(fixture.membership.user),
        planKey: 'player_pro',
        billingPeriod: 'monthly',
      },
    });
    provider.fetchPayment = async () => ({
      id: 'pay_security123',
      status: 'captured',
      subscription_id: 'sub_security123',
      amount: 9900,
      currency: 'INR',
    });

    await assert.rejects(
      service.verifyRecurringSubscription({
        userId: fixture.membership.user,
        subscriptionId: 'sub_security123',
        paymentId: 'pay_security123',
        signature: 'a'.repeat(64),
      }),
      (error) => error?.code === 'SUBSCRIPTION_NOT_ACTIVATABLE',
      'a valid historical checkout signature must not reactivate a cancelled subscription',
    );
    assert.equal(fixture.saveCalls(), 0, 'rejected provider state must not write the membership');
  }

  {
    const fixture = makeMembership();
    fixture.membership.membershipStatus = 'active';
    fixture.membership.subscriptionStatus = 'active';
    PremiumMembership.findOne = async () => fixture.membership;

    await assert.rejects(
      service.processWebhookPayload({
        eventId: 'event_wrong_amount',
        eventType: 'subscription.charged',
        providerCreatedAt: new Date('2026-07-02T00:00:00.000Z'),
        payload: {
          subscription: {
            entity: {
              id: 'sub_security123',
              plan_id: 'plan_security123',
              status: 'active',
              current_start: 1782864000,
              current_end: 1785542400,
            },
          },
          payment: {
            entity: {
              id: 'pay_wrong_amount',
              status: 'captured',
              subscription_id: 'sub_security123',
              amount: 100,
              currency: 'INR',
            },
          },
        },
      }),
      (error) => error?.code === 'PAYMENT_AMOUNT_MISMATCH',
      'a signed webhook cannot mutate entitlement before server-price validation',
    );
    assert.equal(fixture.saveCalls(), 0, 'wrong-amount webhook must fail before membership.save');
  }

  {
    const fixture = makeMembership();
    fixture.membership.source = 'manual';
    fixture.membership.membershipStatus = 'active';
    fixture.membership.subscriptionStatus = 'not_applicable';
    fixture.membership.razorpay = {};
    PremiumMembership.findOne = async () => null;
    PremiumMembership.findById = async () => fixture.membership;
    PaymentTransaction.findOne = async () => ({
      _id: new mongoose.Types.ObjectId(),
      membership: fixture.membership._id,
      providerPaymentId: 'pay_old_generation',
      providerSubscriptionId: 'sub_old_generation',
    });

    const result = await service.processWebhookPayload({
      eventId: 'event_old_generation',
      eventType: 'subscription.charged',
      providerCreatedAt: new Date('2026-07-03T00:00:00.000Z'),
      payload: {
        subscription: { entity: { id: 'sub_old_generation', plan_id: 'plan_security123', status: 'active' } },
        payment: { entity: { id: 'pay_old_generation', status: 'captured', subscription_id: 'sub_old_generation', amount: 9900, currency: 'INR' } },
      },
    });

    assert.equal(result.reason, 'stale_subscription_generation');
    assert.equal(fixture.saveCalls(), 0, 'an old subscription event must not overwrite a current manual grant');
    assert.equal(
      service.transactionOwnsCurrentProviderEntitlement(fixture.membership, { providerSubscriptionId: 'sub_old_generation' }),
      false,
      'a provider refund must never own manual entitlement',
    );
    assert.equal(
      service.transactionOwnsCurrentProviderEntitlement(
        { isCurrent: true, source: 'migration', razorpay: {} },
        { providerPaymentId: 'pay_old_generation' },
      ),
      false,
      'a provider refund must never own migrated entitlement',
    );
    assert.equal(
      service.transactionOwnsCurrentProviderEntitlement(
        { isCurrent: true, source: 'razorpay_subscription', razorpay: { subscriptionId: 'sub_current' } },
        { providerSubscriptionId: 'sub_current' },
      ),
      true,
      'a recurring refund owns entitlement only through the exact current subscription binding',
    );
  }

  {
    const transactionId = new mongoose.Types.ObjectId();
    const state = {
      _id: transactionId,
      amount: 100,
      capturedAmount: 100,
      refundedAmount: 0,
      refundReservedAmount: 0,
      refundStatus: 'none',
      status: 'completed',
      providerRefundId: '',
      refundStateVersion: 0,
      refundHistory: [],
    };
    const snapshot = () => ({
      ...state,
      refundHistory: state.refundHistory.map((entry) => ({ ...entry })),
    });
    let initialReads = 0;
    let releaseInitialReads;
    const initialReadBarrier = new Promise((resolve) => { releaseInitialReads = resolve; });
    let releaseFailedWrite;
    const failedWrite = new Promise((resolve) => { releaseFailedWrite = resolve; });

    PaymentTransaction.findById = async () => {
      if (initialReads < 2) {
        const staleSnapshot = snapshot();
        initialReads += 1;
        if (initialReads === 2) releaseInitialReads();
        await initialReadBarrier;
        return staleSnapshot;
      }
      return snapshot();
    };
    PaymentTransaction.updateOne = async (filter, update) => {
      assert.equal(Array.isArray(update), false, 'refund CAS must use DocumentDB 5 compatible classic updates');
      if (!filter.refundHistory && !filter['refundHistory.refundId']) {
        const versionMatches = filter.refundStateVersion !== undefined
          ? state.refundStateVersion === filter.refundStateVersion
          : filter.$or?.some((entry) =>
            entry.refundStateVersion === state.refundStateVersion ||
            (entry.refundStateVersion?.$exists === false && state.refundStateVersion === undefined));
        if (!versionMatches) return { matchedCount: 0, modifiedCount: 0 };
        Object.assign(state, update.$set || {});
        return { matchedCount: 1, modifiedCount: 1 };
      }

      const desiredStatus = update.$push?.refundHistory?.status || update.$set?.['refundHistory.$.status'];
      if (desiredStatus === 'processed' && update.$push) await failedWrite;
      const elemMatch = filter.refundHistory?.$elemMatch;
      const existingIndex = state.refundHistory.findIndex((entry) => entry.refundId === 'rfnd_concurrent');
      const matches = elemMatch
        ? existingIndex >= 0 && state.refundHistory[existingIndex].status === elemMatch.status
        : existingIndex < 0;
      if (!matches) return { modifiedCount: 0 };

      if (update.$push) state.refundHistory.push({ ...update.$push.refundHistory });
      const target = state.refundHistory.find((entry) => entry.refundId === 'rfnd_concurrent');
      if (update.$set?.['refundHistory.$.status']) target.status = update.$set['refundHistory.$.status'];
      if (update.$set?.['refundHistory.$.reservedAmount'] !== undefined) {
        target.reservedAmount = update.$set['refundHistory.$.reservedAmount'];
      }
      if (update.$set?.providerRefundId) state.providerRefundId = update.$set.providerRefundId;
      for (const [field, increment] of Object.entries(update.$inc || {})) state[field] += increment;
      if (desiredStatus === 'failed') releaseFailedWrite();
      return { modifiedCount: 1 };
    };

    const refund = { id: 'rfnd_concurrent', payment_id: 'pay_concurrent', amount: 10000 };
    const [failedResult, processedResult] = await Promise.all([
      service.transitionRefundTransaction({ transactionId, refund, status: 'failed', amount: 100 }),
      service.transitionRefundTransaction({ transactionId, refund, status: 'processed', amount: 100 }),
    ]);

    assert.equal(failedResult.effectiveStatus === 'failed' || failedResult.effectiveStatus === 'processed', true);
    assert.equal(processedResult.effectiveStatus, 'processed', 'processed must repair a concurrent failed winner');
    assert.equal(state.refundHistory.length, 1, 'the same provider refund must be recorded once');
    assert.equal(state.refundHistory[0].status, 'processed', 'failed may never dominate processed');
    assert.equal(state.refundedAmount, 100, 'the processed amount must be counted exactly once');
    assert.equal(state.refundStatus, 'full');
    assert.equal(state.status, 'refunded');
  }

  console.log('Premium membership service security tests passed');
}

run()
  .finally(() => {
    PremiumMembership.findOne = originals.membershipFindOne;
    PremiumMembership.findById = originals.membershipFindById;
    PaymentTransaction.findOne = originals.transactionFindOne;
    PaymentTransaction.findById = originals.transactionFindById;
    PaymentTransaction.updateOne = originals.transactionUpdateOne;
    provider.verifySubscriptionSignature = originals.verifySubscriptionSignature;
    provider.fetchSubscription = originals.fetchSubscription;
    provider.fetchPayment = originals.fetchPayment;
    provider.getConfiguredPlanId = originals.getConfiguredPlanId;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
