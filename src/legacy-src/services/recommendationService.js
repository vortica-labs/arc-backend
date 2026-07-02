const mongoose = require('mongoose');
const Post = require('../models/Post');
const User = require('../models/User');
const Follow = require('../models/Follow');
const PostEngagement = require('../models/PostEngagement');
const { formatPostDTO } = require('../utils/dto');
const log = require('../utils/logger');
const { getBoostScore, getDeliverySource, recordBoostDelivery } = require('./boostService');

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 30;
const MAX_EXCLUDED_IDS = 120;
const CANDIDATE_MULTIPLIER = 8;

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
    filter.tags = { $in: String(query.tags).split(',').map((tag) => tag.trim()).filter(Boolean) };
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
    and.push({
      $or: [
        { createdAt: { $lt: decoded.createdAt } },
        { createdAt: decoded.createdAt, _id: { $lt: decoded.id } }
      ]
    });
  }

  if (and.length > 0) nextFilter.$and = and;
  return nextFilter;
}

async function getInterestProfile(userId, relationship) {
  if (!userId) {
    return {
      tagWeights: new Map(),
      authorWeights: new Map(),
      postTypeWeights: new Map()
    };
  }

  const recentEvents = await PostEngagement.find({ user: userId })
    .sort({ createdAt: -1 })
    .limit(160)
    .select('post author eventType')
    .lean()
    .catch(() => []);

  const eventPostIds = recentEvents.map((event) => event.post).filter(Boolean);
  const savedUser = await User.findById(userId)
    .select('savedPosts.post')
    .lean()
    .catch(() => null);
  const savedPostIds = Array.isArray(savedUser?.savedPosts)
    ? savedUser.savedPosts.map((item) => item.post).filter(Boolean)
    : [];
  const likedPosts = await Post.find({
    $or: [
      { 'likes.user': userId },
      { 'comments.user': userId },
      { _id: { $in: [...eventPostIds, ...savedPostIds] } }
    ],
    isActive: true
  })
    .sort({ createdAt: -1 })
    .limit(120)
    .select('author tags postType')
    .lean()
    .catch(() => []);

  const tagWeights = new Map();
  const authorWeights = new Map();
  const postTypeWeights = new Map();

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
  });

  likedPosts.forEach((post) => {
    const authorId = normalizeId(post.author);
    if (authorId) authorWeights.set(authorId, (authorWeights.get(authorId) || 0) + 4);
    if (post.postType) postTypeWeights.set(post.postType, (postTypeWeights.get(post.postType) || 0) + 2);
    (post.tags || []).forEach((tag) => {
      const key = String(tag).toLowerCase();
      tagWeights.set(key, (tagWeights.get(key) || 0) + 3);
    });
  });

  return { tagWeights, authorWeights, postTypeWeights };
}

