const mongoose = require('mongoose');
const Post = require('../models/Post');
const User = require('../models/User');
const Follow = require('../models/Follow');
const FollowRequest = require('../models/FollowRequest');
const PostEngagement = require('../models/PostEngagement');
const BoostDeliveryAttribution = require('../models/BoostDeliveryAttribution');
const { formatPostDTO } = require('../utils/dto');
const { resolveClientMediaPayload } = require('../utils/privateMediaDelivery');
const { buildPrivacyAccess } = require('../utils/privacyPolicy');
const { normalizeTag } = require('../utils/hashtags');
const log = require('../utils/logger');
const { getBoostScore, isActiveBoost, getDeliverySource, recordBoostDelivery } = require('./boostService');

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 30;
const MAX_EXCLUDED_IDS = 120;
const CANDIDATE_MULTIPLIER = 8;
// Seen-post cooldown: recently delivered posts are strongly down-ranked and
// recover eligibility gradually — never permanently hidden.
const SEEN_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const SEEN_COOLDOWN_HOURS = 36;
const SEEN_PENALTY_BASE = 85;
const SEEN_PENALTY_HALF_LIFE_HOURS = 7;
const SEEN_FETCH_LIMIT = 400;
// Explicit actions on the exact post must not turn into a positive feedback
// loop where the author/tag affinity wins and immediately serves that same
// post again. The affinity still helps discover other posts from that author
// or topic; this bounded, decaying penalty applies only to the item acted on.
const INTERACTION_COOLDOWN_HOURS = 7 * 24;
const INTERACTION_PENALTY_BASE = 180;
const INTERACTION_PENALTY_HALF_LIFE_HOURS = 24;
const DIRECT_INTERACTION_TYPES = new Set(['like', 'comment', 'share', 'save']);
// A generic seen penalty affects every item delivered on a page almost
// equally. Preserve its long-lived exposure control, but add a short-lived
// positional penalty so the previous session's first few items do not keep
// winning by the same margin on every explicit refresh.
const TOP_POSITION_PENALTY_BASE = [125, 70, 35];
const TOP_POSITION_PENALTY_HALF_LIFE_HOURS = 2;
const TOP_POSITION_PENALTY_WINDOW_HOURS = 8;
// Boosted delivery fairness: a campaign keeps its paid score bonus, but not
// for the same viewer back-to-back, and never more than one boosted slot in
// the first page window.
const BOOST_USER_COOLDOWN_HOURS = 6;
const BOOST_FREQUENCY_CAP = 4;
const BOOST_TOP_WINDOW = 5;
const NEW_POST_KICKER_HOURS = 6;
const MAX_SESSION_SEED_LENGTH = 64;
const MAX_ENGAGEMENT_DURATION_MS = 24 * 60 * 60 * 1000;
const ENGAGEMENT_CONTEXTS = new Set(['feed', 'clips', 'profile', 'search', 'post', 'unknown']);
const ENGAGEMENT_CONTEXT_ALIASES = new Map([
  ['team_profile', 'profile'],
  ['team-profile', 'profile'],
  ['profile-saved', 'profile'],
  ['profile_saved', 'profile'],
  ['profile-liked', 'profile'],
  ['profile_liked', 'profile'],
  ['post-card', 'feed'],
  ['post_card', 'feed'],
  ['post-detail', 'post'],
  ['post_detail', 'post'],
  ['saved', 'profile']
]);

function normalizeEngagementDuration(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.floor(parsed), MAX_ENGAGEMENT_DURATION_MS);
}

function normalizeCompletionRate(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, 1);
}

function normalizeEngagementContext(value) {
  if (typeof value !== 'string') return 'unknown';
  const normalized = value.trim().toLowerCase();
  return ENGAGEMENT_CONTEXT_ALIASES.get(normalized)
    || (ENGAGEMENT_CONTEXTS.has(normalized) ? normalized : 'unknown');
}

function buildViewEngagementUpdate(payload, updatedAt = new Date()) {
  const { durationMs, completionRate, ...insertPayload } = payload;
  return {
    $setOnInsert: insertPayload,
    $max: {
      durationMs,
      completionRate
    },
    $set: { updatedAt }
  };
}

function clampLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_LIMIT);
}

function normalizeId(id) {
  if (!id) return '';
  return (id._id || id).toString();
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id));
}

function parseExcludedIds(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id && isValidObjectId(id))
    .slice(0, MAX_EXCLUDED_IDS);
}

// A Clip opened from Home may already be in the viewer's watched set because
// Home and Clips share the same canonical Post id. Keep that one id eligible
// while building the normal Clips recommendation pages; the client still has
// to find it at its ranked position and never inserts or moves it locally.
function preserveTargetClipInExclusions(excludedIds, rawTargetClipId, mode) {
  if (mode !== 'clips' || !isValidObjectId(rawTargetClipId)) return excludedIds;
  const targetClipId = String(rawTargetClipId);
  return excludedIds.filter((id) => String(id) !== targetClipId);
}

function encodeCursor(post) {
  if (!post?.createdAt || !post?._id) return null;
  return Buffer.from(JSON.stringify({
    createdAt: new Date(post.createdAt).toISOString(),
    id: post._id.toString()
  })).toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor || typeof cursor !== 'string') return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!decoded?.createdAt || !decoded?.id || !isValidObjectId(decoded.id)) return null;
    const createdAt = new Date(decoded.createdAt);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: decoded.id };
  } catch {
    return null;
  }
}

function postHasVideo(post) {
  return Array.isArray(post?.content?.media)
    && post.content.media.some((media) => media?.type === 'video');
}

function getCount(value) {
  return Array.isArray(value) ? value.length : 0;
}

function stableNoise(seed, id) {
  const str = `${seed}:${id}`;
  let hash = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return ((hash >>> 0) % 1000) / 1000;
}

