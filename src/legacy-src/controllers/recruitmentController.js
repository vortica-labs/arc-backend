const TeamRecruitment = require('../models/TeamRecruitment');
const PlayerProfile = require('../models/PlayerProfile');
const RecruitmentApplication = require('../models/RecruitmentApplication');
const User = require('../models/User');
const mongoose = require('mongoose');
const safeAsyncHandler = require('../utils/safeAsyncHandler');
const log = require('../utils/logger');
const { isSocialPreviewRequest } = require('../utils/socialPreviewRequest');
const { createAndEmitNotification } = require('../utils/notificationEmitter');
const { resolvePrivacyAccess } = require('../utils/privacyPolicy');
const {
  generateRecruitmentCode,
  generatePlayerProfileCode,
  saveWithUniqueShareCode,
  backfillUniqueShareCode
} = require('../utils/recruitmentShareCode');
const {
  getPlayerCardDailyLimit,
  reservePlayerCardSlot,
  releasePlayerCardSlot
} = require('../services/recruitmentPostingQuota');
const {
  TEAM_RECRUITMENT_STATUSES,
  PLAYER_PROFILE_STATUSES,
  TEAM_APPLICATION_STATUSES,
  serializeTeamRecruitment,
  serializePlayerProfile,
  isRecruitmentLive,
  isPlayerProfileLive,
  addTeamRecruitmentIntegrityFilters,
  addPlayerProfileIntegrityFilters,
  getValidRecruitmentOwnerMatch,
  isTeamRecruitmentStructurallyValid,
  isPlayerProfileStructurallyValid,
  listCanonicalRecruitmentRecords,
  listCanonicalRecruitmentApplications,
  sameId,
  parsePagination,
  escapeRegex,
  mergeAllowedObject,
  validateTeamRecruitmentCreateProgression,
  validatePlayerProfileCreateProgression
} = require('../services/recruitmentPolicy');

const RECRUITMENT_REQUIREMENT_FIELDS = [
  'dailyPlayingTime', 'tournamentExperience', 'requiredDevice', 'experienceLevel',
  'language', 'additionalRequirements', 'availability', 'requiredSkills', 'portfolioRequirements'
];
const RECRUITMENT_BENEFIT_FIELDS = [
  'salary', 'customSalary', 'location', 'benefitsAndPerks', 'contactInformation'
];
const PLAYER_INFO_FIELDS = [
  'playerName', 'currentRank', 'experienceLevel', 'tournamentExperience',
  'achievements', 'availability', 'languages', 'additionalInfo'
];
const PROFESSIONAL_INFO_FIELDS = [
  'fullName', 'experienceLevel', 'availability', 'preferredLocation',
  'skillsAndExpertise', 'professionalAchievements', 'portfolio'
];
const EXPECTATION_FIELDS = [
  'expectedSalary', 'compensationPreference', 'preferredTeamSize', 'teamType',
  'preferredLocation', 'additionalInfo', 'contactInformation'
];
const RECRUITMENT_GAMES = new Set(['BGMI', 'Valorant', 'Free Fire', 'Call of Duty Mobile', 'CS:GO', 'Fortnite', 'Apex Legends', 'League of Legends', 'Dota 2']);
const normalizeQueryString = (value, maxLength = 200) => (
  typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
);

const normalizeOptionalString = (value) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim();
  return normalized || undefined;
};

const requireUserType = (req, res, expectedType, message) => {
  if (req.user?.userType === expectedType) return true;
  res.status(403).json({ success: false, message });
  return false;
};

const findTeamRecruitmentByIdentifier = (identifier) => {
  if (identifier && mongoose.Types.ObjectId.isValid(identifier)) {
    return TeamRecruitment.findById(identifier);
  }
  return TeamRecruitment.findOne({ recruitmentCode: String(identifier || '').trim().toUpperCase() });
};

const findPlayerProfileByIdentifier = (identifier) => {
  if (identifier && mongoose.Types.ObjectId.isValid(identifier)) {
    return PlayerProfile.findById(identifier);
  }
  return PlayerProfile.findOne({ profileCode: String(identifier || '').trim().toUpperCase() });
};

const addLiveFilters = (query, now = new Date()) => {
  query.status = 'active';
  query.isActive = true;
  query.$or = [
    { expiresAt: { $gt: now } },
    { expiresAt: null },
    { expiresAt: { $exists: false } }
  ];
  return query;
};

const isSameOptionalString = (incoming, existing) => {
  const normalizedIncoming = normalizeOptionalString(incoming);
  const normalizedExisting = normalizeOptionalString(existing);
  return normalizedIncoming === normalizedExisting;
};

const notifyRecruitmentEvent = ({ recipient, sender, title, message, eventType, deliveryKey, data = {} }) =>
  createAndEmitNotification({
    recipient: recipient?._id || recipient,
    sender: sender?._id || sender,
    type: 'recruitment',
    title,
    message,
    data: {
      deepLink: data.recruitmentCode
        ? `/recruitment/${encodeURIComponent(String(data.recruitmentCode))}`
        : data.profileCode
          ? `/profile/${encodeURIComponent(String(data.profileCode))}`
          : '/recruitment',
      customData: {
        eventType,
        notificationDedupeKey: deliveryKey,
        pushRequestId: deliveryKey,
        ...data
      }
    }
  });

const queueRecruitmentNotification = (payload, context) => {
  void notifyRecruitmentEvent(payload).catch((error) => {
    log.error('Recruitment notification dispatch failed', {
      error: String(error),
      ...context
    });
  });
};

const syncEmbeddedApplicantStatus = async ({ recruitmentId, teamId, applicantId, application, status }) => {
  const updateResult = await TeamRecruitment.updateOne(
    { _id: recruitmentId, team: teamId, 'applicants.user': applicantId },
    { $set: { 'applicants.$.status': status } }
  );
  if (updateResult.matchedCount === 1) return;

  const repairResult = await TeamRecruitment.updateOne(
    { _id: recruitmentId, team: teamId, 'applicants.user': { $ne: applicantId } },
    {
      $push: {
        applicants: {
          user: applicantId,
          appliedAt: application.createdAt || new Date(),
          status,
          message: application.message,
          resume: application.resume,
          portfolio: application.portfolio
        }
      }
    }
  );
  if (repairResult.modifiedCount !== 1) {
    const error = new Error('Recruitment applicant status could not be synchronized');
    error.code = 'RECRUITMENT_APPLICANT_SYNC_FAILED';
    throw error;
  }
};

const emitRecruitmentDirectMessage = (applicantId, teamId, message) => {
  const io = global._arcSocketIO;
  if (!io?.to) return false;
  io.to(`user-${String(applicantId)}`).emit('newMessage', {
    chatId: `direct_${teamId}`,
    message
  });
  return true;
};

const getCanonicalApplicantRecipientIds = async (recruitmentId) => {
  const recipientIds = await RecruitmentApplication.distinct('applicant', {
    recruitment: recruitmentId,
    isActive: true
  });
  return Array.from(new Set(recipientIds.map((id) => String(id)).filter(Boolean)));
};

