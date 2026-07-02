const Challenge = require('../models/Challenge');
const ChallengeParticipation = require('../models/ChallengeParticipation');
const User = require('../models/User');
const Follow = require('../models/Follow');
const safeAsyncHandler = require('../utils/safeAsyncHandler');
const log = require('../utils/logger');
const mongoose = require('mongoose');
const { resolvePrivacyAccess, minimalProfile } = require('../utils/privacyPolicy');

const idString = (value) => String(value?._id || value || '');
const isGuestViewer = (viewer) => !viewer?._id || viewer.userType === 'guest';

const serializeChallenge = (value, { includeParticipants = false } = {}) => {
  const challenge = value?.toObject
    ? value.toObject({ virtuals: true })
    : JSON.parse(JSON.stringify(value || {}));
  if (challenge.creator && typeof challenge.creator === 'object') {
    challenge.creator = minimalProfile(challenge.creator);
  }
  challenge.participantCount = Array.isArray(challenge.participants)
    ? challenge.participants.length
    : Number(challenge.participantCount ?? challenge.stats?.totalParticipants ?? 0);
  if (!includeParticipants) {
    delete challenge.participants;
  } else {
    challenge.participants = (challenge.participants || []).map((entry) => ({
      ...entry,
      user: entry?.user && typeof entry.user === 'object' ? minimalProfile(entry.user) : entry?.user
    }));
  }
  return challenge;
};

const canAccessChallengeVisibility = ({ visibility, isSelf = false, isFollower = false }) => {
  const normalized = ['public', 'followers', 'private'].includes(visibility)
    ? visibility
    : 'private';
  return Boolean(
    isSelf
    || normalized === 'public'
    || (normalized === 'followers' && isFollower)
  );
};

const resolveChallengeAccess = async ({ challenge, viewer }) => {
  const creatorId = idString(challenge?.creator);
  const creator = challenge?.creator?.privacySettings
    ? challenge.creator
    : await User.findById(creatorId)
      .select('username userType profile privacySettings blockedUsers isActive')
      .lean();
  if (!creator || creator.isActive === false) return { allowed: false, reason: 'not_found', creator: null };
  const relationship = await resolvePrivacyAccess({ viewer, targetUser: creator });
  if (!relationship.access.canViewProfile) {
    return { allowed: false, reason: relationship.access.reason, creator, relationship };
  }
  const allowed = canAccessChallengeVisibility({
    visibility: challenge.visibility,
    isSelf: relationship.isSelf,
    isFollower: relationship.isFollower
  });
  return {
    allowed,
    reason: allowed ? 'allowed' : 'challenge_visibility',
    creator,
    relationship
  };
};

const rejectChallengePrivacy = (res, access) => res.status(
  access?.reason === 'not_found' ? 404 : 403
).json({
  success: false,
  code: access?.reason === 'not_found' ? 'CHALLENGE_NOT_FOUND' : 'PRIVACY_RESTRICTED',
  reason: access?.reason || 'privacy_restricted',
  message: access?.reason === 'not_found' ? 'Challenge not found' : 'You do not have access to this challenge'
});

// Create a new challenge (Creator only)
const createChallenge = safeAsyncHandler(async (req, res) => {
  const {
    title,
    description,
    challengeType,
    game,
    category,
    requirements,
    rewards,
    startDate,
    endDate,
    visibility,
    tags,
    creatorSettings,
    media
  } = req.body;

  const creatorId = req.user._id;

  // Validate creator permissions
  if (req.user.userType !== 'creator' && !req.user.isCreator) {
    return res.status(403).json({
      success: false,
      message: 'Only creators can create challenges'
    });
  }

  // Validate dates
  const start = new Date(startDate);
  const end = new Date(endDate);

  if (start >= end) {
    return res.status(400).json({
      success: false,
      message: 'End date must be after start date'
    });
  }

  if (start < new Date()) {
    return res.status(400).json({
      success: false,
      message: 'Start date cannot be in the past'
    });
  }

  // Create challenge
  const challenge = new Challenge({
    creator: creatorId,
    title,
    description,
    challengeType,
    game,
    category,
    requirements,
    rewards,
    startDate: start,
    endDate: end,
    visibility,
    tags: tags || [],
    creatorSettings: creatorSettings || {},
    media: media || {}
  });

  await challenge.save();
  await challenge.populate('creator', 'username profile.displayName profile.avatar');

  res.status(201).json({
    success: true,
    message: 'Challenge created successfully',
    data: challenge
  });
});