async function getRelationshipContext(user) {
  if (!user || user.userType === 'guest') {
    const restrictedAuthors = await User.find({
      $or: [
        { isActive: { $ne: true } },
        {
          'privacySettings.showPostsToFollowers': { $exists: true, $ne: true }
        },
        {
          'privacySettings.profileVisibility': { $exists: true, $ne: 'public' }
        },
        {
          'privacySettings.profileVisibility': { $exists: false },
          'privacySettings.accountType': { $exists: true, $ne: 'public' }
        }
      ]
    }).select('_id').lean();
    return {
      currentUserId: null,
      followingIds: new Set(),
      blockedIds: new Set(),
      invisiblePrivateAuthorIds: new Set(restrictedAuthors.map((doc) => normalizeId(doc._id))),
      blockedEitherWayIds: new Set(),
      gamingPreferences: []
    };
  }

  const currentUserId = normalizeId(user._id);
  const blockedFromUser = Array.isArray(user.blockedUsers) ? user.blockedUsers.map(normalizeId) : [];

  const [followDocs, blockedByUsers] = await Promise.all([
    Follow.find({ follower: currentUserId }).select('following').lean(),
    User.find({ blockedUsers: currentUserId }).select('_id').lean()
  ]);

  // Follow is the canonical accepted-relationship store. The legacy arrays
  // are denormalized compatibility data and can be one-sided or stale after a
  // partial historical write, so they must never authorize private content.
  const followingIds = new Set(followDocs.map((doc) => normalizeId(doc.following)).filter(Boolean));
  const blockedIds = new Set(blockedFromUser.filter(Boolean));
  const blockedEitherWayIds = new Set([
    ...blockedIds,
    ...blockedByUsers.map((doc) => normalizeId(doc._id))
  ].filter(Boolean));

  const allowedFollowerIds = [currentUserId, ...followingIds];
  const privateUsers = await User.find({
    _id: { $ne: currentUserId },
    $or: [
      { isActive: { $ne: true } },
      {
        'privacySettings.showPostsToFollowers': { $exists: true, $ne: true }
      },
      {
        _id: { $nin: allowedFollowerIds },
        'privacySettings.profileVisibility': { $exists: true, $ne: 'public' }
      },
      {
        _id: { $nin: allowedFollowerIds },
        'privacySettings.profileVisibility': { $exists: false },
        'privacySettings.accountType': { $exists: true, $ne: 'public' }
      }
    ]
  }).select('_id').lean();

  return {
    currentUserId,
    followingIds,
    blockedIds,
    blockedEitherWayIds,
    invisiblePrivateAuthorIds: new Set(privateUsers.map((doc) => normalizeId(doc._id))),
    gamingPreferences: Array.isArray(user.profile?.gamingPreferences)
      ? user.profile.gamingPreferences.map((item) => String(item).toLowerCase())
      : []
  };
}

function buildAudienceFilter({ user, mode, relationship, query }) {
  const filter = {
    isActive: true,
    hiddenByAdmin: { $ne: true }
  };

  if (mode === 'clips') {
    filter['content.media'] = { $elemMatch: { type: 'video' } };
  }

  if (query.postType) filter.postType = query.postType;
  if (query.author && isValidObjectId(query.author)) filter.author = query.author;
  if (query.tags) {
    // Normalize requested tags to the same lowercase keys posts are indexed
    // under, so hashtag search is case-insensitive (#Valorant === #valorant).
    const wanted = String(query.tags).split(',').map(normalizeTag).filter(Boolean);
    if (wanted.length > 0) filter.tags = { $in: wanted };
  }

  const isGuest = !user || user.userType === 'guest';
  const requestedVisibility = ['public', 'followers', 'private'].includes(query.visibility)
    ? query.visibility
    : null;
  if (requestedVisibility === 'public' || isGuest) {
    filter.visibility = 'public';
  } else if (requestedVisibility === 'followers') {
    filter.visibility = 'followers';
    filter.$and = [{
      $or: [
        { author: relationship.currentUserId },
        { author: { $in: Array.from(relationship.followingIds) } }
      ]
    }];
  } else if (requestedVisibility === 'private') {
    // A client filter must never replace the server-derived audience scope.
    filter.visibility = 'private';
    filter.$and = [{ author: relationship.currentUserId }];
  } else {
    filter.$or = [
      { visibility: 'public' },
      { author: relationship.currentUserId },
      {
        visibility: 'followers',
        author: { $in: Array.from(relationship.followingIds) }
      }
    ];
  }

  const excludedAuthors = new Set([
    ...relationship.blockedEitherWayIds,
    ...relationship.invisiblePrivateAuthorIds
  ]);
  excludedAuthors.delete(relationship.currentUserId);
  if (excludedAuthors.size > 0) {
    filter.$and = [
      ...(Array.isArray(filter.$and) ? filter.$and : []),
      { author: { $nin: Array.from(excludedAuthors) } }
    ];
  }

  // Hide posts the viewer has reported from their own feeds only. This is a
  // per-viewer suppression (not a global delete) and never affects other
  // users, admins, or moderation views, which read reports separately.
  if (relationship.currentUserId) {
    filter['reports.user'] = { $ne: relationship.currentUserId };
  }

  return filter;
}

function applyCursorAndExclusions(filter, { cursor, excludedIds }) {
  const nextFilter = { ...filter };
  const and = Array.isArray(nextFilter.$and) ? [...nextFilter.$and] : [];

  if (excludedIds.length > 0) {
    and.push({ _id: { $nin: excludedIds } });
  }

  const decoded = decodeCursor(cursor);
  if (decoded) {
    const olderThanBoundary = {
      $or: [
        { createdAt: { $lt: decoded.createdAt } },
        { createdAt: decoded.createdAt, _id: { $lt: decoded.id } }
      ]
    };
    // Ranking selects a scored subset of the candidate window, so posts newer
    // than the boundary can be left undelivered. While the client-reported
    // exclusion list still covers the delivered set, keep that newer region
    // eligible (minus exclusions) so ranked-over posts are not skipped
    // forever. Once the exclusion window saturates, fall back to strictly
    // chronological progress to guarantee termination.
    const allowNewerUnseen = excludedIds.length > 0 && excludedIds.length < Math.floor(MAX_EXCLUDED_IDS * 0.75);
    if (allowNewerUnseen) {
      and.push({
        $or: [
          olderThanBoundary,
          { createdAt: { $gt: decoded.createdAt } }
        ]
      });
    } else {
      and.push(olderThanBoundary);
    }
  }

  if (and.length > 0) nextFilter.$and = and;
  return nextFilter;
}

// The next-page boundary advances only as far as content actually delivered:
// using the oldest *selected* post keeps unselected candidates eligible for
// later pages instead of silently skipping everything the ranker passed over.
function pickNextCursorPost({ selectedPosts, candidates, incomingCursor, excludedCount }) {
  if (!candidates.length) return null;
  const lastCandidate = candidates[candidates.length - 1];
  const oldestSelected = [...selectedPosts].sort((a, b) => {
    const timeDelta = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (timeDelta !== 0) return timeDelta;
    return String(a._id) < String(b._id) ? -1 : 1;
  })[0];
  if (!oldestSelected) return lastCandidate;

  const decoded = decodeCursor(incomingCursor);
  if (decoded && excludedCount >= Math.floor(MAX_EXCLUDED_IDS * 0.75)) {
    const boundaryTime = new Date(oldestSelected.createdAt).getTime();
    if (boundaryTime >= decoded.createdAt.getTime()) {
      // Exclusion window is saturated and selection stayed inside the newer
      // region: advance chronologically so pagination always terminates.
      return lastCandidate;
    }
  }
  return oldestSelected;
}

function normalizeSessionSeed(raw) {
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim().slice(0, MAX_SESSION_SEED_LENGTH);
  }
  // Without a client session, rotate by hour bucket so the ordering still
  // changes over time instead of staying frozen for a whole day.
  return new Date().toISOString().slice(0, 13);
}