// Team Recruitment Controllers

// Create team recruitment post
const createTeamRecruitment = safeAsyncHandler(async (req, res) => {
  let { recruitmentType, game, role, staffRole, requirements, benefits } = req.body;
  const teamId = req.user._id;

  recruitmentType = normalizeOptionalString(recruitmentType);
  game = normalizeOptionalString(game);
  role = normalizeOptionalString(role);
  staffRole = normalizeOptionalString(staffRole);

  // Validate team user
  if (!requireUserType(req, res, 'team', 'Only teams can create recruitment posts')) return;

  const normalizedRequirements = mergeAllowedObject({}, requirements, RECRUITMENT_REQUIREMENT_FIELDS);
  const normalizedBenefits = mergeAllowedObject({}, benefits, RECRUITMENT_BENEFIT_FIELDS);
  const progressionError = validateTeamRecruitmentCreateProgression({
    recruitmentType, game, role, staffRole,
    requirements: normalizedRequirements,
    benefits: normalizedBenefits
  });
  if (progressionError) {
    return res.status(400).json({ success: false, message: progressionError });
  }

  const recruitment = new TeamRecruitment({
    team: teamId,
    recruitmentType,
    game: game || undefined,
    role: recruitmentType === 'roster' ? role : undefined,
    staffRole: recruitmentType === 'staff' ? staffRole : undefined,
    requirements: normalizedRequirements,
    benefits: normalizedBenefits
  });

  await saveWithUniqueShareCode({
    document: recruitment,
    codeField: 'recruitmentCode',
    generateCode: () => generateRecruitmentCode(recruitment)
  });

  // Populate team information
  await recruitment.populate('team', 'username profile.displayName profile.avatar');

  res.status(201).json({
    success: true,
    message: 'Recruitment post created successfully',
    data: serializeTeamRecruitment(recruitment)
  });
});

// Get all team recruitments with filters
const getTeamRecruitments = safeAsyncHandler(async (req, res) => {
  const game = normalizeQueryString(req.query.game, 80);
  const recruitmentType = normalizeQueryString(req.query.recruitmentType, 20);
  const location = normalizeQueryString(req.query.location, 120);
  const search = normalizeQueryString(req.query.search, 100);
  const sortBy = normalizeQueryString(req.query.sortBy, 40) || 'createdAt';
  const sortOrder = normalizeQueryString(req.query.sortOrder, 4) || 'desc';
  const my = normalizeQueryString(req.query.my, 5);
  const status = normalizeQueryString(req.query.status, 20);
  if ((req.query.game !== undefined && (typeof req.query.game !== 'string' || (game && !RECRUITMENT_GAMES.has(game)))) ||
      (req.query.recruitmentType !== undefined && (typeof req.query.recruitmentType !== 'string' || (recruitmentType && !['roster', 'staff'].includes(recruitmentType)))) ||
      (req.query.location !== undefined && typeof req.query.location !== 'string') ||
      (req.query.search !== undefined && typeof req.query.search !== 'string') ||
      (req.query.sortBy !== undefined && typeof req.query.sortBy !== 'string') ||
      (req.query.sortOrder !== undefined && (typeof req.query.sortOrder !== 'string' || !['asc', 'desc'].includes(sortOrder))) ||
      (req.query.my !== undefined && (typeof req.query.my !== 'string' || (my && !['true', 'false'].includes(my)))) ||
      (req.query.status !== undefined && typeof req.query.status !== 'string')) {
    return res.status(400).json({ success: false, message: 'Invalid recruitment filter' });
  }
  const { page, limit } = parsePagination(req.query.page, req.query.limit);
  const ownListing = my === 'true';
  const query = addTeamRecruitmentIntegrityFilters(
    ownListing ? { team: req.user._id, isActive: true } : addLiveFilters({})
  );

  if (ownListing && status) {
    // The Web management page shares one status selector across tabs. Preserve
    // its behavior by returning an empty result for a status from another tab.
    if (TEAM_RECRUITMENT_STATUSES.includes(status)) query.status = status;
    else query._id = null;
  }

  // Apply filters
  if (game) query.game = game;
  if (recruitmentType) query.recruitmentType = recruitmentType;
  if (location) query['benefits.location'] = { $regex: escapeRegex(location), $options: 'i' };

  const searchPattern = search ? escapeRegex(search) : '';
  const searchFields = [
    'game', 'role', 'staffRole', 'requirements.additionalRequirements',
    'requirements.requiredSkills', 'requirements.experienceLevel',
    'requirements.language', 'benefits.location'
  ];

  const sortDirection = sortOrder === 'desc' ? -1 : 1;
  const allowedSortFields = new Set(['createdAt', 'game', 'role', 'staffRole', 'applicantCount']);
  const safeSortBy = allowedSortFields.has(sortBy) ? sortBy : 'createdAt';
  const { records: recruitments, total } = await listCanonicalRecruitmentRecords({
    model: TeamRecruitment,
    userModel: User,
    query,
    ownerField: 'team',
    expectedUserType: 'team',
    countField: 'applicantCount',
    sortBy: safeSortBy,
    sortDirection,
    page,
    limit,
    viewerId: req.user?._id,
    viewerBlockedIds: req.user?.blockedUsers,
    searchPattern,
    searchFields
  });
  const totalPages = Math.ceil(total / limit);

  res.json({
    success: true,
    data: {
      recruitments: recruitments.map(serializeTeamRecruitment),
      pagination: {
        currentPage: page,
        totalPages,
        totalRecruitments: total,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    }
  });
});

// Get single team recruitment (by ID or code)
const getTeamRecruitment = safeAsyncHandler(async (req, res) => {
  const id = req.params.id || req.params.code;
  const recruitment = await findTeamRecruitmentByIdentifier(id)
    .populate({
      path: 'team',
      match: getValidRecruitmentOwnerMatch('team'),
      select: 'username userType isActive profile privacySettings blockedUsers teamInfo.teamType'
    });

  if (!recruitment || !recruitment.team || !isTeamRecruitmentStructurallyValid(recruitment)) {
    return res.status(404).json({
      success: false,
      message: 'Recruitment post not found. The link may be invalid or the post has been removed.'
    });
  }

  const isOwner = sameId(recruitment.team, req.user?._id);
  const teamPrivacy = await resolvePrivacyAccess({ viewer: req.user, targetUser: recruitment.team });
  if (!isOwner && !teamPrivacy.access.canViewProfile) {
    return res.status(403).json({
      success: false,
      code: 'PRIVACY_RESTRICTED',
      reason: teamPrivacy.access.reason,
      message: 'This recruitment profile is private',
      data: { privacyAccess: teamPrivacy.access }
    });
  }
  if (!isOwner && !isRecruitmentLive(recruitment)) {
    return res.status(404).json({
      success: false,
      message: 'Recruitment post not found. The link may be invalid or the post is no longer active.'
    });
  }

  // Backfill a shareable code for legacy records without exposing applicant data.
  if (!recruitment.recruitmentCode) {
    await backfillUniqueShareCode({
      model: TeamRecruitment,
      document: recruitment,
      codeField: 'recruitmentCode',
      generateCode: () => generateRecruitmentCode(recruitment)
    });
  }

  if (!isOwner && !isSocialPreviewRequest(req)) {
    await TeamRecruitment.updateOne({ _id: recruitment._id }, { $inc: { views: 1 } });
    recruitment.views = (Number(recruitment.views) || 0) + 1;
  }

  res.json({ success: true, data: serializeTeamRecruitment(recruitment) });
});

const mutateTeamRecruitment = async (req, res, forcedStatus) => {
  const { id } = req.params;
  const teamId = req.user._id;

  if (!requireUserType(req, res, 'team', 'Only teams can manage recruitment posts')) return;

  const recruitment = await findTeamRecruitmentByIdentifier(id);

  if (!recruitment) {
    return res.status(404).json({
      success: false,
      message: 'Recruitment post not found'
    });
  }

  if (!sameId(recruitment.team, teamId)) {
    return res.status(403).json({
      success: false,
      message: 'Not authorized to update this recruitment post'
    });
  }

  // The Web edit journey treats type/game/role as immutable. Accept the values
  // it resubmits, but reject attempts to use the update endpoint to change them.
  const immutableFields = recruitment.recruitmentType === 'roster'
    ? ['recruitmentType', 'game', 'role']
    : ['recruitmentType', 'staffRole'];
  for (const field of immutableFields) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)
      && !isSameOptionalString(req.body[field], recruitment[field])) {
      return res.status(400).json({
        success: false,
        message: `${field} cannot be changed after publishing; create a new recruitment post instead`
      });
    }
  }

  if (Object.prototype.hasOwnProperty.call(req.body, 'requirements')) {
    const requirements = mergeAllowedObject(
      recruitment.requirements,
      req.body.requirements,
      RECRUITMENT_REQUIREMENT_FIELDS
    );
    const requirementGate = recruitment.recruitmentType === 'roster'
      ? [requirements.experienceLevel, requirements.dailyPlayingTime, requirements.tournamentExperience]
      : [requirements.experienceLevel, requirements.availability];
    if (!requirementGate.some(value => typeof value === 'string' && value.trim())) {
      return res.status(400).json({
        success: false,
        message: 'Provide at least one experience or availability requirement'
      });
    }
    recruitment.requirements = requirements;
  }

  if (Object.prototype.hasOwnProperty.call(req.body, 'benefits')) {
    const benefits = mergeAllowedObject(recruitment.benefits, req.body.benefits, RECRUITMENT_BENEFIT_FIELDS);
    if (!normalizeOptionalString(benefits.contactInformation)) {
      return res.status(400).json({ success: false, message: 'Contact information is required' });
    }
    recruitment.benefits = benefits;
  }

  const requestedStatus = forcedStatus || req.body.status;
  const previousStatus = recruitment.status;
  if (requestedStatus !== undefined) {
    if (!TEAM_RECRUITMENT_STATUSES.includes(requestedStatus)) {
      return res.status(400).json({ success: false, message: 'Invalid recruitment status' });
    }
    recruitment.status = requestedStatus;
    if (requestedStatus === 'active' && !isRecruitmentLive({ ...recruitment.toObject(), status: 'active' })) {
      recruitment.isActive = true;
      recruitment.expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    }
  }

  await recruitment.save();
  await recruitment.populate('team', 'username profile.displayName profile.avatar');

  if (requestedStatus !== undefined && requestedStatus !== previousStatus) {
    const recipients = await getCanonicalApplicantRecipientIds(recruitment._id);
    const notificationResults = await Promise.allSettled(recipients.map((recipient) => notifyRecruitmentEvent({
      recipient,
      sender: teamId,
      title: 'Recruitment Post Updated',
      message: `The recruitment post status is now ${recruitment.status}.`,
      eventType: 'recruitment_post_status',
      deliveryKey: `recruitment-post-status:${recruitment._id}:${recruitment.status}:${recruitment.updatedAt.getTime()}`,
      data: {
        recruitmentId: recruitment._id,
        recruitmentCode: recruitment.recruitmentCode,
        status: recruitment.status
      }
    })));
    notificationResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        log.error('Recruitment status fan-out failed', {
          error: String(result.reason), recruitmentId: String(recruitment._id), recipientId: recipients[index]
        });
      }
    });
  }

  res.json({
    success: true,
    message: 'Recruitment post updated successfully',
    data: serializeTeamRecruitment(recruitment)
  });
};

