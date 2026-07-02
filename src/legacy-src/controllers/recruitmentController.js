const TeamRecruitment = require('../models/TeamRecruitment');
const PlayerProfile = require('../models/PlayerProfile');
const RecruitmentApplication = require('../models/RecruitmentApplication');
const User = require('../models/User');
const safeAsyncHandler = require('../utils/safeAsyncHandler');
const log = require('../utils/logger');
const { createAndEmitNotification } = require('../utils/notificationEmitter');

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

  // Normalize empty strings from forms to avoid enum/required validation mismatches.
  const normalize = (value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  recruitmentType = normalize(recruitmentType);
  game = normalize(game);
  role = normalize(role);
  staffRole = normalize(staffRole);

  // Validate team user
  if (req.user.userType !== 'team') {
    return res.status(400).json({
      success: false,
      message: 'Only teams can create recruitment posts'
    });
  }

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
    game,
    role: recruitmentType === 'roster' ? role : undefined,
    staffRole: recruitmentType === 'staff' ? staffRole : undefined,
    requirements,
    benefits
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
    data: recruitment
  });
});

// Get all team recruitments with filters
const getTeamRecruitments = safeAsyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    game,
    recruitmentType,
    location,
    search,
    sortBy = 'createdAt',
    sortOrder = 'desc',
    my
  } = req.query;

  const query = { status: 'active', isActive: true };

  // If my=true, filter to only show current user's recruitments
  if (my === 'true' && req.user) {
    query.team = req.user._id;
  }

  // Apply filters
  if (game) query.game = game;
  if (recruitmentType) query.recruitmentType = recruitmentType;
  if (location) query['benefits.location'] = { $regex: location, $options: 'i' };

  // Search functionality
  if (search) {
    query.$or = [
      { game: { $regex: search, $options: 'i' } },
      { role: { $regex: search, $options: 'i' } },
      { staffRole: { $regex: search, $options: 'i' } },
      { 'requirements.additionalRequirements': { $regex: search, $options: 'i' } },
      { 'requirements.requiredSkills': { $regex: search, $options: 'i' } },
      { 'requirements.experienceLevel': { $regex: search, $options: 'i' } },
      { 'requirements.language': { $regex: search, $options: 'i' } },
      { 'benefits.location': { $regex: search, $options: 'i' } }
    ];
  }

  const sortDirection = sortOrder === 'desc' ? -1 : 1;
  const sortOptions = {};
  sortOptions[sortBy] = sortDirection;

  let recruitments;
  if (sortBy === 'applicantCount') {
    const docs = await TeamRecruitment.aggregate([
      { $match: query },
      { $addFields: { applicantCount: { $size: { $ifNull: ['$applicants', []] } } } },
      { $sort: { applicantCount: sortDirection, createdAt: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit * 1 }
    ]);
    recruitments = await TeamRecruitment.populate(docs, {
      path: 'team',
      select: 'username profile.displayName profile.avatar'
    });
  } else {
    recruitments = await TeamRecruitment.find(query)
      .populate('team', 'username profile.displayName profile.avatar')
      .sort(sortOptions)
      .limit(limit * 1)
      .skip((page - 1) * limit);
  }

  const total = await TeamRecruitment.countDocuments(query);

  res.json({
    success: true,
    data: {
      recruitments,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalRecruitments: total,
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1
      }
    }
  });
});