// Posts recently delivered to this user in this surface. Impressions are
// recorded server-side at serve time; real views (client-tracked) reinforce
// the same signal.
async function getRecentlySeenMap(userId, mode) {
  if (!userId) return new Map();
  const since = new Date(Date.now() - SEEN_LOOKBACK_MS);
  let rows = [];
  try {
    rows = await PostEngagement.find({
      user: userId,
      context: mode,
      eventType: { $in: ['impression', 'view'] },
      updatedAt: { $gte: since }
    })
      .sort({ updatedAt: -1 })
      .limit(SEEN_FETCH_LIMIT)
      .select('post eventType updatedAt impressionCount positionShown sessionId')
      .lean();
  } catch (error) {
    // Continue serving a feed, but do not silently hide the reason exposure
    // suppression became unavailable. This is intentionally metadata-only.
    log.warn('Failed to load recent feed exposure history', {
      error: String(error),
      mode,
      userId: String(userId)
    });
  }

  const seenMap = new Map();
  rows.forEach((row) => {
    const postId = normalizeId(row.post);
    if (!postId) return;
    const rowUpdatedAt = new Date(row.updatedAt || Date.now()).getTime();
    const existing = seenMap.get(postId) || {
      lastShownAt: 0,
      impressionCount: 1,
      lastPositionShownAt: 0,
      lastPositionShown: null,
      lastSessionId: null
    };

    existing.lastShownAt = Math.max(existing.lastShownAt, rowUpdatedAt);
    if (row.eventType === 'impression') {
      existing.impressionCount = Math.max(
        existing.impressionCount,
        Math.max(1, Number(row.impressionCount) || 1)
      );
      if (rowUpdatedAt >= existing.lastPositionShownAt) {
        existing.lastPositionShownAt = rowUpdatedAt;
        existing.lastPositionShown = Number.isInteger(row.positionShown)
          ? row.positionShown
          : null;
        existing.lastSessionId = typeof row.sessionId === 'string' && row.sessionId
          ? row.sessionId
          : null;
      }
    }
    seenMap.set(postId, existing);
  });
  return seenMap;
}

async function getBoostDeliveryMap(userId, mode) {
  if (!userId) return new Map();
  const rows = await BoostDeliveryAttribution.find({
    user: userId,
    context: mode,
    expiresAt: { $gt: new Date() }
  })
    .select('post deliveredAt deliveryCount')
    .lean()
    .catch(() => []);

  const deliveryMap = new Map();
  rows.forEach((row) => {
    const postId = normalizeId(row.post);
    if (!postId) return;
    deliveryMap.set(postId, {
      deliveredAt: new Date(row.deliveredAt || Date.now()).getTime(),
      deliveryCount: Math.max(1, Number(row.deliveryCount) || 1)
    });
  });
  return deliveryMap;
}

function buildImpressionOps(posts, { userId, mode, sessionSeed }) {
  const now = new Date();
  return posts.map((post, index) => ({
    updateOne: {
      filter: { user: userId, post: post._id, eventType: 'impression', context: mode },
      update: {
        $setOnInsert: {
          author: post.author?._id || post.author,
          source: 'organic',
          durationMs: 0,
          completionRate: 0,
          metadata: {}
        },
        $set: {
          updatedAt: now,
          positionShown: index,
          sessionId: sessionSeed || null
        },
        $inc: { impressionCount: 1 }
      },
      upsert: true
    }
  }));
}

async function recordFeedImpressions(posts, { userId, mode, sessionSeed }) {
  if (!userId || !Array.isArray(posts) || posts.length === 0) return;
  const ops = buildImpressionOps(posts, { userId, mode, sessionSeed });
  try {
    await PostEngagement.bulkWrite(ops, { ordered: false });
  } catch (error) {
    // Duplicate-key races between concurrent first impressions are benign,
    // but an unordered bulk error can contain a mixture of duplicate and real
    // write failures. Never discard the non-duplicate failures with the race.
    const writeErrors = Array.isArray(error?.writeErrors) ? error.writeErrors : [];
    const nonDuplicateWriteErrors = writeErrors.filter((entry) => (
      entry?.code !== 11000 && !/E11000/.test(String(entry?.errmsg || entry?.message || ''))
    ));
    const onlyDuplicateRaces = error?.code === 11000
      || (/E11000/.test(String(error)) && nonDuplicateWriteErrors.length === 0);
    if (!onlyDuplicateRaces || nonDuplicateWriteErrors.length > 0) {
      log.warn('Failed to record feed impressions', { error: String(error), mode });
    }
  }
}

function addInteraction(interactionMap, postId, interactedAt, count = 1) {
  const normalizedPostId = normalizeId(postId);
  if (!normalizedPostId) return;
  const timestamp = new Date(interactedAt || 0).getTime();
  // Never manufacture a fresh timestamp for legacy rows that lack one: doing
  // so on every request would suppress them forever instead of allowing decay.
  if (!Number.isFinite(timestamp) || timestamp <= 0) return;
  const current = interactionMap.get(normalizedPostId) || {
    lastInteractedAt: 0,
    interactionCount: 0
  };
  current.lastInteractedAt = Math.max(current.lastInteractedAt, timestamp);
  current.interactionCount += Math.max(1, Number(count) || 1);
  interactionMap.set(normalizedPostId, current);
}

async function getInterestProfile(userId, relationship) {
  if (!userId) {
    return {
      tagWeights: new Map(),
      authorWeights: new Map(),
      postTypeWeights: new Map(),
      savedPostIds: new Set(),
      interactionMap: new Map()
    };
  }

  let recentEvents = [];
  try {
    recentEvents = await PostEngagement.find({
      user: userId,
      // Server-side delivery impressions are exposure records, not intent
      // signals, and must not inflate author affinity.
      eventType: { $ne: 'impression' }
    })
      .sort({ createdAt: -1 })
      .limit(160)
      .select('post author eventType createdAt updatedAt')
      .lean();
  } catch (error) {
    log.warn('Failed to load recent recommendation interactions', {
      error: String(error),
      userId: String(userId)
    });
  }

  const eventPostIds = recentEvents.map((event) => event.post).filter(Boolean);
  const savedUser = await User.findById(userId)
    .select('savedPosts.post savedPosts.savedAt')
    .lean()
    .catch(() => null);
  const savedPosts = Array.isArray(savedUser?.savedPosts)
    ? savedUser.savedPosts.filter((item) => item?.post)
    : [];
  const savedPostIds = savedPosts.map((item) => item.post);
  const interactionUserId = new mongoose.Types.ObjectId(String(userId));
  const likedPosts = await Post.aggregate([
    {
      $match: {
        $or: [
          { 'likes.user': interactionUserId },
          { 'comments.user': interactionUserId },
          { _id: { $in: [...eventPostIds, ...savedPostIds] } }
        ],
        isActive: true
      }
    },
    { $sort: { createdAt: -1 } },
    { $limit: 120 },
    {
      // Return only this viewer's interaction subdocuments. Popular posts can
      // contain large arrays, so loading every user's likes/comments here
      // would turn a bounded ranking lookup into an avoidable payload spike.
      $project: {
        author: 1,
        tags: 1,
        postType: 1,
        createdAt: 1,
        likes: {
          $filter: {
            input: { $ifNull: ['$likes', []] },
            as: 'like',
            cond: { $eq: ['$$like.user', interactionUserId] }
          }
        },
        comments: {
          $filter: {
            input: { $ifNull: ['$comments', []] },
            as: 'comment',
            cond: { $eq: ['$$comment.user', interactionUserId] }
          }
        }
      }
    }
  ]).catch((error) => {
    log.warn('Failed to load exact-post interaction history', {
      error: String(error),
      userId: String(userId)
    });
    return [];
  });

  const tagWeights = new Map();
  const authorWeights = new Map();
  const postTypeWeights = new Map();
  const interactionMap = new Map();

  relationship.gamingPreferences.forEach((pref) => {
    tagWeights.set(pref, (tagWeights.get(pref) || 0) + 6);
  });

  recentEvents.forEach((event) => {
    const weight = event.eventType === 'like' ? 5
      : event.eventType === 'comment' ? 7
        : event.eventType === 'share' || event.eventType === 'save' ? 9
          : event.eventType === 'watch' ? 4
            : 2;
    const authorId = normalizeId(event.author);
    if (authorId) authorWeights.set(authorId, (authorWeights.get(authorId) || 0) + weight);
    if (DIRECT_INTERACTION_TYPES.has(event.eventType)) {
      addInteraction(interactionMap, event.post, event.updatedAt || event.createdAt);
    }
  });

  likedPosts.forEach((post) => {
    const authorId = normalizeId(post.author);
    if (authorId) authorWeights.set(authorId, (authorWeights.get(authorId) || 0) + 4);
    if (post.postType) postTypeWeights.set(post.postType, (postTypeWeights.get(post.postType) || 0) + 2);
    (post.tags || []).forEach((tag) => {
      const key = String(tag).toLowerCase();
      tagWeights.set(key, (tagWeights.get(key) || 0) + 3);
    });
    (post.likes || []).forEach((like) => {
      if (normalizeId(like.user) === normalizeId(userId)) {
        addInteraction(interactionMap, post._id, like.likedAt || post.createdAt);
      }
    });
    (post.comments || []).forEach((comment) => {
      if (normalizeId(comment.user) === normalizeId(userId)) {
        addInteraction(interactionMap, post._id, comment.createdAt || post.createdAt);
      }
    });
  });

  savedPosts.forEach((saved) => addInteraction(interactionMap, saved.post, saved.savedAt));

  return {
    tagWeights,
    authorWeights,
    postTypeWeights,
    savedPostIds: new Set(savedPostIds.map(normalizeId).filter(Boolean)),
    interactionMap
  };
}