// Update editable details or lifecycle status for an owned team recruitment.
const updateTeamRecruitment = safeAsyncHandler((req, res) => mutateTeamRecruitment(req, res));
const closeTeamRecruitment = safeAsyncHandler((req, res) => mutateTeamRecruitment(req, res, 'closed'));
const reopenTeamRecruitment = safeAsyncHandler((req, res) => mutateTeamRecruitment(req, res, 'active'));

// Delete team recruitment (by ID or code)
const deleteTeamRecruitment = safeAsyncHandler(async (req, res) => {
  const { id } = req.params;
  const teamId = req.user._id;

  if (!requireUserType(req, res, 'team', 'Only teams can delete recruitment posts')) return;

  const recruitment = await findTeamRecruitmentByIdentifier(id);

  if (!recruitment) {
    return res.status(404).json({
      success: false,
      message: 'Recruitment post not found'
    });
  }

  if (!sameId(recruitment.team, teamId)) {
    return res.status(403).json({
      success: false,
      message: 'Not authorized to delete this recruitment post'
    });
  }

  const recipients = await getCanonicalApplicantRecipientIds(recruitment._id);
  await TeamRecruitment.findByIdAndDelete(recruitment._id);
  try {
    await RecruitmentApplication.deleteMany({ recruitment: recruitment._id });
  } catch (cleanupError) {
    // The owner-visible resource is already gone. Do not turn a successful,
    // irreversible delete into a misleading retry; record cleanup for repair.
    log.error('Recruitment application cascade cleanup failed', {
      error: String(cleanupError), recruitmentId: String(recruitment._id)
    });
  }
  const notificationResults = await Promise.allSettled(recipients.map((recipient) => notifyRecruitmentEvent({
    recipient,
    sender: teamId,
    title: 'Recruitment Post Removed',
    message: 'A recruitment post you applied to has been removed by the team.',
    eventType: 'recruitment_post_deleted',
    deliveryKey: `recruitment-post-deleted:${recruitment._id}`,
    data: { recruitmentId: recruitment._id }
  })));
  notificationResults.forEach((result, index) => {
    if (result.status === 'rejected') {
      log.error('Recruitment deletion fan-out failed', {
        error: String(result.reason), recruitmentId: String(recruitment._id), recipientId: recipients[index]
      });
    }
  });

  res.json({
    success: true,
    message: 'Recruitment post deleted successfully'
  });
});

