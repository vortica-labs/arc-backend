/**
 * Eligibility Calculation Engine for creator monetization.
 * Runs on profile load and daily cron. Eligibility ≠ approval.
 */

const User = require('../models/User');
const Post = require('../models/Post');
const Report = require('../models/Report');
const MonetizationEligibility = require('../models/MonetizationEligibility');
const { getOrganicViewCount } = require('./boostService');

// Configurable thresholds (short-form clip creator monetization)
const THRESHOLDS = {
  minFollowers: 1000,
  minTotalClipViews45d: 100000,
  minClipsWith3kViews45d: 5,
  minActiveDays45d: 25,
  minCreatorHealthScore: 75
};

/**
 * Compute eligibility for a user. Returns { isEligible, failedConditions, progress_percent, metrics }.
 * @param {string|ObjectId} userId
 * @returns {Promise<{ isEligible: boolean, failedConditions: array, progressPercent: number, metrics: object }>}
 */
async function calculateEligibility(userId) {
  const user = await User.findById(userId).select('createdAt followers membership').lean();
  if (!user) {
    return {
      isEligible: false,
      failedConditions: [{ condition: 'account', current: null, required: 'exists', progressPercent: 0 }],
      progressPercent: 0,
      metrics: {}
    };
  }

  const followersCount = (user.followers && user.followers.length) || 0;
  const membershipTier = user.membership?.tier || 'free';
  const membershipValidUntil = user.membership?.validUntil || null;
  const membershipExpired = membershipValidUntil ? new Date(membershipValidUntil) < new Date() : false;
  const hasActivePremiumMembership = membershipTier !== 'free' && !membershipExpired;

  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - 45);

  // Clips in last 45 days: posts with at least one video
  const clips = await Post.find({
    author: userId,
    isActive: true,
    hiddenByAdmin: { $ne: true },
    createdAt: { $gte: sinceDate },
    'content.media': { $elemMatch: { type: 'video' } }
  })
    .select('content.text viewedBy views metrics boostMeta boostedAt createdAt')
    .lean();

  const viewCounts = clips.map(getOrganicViewCount);
  const totalClipViews45d = viewCounts.reduce((sum, val) => sum + val, 0);
  const clipsWith3kViews45d = viewCounts.filter((v) => v >= 3000).length;

  const activeDaysSet = new Set(
    clips.map((clip) => new Date(clip.createdAt).toISOString().slice(0, 10))
  );
  const activeDays45d = activeDaysSet.size;

  // Creator health: penalize policy violations, reused captions, and low-quality captions
  const userPostIds = await Post.find({ author: userId }).select('_id').lean().then(p => p.map(x => x._id));
  const violationReports = await Report.countDocuments({
    targetType: { $in: ['post', 'comment'] },
    status: 'action_taken',
    targetId: { $in: userPostIds }
  });
  const userReported = await Report.countDocuments({
    targetType: 'user',
    targetId: userId,
    status: 'action_taken'
  });
  const totalPolicyViolations = violationReports + userReported;

  const normalizedTexts = clips
    .map((clip) => (clip.content?.text || '').toLowerCase().replace(/\s+/g, ' ').trim())
    .filter((text) => text.length > 0);
  const textCounts = normalizedTexts.reduce((acc, text) => {
    acc[text] = (acc[text] || 0) + 1;
    return acc;
  }, {});
  const duplicateCount = Object.values(textCounts).reduce((sum, count) => sum + (count > 1 ? count - 1 : 0), 0);
  const duplicateRatio = normalizedTexts.length > 0 ? duplicateCount / normalizedTexts.length : 0;

  const lowQualityCount = clips.filter((clip) => (clip.content?.text || '').trim().length < 10).length;
  const lowQualityRatio = clips.length > 0 ? lowQualityCount / clips.length : 0;

  let creatorHealthScore = 100;
  creatorHealthScore -= Math.min(60, totalPolicyViolations * 20);
  if (duplicateRatio >= 0.3) creatorHealthScore -= 20;
  else if (duplicateRatio >= 0.15) creatorHealthScore -= 10;
  if (lowQualityRatio >= 0.3) creatorHealthScore -= 15;
  else if (lowQualityRatio >= 0.15) creatorHealthScore -= 8;
  creatorHealthScore = Math.max(0, Math.min(100, Math.round(creatorHealthScore)));

  const sortedViews = [...viewCounts].sort((a, b) => a - b);
  const medianView = sortedViews.length
    ? sortedViews[Math.floor(sortedViews.length / 2)]
    : 0;
  const maxView = viewCounts.length ? Math.max(...viewCounts) : 0;
  const suspiciousViewSpike =
    viewCounts.length >= 3 &&
    maxView >= 20000 &&
    (medianView > 0 ? maxView >= medianView * 10 : maxView >= 50000) &&
    (totalClipViews45d > 0 ? maxView / totalClipViews45d >= 0.7 : false);

  const metrics = {
    followersCount,
    hasActivePremiumMembership,
    totalOrganicClipViews45d: totalClipViews45d,
    totalClipViews45d,
    clipsWith3kViews45d,
    clipsWith3kOrganicViews45d: clipsWith3kViews45d,
    activeDays45d,
    creatorHealthScore,
    suspiciousViewSpike,
    policyViolations: totalPolicyViolations,
    lowQualityRatio: Math.round(lowQualityRatio * 100) / 100,
    duplicateRatio: Math.round(duplicateRatio * 100) / 100
  };

  const failedConditions = [];
  let progressSum = 0;
  const numConditions = 6;

  // Active premium membership
  const membershipProgress = hasActivePremiumMembership ? 100 : 0;
  if (!hasActivePremiumMembership) {
    failedConditions.push({
      condition: 'active_premium_membership',
      current: hasActivePremiumMembership ? 1 : 0,
      required: 1,
      progressPercent: membershipProgress
    });
  }
  progressSum += membershipProgress;

  // Followers
  const followerProgress = Math.min(100, (followersCount / THRESHOLDS.minFollowers) * 100);
  if (followersCount < THRESHOLDS.minFollowers) {
    failedConditions.push({
      condition: 'min_followers',
      current: followersCount,
      required: THRESHOLDS.minFollowers,
      progressPercent: Math.round(followerProgress)
    });
  }
  progressSum += followerProgress;

  // Total clip views (last 45 days)
  const totalViewsProgress = Math.min(100, (totalClipViews45d / THRESHOLDS.minTotalClipViews45d) * 100);
  if (totalClipViews45d < THRESHOLDS.minTotalClipViews45d) {
    failedConditions.push({
      condition: 'min_total_clip_views_45d',
      current: totalClipViews45d,
      required: THRESHOLDS.minTotalClipViews45d,
      progressPercent: Math.round(totalViewsProgress)
    });
  }
  progressSum += totalViewsProgress;

  // High-performing clips (>= 3k views each, last 45 days)
  const highClipProgress = Math.min(100, (clipsWith3kViews45d / THRESHOLDS.minClipsWith3kViews45d) * 100);
  if (clipsWith3kViews45d < THRESHOLDS.minClipsWith3kViews45d) {
    failedConditions.push({
      condition: 'min_high_performing_clips_45d',
      current: clipsWith3kViews45d,
      required: THRESHOLDS.minClipsWith3kViews45d,
      progressPercent: Math.round(highClipProgress)
    });
  }
  progressSum += highClipProgress;

  // Active days (last 45 days)
  const activeDaysProgress = Math.min(100, (activeDays45d / THRESHOLDS.minActiveDays45d) * 100);
  if (activeDays45d < THRESHOLDS.minActiveDays45d) {
    failedConditions.push({
      condition: 'min_active_days_45d',
      current: activeDays45d,
      required: THRESHOLDS.minActiveDays45d,
      progressPercent: Math.round(activeDaysProgress)
    });
  }
  progressSum += activeDaysProgress;

  // Creator health
  const healthProgress = Math.min(100, (creatorHealthScore / THRESHOLDS.minCreatorHealthScore) * 100);
  if (creatorHealthScore < THRESHOLDS.minCreatorHealthScore) {
    failedConditions.push({
      condition: 'min_creator_health_score',
      current: creatorHealthScore,
      required: THRESHOLDS.minCreatorHealthScore,
      progressPercent: Math.round(healthProgress)
    });
  }
  progressSum += healthProgress;

  const progressPercent = Math.round(progressSum / numConditions);
  const isEligible = failedConditions.length === 0;

  return {
    isEligible,
    failedConditions,
    progressPercent,
    metrics
  };
}

