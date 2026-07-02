const TeamRecruitment = require('../models/TeamRecruitment');
const PlayerProfile = require('../models/PlayerProfile');
const RecruitmentApplication = require('../models/RecruitmentApplication');
const mongoose = require('mongoose');
const safeAsyncHandler = require('../utils/safeAsyncHandler');
const log = require('../utils/logger');
const { createAndEmitNotification } = require('../utils/notificationEmitter');
const {
  TEAM_RECRUITMENT_STATUSES,
  PLAYER_PROFILE_STATUSES,
  TEAM_APPLICATION_STATUSES,
  serializeTeamRecruitment,
  serializePlayerProfile,
  isRecruitmentLive,
  isPlayerProfileLive,
  sameId,
  parsePagination,
  escapeRegex,
  mergeAllowedObject
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
    recipient,
    sender,
    type: 'recruitment',
    title,
    message,
    data: {
      deepLink: '/recruitment',
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

  // Validate required fields based on recruitment type
  if (recruitmentType === 'staff' && !staffRole) {
    return res.status(400).json({
      success: false,
      message: 'Staff role is required for staff recruitment'
    });
  }

  if (recruitmentType === 'roster' && !role) {
    return res.status(400).json({
      success: false,
      message: 'Role is required for roster recruitment'
    });
  }

  const recruitment = new TeamRecruitment({
    team: teamId,
    recruitmentType,
    game: game || undefined,
    role: recruitmentType === 'roster' ? role : undefined,
    staffRole: recruitmentType === 'staff' ? staffRole : undefined,
    requirements: mergeAllowedObject({}, requirements, RECRUITMENT_REQUIREMENT_FIELDS),
    benefits: mergeAllowedObject({}, benefits, RECRUITMENT_BENEFIT_FIELDS)
  });

  // Generate shareable code with prefix and role
  const prefix = recruitmentType === 'roster' ? 'RST' : 'STF';
  let roleAbbr = '';
  if (recruitmentType === 'roster' && role) {
    roleAbbr = role.substring(0, 3).toUpperCase().replace(/\s/g, '');
  } else if (recruitmentType === 'staff' && staffRole) {
    roleAbbr = staffRole.substring(0, 3).toUpperCase().replace(/\s/g, '');
  } else {
    roleAbbr = 'GEN';
  }
  const crypto = require('crypto');
  const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase();
  recruitment.recruitmentCode = `${prefix}-${roleAbbr}-${randomPart}`;

  await recruitment.save();

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
  const {
    game,
    recruitmentType,
    location,
    search,
    sortBy = 'createdAt',
    sortOrder = 'desc',
    my,
    status
  } = req.query;
  const { page, limit } = parsePagination(req.query.page, req.query.limit);
  const ownListing = my === 'true';
  const query = ownListing ? { team: req.user._id } : addLiveFilters({});

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

  // Search functionality
  if (search) {
    const searchPattern = escapeRegex(search);
    query.$and = query.$and || [];
    query.$and.push({
      $or: [
        { game: { $regex: searchPattern, $options: 'i' } },
        { role: { $regex: searchPattern, $options: 'i' } },
        { staffRole: { $regex: searchPattern, $options: 'i' } },
        { 'requirements.additionalRequirements': { $regex: searchPattern, $options: 'i' } },
        { 'requirements.requiredSkills': { $regex: searchPattern, $options: 'i' } },
        { 'requirements.experienceLevel': { $regex: searchPattern, $options: 'i' } },
        { 'requirements.language': { $regex: searchPattern, $options: 'i' } },
        { 'benefits.location': { $regex: searchPattern, $options: 'i' } }
      ]
    });
  }

  const sortDirection = sortOrder === 'desc' ? -1 : 1;
  const allowedSortFields = new Set(['createdAt', 'game', 'role', 'staffRole', 'applicantCount']);
  const safeSortBy = allowedSortFields.has(sortBy) ? sortBy : 'createdAt';
  const sortOptions = { [safeSortBy]: sortDirection };

  let recruitments;
  if (safeSortBy === 'applicantCount') {
    const docs = await TeamRecruitment.aggregate([
      { $match: query },
      { $addFields: { applicantCount: { $size: { $ifNull: ['$applicants', []] } } } },
      { $sort: { applicantCount: sortDirection, createdAt: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit }
    ]);
    recruitments = await TeamRecruitment.populate(docs, {
      path: 'team',
      select: 'username profile.displayName profile.avatar'
    });
  } else {
    recruitments = await TeamRecruitment.find(query)
      .populate('team', 'username profile.displayName profile.avatar')
      .sort(sortOptions)
      .limit(limit)
      .skip((page - 1) * limit);
  }

  const total = await TeamRecruitment.countDocuments(query);
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
    .populate('team', 'username profile.displayName profile.avatar profile.bio teamInfo.teamType');

  if (!recruitment) {
    return res.status(404).json({
      success: false,
      message: 'Recruitment post not found. The link may be invalid or the post has been removed.'
    });
  }

  const isOwner = sameId(recruitment.team, req.user?._id);
  if (!isOwner && !isRecruitmentLive(recruitment)) {
    return res.status(404).json({
      success: false,
      message: 'Recruitment post not found. The link may be invalid or the post is no longer active.'
    });
  }

  // Backfill a shareable code for legacy records without exposing applicant data.
  if (!recruitment.recruitmentCode) {
    const prefix = recruitment.recruitmentType === 'roster' ? 'RST' : 'STF';
    const sourceRole = recruitment.recruitmentType === 'roster' ? recruitment.role : recruitment.staffRole;
    const roleAbbr = sourceRole
      ? sourceRole.substring(0, 3).toUpperCase().replace(/\s/g, '')
      : 'GEN';
    const crypto = require('crypto');
    recruitment.recruitmentCode = `${prefix}-${roleAbbr}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    await recruitment.save();
  }

  if (!isOwner) {
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
    const recipients = Array.from(new Set((recruitment.applicants || []).map((entry) => String(entry.user)).filter(Boolean)));
    const notificationResults = await Promise.allSettled(recipients.map((recipient) => notifyRecruitmentEvent({
      recipient,
      sender: teamId,
      title: 'Recruitment Post Updated',
      message: `The recruitment post status is now ${recruitment.status}.`,
      eventType: 'recruitment_post_status',
      deliveryKey: `recruitment-post-status:${recruitment._id}:${recruitment.status}:${recruitment.updatedAt.getTime()}`,
      data: { recruitmentId: recruitment._id, status: recruitment.status }
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

  const recipients = Array.from(new Set((recruitment.applicants || []).map((entry) => String(entry.user)).filter(Boolean)));
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

  // ── Daily rate limit: players can create max 2 player cards per day ──
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const todayCount = await PlayerProfile.countDocuments({
    player: playerId,
    createdAt: { $gte: startOfDay, $lte: endOfDay }
  });

  if (todayCount >= 2) {
    return res.status(429).json({
      success: false,
      message: 'Daily limit reached. You can create a maximum of 2 player cards per day.',
      limitInfo: {
        used: todayCount,
        limit: 2,
        resetsAt: endOfDay
      }
    });
  }

  // Validate required fields based on profile type
  if (profileType === 'staff-position' && !staffRole) {
    return res.status(400).json({
      success: false,
      message: 'Staff role is required for staff position profile'
    });
  }

  if (profileType === 'looking-for-team' && !role) {
    return res.status(400).json({
      success: false,
      message: 'Role is required for looking for team profile'
    });
  }

  const profile = new PlayerProfile({
    player: playerId,
    profileType,
    game: profileType === 'looking-for-team' ? game : undefined,
    role: profileType === 'looking-for-team' ? role : undefined,
    staffRole: profileType === 'staff-position' ? staffRole : undefined,
    playerInfo: profileType === 'looking-for-team'
      ? mergeAllowedObject({}, playerInfo, PLAYER_INFO_FIELDS)
      : undefined,
    professionalInfo: profileType === 'staff-position'
      ? mergeAllowedObject({}, professionalInfo, PROFESSIONAL_INFO_FIELDS)
      : undefined,
    expectations: mergeAllowedObject({}, expectations, EXPECTATION_FIELDS)
  });

  // Generate shareable code with prefix and role
  const prefix = profileType === 'looking-for-team' ? 'PLR' : 'STF';
  let roleAbbr = '';
  if (profileType === 'looking-for-team' && role) {
    roleAbbr = role.substring(0, 3).toUpperCase().replace(/\s/g, '');
  } else if (profileType === 'staff-position' && staffRole) {
    roleAbbr = staffRole.substring(0, 3).toUpperCase().replace(/\s/g, '');
  } else {
    roleAbbr = 'GEN';
  }
  const crypto = require('crypto');
  const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase();
  profile.profileCode = `${prefix}-${roleAbbr}-${randomPart}`;

  await profile.save();

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
  const {
    game,
    profileType,
    location,
    search,
    sortBy = 'createdAt',
    sortOrder = 'desc',
    my,
    status
  } = req.query;
  const { page, limit } = parsePagination(req.query.page, req.query.limit);
  const ownListing = my === 'true';
  const query = ownListing ? { player: req.user._id } : addLiveFilters({});

  if (ownListing && status) {
    if (PLAYER_PROFILE_STATUSES.includes(status)) query.status = status;
    else query._id = null;
  }

  // Apply filters
  if (game) query.game = game;
  if (profileType) query.profileType = profileType;
  if (location) query['expectations.preferredLocation'] = { $regex: escapeRegex(location), $options: 'i' };

  // Search functionality
  if (search) {
    const searchPattern = escapeRegex(search);
    query.$and = query.$and || [];
    query.$and.push({
      $or: [
        { game: { $regex: searchPattern, $options: 'i' } },
        { role: { $regex: searchPattern, $options: 'i' } },
        { staffRole: { $regex: searchPattern, $options: 'i' } },
        { 'playerInfo.playerName': { $regex: searchPattern, $options: 'i' } },
        { 'playerInfo.currentRank': { $regex: searchPattern, $options: 'i' } },
        { 'playerInfo.experienceLevel': { $regex: searchPattern, $options: 'i' } },
        { 'playerInfo.languages': { $regex: searchPattern, $options: 'i' } },
        { 'playerInfo.additionalInfo': { $regex: searchPattern, $options: 'i' } },
        { 'professionalInfo.fullName': { $regex: searchPattern, $options: 'i' } },
        { 'professionalInfo.skillsAndExpertise': { $regex: searchPattern, $options: 'i' } },
        { 'professionalInfo.preferredLocation': { $regex: searchPattern, $options: 'i' } },
        { 'expectations.preferredLocation': { $regex: searchPattern, $options: 'i' } }
      ]
    });
  }

  const sortDirection = sortOrder === 'desc' ? -1 : 1;
  const allowedSortFields = new Set(['createdAt', 'game', 'profileType', 'interestedTeamsCount']);
  const safeSortBy = allowedSortFields.has(sortBy) ? sortBy : 'createdAt';
  const sortOptions = { [safeSortBy]: sortDirection };

  let profiles;
  if (safeSortBy === 'interestedTeamsCount') {
    const docs = await PlayerProfile.aggregate([
      { $match: query },
      { $addFields: { interestedTeamsCount: { $size: { $ifNull: ['$interestedTeams', []] } } } },
      { $sort: { interestedTeamsCount: sortDirection, createdAt: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit }
    ]);
    profiles = await PlayerProfile.populate(docs, {
      path: 'player',
      select: 'username profile.displayName profile.avatar'
    });
  } else {
    profiles = await PlayerProfile.find(query)
      .populate('player', 'username profile.displayName profile.avatar')
      .sort(sortOptions)
      .limit(limit)
      .skip((page - 1) * limit)
      .lean();
  }

  const total = await PlayerProfile.countDocuments(query);
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
    .populate('player', 'username profile.displayName profile.avatar profile.bio');

  if (!profile) {
    return res.status(404).json({
      success: false,
      message: 'Player profile not found'
    });
  }

  const isOwner = sameId(profile.player, req.user?._id);
  if (!isOwner && !isPlayerProfileLive(profile)) {
    return res.status(404).json({
      success: false,
      message: 'Player profile not found or no longer active'
    });
  }

  if (isOwner) {
    await profile.populate('interestedTeams.team', 'username profile.displayName profile.avatar');
  }

  // If profile doesn't have a code yet (old profiles), generate one
  if (!profile.profileCode) {
    const prefix = profile.profileType === 'looking-for-team' ? 'PLR' : 'STF';
    let roleAbbr = '';
    if (profile.profileType === 'looking-for-team' && profile.role) {
      roleAbbr = profile.role.substring(0, 3).toUpperCase().replace(/\s/g, '');
    } else if (profile.profileType === 'staff-position' && profile.staffRole) {
      roleAbbr = profile.staffRole.substring(0, 3).toUpperCase().replace(/\s/g, '');
    } else {
      roleAbbr = 'GEN';
    }
    const crypto = require('crypto');
    const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase();
    profile.profileCode = `${prefix}-${roleAbbr}-${randomPart}`;
    await profile.save();
  }

  if (!isOwner) {
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
  const { message, resume, portfolio } = req.body;
  const applicantId = req.user._id;

  if (!requireUserType(req, res, 'player', 'Only individual users can apply to team recruitments')) return;

  const recruitment = await findTeamRecruitmentByIdentifier(recruitmentId);
  if (!recruitment) {
    return res.status(404).json({
      success: false,
      message: 'Recruitment post not found'
    });
  }

  if (sameId(recruitment.team, applicantId)) {
    return res.status(403).json({ success: false, message: 'You cannot apply to your own recruitment post' });
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
    return res.status(400).json({
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
  const appendResult = await TeamRecruitment.updateOne(
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
    data: { applicationId: application._id, recruitmentId: recruitment._id }
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

  await TeamRecruitment.updateOne(
    { _id: recruitment._id },
    { $pull: { applicants: { user: applicantId } } }
  );

  queueRecruitmentNotification({
    recipient: recruitment.team,
    sender: applicantId,
    title: 'Recruitment Application Withdrawn',
    message: `${req.user.profile?.displayName || req.user.username} withdrew their application.`,
    eventType: 'recruitment_application_withdrawn',
    deliveryKey: `recruitment-application-withdrawn:${application._id}`,
    data: { applicationId: application._id, recruitmentId: recruitment._id }
  }, { applicationId: String(application._id), recruitmentId: String(recruitment._id) });

  res.json({
    success: true,
    message: 'Application withdrawn successfully'
  });
});

// Show interest in player profile
const showInterestInProfile = safeAsyncHandler(async (req, res) => {
  const { profileId } = req.params;
  const { message } = req.body;
  const teamId = req.user._id;

  if (!requireUserType(req, res, 'team', 'Only teams can show interest in player profiles')) return;

  const profile = await findPlayerProfileByIdentifier(profileId);
  if (!profile) {
    return res.status(404).json({
      success: false,
      message: 'Player profile not found'
    });
  }

  if (sameId(profile.player, teamId)) {
    return res.status(403).json({ success: false, message: 'You cannot show interest in your own profile' });
  }

  if (!isPlayerProfileLive(profile)) {
    return res.status(409).json({ success: false, message: 'This profile is no longer accepting interest' });
  }

  // Check if team already showed interest
  const existingInterest = profile.interestedTeams.find(
    interest => interest.team.toString() === teamId.toString()
  );

  if (existingInterest) {
    return res.status(400).json({
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
    data: { profileId: profile._id, teamId }
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

  const applications = await RecruitmentApplication.find(query)
    .populate({
      path: 'recruitment',
      select: 'game role staffRole recruitmentType team status isActive expiresAt',
      populate: { path: 'team', select: 'username profile.displayName profile.avatar' }
    })
    .sort({ createdAt: -1 })
    .limit(limit)
    .skip((page - 1) * limit);

  const total = await RecruitmentApplication.countDocuments(query);
  const totalPages = Math.ceil(total / limit);

  res.json({
    success: true,
    data: {
      applications: applications.map((application) => ({
        ...application.toObject(),
        appliedAt: application.createdAt
      })),
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
    
    if (!recruitment || !sameId(recruitment.team, teamId)) {
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

  const applications = await RecruitmentApplication.find(query)
    .populate('applicant', 'username profile.displayName profile.avatar')
    .populate('recruitment', 'game role staffRole recruitmentType')
    .sort({ createdAt: -1 })
    .limit(limit)
    .skip((page - 1) * limit);

  const total = await RecruitmentApplication.countDocuments(query);
  const totalPages = Math.ceil(total / limit);

  res.json({
    success: true,
    data: {
      applications: applications.map((application) => ({
        ...application.toObject(),
        appliedAt: application.createdAt
      })),
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
  const { status, message } = req.body;
  const teamId = req.user._id;

  if (!TEAM_APPLICATION_STATUSES.includes(status)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid application status'
    });
  }

  if (!requireUserType(req, res, 'team', 'Only teams can update application status')) return;

  const application = await RecruitmentApplication.findById(applicationId)
    .populate('recruitment')
    .populate('applicant', 'username email profile.displayName profile.avatar');

  if (!application) {
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
        data: { applicationId: application._id, recruitmentId: recruitment._id, status }
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
          // Delete any previous recruitment_result cards so only the latest shows
          await Message.deleteMany({ sender: teamId, recipient: applicantId, 'inviteData.type': 'recruitment_result' });
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
          // Delete any previous recruitment_result cards so only the latest shows
          await Message.deleteMany({ sender: teamId, recipient: applicantId, 'inviteData.type': 'recruitment_result' });
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

    // 3. Transactional recruitment email (explicitly typed and non-blocking)
    if (process.env.SMTP_USER && process.env.SMTP_PASS && application.applicant.email) {
      try {
        const { enqueueEmail } = require('../utils/jobQueue');
        const { EMAIL_INTENTS } = require('../utils/notificationChannelPolicy');
        const clientUrl = process.env.CLIENT_URL || 'https://arc.squadhunt.com';
        void enqueueEmail(
          application.applicant.email,
          notifTitle,
          notifMessage,
          `${clientUrl.replace(/\/+$/, '')}/messages`,
          {
            intent: EMAIL_INTENTS.RECRUITMENT_STATUS,
            eventType: 'recruitment_application_status',
            notificationType: 'recruitment'
          }
        ).catch((emailError) => {
          log.error('Recruitment email enqueue failed', { error: String(emailError) });
        });
      } catch (e) {
        log.error('Recruitment email setup error', { error: String(e) });
      }
    }
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