// Get all challenges with filters
const getChallenges = safeAsyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    game,
    category,
    challengeType,
    status = 'active',
    creator,
    search,
    sortBy = 'createdAt',
    sortOrder = 'desc'
  } = req.query;

  const pageNumber = Math.max(1, parseInt(page, 10) || 1);
  const pageLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 10));
  const query = {};

  // Apply filters
  if (game) query.game = game;
  if (category) query.category = category;
  if (challengeType) query.challengeType = challengeType;
  if (status) query.status = status;
  if (creator) {
    query.creator = mongoose.Types.ObjectId.isValid(String(creator))
      ? new mongoose.Types.ObjectId(String(creator))
      : null;
  }

  // Search functionality
  if (search) {
    const escapedSearch = String(search).trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.$or = [
      { title: { $regex: escapedSearch, $options: 'i' } },
      { description: { $regex: escapedSearch, $options: 'i' } },
      { tags: { $in: [new RegExp(escapedSearch, 'i')] } }
    ];
  }

  const allowedSortFields = new Set(['createdAt', 'startDate', 'endDate', 'title', 'stats.totalParticipants']);
  const safeSortBy = allowedSortFields.has(String(sortBy)) ? String(sortBy) : 'createdAt';
  const sortOptions = { [safeSortBy]: sortOrder === 'asc' ? 1 : -1, _id: 1 };
  const hasViewer = !isGuestViewer(req.user);
  const viewerId = hasViewer ? new mongoose.Types.ObjectId(String(req.user._id)) : null;
  const viewerRecord = hasViewer
    ? await User.findById(viewerId).select('blockedUsers').lean()
    : null;
  const viewerBlockedIds = (viewerRecord?.blockedUsers || [])
    .filter((value) => mongoose.Types.ObjectId.isValid(String(value)))
    .map((value) => new mongoose.Types.ObjectId(String(value)));
  const creatorVisibility = {
    $switch: {
      branches: [
        {
          case: { $in: ['$__creator.privacySettings.profileVisibility', ['public', 'followers', 'private']] },
          then: '$__creator.privacySettings.profileVisibility'
        },
        {
          case: {
            $and: [
              { $eq: [{ $type: '$__creator.privacySettings.profileVisibility' }, 'missing'] },
              {
                $or: [
                  { $eq: ['$__creator.privacySettings.accountType', 'public'] },
                  { $eq: [{ $type: '$__creator.privacySettings.accountType' }, 'missing'] }
                ]
              }
            ]
          },
          then: 'public'
        }
      ],
      default: 'private'
    }
  };

  const pipeline = [
    { $match: query },
    {
      $lookup: {
        from: User.collection.name,
        let: { creatorId: '$creator' },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', '$$creatorId'] } } },
          { $match: { isActive: true } },
          { $limit: 1 }
        ],
        as: '__creator'
      }
    },
    { $unwind: '$__creator' },
    ...(hasViewer ? [{
      $lookup: {
        from: Follow.collection.name,
        let: { creatorId: '$creator' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$follower', viewerId] },
                  { $eq: ['$following', '$$creatorId'] }
                ]
              }
            }
          },
          { $limit: 1 }
        ],
        as: '__viewerFollow'
      }
    }] : []),
    {
      $match: {
        $expr: hasViewer
          ? {
              $and: [
                { $not: [{ $in: ['$creator', viewerBlockedIds] }] },
                { $not: [{ $in: [viewerId, { $ifNull: ['$__creator.blockedUsers', []] }] }] },
                {
                  $or: [
                    { $eq: ['$creator', viewerId] },
                    { $eq: [creatorVisibility, 'public'] },
                    { $gt: [{ $size: '$__viewerFollow' }, 0] }
                  ]
                },
                {
                  $or: [
                    { $eq: ['$creator', viewerId] },
                    { $eq: ['$visibility', 'public'] },
                    {
                      $and: [
                        { $eq: ['$visibility', 'followers'] },
                        { $gt: [{ $size: '$__viewerFollow' }, 0] }
                      ]
                    }
                  ]
                }
              ]
            }
          : {
              $and: [
                { $eq: [creatorVisibility, 'public'] },
                { $eq: ['$visibility', 'public'] }
              ]
            }
      }
    },
    {
      $addFields: {
        creator: {
          _id: '$__creator._id',
          username: '$__creator.username',
          userType: '$__creator.userType',
          profile: {
            displayName: '$__creator.profile.displayName',
            avatar: '$__creator.profile.avatar'
          }
        },
        participantCount: { $size: { $ifNull: ['$participants', []] } }
      }
    },
    { $project: { participants: 0, __creator: 0, __viewerFollow: 0 } },
    {
      $facet: {
        records: [
          { $sort: sortOptions },
          { $skip: (pageNumber - 1) * pageLimit },
          { $limit: pageLimit }
        ],
        metadata: [{ $count: 'total' }]
      }
    }
  ];

  const [result = {}] = await Challenge.aggregate(pipeline);
  const challenges = (result.records || []).map((challenge) => serializeChallenge(challenge));
  const total = Number(result.metadata?.[0]?.total || 0);

  res.json({
    success: true,
    data: {
      challenges,
      pagination: {
        currentPage: pageNumber,
        totalPages: Math.ceil(total / pageLimit),
        totalChallenges: total,
        hasNext: pageNumber < Math.ceil(total / pageLimit),
        hasPrev: pageNumber > 1
      }
    }
  });
});