/**
 * Get or compute and cache eligibility for a user.
 * @param {string|ObjectId} userId
 * @param {boolean} forceRecalculate - if true, recompute and update cache
 */
async function getOrComputeEligibility(userId, forceRecalculate = false) {
  if (!userId) return null;

  const cached = await MonetizationEligibility.findOne({ user: userId }).lean();
  const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours
  const isStale = !cached || (Date.now() - new Date(cached.lastCalculatedAt).getTime() > maxAgeMs);

  if (cached && !forceRecalculate && !isStale) {
    return {
      isEligible: cached.isEligible,
      failedConditions: cached.failedConditions || [],
      progressPercent: cached.progressPercent ?? 0,
      metrics: cached.metrics || {},
      lastCalculatedAt: cached.lastCalculatedAt
    };
  }

  const result = await calculateEligibility(userId);
  await MonetizationEligibility.findOneAndUpdate(
    { user: userId },
    {
      user: userId,
      isEligible: result.isEligible,
      failedConditions: result.failedConditions,
      progressPercent: result.progressPercent,
      metrics: result.metrics,
      lastCalculatedAt: new Date()
    },
    { upsert: true, new: true }
  );

  return {
    ...result,
    lastCalculatedAt: new Date()
  };
}

/**
 * Run eligibility for all player users (for daily cron). Updates cache only.
 */
async function runEligibilityForAllPlayers() {
  const users = await User.find({ userType: 'player', isActive: true }).select('_id').lean();
  let updated = 0;
  for (const u of users) {
    try {
      const result = await calculateEligibility(u._id);
      await MonetizationEligibility.findOneAndUpdate(
        { user: u._id },
        {
          user: u._id,
          isEligible: result.isEligible,
          failedConditions: result.failedConditions,
          progressPercent: result.progressPercent,
          metrics: result.metrics,
          lastCalculatedAt: new Date()
        },
        { upsert: true }
      );
      updated++;
    } catch (err) {
      console.error('Eligibility run error for user', u._id, err.message);
    }
  }
  return { processed: users.length, updated };
}

module.exports = {
  calculateEligibility,
  getOrComputeEligibility,
  runEligibilityForAllPlayers,
  THRESHOLDS
};