function getInteractionPenalty(interactionEntry, now = Date.now()) {
  if (!interactionEntry?.lastInteractedAt) return 0;
  const hoursSinceInteraction = Math.max(0, (now - interactionEntry.lastInteractedAt) / 36e5);
  if (hoursSinceInteraction >= INTERACTION_COOLDOWN_HOURS) return 0;
  const repeatFactor = Math.min(
    2,
    1 + (Math.max(0, (interactionEntry.interactionCount || 1) - 1) * 0.25)
  );
  return INTERACTION_PENALTY_BASE
    * Math.exp(-hoursSinceInteraction / INTERACTION_PENALTY_HALF_LIFE_HOURS)
    * repeatFactor;
}

function wasRecentlyInteracted(interactionEntry, now = Date.now()) {
  if (!interactionEntry?.lastInteractedAt) return false;
  return (now - interactionEntry.lastInteractedAt) < INTERACTION_COOLDOWN_HOURS * 36e5;
}

function getRecentTopPositionPenalty(seenEntry, now, currentSessionId) {
  if (!seenEntry || !Number.isInteger(seenEntry.lastPositionShown)) return 0;
  if (seenEntry.lastPositionShown < 0 || seenEntry.lastPositionShown >= TOP_POSITION_PENALTY_BASE.length) {
    return 0;
  }
  // Pagination and silent revalidation inside one session must keep the same
  // ordering. Positional rotation only applies when the client intentionally
  // starts a different feed/clips session.
  if (currentSessionId && seenEntry.lastSessionId === currentSessionId) return 0;

  const lastPositionShownAt = Number(seenEntry.lastPositionShownAt) || 0;
  if (!lastPositionShownAt) return 0;
  const hoursSincePosition = Math.max(0, (now - lastPositionShownAt) / 36e5);
  if (hoursSincePosition >= TOP_POSITION_PENALTY_WINDOW_HOURS) return 0;

  const base = TOP_POSITION_PENALTY_BASE[seenEntry.lastPositionShown];
  return base * Math.exp(-hoursSincePosition / TOP_POSITION_PENALTY_HALF_LIFE_HOURS);
}

function getSeenPenalty(seenEntry, now, currentSessionId) {
  if (!seenEntry?.lastShownAt) return 0;
  // A retry, pagination request, or silent revalidation inside the same feed
  // session must be deterministic. The client already excludes delivered ids
  // while paging, so re-penalizing the current session only makes an identical
  // request reorder itself.
  if (currentSessionId && seenEntry.lastSessionId === currentSessionId) return 0;
  const hoursSinceShown = Math.max(0, (now - seenEntry.lastShownAt) / 36e5);
  const topPositionPenalty = getRecentTopPositionPenalty(seenEntry, now, currentSessionId);
  if (hoursSinceShown >= SEEN_COOLDOWN_HOURS) return topPositionPenalty;
  // Repeat exposures decay slower so a post shown many times sinks harder,
  // but the penalty always reaches zero — content is never permanently hidden.
  const repeatFactor = Math.min(2.2, 1 + (Math.max(0, (seenEntry.impressionCount || 1) - 1) * 0.35));
  const exposurePenalty = SEEN_PENALTY_BASE
    * Math.exp(-hoursSinceShown / SEEN_PENALTY_HALF_LIFE_HOURS)
    * repeatFactor;
  return exposurePenalty + topPositionPenalty;
}

function getDampedBoostScore(post, { mode, now, boostDeliveryMap }) {
  const rawBoost = getBoostScore(post, { mode, now });
  if (rawBoost <= 0) return 0;
  const delivery = boostDeliveryMap?.get(normalizeId(post._id));
  if (!delivery) return rawBoost;
  const hoursSinceDelivery = Math.max(0, (now - delivery.deliveredAt) / 36e5);
  const frequencyCapped = delivery.deliveryCount >= BOOST_FREQUENCY_CAP;
  if (hoursSinceDelivery < BOOST_USER_COOLDOWN_HOURS || frequencyCapped) {
    // The campaign already reached this viewer recently (or hit its per-user
    // cap): the post stays eligible but competes on organic merit only.
    return 0;
  }
  return rawBoost;
}