// Player Profile Controllers

// Create player profile
const createPlayerProfile = safeAsyncHandler(async (req, res) => {
  let { profileType, game, role, staffRole, playerInfo, professionalInfo, expectations } = req.body;
  const playerId = req.user._id;

  profileType = normalizeOptionalString(profileType);
  game = normalizeOptionalString(game);
  role = normalizeOptionalString(role);
  staffRole = normalizeOptionalString(staffRole);

  // Validate player user
  if (!requireUserType(req, res, 'player', 'Only individual users can create recruitment profiles')) return;

  const normalizedPlayerInfo = mergeAllowedObject({}, playerInfo, PLAYER_INFO_FIELDS);
  const normalizedProfessionalInfo = mergeAllowedObject({}, professionalInfo, PROFESSIONAL_INFO_FIELDS);
  const normalizedExpectations = mergeAllowedObject({}, expectations, EXPECTATION_FIELDS);
  const progressionError = validatePlayerProfileCreateProgression({
    profileType, game, role, staffRole,
    playerInfo: normalizedPlayerInfo,
    professionalInfo: normalizedProfessionalInfo,
    expectations: normalizedExpectations
  });
  if (progressionError) {
    return res.status(400).json({ success: false, message: progressionError });
  }

  const profile = new PlayerProfile({
    player: playerId,
    profileType,
    game: profileType === 'looking-for-team' ? game : undefined,
    role: profileType === 'looking-for-team' ? role : undefined,
    staffRole: profileType === 'staff-position' ? staffRole : undefined,
    playerInfo: profileType === 'looking-for-team' ? normalizedPlayerInfo : undefined,
    professionalInfo: profileType === 'staff-position' ? normalizedProfessionalInfo : undefined,
    expectations: normalizedExpectations
  });

  const quotaReservation = await reservePlayerCardSlot({ playerId });
  if (!quotaReservation) {
    const limitInfo = await getPlayerCardDailyLimit({ playerId });
    return res.status(429).json({
      success: false,
      message: 'Daily limit reached. You can create a maximum of 2 player cards per day.',
      limitInfo
    });
  }

  try {
    await saveWithUniqueShareCode({
      document: profile,
      codeField: 'profileCode',
      generateCode: () => generatePlayerProfileCode(profile)
    });
  } catch (error) {
    await releasePlayerCardSlot({ quotaId: quotaReservation.quota._id }).catch((releaseError) => {
      log.error('Player-card quota rollback failed', {
        error: String(releaseError), playerId: String(playerId), quotaId: String(quotaReservation.quota._id)
      });
    });
    throw error;
  }

  // Populate player information
  await profile.populate('player', 'username profile.displayName profile.avatar');

  res.status(201).json({
    success: true,
    message: 'Player profile created successfully',
    data: serializePlayerProfile(profile)
  });
});