function scorePost(post, { mode, relationship, interestProfile, seed }) {
  const now = Date.now();
  const createdAt = new Date(post.createdAt).getTime();
  const hoursOld = Math.max(0, (now - createdAt) / 36e5);
  const freshness = Math.exp(-hoursOld / (mode === 'clips' ? 96 : 72));

  const likes = getCount(post.likes);
  const comments = getCount(post.comments);
  const shares = getCount(post.shares);
  const reports = getCount(post.reports);
  const views = Math.max(getCount(post.viewedBy), post.views || 0);
  const engagement = (likes * 3) + (comments * 7) + (shares * 9) + (views * 0.35);
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
  const boostScore = getBoostScore(post, { mode, now });
  const qualityPenalty = reports * 25;
  const exploration = stableNoise(seed, post._id) * (mode === 'clips' ? 16 : 10);
  const viralVelocity = engagementRate > 0 ? Math.min(35, engagementRate * 28) : 0;

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

async function fetchCandidates(filter, { limit, page, cursor }) {
  const query = Post.find(filter)
    .populate('author', 'username profile.displayName profile.avatar profilePicture avatar userType privacySettings isActive')
    .populate('likes.user', 'username profile.displayName profile.avatar profilePicture avatar')
    .populate('comments.user', 'username profile.displayName profile.avatar profilePicture avatar')
    .sort({ createdAt: -1, _id: -1 })
    .limit(Math.max(limit * CANDIDATE_MULTIPLIER, limit + 1));

  if (!cursor && page > 1) {
    query.skip((page - 1) * limit);
  }

  return query.exec();
}

async function getRecommendedPosts({ user, query = {}, mode = 'feed' }) {
  const limit = clampLimit(query.limit, mode === 'clips' ? 10 : DEFAULT_LIMIT);
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const excludedIds = parseExcludedIds(query.exclude || query.excludedIds);
  const relationship = await getRelationshipContext(user);
  const interestProfile = await getInterestProfile(relationship.currentUserId, relationship);
  const baseFilter = buildAudienceFilter({ user, mode, relationship, query });
  const watchedClipIds = mode === 'clips' && query.includeViewed !== 'true'
    ? await findWatchedClipIds(relationship.currentUserId)
    : new Set();

  const effectiveExcludedIds = [...new Set([
    ...excludedIds,
    ...(mode === 'clips' ? Array.from(watchedClipIds) : [])
  ])];

  let filter = applyCursorAndExclusions(baseFilter, {
    cursor: query.cursor,
    excludedIds: effectiveExcludedIds
  });

  let candidates = await fetchCandidates(filter, { limit, page, cursor: query.cursor });
  let exhaustedFreshClips = false;

  if (mode === 'clips' && candidates.length < limit && watchedClipIds.size > 0) {
    exhaustedFreshClips = true;
    const freshCandidates = candidates;
    const freshIds = new Set(freshCandidates.map((post) => normalizeId(post._id)));
    filter = applyCursorAndExclusions(baseFilter, {
      cursor: query.cursor,
      excludedIds: [...excludedIds, ...Array.from(freshIds)]
    });
    const fallbackCandidates = await fetchCandidates(filter, { limit, page, cursor: query.cursor });
    candidates = [...freshCandidates, ...fallbackCandidates];
  }

  const todaySeed = new Date().toISOString().slice(0, 10);
  const seed = `${relationship.currentUserId || 'guest'}:${mode}:${todaySeed}`;
  const scored = candidates
    .map((post) => ({ post, score: scorePost(post, { mode, relationship, interestProfile, seed }) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return new Date(b.post.createdAt).getTime() - new Date(a.post.createdAt).getTime();
    });

  const selected = selectDiversePosts(scored, limit, mode);
  const selectedPosts = selected.map((item) => item.post);
  await recordBoostDelivery(selectedPosts, mode).catch((error) => {
    log.warn('Failed to record boost delivery', { error: String(error), mode });
  });
  const lastCandidate = candidates[candidates.length - 1] || selectedPosts[selectedPosts.length - 1] || null;
  const nextCursor = candidates.length >= limit ? encodeCursor(lastCandidate) : null;
  const total = !query.cursor
    ? await Post.countDocuments(baseFilter).catch(() => null)
    : null;
  const isGuest = user && user.userType === 'guest';

  return {
    posts: selectedPosts.map((post) => {
      const dto = formatPostDTO(
        post,
        isGuest,
        Boolean(relationship.currentUserId && normalizeId(post.author) === relationship.currentUserId)
      );
      if (dto) dto.deliverySource = getDeliverySource(post);
      return dto;
    }),
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
      algorithm: 'weighted-v1',
      mode,
      signals: [
        'visibility',
        'follow_graph',
        'engagement',
        'freshness_decay',
        'tag_affinity',
        'author_affinity',
        'quality_penalty',
        'diversity',
        'exploration',
        'boost_campaign_score',
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
  const payload = {
    user: userId,
    post: postId,
    author: authorId,
    eventType,
    context,
    durationMs,
    completionRate,
    source: source === 'boost' ? 'boost' : 'organic',
    boostCampaign,
    metadata
  };

  try {
    if (eventType === 'view') {
      await PostEngagement.updateOne(
        { user: userId, post: postId, eventType, context },
        {
          $setOnInsert: payload,
          $set: {
            durationMs,
            completionRate,
            updatedAt: new Date()
          }
        },
        { upsert: true }
      );
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
  recordEngagementEvent,
  scorePost,
  selectDiversePosts,
  encodeCursor,
  decodeCursor,
  parseExcludedIds,
  buildAudienceFilter
};
