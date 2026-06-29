const Post = require('../models/Post');
const BoostCampaign = require('../models/BoostCampaign');

const FREQUENCY_HOURS = {
  daily: 24,
  weekly: 168,
  monthly: 720
};

function normalizeFrequency(frequency) {
  return Object.prototype.hasOwnProperty.call(FREQUENCY_HOURS, frequency) ? frequency : 'weekly';
}

function normalizeAudience({ targetPlayers = true, targetTeams = true, tags = [], regions = [] } = {}) {
  const players = targetPlayers !== false;
  const teams = targetTeams !== false;
  return {
    players: players || !teams,
    teams: teams || !players,
    tags: Array.isArray(tags) ? tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean).slice(0, 20) : [],
    regions: Array.isArray(regions) ? regions.map((region) => String(region).trim()).filter(Boolean).slice(0, 20) : []
  };
}

function calculateBoostPrice({ targetReach = 5000, frequency = 'weekly', targetPlayers = true, targetTeams = true } = {}) {
  const normalizedFrequency = normalizeFrequency(frequency);
  const reach = Math.min(50000, Math.max(500, parseInt(targetReach, 10) || 5000));
  const playersOnly = targetPlayers && !targetTeams;
  const teamsOnly = !targetPlayers && targetTeams;
  const impressionsPerRupee = playersOnly ? 13 : teamsOnly ? 8 : 11;
  const dailyPrice = Math.max(49, Math.ceil(reach / impressionsPerRupee));
  if (normalizedFrequency === 'daily') return dailyPrice;
  if (normalizedFrequency === 'weekly') return Math.ceil(dailyPrice * 5);
  return Math.ceil(dailyPrice * 18);
}

function estimateReachFromBudget({ amount, targetPlayers = true, targetTeams = true } = {}) {
  const playersOnly = targetPlayers && !targetTeams;
  const teamsOnly = !targetPlayers && targetTeams;
  const impressionsPerRupee = playersOnly ? 13 : teamsOnly ? 8 : 11;
  const budget = Math.max(0, Number(amount) || 0);
  return Math.max(0, Math.floor(budget * impressionsPerRupee));
}

function isActiveBoost(post, now = Date.now()) {
  const meta = post?.boostMeta || {};
  const endTime = meta.endTime || post?.boostExpiresAt;
  const remainingReach = Number(meta.remainingReach ?? 0);
  const status = meta.status || (post?.boostExpiresAt ? 'running' : undefined);
  return Boolean(
    status === 'running' &&
    endTime &&
    new Date(endTime).getTime() > now &&
    (remainingReach > 0 || !meta.activeCampaign)
  );
}

function getBoostScore(post, { mode = 'feed', now = Date.now() } = {}) {
  if (!isActiveBoost(post, now)) return 0;
  const meta = post.boostMeta || {};
  const purchasedReach = Number(meta.purchasedReach || meta.estimatedReach || 0);
  const remainingReach = Number(meta.remainingReach || 0);
  const budget = Number(meta.budget || 0);
  const totalSpend = Number(meta.totalSpend || 0);
  const remainingRatio = purchasedReach > 0 ? Math.max(0, Math.min(1, remainingReach / purchasedReach)) : 0.5;
  const spendRatio = budget > 0 ? Math.max(0, Math.min(1, totalSpend / budget)) : 0;
  const endTime = meta.endTime || post.boostExpiresAt;
  const hoursLeft = endTime ? Math.max(0, (new Date(endTime).getTime() - now) / 36e5) : 24;
  const urgency = hoursLeft < 8 ? 8 : hoursLeft < 24 ? 4 : 0;
  const budgetSignal = Math.min(16, Math.log10(Math.max(1, budget)) * 6);
  const reachSignal = Math.min(18, purchasedReach / 1000);
  const base = mode === 'clips' ? 20 : 16;
  return Math.min(70, base + budgetSignal + reachSignal + (remainingRatio * 14) + ((1 - spendRatio) * 8) + urgency);
}

function getDeliverySource(post, now = Date.now()) {
  return isActiveBoost(post, now) ? 'boost' : 'organic';
}