function scorePost(post, {
  mode,
  relationship,
  interestProfile,
  seed,
  sessionId,
  seenMap,
  boostDeliveryMap
}) {
  const now = Date.now();
  const createdAt = new Date(post.createdAt).getTime();
  const hoursOld = Math.max(0, (now - createdAt) / 36e5);
  const freshness = Math.exp(-hoursOld / (mode === 'clips' ? 96 : 72));

  const likes = getCount(post.likes);
  const comments = getCount(post.comments);
  const shares = getCount(post.shares);
  const reports = getCount(post.reports);
  const views = Math.max(getCount(post.viewedBy), post.views || 0);
  // Compress engagement to a bounded log scale (~0–90). Raw counts were
  // unbounded, so one very popular post (e.g. 25k views → ~8750) dwarfed
  // freshness/seen-penalty/exploration and stayed pinned at #1 forever, freezing
  // the feed. Log keeps "more engaged ranks higher" but at a magnitude
  // comparable to the other signals, so the seen-penalty and session-seed
  // exploration can actually rotate the order.
  const engagementRaw = (likes * 3) + (comments * 7) + (shares * 9) + (views * 0.35);
  const engagement = Math.log10(1 + engagementRaw) * 22;
  const engagementRate = views > 0 ? ((likes + comments + shares) / views) : (likes + comments + shares);
  const authorId = normalizeId(post.author);
  const ownPostPenalty = relationship.currentUserId && authorId === relationship.currentUserId ? -12 : 0;
  const followingBoost = relationship.followingIds.has(authorId) ? (mode === 'clips' ? 28 : 70) : 0;
  const authorAffinity = interestProfile.authorWeights.get(authorId) || 0;
  const postTypeAffinity = interestProfile.postTypeWeights.get(post.postType) || 0;
  const tagAffinity = (post.tags || []).reduce((sum, tag) => {
    return sum + (interestProfile.tagWeights.get(String(tag).toLowerCase()) || 0);
  }, 0);
  const mediaBoost = postHasVideo(post) ? (mode === 'clips' ? 18 : 4) : 2;
  const boostScore = getDampedBoostScore(post, { mode, now, boostDeliveryMap });
  const qualityPenalty = reports * 25;
  const exploration = stableNoise(seed, post._id) * (mode === 'clips' ? 16 : 10);
  const viralVelocity = engagementRate > 0 ? Math.min(35, engagementRate * 28) : 0;
  // Temporary head start for newly created eligible posts so fresh content
  // reaches the top before engagement accumulates.
  const newPostKicker = hoursOld < NEW_POST_KICKER_HOURS
    ? (mode === 'clips' ? 20 : 26) * Math.exp(-hoursOld / 2.5)
    : 0;
  const seenPenalty = getSeenPenalty(seenMap?.get(normalizeId(post._id)), now, sessionId);
  const interactionPenalty = getInteractionPenalty(
    interestProfile.interactionMap?.get(normalizeId(post._id)),
    now
  );

  const score =
    freshness * (mode === 'clips' ? 85 : 70)
    + engagement
    + viralVelocity
    + followingBoost
    + authorAffinity
    + postTypeAffinity
    + tagAffinity
    + mediaBoost
    + boostScore
    + exploration
    + ownPostPenalty
    + newPostKicker
    - seenPenalty
    - interactionPenalty
    - qualityPenalty;

  return Math.round(score * 100) / 100;
}

function selectDiversePosts(scoredPosts, limit, mode) {
  const selected = [];
  const deferred = [];
  const authorCounts = new Map();
  const tagCounts = new Map();
  const maxPerAuthorFirstPass = mode === 'clips' ? 1 : 2;

  for (const item of scoredPosts) {
    const authorId = normalizeId(item.post.author);
    const topTag = Array.isArray(item.post.tags) && item.post.tags.length > 0
      ? String(item.post.tags[0]).toLowerCase()
      : item.post.postType || 'general';
    const authorCount = authorCounts.get(authorId) || 0;
    const tagCount = tagCounts.get(topTag) || 0;

    if (authorCount >= maxPerAuthorFirstPass || tagCount >= 3) {
      deferred.push(item);
      continue;
    }

    selected.push(item);
    authorCounts.set(authorId, authorCount + 1);
    tagCounts.set(topTag, tagCount + 1);
    if (selected.length >= limit) break;
  }

  for (const item of deferred) {
    if (selected.length >= limit) break;
    if (!selected.some((selectedItem) => selectedItem.post._id.toString() === item.post._id.toString())) {
      selected.push(item);
    }
  }

  return selected;
}

function wasServedInPreviousSession(seenEntry, sessionId, now = Date.now()) {
  if (!seenEntry?.lastShownAt) return false;
  if (sessionId && seenEntry.lastSessionId === sessionId) return false;
  const hoursSinceShown = Math.max(0, (now - seenEntry.lastShownAt) / 36e5);
  return hoursSinceShown < SEEN_COOLDOWN_HOURS;
}

// Score penalties alone cannot guarantee useful refresh diversity: a strongly
// relevant/followed/high-engagement post can still beat an unseen candidate
// after the penalty and occupy the same slot over and over. For Home Feed
// refresh sessions, make freshness a selection tier instead:
//   1. choose from candidates not served in another recent session;
//   2. preserve the complete recommendation score and diversity rules inside
//      that tier;
//   3. fill from ranked seen candidates only when inventory is small.
//
// This is deliberately not a random shuffle and does not permanently exclude
// anything. The existing cooldown expires entries, and the fallback guarantees
// a full feed for new/small accounts. Clips retain their watched-content
// exclusion and additionally share the exact-post interaction tier.
function selectSessionFreshPosts(scoredPosts, limit, mode, {
  seenMap = new Map(),
  interactionMap = new Map(),
  sessionId,
  now = Date.now()
} = {}) {
  const hasInteractions = interactionMap instanceof Map && interactionMap.size > 0;
  const hasSeenHistory = seenMap instanceof Map && seenMap.size > 0;
  if (!hasInteractions && (mode !== 'feed' || !hasSeenHistory)) {
    return selectDiversePosts(scoredPosts, limit, mode);
  }

  const fresh = [];
  const recentlyServed = [];
  const recentlyInteracted = [];
  scoredPosts.forEach((item) => {
    const postId = normalizeId(item.post?._id);
    if (wasRecentlyInteracted(interactionMap.get(postId), now)) {
      recentlyInteracted.push(item);
    } else if (mode === 'feed' && wasServedInPreviousSession(seenMap.get(postId), sessionId, now)) {
      recentlyServed.push(item);
    } else {
      fresh.push(item);
    }
  });

  const selected = selectDiversePosts(fresh, limit, mode);
  const selectedIds = new Set(selected.map((item) => normalizeId(item.post?._id)));
  const fillFrom = (items) => {
    if (selected.length >= limit) return;
    const fallback = selectDiversePosts(
      items.filter((item) => !selectedIds.has(normalizeId(item.post?._id))),
      limit - selected.length,
      mode
    );
    fallback.forEach((item) => {
      selected.push(item);
      selectedIds.add(normalizeId(item.post?._id));
    });
  };

  // Seen-but-not-acted-on content is preferable to content the viewer just
  // liked/commented/shared/saved. The final tier is still a fallback, so small
  // pools work and older interacted posts naturally re-enter after cooldown.
  fillFrom(recentlyServed);
  fillFrom(recentlyInteracted);
  return selected;
}

