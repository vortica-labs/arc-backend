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

function getPricingTierFromBudget(budget = 0) {
  const amount = Number(budget) || 0;
  if (amount <= 499) return 'starter';
  if (amount <= 1999) return 'growth';
  if (amount <= 9999) return 'pro';
  return 'custom';
}

function toDateMs(value, fallback = Date.now()) {
  const ms = value ? new Date(value).getTime() : fallback;
  return Number.isFinite(ms) ? ms : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - (2 * t));
}

function hashToUnit(seed) {
  let hash = 2166136261;
  const input = String(seed);
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 100000) / 100000;
}

function getMinuteBucket(date = new Date()) {
  return String(Math.floor(new Date(date).getTime() / 60000));
}

function getTimelineEntry(type, {
  views = 0,
  deliveredViews = 0,
  remainingViews = 0,
  progress = 0,
  message = '',
  reason = '',
  previousValue = null,
  newValue = null,
  actor = { username: 'system', role: 'system' }
} = {}) {
  return {
    type,
    views,
    deliveredViews,
    remainingViews,
    progress,
    message,
    reason,
    previousValue,
    newValue,
    actor: {
      username: actor?.username || 'system',
      role: actor?.role || 'system'
    },
    createdAt: new Date()
  };
}

function calculateManualDeliveryBatch({
  campaignId,
  targetViews,
  deliveredViews,
  startedAt,
  endsAt,
  now = new Date(),
  lastDeliveryBucket
}) {
  const target = Math.max(0, Math.floor(Number(targetViews) || 0));
  const delivered = clamp(Math.floor(Number(deliveredViews) || 0), 0, target);
  const remaining = Math.max(0, target - delivered);
  const bucket = getMinuteBucket(now);

  if (!target || !remaining) {
    return {
      bucket,
      delta: 0,
      shouldComplete: true,
      nextDelivered: delivered,
      nextRemaining: remaining,
      progress: target > 0 ? 100 : 0,
      deliverySpeedPerHour: 0,
      estimatedCompletionAt: now
    };
  }

  if (lastDeliveryBucket && String(lastDeliveryBucket) === bucket) {
    return {
      bucket,
      delta: 0,
      shouldComplete: false,
      nextDelivered: delivered,
      nextRemaining: remaining,
      progress: Math.round((delivered / target) * 10000) / 100,
      deliverySpeedPerHour: 0,
      estimatedCompletionAt: endsAt
    };
  }

  const nowMs = toDateMs(now);
  const startMs = toDateMs(startedAt, nowMs);
  const endMs = Math.max(startMs + 60000, toDateMs(endsAt, startMs + 60000));
  const durationMs = Math.max(60000, endMs - startMs);
  const elapsedMs = clamp(nowMs - startMs, 0, durationMs);
  const elapsedRatio = elapsedMs / durationMs;
  const completeByTime = nowMs >= endMs;

  const curve = smoothstep(elapsedRatio);
  const jitterWindow = Math.max(1, Math.floor(target * 0.018));
  const jitter = Math.round((hashToUnit(`${campaignId}:${bucket}:jitter`) - 0.5) * jitterWindow);
  const expectedDelivered = completeByTime
    ? target
    : clamp(Math.floor(target * curve) + jitter, 0, target);

  let delta = Math.max(0, expectedDelivered - delivered);
  const totalMinutes = Math.max(1, Math.ceil(durationMs / 60000));
  const averagePerMinute = target / totalMinutes;
  const minBatch = Math.max(1, Math.floor(averagePerMinute * 0.35));
  const maxBatch = Math.max(minBatch, Math.ceil(averagePerMinute * 1.85));
  const skipChance = hashToUnit(`${campaignId}:${bucket}:skip`);
  const shouldSkip = !completeByTime && delta <= minBatch && skipChance < 0.28 && remaining > maxBatch;

  if (shouldSkip) {
    delta = 0;
  } else if (!completeByTime && delta > 0) {
    const batchJitter = 0.7 + (hashToUnit(`${campaignId}:${bucket}:batch`) * 0.9);
    const naturalCap = Math.max(1, Math.ceil(maxBatch * batchJitter));
    delta = clamp(delta, Math.min(minBatch, remaining), Math.min(naturalCap, remaining));
  }

  if (completeByTime) {
    delta = remaining;
  }

  const nextDelivered = clamp(delivered + delta, 0, target);
  const nextRemaining = Math.max(0, target - nextDelivered);
  const progress = target > 0 ? Math.min(100, Math.round((nextDelivered / target) * 10000) / 100) : 0;
  const elapsedHours = Math.max(1 / 60, elapsedMs / 36e5);
  const deliverySpeedPerHour = Math.round((nextDelivered / elapsedHours) * 100) / 100;
  const estimatedCompletionAt = delta > 0 && nextRemaining > 0
    ? new Date(nowMs + ((nextRemaining / Math.max(1, deliverySpeedPerHour)) * 36e5))
    : new Date(endMs);

  return {
    bucket,
    delta,
    shouldComplete: nextRemaining <= 0 || completeByTime,
    nextDelivered,
    nextRemaining,
    progress,
    deliverySpeedPerHour,
    estimatedCompletionAt
  };
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
    pricingTier: getPricingTierFromBudget(budget),
    paymentStatus: 'pending',
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
  const post = await Post.findById(campaign.post).select('content.media postType').lean();
  const hasVideo = Array.isArray(post?.content?.media)
    ? post.content.media.some((media) => media?.type === 'video')
    : post?.postType === 'clip';

  const updatedCampaign = await BoostCampaign.findByIdAndUpdate(
    campaign._id,
    {
      status: 'running',
      campaignType: hasVideo ? 'clip' : 'post',
      pricingTier: getPricingTierFromBudget(campaign.budget),
      paymentStatus: 'paid',
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

async function processSingleManualBoostCampaign(campaign, { now = new Date(), actor } = {}) {
  if (!campaign || !campaign.manualDelivery?.enabled || campaign.deliveryMode !== 'manual') {
    return campaign;
  }

  const manualStatus = campaign.manualDelivery.status || campaign.status;
  if (!['scheduled', 'running'].includes(manualStatus) || !['running', 'pending'].includes(campaign.status)) {
    return campaign;
  }

  const targetViews = Math.max(
    0,
    Number(campaign.manualDelivery.targetViews || campaign.purchasedReach || campaign.estimatedReach || 0)
  );
  const scheduledStartAt = campaign.manualDelivery.scheduledStartAt || campaign.manualDelivery.startedAt || campaign.startTime;
  const nowMs = toDateMs(now);
  const scheduledMs = toDateMs(scheduledStartAt, nowMs);

  if (!targetViews || scheduledMs > nowMs) {
    return campaign;
  }

  const startedAt = campaign.manualDelivery.startedAt || scheduledStartAt || now;
  const durationMinutes = Number(campaign.manualDelivery.durationMinutes) ||
    Math.max(1, Math.round((Number(campaign.manualDelivery.durationHours || 0) || 1) * 60));
  const endsAt = campaign.manualDelivery.endsAt ||
    new Date(toDateMs(startedAt, nowMs) + (durationMinutes * 60000));
  const alreadyDelivered = Math.max(0, Number(campaign.manualDelivery.deliveredViews || 0));
  const batch = calculateManualDeliveryBatch({
    campaignId: campaign._id,
    targetViews,
    deliveredViews: alreadyDelivered,
    startedAt,
    endsAt,
    now,
    lastDeliveryBucket: campaign.manualDelivery.lastDeliveryBucket
  });

  const timelineEntries = [];
  const startedBefore = Boolean(campaign.manualDelivery.startedAt);
  if (!startedBefore || manualStatus === 'scheduled') {
    timelineEntries.push(getTimelineEntry('started', {
      deliveredViews: alreadyDelivered,
      remainingViews: Math.max(0, targetViews - alreadyDelivered),
      progress: targetViews ? Math.round((alreadyDelivered / targetViews) * 10000) / 100 : 0,
      message: 'Manual boost delivery started.',
      actor
    }));
  }

  if (batch.delta > 0) {
    timelineEntries.push(getTimelineEntry('batch', {
      views: batch.delta,
      deliveredViews: batch.nextDelivered,
      remainingViews: batch.nextRemaining,
      progress: batch.progress,
      message: `Delivered ${batch.delta} boost views.`,
      actor
    }));
  }

  if (batch.shouldComplete) {
    timelineEntries.push(getTimelineEntry('completed', {
      deliveredViews: batch.nextDelivered,
      remainingViews: 0,
      progress: 100,
      message: 'Manual boost delivery completed.',
      actor
    }));
  }

  const update = {
    $set: {
      status: batch.shouldComplete ? 'completed' : 'running',
      startTime: campaign.startTime || startedAt || now,
      endTime: endsAt,
      remainingReach: batch.nextRemaining,
      'manualDelivery.status': batch.shouldComplete ? 'completed' : 'running',
      'manualDelivery.startedAt': campaign.manualDelivery.startedAt || startedAt || now,
      'manualDelivery.endsAt': endsAt,
      'manualDelivery.actualCompletedAt': batch.shouldComplete ? now : campaign.manualDelivery.actualCompletedAt,
      'manualDelivery.lastAppliedAt': now,
      'manualDelivery.lastDeliveryBucket': batch.bucket,
      'manualDelivery.deliveredViews': batch.nextDelivered,
      'manualDelivery.remainingViews': batch.nextRemaining,
      'manualDelivery.deliveryPercent': batch.shouldComplete ? 100 : batch.progress,
      'manualDelivery.deliverySpeedPerHour': batch.deliverySpeedPerHour,
      'manualDelivery.estimatedCompletionAt': batch.shouldComplete ? now : batch.estimatedCompletionAt,
      'analytics.boostViews': batch.nextDelivered,
      'analytics.boostReach': Math.max(Number(campaign.analytics?.boostReach || 0), batch.nextDelivered),
      'metadata.lastManualDeliveryAt': now
    }
  };

  if (timelineEntries.length > 0) {
    update.$push = {
      'manualDelivery.timeline': {
        $each: timelineEntries,
        $slice: -200
      }
    };
  }

  const updateQuery = {
    _id: campaign._id,
    deliveryMode: 'manual',
    'manualDelivery.enabled': true,
    $or: [
      { 'manualDelivery.lastDeliveryBucket': { $exists: false } },
      { 'manualDelivery.lastDeliveryBucket': null },
      { 'manualDelivery.lastDeliveryBucket': { $ne: batch.bucket } }
    ]
  };

  const updatedCampaign = await BoostCampaign.findOneAndUpdate(updateQuery, update, { new: true });

  if (!updatedCampaign) {
    return campaign;
  }

  if (batch.delta > 0) {
    await Post.updateOne(
      { _id: campaign.post },
      {
        $inc: {
          views: batch.delta,
          'metrics.boostViews': batch.delta,
          'metrics.boostReach': batch.delta
        },
        $set: {
          'boostMeta.remainingReach': batch.nextRemaining,
          'boostMeta.status': batch.shouldComplete ? 'completed' : 'running'
        }
      }
    );
  } else if (batch.shouldComplete) {
    await Post.updateOne(
      { _id: campaign.post },
      {
        $set: {
          'boostMeta.remainingReach': 0,
          'boostMeta.status': 'completed'
        }
      }
    );
  } else if (!startedBefore || manualStatus === 'scheduled') {
    await Post.updateOne(
      { _id: campaign.post },
      {
        $set: {
          'boostMeta.remainingReach': batch.nextRemaining,
          'boostMeta.status': 'running'
        }
      }
    );
  }

  return updatedCampaign;
}

async function processDueManualBoostDeliveries({ limit = 100, now = new Date() } = {}) {
  const dueCampaigns = await BoostCampaign.find({
    deliveryMode: 'manual',
    'manualDelivery.enabled': true,
    'manualDelivery.status': { $in: ['scheduled', 'running'] },
    $or: [
      { 'manualDelivery.scheduledStartAt': { $lte: now } },
      { 'manualDelivery.scheduledStartAt': { $exists: false } },
      { 'manualDelivery.scheduledStartAt': null }
    ]
  })
    .sort({ 'manualDelivery.scheduledStartAt': 1, createdAt: 1 })
    .limit(limit);

  const results = await Promise.allSettled(dueCampaigns.map((campaign) => processSingleManualBoostCampaign(campaign, { now })));
  return {
    scanned: dueCampaigns.length,
    processed: results.filter((result) => result.status === 'fulfilled').length,
    failed: results.filter((result) => result.status === 'rejected').length
  };
}

async function applyManualDeliveryProgress(campaign) {
  return processSingleManualBoostCampaign(campaign);
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
  getPricingTierFromBudget,
  calculateManualDeliveryBatch,
  createPendingBoostCampaign,
  activateBoostCampaign,
  recordBoostDelivery,
  processSingleManualBoostCampaign,
  processDueManualBoostDeliveries,
  applyManualDeliveryProgress,
  getOrganicViewCount
};