// Get single challenge
const getChallenge = safeAsyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(String(id))) {
    return res.status(404).json({ success: false, message: 'Challenge not found' });
  }

  const challenge = await Challenge.findById(id)
    .populate('creator', 'username userType profile.displayName profile.avatar privacySettings blockedUsers isActive')
    .populate('participants.user', 'username profile.displayName profile.avatar');

  if (!challenge) {
    return res.status(404).json({
      success: false,
      message: 'Challenge not found'
    });
  }

  const access = await resolveChallengeAccess({ challenge, viewer: req.user });
  if (!access.allowed) return rejectChallengePrivacy(res, access);

  // Increment view count
  challenge.stats.views += 1;
  await challenge.save();

  res.json({
    success: true,
    data: serializeChallenge(challenge, { includeParticipants: access.relationship?.isSelf === true })
  });
});

// Join a challenge
const joinChallenge = safeAsyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user._id;
  if (!mongoose.Types.ObjectId.isValid(String(id))) {
    return res.status(404).json({ success: false, message: 'Challenge not found' });
  }

  const challenge = await Challenge.findById(id)
    .populate('creator', 'username userType profile.displayName profile.avatar privacySettings blockedUsers isActive');
  if (!challenge) {
    return res.status(404).json({
      success: false,
      message: 'Challenge not found'
    });
  }

  const access = await resolveChallengeAccess({ challenge, viewer: req.user });
  if (!access.allowed) return rejectChallengePrivacy(res, access);

  // Check if challenge is active
  if (challenge.status !== 'active') {
    return res.status(400).json({
      success: false,
      message: 'Challenge is not active'
    });
  }

  // Check if challenge has started
  if (new Date() < challenge.startDate) {
    return res.status(400).json({
      success: false,
      message: 'Challenge has not started yet'
    });
  }

  // Check if challenge has ended
  if (new Date() > challenge.endDate) {
    return res.status(400).json({
      success: false,
      message: 'Challenge has ended'
    });
  }

  try {
    await challenge.addParticipant(userId);

    // Create participation record
    const participation = new ChallengeParticipation({
      challenge: challenge._id,
      participant: userId,
      progress: {
        targetValue: challenge.requirements.targetValue
      }
    });

    await participation.save();
    await participation.populate('participant', 'username profile.displayName profile.avatar');

    res.json({
      success: true,
      message: 'Successfully joined challenge',
      data: participation
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// Update challenge progress
const updateProgress = safeAsyncHandler(async (req, res) => {
  const { id } = req.params;
  const { progressValue } = req.body;
  const userId = req.user._id;

  const challenge = await Challenge.findById(id);
  if (!challenge) {
    return res.status(404).json({
      success: false,
      message: 'Challenge not found'
    });
  }

  const participation = await ChallengeParticipation.findOne({
    challenge: challenge._id,
    participant: userId
  });

  if (!participation) {
    return res.status(400).json({
      success: false,
      message: 'You are not participating in this challenge'
    });
  }

  try {
    await participation.updateProgress(progressValue, challenge);
    await challenge.updateProgress(userId, progressValue);

    res.json({
      success: true,
      message: 'Progress updated successfully',
      data: participation
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

// Get user's challenges (created by user)
const getMyChallenges = safeAsyncHandler(async (req, res) => {
  const { page = 1, limit = 10, status } = req.query;
  const userId = req.user._id;

  const query = { creator: userId };
  if (status) query.status = status;

  const challenges = await Challenge.find(query)
    .populate('creator', 'username profile.displayName profile.avatar')
    .sort({ createdAt: -1 })
    .limit(limit * 1)
    .skip((page - 1) * limit)
    .lean();

  const total = await Challenge.countDocuments(query);

  res.json({
    success: true,
    data: {
      challenges,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalChallenges: total,
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1
      }
    }
  });
});

// Get user's participations
const getMyParticipations = safeAsyncHandler(async (req, res) => {
  const { page = 1, limit = 10, status } = req.query;
  const userId = req.user._id;

  const query = { participant: userId };
  if (status) query.status = status;

  const participations = await ChallengeParticipation.find(query)
    .populate('challenge', 'title description game challengeType rewards startDate endDate')
    .populate('challenge.creator', 'username profile.displayName profile.avatar')
    .sort({ joinedAt: -1 })
    .limit(limit * 1)
    .skip((page - 1) * limit)
    .lean();

  const total = await ChallengeParticipation.countDocuments(query);

  res.json({
    success: true,
    data: {
      participations,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalParticipations: total,
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1
      }
    }
  });
});

// Update challenge (Creator only)
const updateChallenge = safeAsyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user._id;

  const challenge = await Challenge.findById(id);
  if (!challenge) {
    return res.status(404).json({
      success: false,
      message: 'Challenge not found'
    });
  }

  // Check if user is the creator
  if (challenge.creator.toString() !== userId.toString()) {
    return res.status(403).json({
      success: false,
      message: 'Only the creator can update this challenge'
    });
  }

  // Whitelist fields to prevent NoSQL Mass Assignment / Injection
  const allowedGeneralUpdates = [
    'title', 'description', 'challengeType', 'game', 'category',
    'requirements', 'rewards', 'startDate', 'endDate', 'visibility',
    'tags', 'creatorSettings', 'media', 'status'
  ];

  const updateData = {};
  allowedGeneralUpdates.forEach(field => {
    if (req.body[field] !== undefined) {
      updateData[field] = req.body[field];
    }
  });

  // Don't allow updating core fields if challenge has started and has participants
  if (challenge.status === 'active' && challenge.participants.length > 0) {
    const allowedActiveUpdates = ['description', 'media', 'creatorSettings'];
    const updateKeys = Object.keys(updateData);
    const hasRestrictedUpdate = updateKeys.some(key => !allowedActiveUpdates.includes(key));

    if (hasRestrictedUpdate) {
      return res.status(400).json({
        success: false,
        message: 'Cannot update core challenge details after it has started with participants'
      });
    }
  }

  const updatedChallenge = await Challenge.findByIdAndUpdate(
    id,
    { $set: updateData },
    { new: true, runValidators: true }
  ).populate('creator', 'username profile.displayName profile.avatar');

  res.json({
    success: true,
    message: 'Challenge updated successfully',
    data: updatedChallenge
  });
});

// Delete challenge (Creator only)
const deleteChallenge = safeAsyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user._id;

  const challenge = await Challenge.findById(id);
  if (!challenge) {
    return res.status(404).json({
      success: false,
      message: 'Challenge not found'
    });
  }

  // Check if user is the creator
  if (challenge.creator.toString() !== userId.toString()) {
    return res.status(403).json({
      success: false,
      message: 'Only the creator can delete this challenge'
    });
  }

  // Don't allow deletion if challenge has participants
  if (challenge.participants.length > 0) {
    return res.status(400).json({
      success: false,
      message: 'Cannot delete challenge with active participants'
    });
  }

  await Challenge.findByIdAndDelete(id);
  await ChallengeParticipation.deleteMany({ challenge: id });

  res.json({
    success: true,
    message: 'Challenge deleted successfully'
  });
});

// Distribute rewards (Creator only)
const distributeRewards = safeAsyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user._id;

  const challenge = await Challenge.findById(id);
  if (!challenge) {
    return res.status(404).json({
      success: false,
      message: 'Challenge not found'
    });
  }

  // Check if user is the creator
  if (challenge.creator.toString() !== userId.toString()) {
    return res.status(403).json({
      success: false,
      message: 'Only the creator can distribute rewards'
    });
  }

  // Check if challenge has ended
  if (new Date() < challenge.endDate) {
    return res.status(400).json({
      success: false,
      message: 'Challenge has not ended yet'
    });
  }

  try {
    await challenge.distributeRewards();

    // Update participation records
    await ChallengeParticipation.updateMany(
      {
        challenge: challenge._id,
        'progress.completed': true,
        'rewards.claimed': false
      },
      {
        'rewards.claimed': true,
        'rewards.claimedAt': new Date()
      }
    );

    res.json({
      success: true,
      message: 'Rewards distributed successfully',
      data: {
        totalRewardsDistributed: challenge.stats.totalRewardsDistributed
      }
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
});

module.exports = {
  createChallenge,
  getChallenges,
  getChallenge,
  joinChallenge,
  updateProgress,
  getMyChallenges,
  getMyParticipations,
  updateChallenge,
  deleteChallenge,
  distributeRewards,
  _private: {
    canAccessChallengeVisibility,
    serializeChallenge
  }
};