// Get all player profiles with filters
const getPlayerProfiles = safeAsyncHandler(async (req, res) => {
  const game = normalizeQueryString(req.query.game, 80);
  const profileType = normalizeQueryString(req.query.profileType, 30);
  const location = normalizeQueryString(req.query.location, 120);
  const search = normalizeQueryString(req.query.search, 100);
  const sortBy = normalizeQueryString(req.query.sortBy, 40) || 'createdAt';
  const sortOrder = normalizeQueryString(req.query.sortOrder, 4) || 'desc';
  const my = normalizeQueryString(req.query.my, 5);
  const status = normalizeQueryString(req.query.status, 20);
  if ((req.query.game !== undefined && (typeof req.query.game !== 'string' || (game && !RECRUITMENT_GAMES.has(game)))) ||
      (req.query.profileType !== undefined && (typeof req.query.profileType !== 'string' || (profileType && !['looking-for-team', 'staff-position'].includes(profileType)))) ||
      (req.query.location !== undefined && typeof req.query.location !== 'string') ||
      (req.query.search !== undefined && typeof req.query.search !== 'string') ||
      (req.query.sortBy !== undefined && typeof req.query.sortBy !== 'string') ||
      (req.query.sortOrder !== undefined && (typeof req.query.sortOrder !== 'string' || !['asc', 'desc'].includes(sortOrder))) ||
      (req.query.my !== undefined && (typeof req.query.my !== 'string' || (my && !['true', 'false'].includes(my)))) ||
      (req.query.status !== undefined && typeof req.query.status !== 'string')) {
    return res.status(400).json({ success: false, message: 'Invalid player profile filter' });
  }
  const { page, limit } = parsePagination(req.query.page, req.query.limit);
  const ownListing = my === 'true';
  const query = addPlayerProfileIntegrityFilters(
    ownListing ? { player: req.user._id, isActive: true } : addLiveFilters({})
  );

  if (ownListing && status) {
    if (PLAYER_PROFILE_STATUSES.includes(status)) query.status = status;
    else query._id = null;
  }

  // Apply filters
  if (game) query.game = game;
  if (profileType) query.profileType = profileType;
  if (location) query['expectations.preferredLocation'] = { $regex: escapeRegex(location), $options: 'i' };

  const searchPattern = search ? escapeRegex(search) : '';
  const searchFields = [
    'game', 'role', 'staffRole', 'playerInfo.playerName', 'playerInfo.currentRank',
    'playerInfo.experienceLevel', 'playerInfo.languages', 'playerInfo.additionalInfo',
    'professionalInfo.fullName', 'professionalInfo.skillsAndExpertise',
    'professionalInfo.preferredLocation', 'expectations.preferredLocation'
  ];

  const sortDirection = sortOrder === 'desc' ? -1 : 1;
  const allowedSortFields = new Set(['createdAt', 'game', 'profileType', 'interestedTeamsCount']);
  const safeSortBy = allowedSortFields.has(sortBy) ? sortBy : 'createdAt';
  const { records: profiles, total } = await listCanonicalRecruitmentRecords({
    model: PlayerProfile,
    userModel: User,
    query,
    ownerField: 'player',
    expectedUserType: 'player',
    countField: 'interestedTeamsCount',
    sortBy: safeSortBy,
    sortDirection,
    page,
    limit,
    viewerId: req.user?._id,
    viewerBlockedIds: req.user?.blockedUsers,
    searchPattern,
    searchFields
  });
  const totalPages = Math.ceil(total / limit);

  res.json({
    success: true,
    data: {
      profiles: profiles.map(serializePlayerProfile),
      pagination: {
        currentPage: page,
        totalPages,
        totalProfiles: total,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    }
  });
});

// Get single player profile
const getPlayerProfile = safeAsyncHandler(async (req, res) => {
  const id = req.params.id || req.params.code;
  const profile = await findPlayerProfileByIdentifier(id)
    .populate({
      path: 'player',
      match: getValidRecruitmentOwnerMatch('player'),
      select: 'username userType isActive profile privacySettings blockedUsers'
    });

  if (!profile || !profile.player || !isPlayerProfileStructurallyValid(profile)) {
    return res.status(404).json({
      success: false,
      message: 'Player profile not found'
    });
  }

  const isOwner = sameId(profile.player, req.user?._id);
  const playerPrivacy = await resolvePrivacyAccess({ viewer: req.user, targetUser: profile.player });
  if (!isOwner && !playerPrivacy.access.canViewProfile) {
    return res.status(403).json({
      success: false,
      code: 'PRIVACY_RESTRICTED',
      reason: playerPrivacy.access.reason,
      message: 'This recruitment profile is private',
      data: { privacyAccess: playerPrivacy.access }
    });
  }
  if (!isOwner && !isPlayerProfileLive(profile)) {
    return res.status(404).json({
      success: false,
      message: 'Player profile not found or no longer active'
    });
  }

  if (isOwner) {
    await profile.populate({
      path: 'interestedTeams.team',
      match: getValidRecruitmentOwnerMatch('team'),
      select: 'username userType isActive needsProfileCompletion profile.displayName profile.avatar'
    });
  }

  // If profile doesn't have a code yet (old profiles), generate one
  if (!profile.profileCode) {
    await backfillUniqueShareCode({
      model: PlayerProfile,
      document: profile,
      codeField: 'profileCode',
      generateCode: () => generatePlayerProfileCode(profile)
    });
  }

  if (!isOwner && !isSocialPreviewRequest(req)) {
    await PlayerProfile.updateOne({ _id: profile._id }, { $inc: { views: 1 } });
    profile.views = (Number(profile.views) || 0) + 1;
  }

  res.json({
    success: true,
    data: serializePlayerProfile(profile, { includeInterestedTeams: isOwner })
  });
});

// Update player profile
const updatePlayerProfile = safeAsyncHandler(async (req, res) => {
  const { id } = req.params;
  const playerId = req.user._id;

  if (!requireUserType(req, res, 'player', 'Only individual users can edit recruitment profiles')) return;

  const profile = await findPlayerProfileByIdentifier(id);

  if (!profile) {
    return res.status(404).json({
      success: false,
      message: 'Player profile not found'
    });
  }

  if (!sameId(profile.player, playerId)) {
    return res.status(403).json({
      success: false,
      message: 'Not authorized to update this profile'
    });
  }

  for (const field of ['profileType', 'game', 'role', 'staffRole']) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)
      && !isSameOptionalString(req.body[field], profile[field])) {
      return res.status(400).json({
        success: false,
        message: `${field} cannot be changed after publishing; create a new recruitment profile instead`
      });
    }
  }

  if (Object.prototype.hasOwnProperty.call(req.body, 'playerInfo')) {
    profile.playerInfo = mergeAllowedObject(profile.playerInfo, req.body.playerInfo, PLAYER_INFO_FIELDS);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'professionalInfo')) {
    profile.professionalInfo = mergeAllowedObject(
      profile.professionalInfo,
      req.body.professionalInfo,
      PROFESSIONAL_INFO_FIELDS
    );
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'expectations')) {
    profile.expectations = mergeAllowedObject(profile.expectations, req.body.expectations, EXPECTATION_FIELDS);
  }

  if (profile.profileType === 'looking-for-team') {
    if (!normalizeOptionalString(profile.playerInfo?.playerName)
      || !normalizeOptionalString(profile.playerInfo?.currentRank)) {
      return res.status(400).json({
        success: false,
        message: 'Player name and current rank are required for looking for team profiles'
      });
    }
  } else if (!normalizeOptionalString(profile.professionalInfo?.fullName)
    || !normalizeOptionalString(profile.professionalInfo?.skillsAndExpertise)) {
    return res.status(400).json({
      success: false,
      message: 'Full name and skills and expertise are required for staff profiles'
    });
  }

  if (!normalizeOptionalString(profile.expectations?.contactInformation)) {
    return res.status(400).json({ success: false, message: 'Contact information is required' });
  }

  if (Object.prototype.hasOwnProperty.call(req.body, 'status')) {
    if (!PLAYER_PROFILE_STATUSES.includes(req.body.status)) {
      return res.status(400).json({ success: false, message: 'Invalid profile status' });
    }
    profile.status = req.body.status;
    if (req.body.status === 'active' && !isPlayerProfileLive({ ...profile.toObject(), status: 'active' })) {
      profile.isActive = true;
      profile.expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    }
  }

  await profile.save();
  await profile.populate('player', 'username profile.displayName profile.avatar');

  res.json({
    success: true,
    message: 'Player profile updated successfully',
    data: serializePlayerProfile(profile)
  });
});

const getPlayerCardLimit = safeAsyncHandler(async (req, res) => {
  if (!requireUserType(req, res, 'player', 'Only individual users have a player-card posting limit')) return;
  const limitInfo = await getPlayerCardDailyLimit({ playerId: req.user._id });
  res.json({ success: true, data: limitInfo });
});

// Delete player profile
const deletePlayerProfile = safeAsyncHandler(async (req, res) => {
  const { id } = req.params;
  const playerId = req.user._id;

  if (!requireUserType(req, res, 'player', 'Only individual users can delete recruitment profiles')) return;

  const profile = await findPlayerProfileByIdentifier(id);

  if (!profile) {
    return res.status(404).json({
      success: false,
      message: 'Player profile not found'
    });
  }

  if (!sameId(profile.player, playerId)) {
    return res.status(403).json({
      success: false,
      message: 'Not authorized to delete this profile'
    });
  }

  await PlayerProfile.findByIdAndDelete(profile._id);

  res.json({
    success: true,
    message: 'Player profile deleted successfully'
  });
});

// Application Controllers