async function createPendingBoostCampaign({
  userId,
  postId,
  amount,
  frequency,
  targetReach,
  targetPlayers,
  targetTeams,
  razorpayOrderId,
  currency = 'INR'
}) {
  const normalizedFrequency = normalizeFrequency(frequency);
  const audience = normalizeAudience({ targetPlayers, targetTeams });
  const budget = Number(amount) || 0;
  const estimatedReach = estimateReachFromBudget({
    amount: budget,
    targetPlayers: audience.players,
    targetTeams: audience.teams
  });
  const requestedReach = Math.min(50000, Math.max(500, parseInt(targetReach, 10) || estimatedReach || 5000));
  const purchasedReach = Math.max(requestedReach, estimatedReach);
  const durationHours = FREQUENCY_HOURS[normalizedFrequency];

  return BoostCampaign.create({
    user: userId,
    post: postId,
    status: 'pending',
    budget,
    currency,
    frequency: normalizedFrequency,
    estimatedReach,
    purchasedReach,
    remainingReach: purchasedReach,
    dailySpend: normalizedFrequency === 'daily' ? budget : Math.round((budget / Math.max(1, durationHours / 24)) * 100) / 100,
    totalSpend: 0,
    targetAudience: audience,
    razorpayOrderId,
    metadata: {
      requestedReach
    }
  });
}

async function activateBoostCampaign({ campaign, paymentId, paymentAmount }) {
  const now = new Date();
  const durationHours = FREQUENCY_HOURS[normalizeFrequency(campaign.frequency)];
  const endTime = new Date(now.getTime() + durationHours * 60 * 60 * 1000);
  const totalSpend = Number(paymentAmount ?? campaign.budget) || campaign.budget;

  const updatedCampaign = await BoostCampaign.findByIdAndUpdate(
    campaign._id,
    {
      status: 'running',
      startTime: now,
      endTime,
      totalSpend,
      razorpayPaymentId: paymentId,
      remainingReach: Math.max(0, campaign.remainingReach ?? campaign.purchasedReach ?? 0)
    },
    { new: true }
  );

  await Post.findByIdAndUpdate(campaign.post, {
    boostedAt: now,
    boostExpiresAt: endTime,
    boostMeta: {
      activeCampaign: campaign._id,
      status: 'running',
      budget: campaign.budget,
      estimatedReach: campaign.estimatedReach,
      purchasedReach: campaign.purchasedReach,
      remainingReach: campaign.remainingReach ?? campaign.purchasedReach,
      dailySpend: campaign.dailySpend,
      totalSpend,
      startTime: now,
      endTime,
      targetAudience: campaign.targetAudience
    }
  });

  return updatedCampaign;
}

async function recordBoostDelivery(posts, context = 'feed') {
  const delivered = Array.isArray(posts) ? posts : [posts];
  const active = delivered.filter((post) => getDeliverySource(post) === 'boost' && post?.boostMeta?.activeCampaign);
  await Promise.all(active.map(async (post) => {
    const campaignId = post.boostMeta.activeCampaign;
    const campaignUpdate = await BoostCampaign.findOneAndUpdate(
      { _id: campaignId, status: 'running', remainingReach: { $gt: 0 } },
      {
        $inc: {
          remainingReach: -1,
          'analytics.boostReach': 1,
          'analytics.impressions': 1
        },
        $set: { 'metadata.lastDeliveryContext': context }
      },
      { new: true }
    );
    if (campaignUpdate) {
      await Post.updateOne(
        { _id: post._id, 'boostMeta.activeCampaign': campaignId, 'boostMeta.remainingReach': { $gt: 0 } },
        {
          $inc: {
            'boostMeta.remainingReach': -1,
            'metrics.boostReach': 1
          }
        }
      );
      if (campaignUpdate.remainingReach <= 0) {
        await BoostCampaign.updateOne(
          { _id: campaignId },
          { status: 'completed' }
        );
        await Post.updateOne(
          { _id: post._id, 'boostMeta.activeCampaign': campaignId },
          {
            $set: {
              'boostMeta.status': 'completed',
              'boostMeta.remainingReach': 0
            }
          }
        );
      }
    }
  }));
}