// Boosted posts keep paid distribution but never own a fixed slot:
// - at most one boosted post inside the first `topWindow` items;
// - a boosted post only holds position 1 when it earned it organically,
//   otherwise its slot rotates deterministically with the session seed.
function applyBoostPlacement(selected, { seed, topWindow = BOOST_TOP_WINDOW, now = Date.now() } = {}) {
  if (!Array.isArray(selected) || selected.length < 3) return selected;

  const items = [...selected];
  const window = Math.min(topWindow, items.length);
  const isBoosted = (item) => isActiveBoost(item.post, now);
  const organicExists = items.some((item) => !isBoosted(item));
  if (!organicExists) return items;

  // Keep only the strongest boosted item inside the top window; defer the
  // rest just below the window (their relative order is preserved).
  const boostedInWindow = items.slice(0, window).filter(isBoosted);
  if (boostedInWindow.length > 1) {
    const overflow = boostedInWindow.slice(1);
    overflow.reverse().forEach((item) => {
      const fromIndex = items.indexOf(item);
      items.splice(fromIndex, 1);
      items.splice(Math.min(window, items.length), 0, item);
    });
  }

  const first = items[0];
  if (first && isBoosted(first)) {
    const organicScore = first.score - getBoostScore(first.post, { now });
    const bestOrganic = items.find((item) => !isBoosted(item));
    if (bestOrganic && organicScore < bestOrganic.score) {
      // Paid weight alone put it first: rotate it into a seed-derived slot
      // inside the window so the same viewer does not always see it on top.
      const slot = 1 + Math.floor(stableNoise(`${seed}:boost-slot`, normalizeId(first.post._id)) * (window - 1));
      items.splice(0, 1);
      items.splice(Math.min(slot, items.length), 0, first);
    }
  }

  return items;
}

async function findWatchedClipIds(userId) {
  if (!userId) return new Set();
  const [viewEvents, viewedPosts] = await Promise.all([
    PostEngagement.find({ user: userId, eventType: 'view', context: 'clips' })
      .sort({ createdAt: -1 })
      .limit(1500)
      .select('post')
      .lean()
      .catch(() => []),
    Post.find({
      'viewedBy.user': userId,
      'content.media': { $elemMatch: { type: 'video' } }
    })
      .sort({ createdAt: -1 })
      .limit(1500)
      .select('_id')
      .lean()
      .catch(() => [])
  ]);
  return new Set([
    ...viewEvents.map((event) => normalizeId(event.post)),
    ...viewedPosts.map((post) => normalizeId(post._id))
  ].filter(Boolean));
}

function getCandidatePoolLimit(limit) {
  return Math.max(limit * CANDIDATE_MULTIPLIER, limit + 1);
}

function getCandidateExplorationSkip(total, recentLimit, explorationLimit, sessionSeed) {
  const normalizedTotal = Math.max(0, Number(total) || 0);
  const minimumSkip = Math.max(0, recentLimit);
  const maximumSkip = Math.max(minimumSkip, normalizedTotal - explorationLimit);
  if (maximumSkip === minimumSkip) return minimumSkip;
  const availableOffsets = maximumSkip - minimumSkip + 1;
  return minimumSkip + Math.floor(
    stableNoise(`${sessionSeed}:candidate-window`, 'feed-exploration') * availableOffsets
  );
}

async function fetchCandidates(filter, {
  limit,
  page,
  cursor,
  candidateLimit = getCandidatePoolLimit(limit),
  skip = null
}) {
  const query = Post.find(filter)
    .populate('author', 'username profile.displayName profile.avatar profilePicture avatar userType privacySettings isActive')
    .populate('likes.user', 'username profile.displayName profile.avatar profilePicture avatar')
    .populate('comments.user', 'username profile.displayName profile.avatar profilePicture avatar')
    .sort({ createdAt: -1, _id: -1 })
    .limit(candidateLimit);

  if (!cursor && Number.isInteger(skip) && skip > 0) {
    query.skip(skip);
  } else if (!cursor && page > 1) {
    query.skip((page - 1) * limit);
  }

  return query.exec();
}

async function fetchSessionCandidates(filter, {
  limit,
  page,
  cursor,
  mode,
  sessionSeed,
  total,
  allowExplorationWindow = true
}) {
  const poolLimit = getCandidatePoolLimit(limit);
  if (
    !allowExplorationWindow
    || mode !== 'feed'
    || cursor
    || page > 1
    || !Number.isFinite(total)
    || total <= poolLimit
  ) {
    return fetchCandidates(filter, { limit, page, cursor, candidateLimit: poolLimit });
  }

  // Page one used to consider only the newest `limit * 8` records. Once a
  // regular viewer had consumed that fixed window, hundreds of eligible older
  // posts were unreachable regardless of the seen penalty. Keep half of the
  // bounded pool recent and use the rotating session seed to seek into a
  // different older indexed window for the other half. No random collection
  // scan and no unbounded history/query are introduced.
  const recentLimit = Math.ceil(poolLimit / 2);
  const explorationLimit = poolLimit - recentLimit;
  const explorationSkip = getCandidateExplorationSkip(
    total,
    recentLimit,
    explorationLimit,
    sessionSeed
  );
  const [recent, exploration] = await Promise.all([
    fetchCandidates(filter, {
      limit,
      page: 1,
      cursor: null,
      candidateLimit: recentLimit,
      skip: 0
    }),
    fetchCandidates(filter, {
      limit,
      page: 1,
      cursor: null,
      candidateLimit: explorationLimit,
      skip: explorationSkip
    })
  ]);
  const seenIds = new Set();
  return [...recent, ...exploration].filter((post) => {
    const postId = normalizeId(post?._id);
    if (!postId || seenIds.has(postId)) return false;
    seenIds.add(postId);
    return true;
  });
}

function buildTargetClipFilter(baseFilter, rawTargetClipId, mode) {
  if (mode !== 'clips' || !isValidObjectId(rawTargetClipId)) return null;
  return {
    ...baseFilter,
    _id: String(rawTargetClipId)
  };
}

async function fetchTargetClip(filter) {
  if (!filter) return null;
  return Post.findOne(filter)
    .populate('author', 'username profile.displayName profile.avatar profilePicture avatar userType privacySettings isActive')
    .populate('likes.user', 'username profile.displayName profile.avatar profilePicture avatar')
    .populate('comments.user', 'username profile.displayName profile.avatar profilePicture avatar')
    .exec();
}