// Apply to team recruitment (by ID or code)
const applyToRecruitment = safeAsyncHandler(async (req, res) => {
  const { recruitmentId } = req.params;
  let { message, resume, portfolio } = req.body;
  const applicantId = req.user._id;

  message = normalizeOptionalString(message);
  resume = normalizeOptionalString(resume);
  portfolio = normalizeOptionalString(portfolio);

  if (!requireUserType(req, res, 'player', 'Only individual users can apply to team recruitments')) return;

  const recruitment = await findTeamRecruitmentByIdentifier(recruitmentId).populate({
    path: 'team',
    match: getValidRecruitmentOwnerMatch('team'),
    select: 'username userType profile.displayName profile.avatar privacySettings blockedUsers isActive'
  });
  if (!recruitment || !recruitment.team || !isTeamRecruitmentStructurallyValid(recruitment)) {
    return res.status(404).json({
      success: false,
      message: 'Recruitment post not found'
    });
  }

  if (sameId(recruitment.team, applicantId)) {
    return res.status(403).json({ success: false, message: 'You cannot apply to your own recruitment post' });
  }

  const teamPrivacy = await resolvePrivacyAccess({ viewer: req.user, targetUser: recruitment.team });
  if (!teamPrivacy.access.canViewProfile) {
    return res.status(404).json({ success: false, message: 'Recruitment post not found' });
  }

  if (!isRecruitmentLive(recruitment)) {
    return res.status(409).json({
      success: false,
      message: 'This recruitment is no longer accepting applications'
    });
  }

  // Check if user already applied
  const existingApplication = await RecruitmentApplication.findOne({
    applicant: applicantId,
    recruitment: recruitment._id,
    isActive: true
  });

  if (existingApplication) {
    return res.status(409).json({
      success: false,
      message: 'You have already applied to this recruitment'
    });
  }

  const application = new RecruitmentApplication({
    applicant: applicantId,
    recruitment: recruitment._id,
    applicationType: 'team-recruitment',
    message,
    resume,
    portfolio
  });

  try {
    await application.save();
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: 'You have already applied to this recruitment' });
    }
    throw error;
  }

  // Re-authorize lifecycle state at the write boundary so a concurrent close
  // cannot accept one final application after the earlier read check.
  let appendResult;
  try {
    // Canonical uniqueness guarantees this applicant has no other active
    // application. Remove only stale legacy/withdrawn embedded rows before the
    // new append so positional status updates can never target a duplicate.
    await TeamRecruitment.updateOne(
      { _id: recruitment._id },
      { $pull: { applicants: { user: applicantId } } }
    );
    appendResult = await TeamRecruitment.updateOne(
      addLiveFilters({ _id: recruitment._id }),
      {
        $push: {
          applicants: {
            user: applicantId,
            appliedAt: new Date(),
            status: 'pending',
            message,
            resume,
            portfolio
          }
        }
      }
    );
  } catch (appendError) {
    await RecruitmentApplication.deleteOne({ _id: application._id }).catch((rollbackError) => {
      log.error('Recruitment application compensation failed', {
        error: String(rollbackError), applicationId: String(application._id), recruitmentId: String(recruitment._id)
      });
    });
    throw appendError;
  }

  if (appendResult.modifiedCount !== 1) {
    await RecruitmentApplication.deleteOne({ _id: application._id });
    return res.status(409).json({
      success: false,
      message: 'This recruitment is no longer accepting applications'
    });
  }

  queueRecruitmentNotification({
    recipient: recruitment.team,
    sender: applicantId,
    title: 'New Recruitment Application',
    message: `${req.user.profile?.displayName || req.user.username} applied to your recruitment post.`,
    eventType: 'recruitment_application_submitted',
    deliveryKey: `recruitment-application-submitted:${application._id}`,
    data: {
      applicationId: application._id,
      recruitmentId: recruitment._id,
      recruitmentCode: recruitment.recruitmentCode
    }
  }, { applicationId: String(application._id), recruitmentId: String(recruitment._id) });

  res.status(201).json({
    success: true,
    message: 'Application submitted successfully',
    data: application
  });
});

// Withdraw user's active application from a team recruitment (by ID or code)
const withdrawApplication = safeAsyncHandler(async (req, res) => {
  const { recruitmentId } = req.params;
  const applicantId = req.user._id;

  if (!requireUserType(req, res, 'player', 'Only individual users can withdraw recruitment applications')) return;

  const recruitment = await findTeamRecruitmentByIdentifier(recruitmentId);

  if (!recruitment) {
    return res.status(404).json({
      success: false,
      message: 'Recruitment post not found'
    });
  }

  const application = await RecruitmentApplication.findOne({
    applicant: applicantId,
    recruitment: recruitment._id,
    isActive: true
  });

  if (!application) {
    return res.status(404).json({
      success: false,
      message: 'Active application not found'
    });
  }

  if (!['pending', 'reviewed', 'shortlisted'].includes(application.status)) {
    return res.status(409).json({
      success: false,
      message: `A ${application.status} application can no longer be withdrawn`
    });
  }

  const withdrawResult = await RecruitmentApplication.updateOne(
    {
      _id: application._id,
      applicant: applicantId,
      isActive: true,
      status: { $in: ['pending', 'reviewed', 'shortlisted'] }
    },
    { $set: { status: 'withdrawn', isActive: false } }
  );
  if (withdrawResult.modifiedCount !== 1) {
    return res.status(409).json({ success: false, message: 'Application status changed; refresh and try again' });
  }

  try {
    await TeamRecruitment.updateOne(
      { _id: recruitment._id },
      { $pull: { applicants: { user: applicantId } } }
    );
  } catch (pullError) {
    const rollback = await RecruitmentApplication.updateOne(
      { _id: application._id, status: 'withdrawn', isActive: false },
      { $set: { status: application.status, isActive: true } }
    ).catch((rollbackError) => {
      log.error('Recruitment withdrawal compensation failed', {
        error: String(rollbackError), applicationId: String(application._id), recruitmentId: String(recruitment._id)
      });
      return null;
    });
    if (!rollback || rollback.modifiedCount !== 1) {
      log.error('Recruitment withdrawal left a consistency repair pending', {
        applicationId: String(application._id), recruitmentId: String(recruitment._id)
      });
    }
    throw pullError;
  }

  queueRecruitmentNotification({
    recipient: recruitment.team,
    sender: applicantId,
    title: 'Recruitment Application Withdrawn',
    message: `${req.user.profile?.displayName || req.user.username} withdrew their application.`,
    eventType: 'recruitment_application_withdrawn',
    deliveryKey: `recruitment-application-withdrawn:${application._id}`,
    data: {
      applicationId: application._id,
      recruitmentId: recruitment._id,
      recruitmentCode: recruitment.recruitmentCode
    }
  }, { applicationId: String(application._id), recruitmentId: String(recruitment._id) });

  res.json({
    success: true,
    message: 'Application withdrawn successfully'
  });
});

// Show interest in player profile
const showInterestInProfile = safeAsyncHandler(async (req, res) => {
  const { profileId } = req.params;
  let { message } = req.body;
  const teamId = req.user._id;

  message = normalizeOptionalString(message);

  if (!requireUserType(req, res, 'team', 'Only teams can show interest in player profiles')) return;

  const profile = await findPlayerProfileByIdentifier(profileId).populate({
    path: 'player',
    match: getValidRecruitmentOwnerMatch('player'),
    select: 'username userType profile.displayName profile.avatar privacySettings blockedUsers isActive'
  });
  if (!profile || !profile.player || !isPlayerProfileStructurallyValid(profile)) {
    return res.status(404).json({
      success: false,
      message: 'Player profile not found'
    });
  }

  if (sameId(profile.player, teamId)) {
    return res.status(403).json({ success: false, message: 'You cannot show interest in your own profile' });
  }

  const playerPrivacy = await resolvePrivacyAccess({ viewer: req.user, targetUser: profile.player });
  if (!playerPrivacy.access.canViewProfile) {
    return res.status(404).json({ success: false, message: 'Player profile not found' });
  }

  if (!isPlayerProfileLive(profile)) {
    return res.status(409).json({ success: false, message: 'This profile is no longer accepting interest' });
  }

  // Check if team already showed interest
  const existingInterest = (profile.interestedTeams || []).find(
    interest => sameId(interest?.team, teamId)
  );

  if (existingInterest) {
    return res.status(409).json({
      success: false,
      message: 'You have already shown interest in this profile'
    });
  }

  const interestResult = await PlayerProfile.updateOne(
    {
      ...addLiveFilters({ _id: profile._id }),
      'interestedTeams.team': { $ne: teamId }
    },
    {
      $push: {
        interestedTeams: {
          team: teamId,
          interestedAt: new Date(),
          status: 'pending',
          message
        }
      }
    }
  );

  if (interestResult.modifiedCount !== 1) {
    return res.status(409).json({
      success: false,
      message: 'This profile changed or already has interest from your team'
    });
  }

  queueRecruitmentNotification({
    recipient: profile.player,
    sender: teamId,
    title: 'A Team Is Interested',
    message: `${req.user.profile?.displayName || req.user.username} showed interest in your player profile.`,
    eventType: 'recruitment_profile_interest',
    deliveryKey: `recruitment-profile-interest:${profile._id}:${teamId}`,
    data: { profileId: profile._id, profileCode: profile.profileCode, teamId }
  }, { profileId: String(profile._id), teamId: String(teamId) });

  res.json({
    success: true,
    message: 'Interest shown successfully'
  });
});