// Get single team recruitment (by ID or code)
const getTeamRecruitment = safeAsyncHandler(async (req, res) => {
  // Support both :id and :code route parameters
  const id = req.params.id || req.params.code;
  const isCodeRoute = !!req.params.code; // If :code param exists, it's the shareable link route

  let recruitment;
  const mongoose = require('mongoose');
  
  // If it's the /recruitment/:code route, ONLY search by code (no ID fallback)
  if (isCodeRoute) {
    // Shareable link route - must be a code
    // Trim and ensure uppercase for consistency
    const codeToSearch = id.trim().toUpperCase();
    recruitment = await TeamRecruitment.findOne({ recruitmentCode: codeToSearch })
      .populate('team', 'username profile.displayName profile.avatar profile.bio teamInfo.teamType')
      .populate('applicants.user', 'username profile.displayName profile.avatar');
  } else {
    // Regular route - can be either code or ID
    // Check if it's a code format: RST-XXX-XXXX or STF-XXX-XXXX (contains dashes)
  if (id && (id.includes('-') || id.length > 20)) {
    // Looks like a recruitment code (format: RST-IGL-A1B2C3D4)
    recruitment = await TeamRecruitment.findOne({ recruitmentCode: id })
      .populate('team', 'username profile.displayName profile.avatar profile.bio teamInfo.teamType')
      .populate('applicants.user', 'username profile.displayName profile.avatar');
    
    // Don't try findById if it's a code format - it will fail with CastError
  } else if (id && mongoose.Types.ObjectId.isValid(id)) {
    // Try as MongoDB ObjectId (only if it's a valid ObjectId format)
    recruitment = await TeamRecruitment.findById(id)
      .populate('team', 'username profile.displayName profile.avatar profile.bio teamInfo.teamType')
      .populate('applicants.user', 'username profile.displayName profile.avatar');
    }
  }

  if (!recruitment) {
    return res.status(404).json({
      success: false,
      message: 'Recruitment post not found. The link may be invalid or the post has been removed.'
    });
  }

  // If recruitment doesn't have a code yet (old posts), generate one
  if (!recruitment.recruitmentCode) {
    const prefix = recruitment.recruitmentType === 'roster' ? 'RST' : 'STF';
    let roleAbbr = '';
    if (recruitment.recruitmentType === 'roster' && recruitment.role) {
      roleAbbr = recruitment.role.substring(0, 3).toUpperCase().replace(/\s/g, '');
    } else if (recruitment.recruitmentType === 'staff' && recruitment.staffRole) {
      roleAbbr = recruitment.staffRole.substring(0, 3).toUpperCase().replace(/\s/g, '');
    } else {
      roleAbbr = 'GEN';
    }
    const crypto = require('crypto');
    const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase();
    recruitment.recruitmentCode = `${prefix}-${roleAbbr}-${randomPart}`.toUpperCase();
    await recruitment.save();
  }

  // Increment view count
  recruitment.views += 1;
  await recruitment.save();

  res.json({
    success: true,
    data: recruitment
  });
});

