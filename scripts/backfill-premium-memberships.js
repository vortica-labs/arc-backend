#!/usr/bin/env node
require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');

const legacyRoot = path.resolve(__dirname, '..', 'src', 'legacy-src');
const User = require(path.join(legacyRoot, 'models', 'User.js'));
const PaymentTransaction = require(path.join(legacyRoot, 'models', 'PaymentTransaction.js'));
const PremiumMembership = require(path.join(legacyRoot, 'models', 'PremiumMembership.js'));
const service = require(path.join(legacyRoot, 'services', 'premiumMembershipService.js'));

const apply = process.argv.includes('--apply');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Math.max(1, Number(limitArg.split('=')[1]) || 1) : Number.POSITIVE_INFINITY;
const VALID_PLANS = new Set(['player_pro', 'player_pro_plus', 'team_pro', 'team_org']);
const VALID_PERIODS = new Set(['monthly', 'quarterly', 'yearly', 'lifetime']);

const derivedExpiry = (start, period) => service.deriveExpiry(start, period === 'lifetime' ? 'monthly' : period);
const inferPeriod = (transaction, expiresAt, startedAt) => {
  const explicit = transaction?.metadata?.billingPeriod;
  if (VALID_PERIODS.has(explicit)) return explicit;
  if (!expiresAt) return null;
  const days = Math.max(1, (expiresAt.getTime() - startedAt.getTime()) / 86400000);
  if (days > 300) return 'yearly';
  if (days > 60) return 'quarterly';
  return 'monthly';
};

async function repairMembership(user, existing, transaction) {
  const payments = await PaymentTransaction.find({ user: user._id, type: 'subscription' }).sort({ paidAt: 1, createdAt: 1 }).lean();
  if (apply) {
    await PaymentTransaction.updateMany(
      { user: user._id, type: 'subscription', $or: [{ membership: null }, { membership: { $exists: false } }] },
      { $set: { membership: existing._id, referenceId: existing._id, referenceType: 'membership' } }
    );
    await service.projectEntitlement(existing);
    await service.appendEvent({
      membership: existing,
      action: 'synchronization',
      source: 'migration',
      actor: service.systemActor('migration:premium-backfill'),
      dedupeKey: `migration:${user._id}`,
      metadata: { backfilled: true, attachedPayments: payments.length }
    });
  }
  return payments.length;
}

async function run() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  await mongoose.connect(process.env.MONGODB_URI);
  const paymentUserIds = await PaymentTransaction.distinct('user', { type: 'subscription' });
  const query = {
    $or: [
      { isPremium: true },
      { 'membership.tier': { $in: Array.from(VALID_PLANS) } },
      { _id: { $in: paymentUserIds } }
    ]
  };
  const cursor = User.find(query)
    .select('_id userType isPremium membership createdAt')
    .sort({ _id: 1 })
    .lean()
    .cursor();

  const stats = {
    mode: apply ? 'apply' : 'dry-run', scanned: 0, wouldCreate: 0, created: 0,
    repaired: 0, attachedPayments: 0, skipped: 0, errors: 0
  };
  for await (const user of cursor) {
    if (stats.scanned >= limit) break;
    stats.scanned += 1;
    try {
      const latest = await PaymentTransaction.findOne({ user: user._id, type: 'subscription' }).sort({ paidAt: -1, createdAt: -1 }).lean();
      const existing = await PremiumMembership.findOne({ user: user._id, isCurrent: true });
      if (existing) {
        stats.attachedPayments += await repairMembership(user, existing, latest);
        stats.repaired += 1;
        continue;
      }

      const planKey = VALID_PLANS.has(user.membership?.tier)
        ? user.membership.tier
        : (VALID_PLANS.has(latest?.metadata?.planId) ? latest.metadata.planId : latest?.metadata?.tier);
      if (!VALID_PLANS.has(planKey)) {
        stats.skipped += 1;
        continue;
      }

      let expiresAt = user.membership?.validUntil ? new Date(user.membership.validUntil) : null;
      let startedAt = new Date(latest?.paidAt || latest?.createdAt || user.createdAt || Date.now());
      let billingPeriod = inferPeriod(latest, expiresAt, startedAt);
      const explicitlyActiveNoExpiry = user.isPremium === true && !expiresAt && !latest;
      if (explicitlyActiveNoExpiry) {
        billingPeriod = 'lifetime';
      } else {
        billingPeriod = billingPeriod && billingPeriod !== 'lifetime' ? billingPeriod : 'monthly';
        if (!expiresAt) expiresAt = derivedExpiry(startedAt, billingPeriod);
      }
      if (expiresAt && startedAt >= expiresAt) startedAt = new Date(expiresAt.getTime() - 30 * 86400000);

      let membershipStatus;
      if (latest?.status === 'refunded') membershipStatus = 'refunded';
      else if (!user.isPremium && (!expiresAt || expiresAt <= new Date())) membershipStatus = 'expired';
      else if (!user.isPremium) membershipStatus = 'cancelled';
      else membershipStatus = expiresAt && expiresAt <= new Date() ? 'expired' : 'active';

      const values = {
        user: user._id,
        isCurrent: true,
        accountType: user.userType === 'team' ? 'team' : (user.userType === 'creator' ? 'creator' : 'player'),
        planKey,
        planTier: planKey,
        billingPeriod,
        source: latest?.paymentId || latest?.orderId ? 'razorpay_order' : 'migration',
        platform: latest?.platform || 'unknown',
        membershipStatus,
        subscriptionStatus: 'not_applicable',
        autoRenew: false,
        startedAt,
        currentPeriodStart: startedAt,
        currentPeriodEnd: expiresAt,
        expiresAt,
        endedAt: ['expired', 'cancelled', 'refunded'].includes(membershipStatus) ? (expiresAt || new Date()) : null,
        lastPaymentAt: latest?.paidAt || latest?.createdAt || null,
        amount: Number(latest?.amount || 0),
        currency: latest?.currency || 'INR',
        razorpay: {
          paymentId: latest?.providerPaymentId || latest?.paymentId || undefined,
          orderId: latest?.providerOrderId || latest?.orderId || undefined
        },
        metadata: { backfilled: true, billingPeriodInferred: !VALID_PERIODS.has(latest?.metadata?.billingPeriod) }
      };
      stats.wouldCreate += 1;
      if (!apply) continue;
      let membership;
      try {
        membership = await PremiumMembership.create(values);
      } catch (error) {
        if (error?.code !== 11000) throw error;
        membership = await PremiumMembership.findOne({ user: user._id, isCurrent: true });
        if (!membership) throw error;
      }
      stats.attachedPayments += await repairMembership(user, membership, latest);
      stats.created += 1;
    } catch (error) {
      stats.errors += 1;
      console.error('[Premium Backfill] user failed', { userId: String(user._id), code: error?.code || 'UNKNOWN', message: error?.message || String(error) });
    }
  }
  console.log(JSON.stringify(stats, null, 2));
  await mongoose.disconnect();
  if (stats.errors) process.exitCode = 1;
}

run().catch(async (error) => {
  console.error('[Premium Backfill] fatal', error.message);
  await mongoose.disconnect().catch(() => null);
  process.exitCode = 1;
});