async function getRecommendedPosts({ user, query = {}, mode = 'feed' }) {
  const limit = clampLimit(query.limit, mode === 'clips' ? 10 : DEFAULT_LIMIT);
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const excludedIds = parseExcludedIds(query.exclude || query.excludedIds);
  const sessionSeed = normalizeSessionSeed(query.sessionSeed);
  const relationship = await getRelationshipContext(user);
  const [interestProfile, seenMap, boostDeliveryMap] = await Promise.all([
    getInterestProfile(relationship.currentUserId, relationship),
    getRecentlySeenMap(relationship.currentUserId, mode),
    getBoostDeliveryMap(relationship.currentUserId, mode)
  ]);
  const baseFilter = buildAudienceFilter({ user, mode, relationship, query });
  const targetClipFilter = buildTargetClipFilter(baseFilter, query.targetClipId, mode);
  const [watchedClipIds, targetClipPost, total] = await Promise.all([
    mode === 'clips' && query.includeViewed !== 'true'
      ? findWatchedClipIds(relationship.currentUserId)
      : Promise.resolve(new Set()),
    fetchTargetClip(targetClipFilter),
    !query.cursor
      ? Post.countDocuments(baseFilter).catch((error) => {
        log.warn('Failed to count recommendation candidates', {
          error: String(error),
          mode
        });
        return null;
      })
      : Promise.resolve(null)
  ]);

  const requestedExcludedIds = preserveTargetClipInExclusions(
    excludedIds,
    query.targetClipId,
    mode
  );
  const effectiveExcludedIds = preserveTargetClipInExclusions([...new Set([
    ...requestedExcludedIds,
    ...(mode === 'clips' ? Array.from(watchedClipIds) : [])
  ])], query.targetClipId, mode);

  let filter = applyCursorAndExclusions(baseFilter, {
    cursor: query.cursor,
    excludedIds: effectiveExcludedIds
  });

  let candidates = await fetchSessionCandidates(filter, {
    limit,
    page,
    cursor: query.cursor,
    mode,
    sessionSeed,
    total,
    // Discover/search results retain their chronological candidate contract;
    // only the recommendation Home Feed rotates the source window.
    allowExplorationWindow: query.context !== 'search'
  });
  let exhaustedFreshClips = false;

  if (mode === 'clips' && candidates.length < limit && watchedClipIds.size > 0) {
    exhaustedFreshClips = true;
    const freshCandidates = candidates;
    const freshIds = new Set(freshCandidates.map((post) => normalizeId(post._id)));
    filter = applyCursorAndExclusions(baseFilter, {
      cursor: query.cursor,
      excludedIds: preserveTargetClipInExclusions(
        [...requestedExcludedIds, ...Array.from(freshIds)],
        query.targetClipId,
        mode
      )
    });
    const fallbackCandidates = await fetchCandidates(filter, { limit, page, cursor: query.cursor });
    candidates = [...freshCandidates, ...fallbackCandidates];
  }

  // The seed is stable within a feed session (client-provided) so pagination
  // and silent revalidation stay deterministic, and rotates between sessions
  // so consecutive refreshes explore a different ordering.
  const seed = `${relationship.currentUserId || 'guest'}:${mode}:${sessionSeed}`;
  const scored = candidates
    .map((post) => ({
      post,
      score: scorePost(post, {
        mode,
        relationship,
        interestProfile,
        seed,
        sessionId: sessionSeed,
        seenMap,
        boostDeliveryMap
      })
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.post.createdAt).getTime() - new Date(a.post.createdAt).getTime();
    });

  const selected = applyBoostPlacement(selectSessionFreshPosts(scored, limit, mode, {
    seenMap,
    interactionMap: interestProfile.interactionMap,
    sessionId: sessionSeed
  }), { seed });
  const selectedPosts = selected.map((item) => item.post);
  const attributedBoostPostIds = await recordBoostDelivery(selectedPosts, mode, relationship.currentUserId).catch((error) => {
    log.warn('Failed to record boost delivery', { error: String(error), mode });
    return new Set();
  });
  // Discover uses the same ranked dataset, but merely rendering search tiles
  // must not mutate the normal Feed/Clips session's seen history. Otherwise a
  // Web search can change the immediately following Mobile result set (or vice
  // versa) even when both clients send identical hashtag parameters.
  const impressionContext = query.context === 'search' ? 'search' : mode;
  await recordFeedImpressions(selectedPosts, {
    userId: relationship.currentUserId,
    mode: impressionContext,
    sessionSeed
  });
  const nextCursorPost = pickNextCursorPost({
    selectedPosts,
    candidates,
    incomingCursor: query.cursor,
    excludedCount: effectiveExcludedIds.length
  });
  const nextCursor = candidates.length >= limit ? encodeCursor(nextCursorPost) : null;
  const isGuest = !user || user.userType === 'guest';
  // Development-only ranking diagnostics (Phase 4 feed contract + Phase 14
  // observability). Never emitted in production so internal scoring stays
  // private, but locally it exposes exactly why each post holds its slot so a
  // repeated-order/boost-pinning report can be reproduced with real evidence.
  const includeRankingDebug = process.env.NODE_ENV !== 'production';
  const rankingNow = Date.now();
  const scoreById = includeRankingDebug
    ? new Map(selected.map((item) => [normalizeId(item.post._id), item.score]))
    : null;
  const selectedPositionById = includeRankingDebug
    ? new Map(selectedPosts.map((post, index) => [normalizeId(post._id), index]))
    : null;

  // Viewer-specific follow-state for each author, so Feed/Clips render the same
  // Follow / Requested / Unfollow / Requests-off CTA as the Profile and user-list
  // endpoints. Uses the one shared follow-eligibility model (buildPrivacyAccess)
  // instead of the client guessing from stripped/absent privacy fields — which is
  // what made every non-followed author wrongly read as "Requests Off".
  const viewerId = relationship.currentUserId;
  const presentationPosts = targetClipPost
    ? [targetClipPost, ...selectedPosts.filter((post) => normalizeId(post._id) !== normalizeId(targetClipPost._id))]
    : selectedPosts;
  let pendingFollowTargetIds = new Set();
  if (viewerId) {
    const authorIds = [...new Set(presentationPosts
      .map((post) => normalizeId(post.author))
      .filter((id) => id && id !== viewerId))];
    if (authorIds.length > 0) {
      const pending = await FollowRequest.find({
        requester: viewerId,
        target: { $in: authorIds },
        status: 'pending'
      }).select('target').lean();
      pendingFollowTargetIds = new Set(pending.map((r) => normalizeId(r.target)).filter(Boolean));
    }
  }

  const formattedPosts = new Map(presentationPosts.map((post) => {
    const dto = formatPostDTO(
      post,
      isGuest,
      Boolean(relationship.currentUserId && normalizeId(post.author) === relationship.currentUserId),
      relationship.currentUserId
    );
    if (dto) {
      const postId = normalizeId(post._id);
      dto.deliverySource = attributedBoostPostIds.has(postId) ? 'boost' : 'organic';
      dto.isSaved = Boolean(relationship.currentUserId && interestProfile.savedPostIds.has(postId));
      // Attach follow-state to the author (skip self — the client hides follow UI
      // for own content anyway).
      if (dto.author && typeof dto.author === 'object' && post.author && typeof post.author === 'object') {
        const authorId = normalizeId(post.author);
        const isSelfAuthor = Boolean(viewerId && authorId === viewerId);
        if (!isSelfAuthor) {
          const isFollowing = Boolean(viewerId && relationship.followingIds.has(authorId));
          const followRequestPending = pendingFollowTargetIds.has(authorId);
          const access = buildPrivacyAccess({
            settings: post.author.privacySettings,
            isSelf: false,
            isFollower: isFollowing
          });
          const canFollow = access.canFollow && !followRequestPending && !isFollowing;
          dto.author.isFollowing = isFollowing;
          dto.author.followStatus = isFollowing ? 'accepted' : followRequestPending ? 'pending' : 'none';
          dto.author.followRequestPending = followRequestPending;
          dto.author.canFollow = canFollow;
          dto.author.privacyAccess = { canFollow, followRequestPending };
        }
      }
      if (includeRankingDebug) {
        const hoursOld = Math.max(0, (rankingNow - new Date(post.createdAt).getTime()) / 36e5);
        const isBoosted = isActiveBoost(post, rankingNow);
        const isPreviouslySeen = seenMap.has(postId);
        const interactionEntry = interestProfile.interactionMap?.get(postId);
        dto._ranking = {
          position: selectedPositionById.get(postId) ?? null,
          rankingScore: scoreById.get(postId) ?? null,
          isBoosted,
          boostWeight: isBoosted ? getDampedBoostScore(post, { mode, now: rankingNow, boostDeliveryMap }) : 0,
          isPreviouslySeen,
          isRecentlyInteracted: wasRecentlyInteracted(interactionEntry, rankingNow),
          interactionPenalty: Math.round(getInteractionPenalty(interactionEntry, rankingNow) * 100) / 100,
          seenPenalty: Math.round(getSeenPenalty(seenMap.get(postId), rankingNow, sessionSeed) * 100) / 100,
          previousPosition: seenMap.get(postId)?.lastPositionShown ?? null,
          previousSessionId: seenMap.get(postId)?.lastSessionId ?? null,
          freshness: Math.round(Math.exp(-hoursOld / (mode === 'clips' ? 96 : 72)) * 1000) / 1000,
          hoursOld: Math.round(hoursOld * 10) / 10,
          newPostKicker: hoursOld < NEW_POST_KICKER_HOURS,
          createdAt: post.createdAt,
          rankingReason: wasRecentlyInteracted(interactionEntry, rankingNow)
            ? 'organic(interaction-suppressed)'
            : isBoosted
              ? 'boost+organic'
              : isPreviouslySeen
              ? 'organic(seen-penalized)'
              : hoursOld < NEW_POST_KICKER_HOURS
                ? 'fresh'
                : 'organic',
        };
      }
    }
    return [normalizeId(post._id), dto];
  }));
  const posts = selectedPosts.map((post) => formattedPosts.get(normalizeId(post._id)) || null);
  const targetClip = targetClipPost
    ? formattedPosts.get(normalizeId(targetClipPost._id)) || null
    : null;
  const deliveredMedia = await resolveClientMediaPayload({ posts, targetClip });

  if (includeRankingDebug) {
    log.info('feed-ranking', {
      mode,
      viewer: relationship.currentUserId ? String(relationship.currentUserId) : 'guest',
      sessionSeed,
      cursor: query.cursor || null,
      nextCursor,
      count: selectedPosts.length,
      boostedCount: selectedPosts.filter((p) => isActiveBoost(p, rankingNow)).length,
      seenCount: selectedPosts.filter((p) => seenMap.has(normalizeId(p._id))).length,
      interactedCount: selectedPosts.filter((p) => (
        wasRecentlyInteracted(interestProfile.interactionMap?.get(normalizeId(p._id)), rankingNow)
      )).length,
      returnedIds: selectedPosts.map((p) => normalizeId(p._id)),
    });
  }

  return {
    posts: deliveredMedia.posts,
    ...(query.targetClipId ? { targetClip: deliveredMedia.targetClip } : {}),
    pagination: {
      current: page,
      total: total !== null ? Math.ceil(total / limit) : undefined,
      count: selectedPosts.length,
      totalPosts: mode === 'feed' ? total : undefined,
      totalClips: mode === 'clips' ? total : undefined,
      hasMore: Boolean(nextCursor),
      nextCursor,
      cursor: query.cursor || null
    },
    recommendation: {
      algorithm: 'weighted-v2',
      mode,
      context: impressionContext,
      sessionSeed,
      signals: [
        'visibility',
        'follow_graph',
        'engagement',
        'freshness_decay',
        'new_post_kicker',
        'tag_affinity',
        'author_affinity',
        'quality_penalty',
        'diversity',
        'session_exploration',
        mode === 'feed' ? 'session_candidate_window' : 'watched_candidate_exclusion',
        'seen_post_cooldown',
        'exact_post_interaction_suppression',
        mode === 'feed' ? 'unseen_session_priority' : 'watched_content_rotation',
        'previous_top_position_penalty',
        'boost_campaign_score',
        'boost_frequency_cap',
        'boost_slot_rotation',
        mode === 'clips' ? 'watched_exclusion' : 'fresh_content'
      ],
      exhaustedFreshClips
    }
  };
}