async function applyManualDeliveryProgress(campaign) {
  if (!campaign || !campaign.manualDelivery?.enabled || campaign.deliveryMode !== 'manual') {
    return campaign;
  }

  if (!['running', 'paused'].includes(campaign.status)) {
    return campaign;
  }

  const targetViews = Math.max(
    0,
    Number(campaign.manualDelivery.targetViews || campaign.purchasedReach || campaign.estimatedReach || 0)
  );
  const startedAt = campaign.manualDelivery.startedAt || campaign.startTime;
  const endsAt = campaign.manualDelivery.endsAt || campaign.endTime;

  if (!targetViews || !startedAt || !endsAt) {
    return campaign;
  }

  const nowMs = Date.now();
  const startMs = new Date(startedAt).getTime();
  const endMs = new Date(endsAt).getTime();
  const durationMs = Math.max(1, endMs - startMs);
  const elapsedRatio = campaign.status === 'paused'
    ? Math.max(0, Math.min(1, (new Date(campaign.manualDelivery.lastAppliedAt || startedAt).getTime() - startMs) / durationMs))
    : Math.max(0, Math.min(1, (nowMs - startMs) / durationMs));
  const expectedDelivered = Math.min(targetViews, Math.floor(targetViews * elapsedRatio));
  const alreadyDelivered = Math.max(0, Number(campaign.manualDelivery.deliveredViews || 0));
  const delta = Math.max(0, expectedDelivered - alreadyDelivered);
  const nextDelivered = alreadyDelivered + delta;
  const nextRemaining = Math.max(0, targetViews - nextDelivered);
  const deliveryPercent = targetViews > 0 ? Math.min(100, Math.round((nextDelivered / targetViews) * 10000) / 100) : 0;
  const shouldComplete = nextRemaining <= 0 || nowMs >= endMs;

  const update = {
    $set: {
      'manualDelivery.lastAppliedAt': new Date(),
      'manualDelivery.deliveredViews': nextDelivered,
      'manualDelivery.remainingViews': nextRemaining,
      'manualDelivery.deliveryPercent': deliveryPercent,
      remainingReach: nextRemaining,
      'analytics.boostViews': nextDelivered,
      'analytics.boostReach': Math.max(Number(campaign.analytics?.boostReach || 0), nextDelivered),
      'metadata.lastManualDeliveryAt': new Date()
    }
  };

  if (shouldComplete) {
    update.$set.status = 'completed';
    update.$set.remainingReach = 0;
    update.$set['manualDelivery.remainingViews'] = 0;
    update.$set['manualDelivery.deliveryPercent'] = 100;
  }

  const updatedCampaign = await BoostCampaign.findByIdAndUpdate(campaign._id, update, { new: true });

  if (delta > 0) {
    await Post.updateOne(
      { _id: campaign.post },
      {
        $inc: {
          views: delta,
          'metrics.boostViews': delta,
          'metrics.boostReach': delta
        },
        $set: {
          'boostMeta.remainingReach': nextRemaining,
          'boostMeta.status': shouldComplete ? 'completed' : 'running'
        }
      }
    );
  } else if (shouldComplete) {
    await Post.updateOne(
      { _id: campaign.post },
      {
        $set: {
          'boostMeta.remainingReach': 0,
          'boostMeta.status': 'completed'
        }
      }
    );
  }

  return updatedCampaign || campaign;
}

function getOrganicViewCount(post) {
  const explicit = post?.metrics && Number(post.metrics.organicViews);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (post?.metrics && Object.prototype.hasOwnProperty.call(post.metrics, 'organicViews')) return 0;
  if (post?.boostedAt || post?.boostMeta?.activeCampaign) return 0;
  return Math.max(
    Array.isArray(post?.viewedBy) ? post.viewedBy.length : 0,
    Number(post?.views) || 0
  );
}

module.exports = {
  FREQUENCY_HOURS,
  normalizeFrequency,
  normalizeAudience,
  calculateBoostPrice,
  estimateReachFromBudget,
  isActiveBoost,
  getBoostScore,
  getDeliverySource,
  createPendingBoostCampaign,
  activateBoostCampaign,
  recordBoostDelivery,
  applyManualDeliveryProgress,
  getOrganicViewCount
};