// Get user's applications
const getUserApplications = safeAsyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { page, limit } = parsePagination(
    req.query.page,
    req.query.limit,
    { defaultLimit: 100, maxLimit: 100 }
  );
  const { status } = req.query;

  if (!requireUserType(req, res, 'player', 'Only individual users can view recruitment applications')) return;

  const query = { applicant: userId, isActive: true };
  if (status) {
    const allowedStatuses = ['pending', ...TEAM_APPLICATION_STATUSES];
    if (allowedStatuses.includes(status)) query.status = status;
    else query._id = null;
  }

  const { records: applications, total } = await listCanonicalRecruitmentApplications({
    applicationModel: RecruitmentApplication,
    recruitmentModel: TeamRecruitment,
    userModel: User,
    query,
    page,
    limit
  });
  const totalPages = Math.ceil(total / limit);

  res.json({
    success: true,
    data: {
      applications,
      pagination: {
        currentPage: page,
        totalPages,
        totalApplications: total,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    }
  });
});

// Get team's recruitment applications
const getTeamApplications = safeAsyncHandler(async (req, res) => {
  const teamId = req.user._id;
  const { recruitmentId, status } = req.query;
  const { page, limit } = parsePagination(
    req.query.page,
    req.query.limit,
    { defaultLimit: 100, maxLimit: 100 }
  );

  // Validate team user
  if (!requireUserType(req, res, 'team', 'Only teams can view applications')) return;

  let query = { isActive: true };

  if (recruitmentId) {
    const recruitment = await findTeamRecruitmentByIdentifier(recruitmentId);
    
    if (
      !recruitment
      || !sameId(recruitment.team, teamId)
      || recruitment.isActive !== true
      || !isTeamRecruitmentStructurallyValid(recruitment)
    ) {
      return res.status(404).json({
        success: false,
        message: 'Recruitment not found or not authorized'
      });
    }
    query.recruitment = recruitment._id;
  } else {
    // Get all applications for team's recruitments
    const teamRecruitments = await TeamRecruitment.find({ team: teamId }).select('_id');
    query.recruitment = { $in: teamRecruitments.map(r => r._id) };
  }

  if (status) {
    const allowedStatuses = ['pending', ...TEAM_APPLICATION_STATUSES];
    if (allowedStatuses.includes(status)) query.status = status;
    else query._id = null;
  }

  const { records: applications, total } = await listCanonicalRecruitmentApplications({
    applicationModel: RecruitmentApplication,
    recruitmentModel: TeamRecruitment,
    userModel: User,
    query,
    page,
    limit
  });
  const totalPages = Math.ceil(total / limit);

  res.json({
    success: true,
    data: {
      applications,
      pagination: {
        currentPage: page,
        totalPages,
        totalApplications: total,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    }
  });
});

// Update application status
const updateApplicationStatus = safeAsyncHandler(async (req, res) => {
  const { applicationId } = req.params;
  const { status } = req.body;
  if (req.body.message !== undefined && typeof req.body.message !== 'string') {
    return res.status(400).json({ success: false, message: 'Message must be text' });
  }
  const message = normalizeOptionalString(req.body.message);
  if (message && message.length > 1000) {
    return res.status(400).json({ success: false, message: 'Message cannot exceed 1000 characters' });
  }
  const teamId = req.user._id;

  if (!mongoose.Types.ObjectId.isValid(applicationId)) {
    return res.status(400).json({ success: false, message: 'Invalid application ID' });
  }

  if (!TEAM_APPLICATION_STATUSES.includes(status)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid application status'
    });
  }

  if (!requireUserType(req, res, 'team', 'Only teams can update application status')) return;

  const application = await RecruitmentApplication.findById(applicationId)
    .populate('recruitment')
    .populate({
      path: 'applicant',
      match: getValidRecruitmentOwnerMatch('player'),
      select: 'username email userType isActive needsProfileCompletion profile.displayName profile.avatar'
    });

  if (!application || !application.applicant) {
    return res.status(404).json({
      success: false,
      message: 'Application not found'
    });
  }

  if (!application.isActive || application.status === 'withdrawn') {
    return res.status(409).json({ success: false, message: 'Withdrawn applications cannot be updated' });
  }

  if (!application.recruitment) {
    return res.status(404).json({ success: false, message: 'Recruitment post no longer exists' });
  }

  // Check if team owns the recruitment
  if (!sameId(application.recruitment.team, teamId)) {
    return res.status(403).json({
      success: false,
      message: 'Not authorized to update this application'
    });
  }

  const recruitment = await TeamRecruitment.findOne({
    _id: application.recruitment._id,
    team: teamId
  }).populate('team', 'username profile.displayName profile.avatar');
  if (!recruitment) {
    return res.status(404).json({ success: false, message: 'Recruitment post no longer exists' });
  }

  const applicantId = application.applicant._id;

  if (['accepted', 'rejected'].includes(application.status) && application.status !== status) {
    return res.status(409).json({
      success: false,
      message: `A ${application.status} application is final and cannot be changed`
    });
  }

  if (application.status === status) {
    // A previous request may have committed the canonical application update
    // before its denormalized recruitment entry was repaired. Idempotent
    // retries always reconcile both records before reporting success.
    await syncEmbeddedApplicantStatus({
      recruitmentId: recruitment._id,
      teamId,
      applicantId,
      application,
      status
    });
    return res.json({
      success: true,
      message: 'Application status already up to date',
      data: application
    });
  }

  const previousStatus = application.status;
  const previousTeamResponse = typeof application.teamResponse?.toObject === 'function'
    ? application.teamResponse.toObject()
    : application.teamResponse;
  const teamResponse = {
    message,
    respondedAt: new Date(),
    respondedBy: teamId
  };

  log.debug(`[Recruitment] updateApplicationStatus: applicationId=${applicationId} status=${status} teamId=${teamId}`);

  // The application collection is canonical. Compare-and-set prevents two
  // reviewers from accepting/rejecting the same pending application at once.
  const applicationUpdate = await RecruitmentApplication.updateOne(
    { _id: application._id, isActive: true, status: previousStatus },
    { $set: { status, teamResponse } }
  );
  if (applicationUpdate.modifiedCount !== 1) {
    return res.status(409).json({
      success: false,
      message: 'Application status changed; refresh and try again'
    });
  }

  try {
    await syncEmbeddedApplicantStatus({
      recruitmentId: recruitment._id,
      teamId,
      applicantId,
      application,
      status
    });
  } catch (syncError) {
    const rollbackUpdate = { $set: { status: previousStatus } };
    if (previousTeamResponse) rollbackUpdate.$set.teamResponse = previousTeamResponse;
    else rollbackUpdate.$unset = { teamResponse: '' };
    const rollback = await RecruitmentApplication.updateOne(
      { _id: application._id, status },
      rollbackUpdate
    );
    log.error('Recruitment applicant status synchronization failed', {
      error: String(syncError),
      applicationId: String(application._id),
      recruitmentId: String(recruitment._id),
      rollbackSucceeded: rollback.modifiedCount === 1
    });
    throw syncError;
  }

  application.status = status;
  application.teamResponse = teamResponse;

  // ── Post-status side effects (non-blocking) ──────────────────────────────
  const teamName = recruitment.team.profile?.displayName || recruitment.team.username || 'A team';
  const roleLabel = recruitment.recruitmentType === 'roster'
    ? (recruitment.role || 'a role')
    : (recruitment.staffRole || 'a position');
  const game = recruitment.game || '';

  // Build human-readable status label and DM text
  const statusLabels = {
    accepted:    { title: '🎉 Application Accepted!',   verb: 'accepted'    },
    rejected:    { title: '❌ Application Update',       verb: 'rejected'    },
    shortlisted: { title: '⭐ You\'ve Been Shortlisted!', verb: 'shortlisted' },
    reviewed:    { title: '👀 Application Reviewed',     verb: 'reviewed'    },
  };
  const label = statusLabels[status];

  if (label) {
    const notifTitle = label.title;
    const notifMessage = message
      ? `${teamName} ${label.verb} your application for ${roleLabel}${game ? ` (${game})` : ''}. Team note: "${message}"`
      : `${teamName} ${label.verb} your application for ${roleLabel}${game ? ` (${game})` : ''}.`;

    // 1. In-app notification
    try {
      await notifyRecruitmentEvent({
        recipient: applicantId,
        sender: teamId,
        title: notifTitle,
        message: notifMessage,
        eventType: 'recruitment_application_status',
        deliveryKey: `recruitment-application-status:${application._id}:${status}`,
        data: {
          applicationId: application._id,
          recruitmentId: recruitment._id,
          recruitmentCode: recruitment.recruitmentCode,
          status
        }
      });
    } catch (e) {
      log.error('Recruitment status notification failed', {
        error: String(e), applicationId: String(application._id), recipientId: String(applicantId), status
      });
    }

    // 2. Automated DM from team to applicant
    if (['accepted', 'shortlisted', 'rejected'].includes(status)) {
      try {
        const { Message } = require('../models/Message');

        if (status === 'shortlisted') {
          log.debug(`[Recruitment] Sending shortlist plain DM to applicant ${applicantId}`);
          const dm = await Message.create({
            sender: teamId,
            recipient: applicantId,
            messageType: 'direct',
            content: {
              text: message
                ? `⭐ Your application for ${roleLabel}${game ? ` (${game})` : ''} has been shortlisted! Team note: "${message}"`
                : `⭐ Your application for ${roleLabel}${game ? ` (${game})` : ''} has been shortlisted! The team will review further and reach out soon.`,
              media: []
            }
          });
          emitRecruitmentDirectMessage(applicantId, teamId, dm);

        } else if (status === 'accepted') {
          log.debug(`[Recruitment] Sending ACCEPTED card DM to applicant ${applicantId}`);
          const dm = await Message.create({
            sender: teamId,
            recipient: applicantId,
            messageType: 'direct',
            content: {
              text: message
                ? `Your application for ${roleLabel}${game ? ` (${game})` : ''} has been accepted. Team note: "${message}"`
                : `Your application for ${roleLabel}${game ? ` (${game})` : ''} has been accepted.`,
              media: []
            },
            inviteData: {
              type: 'recruitment_result',
              recruitmentId: recruitment._id,
              applicationId: application._id,
              teamId: teamId,
              game: recruitment.game || '',
              role: roleLabel,
              status: 'accepted',
              message: message || '',
              recruitmentType: recruitment.recruitmentType || 'roster',
            }
          });
          emitRecruitmentDirectMessage(applicantId, teamId, dm);

        } else if (status === 'rejected') {
          log.debug(`[Recruitment] Sending REJECTED card DM to applicant ${applicantId}`);
          const dm = await Message.create({
            sender: teamId,
            recipient: applicantId,
            messageType: 'direct',
            content: {
              text: message
                ? `Your application for ${roleLabel}${game ? ` (${game})` : ''} was not selected. Team note: "${message}"`
                : `Your application for ${roleLabel}${game ? ` (${game})` : ''} was not selected.`,
              media: []
            },
            inviteData: {
              type: 'recruitment_result',
              recruitmentId: recruitment._id,
              applicationId: application._id,
              teamId: teamId,
              game: recruitment.game || '',
              role: roleLabel,
              status: 'rejected',
              message: message || '',
              recruitmentType: recruitment.recruitmentType || 'roster',
            }
          });
          emitRecruitmentDirectMessage(applicantId, teamId, dm);
        }
      } catch (e) {
        console.error('Recruitment DM error:', e.message);
      }
    }

    // Recruitment decisions are activity notifications: the in-app row,
    // push, and direct message above are the complete delivery contract.
    // Email is intentionally reserved for account/security/billing/legal and
    // critical platform events.
  }
  // ─────────────────────────────────────────────────────────────────────────

  res.json({
    success: true,
    message: 'Application status updated successfully',
    data: application
  });
});

module.exports = {
  // Team Recruitment
  createTeamRecruitment,
  getTeamRecruitments,
  getTeamRecruitment,
  updateTeamRecruitment,
  closeTeamRecruitment,
  reopenTeamRecruitment,
  deleteTeamRecruitment,
  
  // Player Profile
  createPlayerProfile,
  getPlayerCardLimit,
  getPlayerProfiles,
  getPlayerProfile,
  updatePlayerProfile,
  deletePlayerProfile,
  
  // Applications
  applyToRecruitment,
  withdrawApplication,
  showInterestInProfile,
  getUserApplications,
  getTeamApplications,
  updateApplicationStatus
};