// Update team recruitment
const updateTeamRecruitment = safeAsyncHandler(async (req, res) => {
  const { id } = req.params;
  const teamId = req.user._id;

  const recruitment = await TeamRecruitment.findById(id);

  if (!recruitment) {
    return res.status(404).json({
      success: false,
      message: 'Recruitment post not found'
    });
  }

  if (recruitment.team.toString() !== teamId.toString()) {
    return res.status(403).json({
      success: false,
      message: 'Not authorized to update this recruitment post'
    });
  }

  // Whitelist allowed fields to prevent injection of protected fields
  const allowedFields = [
    'recruitmentType', 'game', 'role', 'staffRole',
    'requirements', 'benefits', 'status', 'description'
  ];
  const updateData = {};
  allowedFields.forEach(field => {
    if (req.body[field] !== undefined) {
      updateData[field] = req.body[field];
    }
  });

  const updatedRecruitment = await TeamRecruitment.findByIdAndUpdate(
    recruitment._id,
    updateData,
    { new: true, runValidators: true }
  ).populate('team', 'username profile.displayName profile.avatar');

  if (Object.prototype.hasOwnProperty.call(updateData, 'status')) {
    const recipients = Array.from(new Set((recruitment.applicants || []).map((entry) => String(entry.user)).filter(Boolean)));
    const notificationResults = await Promise.allSettled(recipients.map((recipient) => notifyRecruitmentEvent({
      recipient,
      sender: teamId,
      title: 'Recruitment Post Updated',
      message: `The recruitment post status is now ${updatedRecruitment.status}.`,
      eventType: 'recruitment_post_status',
      deliveryKey: `recruitment-post-status:${recruitment._id}:${updatedRecruitment.status}`,
      data: { recruitmentId: recruitment._id, status: updatedRecruitment.status }
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
    data: updatedRecruitment
  });
});

// Delete team recruitment (by ID or code)
const deleteTeamRecruitment = safeAsyncHandler(async (req, res) => {
  const { id } = req.params;
  const teamId = req.user._id;

  // Find recruitment by code or ID
  let recruitment;
  const mongoose = require('mongoose');
  if (id && id.includes('-')) {
    recruitment = await TeamRecruitment.findOne({ recruitmentCode: id });
  } else if (id && mongoose.Types.ObjectId.isValid(id)) {
    recruitment = await TeamRecruitment.findById(id);
  } else {
    recruitment = await TeamRecruitment.findOne({ recruitmentCode: id });
  }

  if (!recruitment) {
    return res.status(404).json({
      success: false,
      message: 'Recruitment post not found'
    });
  }

  if (recruitment.team.toString() !== teamId.toString()) {
    return res.status(403).json({
      success: false,
      message: 'Not authorized to delete this recruitment post'
    });
  }

  const recipients = Array.from(new Set((recruitment.applicants || []).map((entry) => String(entry.user)).filter(Boolean)));
  await TeamRecruitment.findByIdAndDelete(recruitment._id);
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

  // Normalize empty strings from client forms to avoid enum validation crashes.
  const normalize = (value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  profileType = normalize(profileType);
  game = normalize(game);
  role = normalize(role);
  staffRole = normalize(staffRole);

  // Validate player user
  if (req.user.userType !== 'player') {
    return res.status(400).json({
      success: false,
      message: 'Only players can create profiles'
    });
  }

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
    playerInfo: profileType === 'looking-for-team' ? playerInfo : undefined,
    professionalInfo: profileType === 'staff-position' ? professionalInfo : undefined,
    expectations
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
    data: profile
  });
});

// Get all player profiles with filters
const getPlayerProfiles = safeAsyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 10,
    game,
    profileType,
    location,
    search,
    sortBy = 'createdAt',
    sortOrder = 'desc',
    my
  } = req.query;

  const query = { status: 'active', isActive: true };

  // If my=true, filter to only show current user's profiles
  if (my === 'true' && req.user) {
    query.player = req.user._id;
  }

  // Apply filters
  if (game) query.game = game;
  if (profileType) query.profileType = profileType;
  if (location) query['expectations.preferredLocation'] = { $regex: location, $options: 'i' };

  // Search functionality
  if (search) {
    query.$or = [
      { game: { $regex: search, $options: 'i' } },
      { role: { $regex: search, $options: 'i' } },
      { staffRole: { $regex: search, $options: 'i' } },
      { 'playerInfo.playerName': { $regex: search, $options: 'i' } },
      { 'playerInfo.currentRank': { $regex: search, $options: 'i' } },
      { 'playerInfo.experienceLevel': { $regex: search, $options: 'i' } },
      { 'playerInfo.languages': { $regex: search, $options: 'i' } },
      { 'playerInfo.additionalInfo': { $regex: search, $options: 'i' } },
      { 'professionalInfo.fullName': { $regex: search, $options: 'i' } },
      { 'professionalInfo.skillsAndExpertise': { $regex: search, $options: 'i' } },
      { 'professionalInfo.preferredLocation': { $regex: search, $options: 'i' } },
      { 'expectations.preferredLocation': { $regex: search, $options: 'i' } }
    ];
  }

  const sortDirection = sortOrder === 'desc' ? -1 : 1;
  const sortOptions = {};
  sortOptions[sortBy] = sortDirection;

  let profiles;
  if (sortBy === 'interestedTeamsCount') {
    const docs = await PlayerProfile.aggregate([
      { $match: query },
      { $addFields: { interestedTeamsCount: { $size: { $ifNull: ['$interestedTeams', []] } } } },
      { $sort: { interestedTeamsCount: sortDirection, createdAt: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit * 1 }
    ]);
    profiles = await PlayerProfile.populate(docs, {
      path: 'player',
      select: 'username profile.displayName profile.avatar'
    });
  } else {
    profiles = await PlayerProfile.find(query)
      .populate('player', 'username profile.displayName profile.avatar')
      .sort(sortOptions)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();
  }

  const total = await PlayerProfile.countDocuments(query);

  res.json({
    success: true,
    data: {
      profiles,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalProfiles: total,
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1
      }
    }
  });
});