async function recordEngagementEvent({
  userId,
  postId,
  authorId,
  eventType,
  context = 'unknown',
  durationMs = 0,
  completionRate = 0,
  metadata = {},
  source = 'organic',
  boostCampaign = null
}) {
  if (!userId || !postId || !eventType) return;
  const normalizedContext = normalizeEngagementContext(context);
  const normalizedDurationMs = normalizeEngagementDuration(durationMs);
  const normalizedCompletionRate = normalizeCompletionRate(completionRate);
  const payload = {
    user: userId,
    post: postId,
    author: authorId,
    eventType,
    context: normalizedContext,
    durationMs: normalizedDurationMs,
    completionRate: normalizedCompletionRate,
    source: source === 'boost' ? 'boost' : 'organic',
    boostCampaign,
    metadata
  };

  try {
    if (eventType === 'view') {
      const filter = { user: userId, post: postId, eventType, context: normalizedContext };
      const update = buildViewEngagementUpdate(payload);
      try {
        await PostEngagement.updateOne(filter, update, { upsert: true });
      } catch (error) {
        if (error?.code !== 11000) throw error;
        // A concurrent first view won the unique-index race. Re-apply the
        // monotonic fields so the losing request's watch progress is not lost.
        await PostEngagement.updateOne(filter, update, { upsert: false });
      }
      return;
    }
    await PostEngagement.create(payload);
  } catch (error) {
    if (error?.code !== 11000) {
      log.warn('Failed to record post engagement event', { error: String(error), eventType, postId: String(postId) });
    }
  }
}

module.exports = {
  getRecommendedPosts,
  getRelationshipContext,
  recordEngagementEvent,
  scorePost,
  selectDiversePosts,
  selectSessionFreshPosts,
  wasServedInPreviousSession,
  applyBoostPlacement,
  applyCursorAndExclusions,
  pickNextCursorPost,
  getCandidatePoolLimit,
  getCandidateExplorationSkip,
  buildImpressionOps,
  getSeenPenalty,
  getInteractionPenalty,
  wasRecentlyInteracted,
  getRecentTopPositionPenalty,
  getDampedBoostScore,
  normalizeSessionSeed,
  stableNoise,
  encodeCursor,
  decodeCursor,
  parseExcludedIds,
  preserveTargetClipInExclusions,
  buildTargetClipFilter,
  buildAudienceFilter,
  buildViewEngagementUpdate,
  normalizeEngagementContext,
  normalizeEngagementDuration,
  normalizeCompletionRate,
  MAX_ENGAGEMENT_DURATION_MS,
  SEEN_COOLDOWN_HOURS,
  INTERACTION_COOLDOWN_HOURS,
  TOP_POSITION_PENALTY_BASE,
  TOP_POSITION_PENALTY_WINDOW_HOURS,
  BOOST_USER_COOLDOWN_HOURS,
  BOOST_FREQUENCY_CAP,
  BOOST_TOP_WINDOW
};
