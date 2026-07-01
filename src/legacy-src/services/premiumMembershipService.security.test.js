const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const PremiumMembership = require('../models/PremiumMembership');
const PaymentTransaction = require('../models/PaymentTransaction');
const provider = require('./razorpayPremiumProvider');
const service = require('./premiumMembershipService');

const originals = {
  membershipFindOne: PremiumMembership.findOne,
  transactionFindOne: PaymentTransaction.findOne,
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

  console.log('Premium membership service security tests passed');
}

run()
  .finally(() => {
    PremiumMembership.findOne = originals.membershipFindOne;
    PaymentTransaction.findOne = originals.transactionFindOne;
    provider.verifySubscriptionSignature = originals.verifySubscriptionSignature;
    provider.fetchSubscription = originals.fetchSubscription;
    provider.fetchPayment = originals.fetchPayment;
    provider.getConfiguredPlanId = originals.getConfiguredPlanId;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
