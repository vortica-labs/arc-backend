/**
 * Creator Earnings Calculation Service.
 * CPM-based earnings: (totalClipViews / 1000) × CPM per creator per cycle.
 * Stores final payable amount in EarningsSnapshot per payout cycle.
 */

const Post = require('../models/Post');
const User = require('../models/User');
const EarningsSnapshot = require('../models/EarningsSnapshot');
const PayoutCycle = require('../models/PayoutCycle');
const CreatorPayout = require('../models/CreatorPayout');
const { getOrganicViewCount } = require('./boostService');

// Platform keeps a share; kept for audit purposes
const PLATFORM_REVENUE_SHARE_PERCENT = 30;

/** Platform-wide default CPM (INR per 1,000 views) — overridden per creator by admin */
const PLATFORM_DEFAULT_CPM = Number(process.env.PLATFORM_DEFAULT_CPM) || 50;

/** Max payout per creator per cycle (INR) */
const MAX_PAYOUT_PER_CREATOR = Number(process.env.MAX_PAYOUT_PER_CREATOR) || 10000;

/**
 * Get current open payout cycle (monthly). Creates one if none exists.
 */
async function getOrCreateCurrentCycle() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const startDate = new Date(year, month, 1);
  const endDate = new Date(year, month + 1, 0, 23, 59, 59, 999);
  const cycleLabel = `${year}-${String(month + 1).padStart(2, '0')}`;

  let cycle = await PayoutCycle.findOne({ cycleLabel });
  if (!cycle) {
    cycle = await PayoutCycle.create({
      cycleLabel,
      periodType: 'monthly',
      startDate,
      endDate,
      status: 'open',
      minimumPayoutThreshold: 500
    });
  }
  return cycle;
}

/**
 * Calculate CPM-based earnings for one creator in a cycle.
 * Returns { amount, inputs } where amount is in INR (rounded to 2 decimal places).
 */
async function calculateCreatorEarnings(userId, cycle) {
  const user = await User.findById(userId).select('creatorCpm').lean();
  const cpm = (user?.creatorCpm != null && user.creatorCpm > 0)
    ? user.creatorCpm
    : PLATFORM_DEFAULT_CPM;

  const posts = await Post.find({
    author: userId,
    isActive: true,
    createdAt: { $gte: cycle.startDate, $lte: cycle.endDate },
    'content.media': { $elemMatch: { type: 'video' } }
  }).select('viewedBy views metrics boostMeta boostedAt').lean();

  const totalClipViews = posts.reduce((sum, p) => sum + getOrganicViewCount(p), 0);

  const amount = Math.round((totalClipViews / 1000) * cpm * 100) / 100;
  return {
    amount,
    inputs: {
      totalClipViews,
      totalOrganicClipViews: totalClipViews,
      cpm,
      platformSharePercent: PLATFORM_REVENUE_SHARE_PERCENT
    }
  };
}

/**
 * Run full CPM earnings calculation for a cycle: compute per-creator earnings,
 * cap at MAX_PAYOUT_PER_CREATOR, save EarningsSnapshot for each.
 */
async function runEarningsForCycle(cycleId) {
  const cycle = await PayoutCycle.findById(cycleId);
  if (!cycle || cycle.status !== 'open') {
    throw new Error('Cycle not found or not open');
  }

  const approvedCreators = await User.find({
    userType: 'player',
    isCreator: true,
    isActive: true
  }).select('_id').lean();

  for (const u of approvedCreators) {
    const { amount, inputs } = await calculateCreatorEarnings(u._id, cycle);
    const cappedAmount = Math.min(amount, MAX_PAYOUT_PER_CREATOR);

    await EarningsSnapshot.findOneAndUpdate(
      { user: u._id, payoutCycle: cycleId },
      {
        user: u._id,
        payoutCycle: cycleId,
        amount: cappedAmount,
        inputs,
        held: false,
        calculatedAt: new Date()
      },
      { upsert: true, new: true }
    );
  }

  return { creatorsProcessed: approvedCreators.length, cycleId };
}

/**
 * Get estimated earnings for current cycle for one creator (from snapshot or live CPM calc).
 */
async function getEstimatedEarningsForCreator(userId) {
  const cycle = await getOrCreateCurrentCycle();
  let snapshot = await EarningsSnapshot.findOne({ user: userId, payoutCycle: cycle._id }).lean();
  if (!snapshot) {
    const { amount, inputs } = await calculateCreatorEarnings(userId, cycle);
    const cappedAmount = Math.min(amount, MAX_PAYOUT_PER_CREATOR);
    return {
      amount: cappedAmount,
      cycleLabel: cycle.cycleLabel,
      cycleEndDate: cycle.endDate,
      inputs,
      isEstimate: true
    };
  }
  return {
    amount: snapshot.amount,
    cycleLabel: cycle.cycleLabel,
    cycleEndDate: cycle.endDate,
    inputs: snapshot.inputs,
    isEstimate: false,
    held: snapshot.held
  };
}

/**
 * Close the previous month's cycle: run earnings, then create CreatorPayout (pending) for each above threshold.
 * Call on 1st of each month (cron).
 */
async function closePreviousCycleAndCreatePayouts() {
  const now = new Date();
  const prevMonth = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const cycleLabel = `${year}-${String(prevMonth + 1).padStart(2, '0')}`;
  const cycle = await PayoutCycle.findOne({ cycleLabel });
  if (!cycle || cycle.status !== 'open') {
    return { done: false, reason: 'Cycle not found or already closed' };
  }
  await runEarningsForCycle(cycle._id);
  await PayoutCycle.findByIdAndUpdate(cycle._id, { status: 'closed' });
  const threshold = cycle.minimumPayoutThreshold ?? 500;
  const snapshots = await EarningsSnapshot.find({
    payoutCycle: cycle._id,
    held: { $ne: true },
    amount: { $gte: threshold }
  }).lean();
  for (const s of snapshots) {
    await CreatorPayout.findOneAndUpdate(
      { user: s.user, payoutCycle: cycle._id },
      {
        user: s.user,
        payoutCycle: cycle._id,
        amount: s.amount,
        status: 'pending'
      },
      { upsert: true }
    );
  }
  return { done: true, cycleLabel, payoutsCreated: snapshots.length };
}

module.exports = {
  getOrCreateCurrentCycle,
  calculateCreatorEarnings,
  runEarningsForCycle,
  getEstimatedEarningsForCreator,
  closePreviousCycleAndCreatePayouts,
  PLATFORM_DEFAULT_CPM,
  MAX_PAYOUT_PER_CREATOR,
  PLATFORM_REVENUE_SHARE_PERCENT
};