// Get single player profile
const getPlayerProfile = safeAsyncHandler(async (req, res) => {
  // Support both :id and :code route parameters
  const id = req.params.id || req.params.code;

  // Try to find by profileCode first (if it looks like a code), then by _id
  let profile;
  const mongoose = require('mongoose');
  
  // Check if it's a code format: PLR-XXX-XXXX or STF-XXX-XXXX (contains dashes)
  if (id && (id.includes('-') || id.length > 20)) {
    // Looks like a profile code (format: PLR-IGL-A1B2C3D4)
    profile = await PlayerProfile.findOne({ profileCode: id })
      .populate('player', 'username profile.displayName profile.avatar profile.bio')
      .populate('interestedTeams.team', 'username profile.displayName profile.avatar');
    // Don't try findById if it's a code format - it will fail with CastError
  } else if (id && mongoose.Types.ObjectId.isValid(id)) {
    // Try as MongoDB ObjectId (only if it's a valid ObjectId format)
    profile = await PlayerProfile.findById(id)
      .populate('player', 'username profile.displayName profile.avatar profile.bio')
      .populate('interestedTeams.team', 'username profile.displayName profile.avatar');
  }

  if (!profile) {
    return res.status(404).json({
      success: false,
      message: 'Player profile not found'
    });
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

  // Increment view count
  profile.views += 1;
  await profile.save();

  res.json({
    success: true,
    data: profile
  });
});

// Update player profile
const updatePlayerProfile = safeAsyncHandler(async (req, res) => {
  const { id } = req.params;
  const playerId = req.user._id;

  // Find profile by code or ID
  let profile;
  if (id && id.includes('-')) {
    profile = await PlayerProfile.findOne({ profileCode: id });
  } else if (id && require('mongoose').Types.ObjectId.isValid(id)) {
    profile = await PlayerProfile.findById(id);
  } else {
    profile = await PlayerProfile.findOne({ profileCode: id });
  }

  if (!profile) {
    return res.status(404).json({
      success: false,
      message: 'Player profile not found'
    });
  }

  if (profile.player.toString() !== playerId.toString()) {
    return res.status(403).json({
      success: false,
      message: 'Not authorized to update this profile'
    });
  }

  const updatedProfile = await PlayerProfile.findByIdAndUpdate(
    profile._id,
    req.body,
    { new: true, runValidators: true }
  ).populate('player', 'username profile.displayName profile.avatar');

  res.json({
    success: true,
    message: 'Player profile updated successfully',
    data: updatedProfile
  });
});

// Delete player profile
const deletePlayerProfile = safeAsyncHandler(async (req, res) => {
  const { id } = req.params;
  const playerId = req.user._id;

  // Find profile by code or ID
  let profile;
  if (id && id.includes('-')) {
    profile = await PlayerProfile.findOne({ profileCode: id });
  } else if (id && require('mongoose').Types.ObjectId.isValid(id)) {
    profile = await PlayerProfile.findById(id);
  } else {
    profile = await PlayerProfile.findOne({ profileCode: id });
  }

  if (!profile) {
    return res.status(404).json({
      success: false,
      message: 'Player profile not found'
    });
  }

  if (profile.player.toString() !== playerId.toString()) {
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

  // Find recruitment by code or ID
  let recruitment;
  const mongoose = require('mongoose');
  if (recruitmentId && recruitmentId.includes('-')) {
    // Has dashes = recruitment code format (RST-XXX-XXXXXXXX)
    recruitment = await TeamRecruitment.findOne({ recruitmentCode: recruitmentId });
  } else if (recruitmentId && mongoose.Types.ObjectId.isValid(recruitmentId)) {
    recruitment = await TeamRecruitment.findById(recruitmentId);
  } else {
    recruitment = await TeamRecruitment.findOne({ recruitmentCode: recruitmentId });
  }
  if (!recruitment) {
    return res.status(404).json({
      success: false,
      message: 'Recruitment post not found'
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

  await application.save();

  // Add to recruitment's applicants list
  recruitment.applicants.push({
    user: applicantId,
    appliedAt: new Date(),
    status: 'pending',
    message,
    resume,
    portfolio
  });

  await recruitment.save();

  await notifyRecruitmentEvent({
    recipient: recruitment.team,
    sender: applicantId,
    title: 'New Recruitment Application',
    message: `${req.user.profile?.displayName || req.user.username} applied to your recruitment post.`,
    eventType: 'recruitment_application_submitted',
    deliveryKey: `recruitment-application-submitted:${application._id}`,
    data: { applicationId: application._id, recruitmentId: recruitment._id }
  });

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

  let recruitment;
  const mongoose = require('mongoose');
  if (recruitmentId && recruitmentId.includes('-')) {
    recruitment = await TeamRecruitment.findOne({ recruitmentCode: recruitmentId.toUpperCase() });
  } else if (recruitmentId && mongoose.Types.ObjectId.isValid(recruitmentId)) {
    recruitment = await TeamRecruitment.findById(recruitmentId);
  } else {
    recruitment = await TeamRecruitment.findOne({ recruitmentCode: recruitmentId });
  }

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

  application.status = 'withdrawn';
  application.isActive = false;
  await application.save();

  recruitment.applicants = recruitment.applicants.filter(
    app => app.user.toString() !== applicantId.toString()
  );
  await recruitment.save();

  await notifyRecruitmentEvent({
    recipient: recruitment.team,
    sender: applicantId,
    title: 'Recruitment Application Withdrawn',
    message: `${req.user.profile?.displayName || req.user.username} withdrew their application.`,
    eventType: 'recruitment_application_withdrawn',
    deliveryKey: `recruitment-application-withdrawn:${application._id}`,
    data: { applicationId: application._id, recruitmentId: recruitment._id }
  });

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

  // Validate team user
  if (req.user.userType !== 'team') {
    return res.status(400).json({
      success: false,
      message: 'Only teams can show interest in player profiles'
    });
  }

  // Check if profile exists
  let profile;
  const mongoose = require('mongoose');
  if (profileId && profileId.includes('-')) {
    profile = await PlayerProfile.findOne({ profileCode: profileId.toUpperCase() });
  } else if (profileId && mongoose.Types.ObjectId.isValid(profileId)) {
    profile = await PlayerProfile.findById(profileId);
  } else {
    profile = await PlayerProfile.findOne({ profileCode: profileId });
  }
  if (!profile) {
    return res.status(404).json({
      success: false,
      message: 'Player profile not found'
    });
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

  profile.interestedTeams.push({
    team: teamId,
    interestedAt: new Date(),
    status: 'pending',
    message
  });

  await profile.save();

  await notifyRecruitmentEvent({
    recipient: profile.player,
    sender: teamId,
    title: 'A Team Is Interested',
    message: `${req.user.profile?.displayName || req.user.username} showed interest in your player profile.`,
    eventType: 'recruitment_profile_interest',
    deliveryKey: `recruitment-profile-interest:${profile._id}:${teamId}`,
    data: { profileId: profile._id, teamId }
  });

  res.json({
    success: true,
    message: 'Interest shown successfully'
  });
});

// Get user's applications
const getUserApplications = safeAsyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { page = 1, limit = 10, status } = req.query;

  const query = { applicant: userId, isActive: true };
  if (status) query.status = status;

  const applications = await RecruitmentApplication.find(query)
    .populate('recruitment', 'game role staffRole recruitmentType team')
    .populate('recruitment.team', 'username profile.displayName profile.avatar')
    .sort({ createdAt: -1 })
    .limit(limit * 1)
    .skip((page - 1) * limit);

  const total = await RecruitmentApplication.countDocuments(query);

  res.json({
    success: true,
    data: {
      applications,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalApplications: total,
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1
      }
    }
  });
});

// Get team's recruitment applications
const getTeamApplications = safeAsyncHandler(async (req, res) => {
  const teamId = req.user._id;
  const { recruitmentId, page = 1, limit = 10, status } = req.query;

  // Validate team user
  if (req.user.userType !== 'team') {
    return res.status(400).json({
      success: false,
      message: 'Only teams can view applications'
    });
  }

  let query = { isActive: true };

  if (recruitmentId) {
    // Find recruitment by code or ID
    let recruitment;
    const mongoose = require('mongoose');
    if (recruitmentId && recruitmentId.includes('-')) {
      recruitment = await TeamRecruitment.findOne({ recruitmentCode: recruitmentId.toUpperCase() });
    } else if (recruitmentId && mongoose.Types.ObjectId.isValid(recruitmentId)) {
      recruitment = await TeamRecruitment.findById(recruitmentId);
    } else {
      recruitment = await TeamRecruitment.findOne({ recruitmentCode: recruitmentId });
    }
    
    if (!recruitment || recruitment.team.toString() !== teamId.toString()) {
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

  if (status) query.status = status;

  const applications = await RecruitmentApplication.find(query)
    .populate('applicant', 'username profile.displayName profile.avatar')
    .populate('recruitment', 'game role staffRole recruitmentType')
    .sort({ createdAt: -1 })
    .limit(limit * 1)
    .skip((page - 1) * limit);

  const total = await RecruitmentApplication.countDocuments(query);

  res.json({
    success: true,
    data: {
      applications,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalApplications: total,
        hasNext: page < Math.ceil(total / limit),
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
  const allowedStatuses = ['pending', 'reviewed', 'shortlisted', 'rejected', 'accepted', 'withdrawn'];

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid application status'
    });
  }

  // Validate team user
  if (req.user.userType !== 'team') {
    return res.status(400).json({
      success: false,
      message: 'Only teams can update application status'
    });
  }

  const application = await RecruitmentApplication.findById(applicationId)
    .populate('recruitment')
    .populate('applicant', 'username email profile.displayName profile.avatar');

  if (!application) {
    return res.status(404).json({
      success: false,
      message: 'Application not found'
    });
  }

  // Check if team owns the recruitment
  if (application.recruitment.team.toString() !== teamId.toString()) {
    return res.status(403).json({
      success: false,
      message: 'Not authorized to update this application'
    });
  }

  application.status = status;
  application.teamResponse = {
    message,
    respondedAt: new Date(),
    respondedBy: teamId
  };

  log.debug(`[Recruitment] updateApplicationStatus: applicationId=${applicationId} status=${status} teamId=${teamId}`);

  await application.save();

  // Update status in recruitment's applicants list
  const recruitment = await TeamRecruitment.findById(application.recruitment._id)
    .populate('team', 'username profile.displayName profile.avatar');
  const applicantEntry = recruitment.applicants.find(
    app => app.user.toString() === application.applicant._id.toString()
  );
  if (applicantEntry) {
    applicantEntry.status = status;
    await recruitment.save();
  }

  // ── Post-status side effects (non-blocking) ──────────────────────────────
  const applicantId = application.applicant._id;
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
