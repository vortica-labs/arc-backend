const Tournament = require('../models/Tournament');
const User = require('../models/User');
const TournamentHostActiveLock = require('../models/TournamentHostActiveLock');
const { createAndEmitNotification } = require('../utils/notificationEmitter');
const { enqueueBulkNotifications } = require('../utils/jobQueue');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const log = require('../utils/logger');
const { normalizeQuerySearch, buildPrefixRegex } = require('../utils/searchQuery');
const { getRedisClient } = require('../utils/redisCache');
const { uploadImage, deleteFile } = require('../utils/cloudinary');
const { deleteTournamentAndCleanup } = require('../services/tournamentDeletionService');
const {
  generatedDuoTeamQuery,
  cleanupGeneratedDuoTeams
} = require('../services/generatedDuoTeamService');
const {
  minimalTournamentUser,
  isPublishedTournamentGroupResult,
  sanitizeTournamentGroupResults,
  sanitizePublicTournament
} = require('../utils/tournamentPublicDto');
const {
  normalizeTournamentTimezone,
  parseTournamentDateTime,
  formatTournamentLocalDateTime,
  resolveTournamentMatchDateTime,
  getTournamentPhase,
  getNextTournamentTransitionAt,
  isTournamentRegistrationOpen,
  canTournamentStart,
  registrationWindowQuery,
  upcomingWindowQuery,
  ongoingWindowQuery,
  completedWindowQuery
} = require('../utils/tournamentDateTime');
const {
  registeredCountForFormat,
  getTournamentCapacity,
  mongoCapacityUsedExpression
} = require('../utils/tournamentCapacity');
const { buildTournamentEntrantRemovalUpdate } = require('../utils/tournamentCompetitionState');
const { getTimezoneDayBounds } = require('../utils/timezoneDayBounds');

const TOURNAMENT_UPLOAD_DIR = path.resolve(process.cwd(), 'uploads', 'tournaments');

const localTournamentBannerPath = (banner) => {
  if (!banner || /^https?:\/\//i.test(String(banner))) return null;
  const raw = String(banner).replace(/\\/g, '/');
  const filename = path.basename(raw);
  const allowedStoredValues = new Set([filename, `/uploads/tournaments/${filename}`]);
  if (!filename || !allowedStoredValues.has(raw)) return null;
  const resolved = path.resolve(TOURNAMENT_UPLOAD_DIR, filename);
  return resolved.startsWith(`${TOURNAMENT_UPLOAD_DIR}${path.sep}`) ? resolved : null;
};

const notificationRecipientId = (value) => {
  if (value === null || value === undefined) return '';
  const candidate = typeof value === 'object'
    ? (value._id || value.teamId || value.user?._id || value.user)
    : value;
  if (candidate === null || candidate === undefined || typeof candidate === 'object') return '';
  const normalized = String(candidate).trim();
  return normalized === '[object Object]' ? '' : normalized;
};

const uniqueNotificationRecipients = (values = []) =>
  Array.from(new Set(values.map(notificationRecipientId).filter(Boolean)));

const expandTournamentRecipientIds = async (values = []) => {
  const recipientIds = uniqueNotificationRecipients(values);
  if (recipientIds.length === 0) return [];
  try {
    const registeredTeams = await User.find({
      _id: { $in: recipientIds },
      userType: 'team',
      isActive: true
    }).select('teamInfo.members.user').lean();
    return uniqueNotificationRecipients([
      ...recipientIds,
      ...registeredTeams.flatMap((team) => (
        (team.teamInfo?.members || []).map((member) => member.user)
      ))
    ]);
  } catch (error) {
    log.error('Failed to expand tournament team recipients', { error: String(error) });
    return recipientIds;
  }
};

const notifyTournamentRecipients = async ({ tournament, recipients, sender, title, message, eventType, revision, extraData = {} }) => {
  const recipientIds = await expandTournamentRecipientIds(recipients);
  if (recipientIds.length === 0) return [];
  const dedupeKey = `tournament:${tournament._id}:${eventType}:${String(revision || tournament.updatedAt || '').slice(0, 80)}`;
  const results = await Promise.allSettled(recipientIds.map((recipient) => createAndEmitNotification({
    recipient,
    sender,
    type: 'tournament',
    title,
    message,
    data: {
      tournamentId: tournament._id,
      deepLink: `/tournament/${tournament._id}`,
      customData: {
        eventType,
        notificationDedupeKey: dedupeKey,
        pushRequestId: dedupeKey,
        ...extraData
      }
    }
  })));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      log.error('Tournament lifecycle notification failed', {
        error: String(result.reason),
        recipientId: recipientIds[index],
        tournamentId: String(tournament._id),
        eventType
      });
    }
  });
  return results;
};

// Registration can be opened through either the dedicated command endpoint or
// the Web management form's status update. Keep the durable fan-out in one
// post-commit producer so both accepted commands have identical side effects.
// The registration start timestamp is part of the key: retries of one opening
// are idempotent, while a genuinely new opening window remains deliverable.
const enqueueRegistrationOpenedNotifications = async (
  tournament,
  {
    findActiveUsers = () => User.find({ isActive: { $ne: false } }, '_id')
      .lean()
      .cursor({ batchSize: 500 }),
    enqueue = enqueueBulkNotifications
  } = {}
) => {
  if (!tournament?._id) return;
  const registrationStart = new Date(tournament.registrationStartDate || tournament.updatedAt || 0);
  const revision = Number.isNaN(registrationStart.getTime())
    ? String(tournament.updatedAt || 'unknown')
    : registrationStart.toISOString();
  const deliveryKey = `tournament-registration-open:${tournament._id}:${revision}`;
  const title = 'Registration Opened';
  const message = `Registration opened for "${tournament.name}"! Join now to participate.`;
  let batch = [];
  for await (const user of findActiveUsers()) {
    const recipientId = notificationRecipientId(user);
    if (!recipientId) continue;
    batch.push(recipientId);
    if (batch.length >= 500) {
      await enqueue(
        batch,
        title,
        message,
        'tournament',
        { tournamentId: tournament._id, customData: { action: 'registration_opened' } },
        deliveryKey
      );
      batch = [];
    }
  }
  if (batch.length > 0) {
    await enqueue(
      batch,
      title,
      message,
      'tournament',
      { tournamentId: tournament._id, customData: { action: 'registration_opened' } },
      deliveryKey
    );
  }
};

// Keep multipart data in memory. Tournament banners are persisted to S3 only
// after authorization and business validation have succeeded, so ECS tasks do
// not depend on ephemeral/writable container storage.
const storage = multer.memoryStorage();

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
}).single('banner');

const sendTournamentUploadError = (res, error) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      code: 'FILE_TOO_LARGE',
      message: 'Tournament banner must not exceed 5MB'
    });
  }
  if (error?.message === 'Only image files are allowed') {
    return res.status(415).json({
      success: false,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Only image files are allowed'
    });
  }
  log.error('Tournament banner upload failed', { error: String(error) });
  return res.status(400).json({
    success: false,
    code: 'FILE_UPLOAD_REJECTED',
    message: 'Tournament banner upload was rejected'
  });
};

const sendTournamentPersistenceError = (res, error, fallbackMessage) => {
  if (error?.name === 'ValidationError' || error?.name === 'CastError') {
    const details = error?.errors
      ? Object.values(error.errors).map((entry) => entry.message)
      : undefined;
    return res.status(400).json({
      success: false,
      code: 'TOURNAMENT_VALIDATION_FAILED',
      message: error?.name === 'CastError' ? 'Invalid tournament field value' : 'Validation failed',
      ...(details?.length ? { errors: details } : {})
    });
  }
  if (error?.code === 11000) {
    return res.status(409).json({
      success: false,
      code: 'TOURNAMENT_CONFLICT',
      message: 'Tournament data conflicts with an existing record'
    });
  }
  log.error(fallbackMessage, { error: String(error) });
  return res.status(500).json({
    success: false,
    message: fallbackMessage,
    error: process.env.NODE_ENV === 'development' ? error?.message : undefined
  });
};

// Helper function to convert banner filename to full URL
const getBannerUrl = (banner) => {
  if (!banner) {
    if (process.env.NODE_ENV === 'development') { console.log('Banner is null or undefined');}
    return null;
  }
  // If already a full URL (starts with http:// or https://), return as is
  if (banner.startsWith('http://') || banner.startsWith('https://')) {
    if (process.env.NODE_ENV === 'development') { console.log('Banner is already a full URL:', banner);}
    return banner;
  }
  // If it's already a path starting with /uploads, return as is
  if (banner.startsWith('/uploads/')) {
    if (process.env.NODE_ENV === 'development') { console.log('Banner is already a path:', banner);}
    return banner;
  }
  // If it's just a filename, construct the full URL
  const bannerUrl = `/uploads/tournaments/${banner}`;
  if (process.env.NODE_ENV === 'development') { console.log('Banner URL constructed:', { original: banner, constructed: bannerUrl });}
  return bannerUrl;
};

// Helper function to process tournament object and convert banner to URL
const processTournament = (tournament) => {
  if (!tournament) return tournament;
  const tournamentObj = tournament.toObject ? tournament.toObject() : tournament;
  if (tournamentObj.banner) {
    tournamentObj.banner = getBannerUrl(tournamentObj.banner);
  }
  return tournamentObj;
};

// Helper function to check if tournament can be edited (within 5 days of end)
const canEditTournament = (tournament) => {
  if (!tournament) return false;

  const phase = getTournamentPhase(tournament);
  if (phase === 'Cancelled') return false;
  if (phase !== 'Completed') {
    return ['Upcoming', 'Upcoming Registration', 'Registration Open', 'Registration Closed', 'Ongoing']
      .includes(phase);
  }
  
  // If completed, check if within 5 days of end date
  const endDate = tournament.tournamentEndDate ? new Date(tournament.tournamentEndDate) : new Date(tournament.endDate);
  const now = new Date();
  const daysSinceEnd = (now - endDate) / (1000 * 60 * 60 * 24); // Convert to days
  
  return daysSinceEnd <= 5;
};

const isTerminalTournament = (tournament, now = new Date()) => (
  ['Completed', 'Cancelled'].includes(getTournamentPhase(tournament, now))
);

const isTournamentBeforeStart = (tournament, now = new Date()) => (
  ['Upcoming Registration', 'Registration Open', 'Registration Closed']
    .includes(getTournamentPhase(tournament, now))
);

// Reads must never mutate lifecycle state. Completion is a transactional host
// command performed by generateFinalResult so standings, history, realtime,
// notifications, and the active-host lock change together.
const checkAndMarkCompletedTournaments = async (tournament) => {
  return tournament;
};

const idString = (value) => String(value?._id || value || '');
const isTournamentCode = (value) => /^TRN-[A-Z0-9]+-[A-Z0-9]{8}$/i.test(String(value || '').trim());

const removeParticipantFromCompetitionState = (tournament, participantId) => {
  const removedId = idString(participantId);
  tournament.groups = (tournament.groups || []).map((group) => {
    group.participants = (group.participants || []).filter((value) => idString(value) !== removedId);
    return group;
  });
  tournament.matches = (tournament.matches || []).filter((match) => (
    idString(match.team1) !== removedId && idString(match.team2) !== removedId
  ));
  tournament.groupResults = (tournament.groupResults || []).map((result) => {
    result.teams = (result.teams || []).filter((team) => idString(team.teamId) !== removedId);
    return result;
  });
  tournament.qualifications = (tournament.qualifications || []).map((qualification) => {
    qualification.qualifiedTeams = (qualification.qualifiedTeams || [])
      .filter((value) => idString(value) !== removedId);
    qualification.totalQualified = qualification.qualifiedTeams.length;
    return qualification;
  });
  if (tournament.finalResult?.standings) {
    tournament.finalResult.standings = tournament.finalResult.standings
      .filter((standing) => idString(standing.teamId) !== removedId);
  }
  if (tournament.finalResult?.specialPrizeWinners) {
    tournament.finalResult.specialPrizeWinners = tournament.finalResult.specialPrizeWinners
      .filter((winner) => idString(winner.winnerId) !== removedId);
  }
  tournament.markModified('groups');
  tournament.markModified('matches');
  tournament.markModified('groupResults');
  tournament.markModified('qualifications');
  tournament.markModified('finalResult');
};

const isDirectTournamentParticipant = (tournament, userId) => {
  const expected = idString(userId);
  if (!expected || !tournament) return false;
  return idString(tournament.host) === expected
    || (tournament.participants || []).some((participant) => idString(participant) === expected)
    || (tournament.teams || []).some((team) => idString(team) === expected);
};

const hasActiveMembershipInTeams = async (teamIds, userId) => {
  const ids = (teamIds || []).map(idString).filter(Boolean);
  if (!ids.length || !userId) return false;
  return Boolean(await User.exists({
    _id: { $in: ids },
    userType: 'team',
    isActive: true,
    'teamInfo.members': { $elemMatch: { user: userId } }
  }));
};

const getActiveTeamIdsForUser = async (userId) => {
  if (!userId) return [];
  return User.find({
    userType: 'team',
    isActive: true,
    'teamInfo.members': { $elemMatch: { user: userId } }
  }).distinct('_id');
};

const getActiveTeamWithdrawalContextForUser = async (userId) => {
  const activeTeamIds = await getActiveTeamIdsForUser(userId);
  if (activeTeamIds.length === 0) {
    return { activeTeamIds, generatedDuoTeamIds: [] };
  }
  const generatedDuoTeamIds = await User.find({
    ...generatedDuoTeamQuery(activeTeamIds),
    isActive: true
  }).distinct('_id');
  return { activeTeamIds, generatedDuoTeamIds };
};

const canReadTournamentMessages = async (tournament, userId) => (
  isDirectTournamentParticipant(tournament, userId)
  || hasActiveMembershipInTeams(tournament?.teams, userId)
);

const canReadGroupMessages = async (tournament, group, userId) => {
  if (idString(tournament?.host) === idString(userId)) return true;
  const participantIds = group?.participants || [];
  return participantIds.some((participant) => idString(participant) === idString(userId))
    || hasActiveMembershipInTeams(participantIds, userId);
};

const sanitizeTournamentMessages = (messages = []) => messages.map((message) => {
  const safe = message?.toObject ? message.toObject() : { ...message };
  if (safe.sender && typeof safe.sender === 'object') {
    safe.sender = minimalTournamentUser(safe.sender);
  }
  return safe;
});

const attachViewerMessageHistory = (
  contextualTournament,
  sourceTournament,
  messageState,
  userId
) => {
  if (!contextualTournament || !messageState || !userId) return contextualTournament;
  const isHost = contextualTournament.viewerRole === 'host';
  if (!isHost && contextualTournament.viewerParticipation !== true) return contextualTournament;

  const viewerCompetitionIds = new Set([
    idString(userId),
    idString(contextualTournament.viewerRegisteredTeamId)
  ].filter(Boolean));
  const viewerGroupKeys = new Set();
  (sourceTournament?.groups || []).forEach((group) => {
    if (!isHost && !(group?.participants || []).some(
      (participant) => viewerCompetitionIds.has(idString(participant))
    )) return;
    viewerGroupKeys.add(idString(group?._id));
    viewerGroupKeys.add(String(group?.name || ''));
  });

  const groupMessages = (messageState.groupMessages || [])
    .filter((thread) => isHost || viewerGroupKeys.has(String(thread?.groupId || '')))
    .map((thread) => ({
      groupId: String(thread?.groupId || ''),
      round: Number(thread?.round || 1),
      messages: sanitizeTournamentMessages(thread?.messages || [])
    }));

  return {
    ...contextualTournament,
    tournamentMessages: sanitizeTournamentMessages(messageState.tournamentMessages || []),
    groupMessages
  };
};

const loadTournamentMessageState = (tournamentId) => Tournament.findById(tournamentId)
  .select('tournamentMessages groupMessages')
  .populate('tournamentMessages.sender', 'username userType profile.displayName profile.avatar')
  .populate('groupMessages.messages.sender', 'username userType profile.displayName profile.avatar');

const TOURNAMENT_MESSAGE_TYPES = new Set(['text', 'announcement', 'system']);
const normalizeTournamentMessageType = (value = 'text') => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return TOURNAMENT_MESSAGE_TYPES.has(normalized) ? normalized : null;
};

const parseEmbeddedArrayIndex = (value, length) => {
  if (!/^\d+$/.test(String(value ?? ''))) return null;
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && index < length ? index : null;
};

const ACTIVE_TOURNAMENT_STATUSES = ['Upcoming', 'Registration Open', 'Ongoing'];
const MAX_GENERATED_MATCHES_PER_ROUND = 512;
const MAX_ROUND_GROUPS = 128;
const MAX_ROUND_PARTICIPANTS = 512;
const isPlainObject = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);
const isCompetitionId = (value) => /^[a-f\d]{24}$/i.test(idString(value));
const tournamentRevisionFilter = (tournament) => (
  tournament?.updatedAt ? { updatedAt: tournament.updatedAt } : {}
);
const hasPublishedFinalResult = (tournament) => Boolean(tournament?.finalResult?.generatedAt);
const competitionMutationBlocked = (tournament) => (
  isTerminalTournament(tournament) || hasPublishedFinalResult(tournament)
);
const normalizeCompetitionEntry = (entry) => {
  const source = isPlainObject(entry) ? entry : {};
  const teamId = source.teamId || entry;
  if (!isCompetitionId(teamId)) return null;
  return {
    teamId,
    teamName: typeof source.teamName === 'string'
      ? source.teamName.trim().slice(0, 200)
      : '',
    teamLogo: typeof source.teamLogo === 'string'
      ? source.teamLogo.trim().slice(0, 2048)
      : null
  };
};
const tournamentResultTeamDto = (team) => {
  const source = typeof team?.toObject === 'function' ? team.toObject() : (team || {});
  const populatedTeam = source.teamId && typeof source.teamId === 'object'
    ? minimalTournamentUser(source.teamId)
    : null;
  return {
    // The Web results editor treats this field as an identifier (React key,
    // update selector, and submission payload). Never make its type depend on
    // whether Mongoose happened to populate the reference.
    teamId: idString(source.teamId),
    teamName: String(
      source.teamName
      || populatedTeam?.profile?.displayName
      || populatedTeam?.username
      || ''
    ),
    teamLogo: source.teamLogo || populatedTeam?.profile?.avatar || '',
    wins: Number(source.wins) || 0,
    finishPoints: Number(source.finishPoints) || 0,
    positionPoints: Number(source.positionPoints) || 0,
    totalPoints: Number(source.totalPoints) || 0,
    rank: Number(source.rank) || 0,
    qualified: source.qualified === true
  };
};
const normalizeRoundGroupsInput = (groups) => {
  if (!Array.isArray(groups) || groups.length === 0 || groups.length > MAX_ROUND_GROUPS) {
    return { error: `Groups must contain between 1 and ${MAX_ROUND_GROUPS} entries` };
  }
  let participantCount = 0;
  const normalizedGroups = [];
  const groupNames = new Set();
  for (const group of groups) {
    if (!isPlainObject(group)
      || typeof group.name !== 'string'
      || !group.name.trim()
      || group.name.trim().length > 120
      || !Array.isArray(group.participants)
      || group.participants.length === 0) {
      return { error: 'Every group needs a valid name and a non-empty participants array' };
    }
    const groupName = group.name.trim();
    const groupNameKey = groupName.toLowerCase();
    if (groupNames.has(groupNameKey)) return { error: 'Group names must be unique' };
    groupNames.add(groupNameKey);
    const participants = group.participants.map(normalizeCompetitionEntry);
    if (participants.some((participant) => !participant)) {
      return { error: 'Every round participant must contain a valid teamId' };
    }
    participantCount += participants.length;
    if (participantCount > MAX_ROUND_PARTICIPANTS) {
      return { error: `A round supports at most ${MAX_ROUND_PARTICIPANTS} participants` };
    }
    normalizedGroups.push({ name: groupName, participants });
  }
  return { groups: normalizedGroups };
};
const normalizeCompetitionList = (entries) => {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ROUND_PARTICIPANTS) {
    return null;
  }
  const normalized = entries.map(normalizeCompetitionEntry);
  return normalized.some((entry) => !entry) ? null : normalized;
};
// entryFee is selected only for server-side legacy-payment quarantine. The
// public DTO always strips it before returning a response.
const PUBLIC_TOURNAMENT_SELECT = '-groupMessages -tournamentMessages +entryFee';
const PUBLIC_HOST_POPULATE = {
  path: 'host',
  match: { isActive: true },
  select: 'username profile.displayName profile.avatar'
};
const PUBLIC_PARTICIPANT_POPULATE = {
  path: 'participants',
  match: { isActive: true },
  select: 'username profile.displayName profile.avatar'
};
const PUBLIC_TEAM_POPULATE = {
  path: 'teams',
  match: { isActive: true, userType: 'team' },
  select: 'username userType profile.displayName profile.avatar'
};
const AUTHORIZED_TEAM_POPULATE = {
  path: 'teams',
  match: { isActive: true, userType: 'team' },
  select: 'username userType profile.displayName profile.avatar teamInfo.members.user teamInfo.members.role',
  populate: {
    path: 'teamInfo.members.user',
    select: 'username userType profile.displayName profile.avatar'
  }
};
const activeCompetitionUserPopulate = (path) => ({
  path,
  match: { isActive: true },
  select: 'username profile.displayName profile.avatar'
});

const hydratePublicTournamentQuery = (query) => query
  .select(PUBLIC_TOURNAMENT_SELECT)
  .populate(PUBLIC_HOST_POPULATE)
  .populate(PUBLIC_PARTICIPANT_POPULATE)
  .populate(PUBLIC_TEAM_POPULATE)
  .populate(activeCompetitionUserPopulate('groups.participants'))
  .populate(activeCompetitionUserPopulate('matches.team1'))
  .populate(activeCompetitionUserPopulate('matches.team2'))
  .populate(activeCompetitionUserPopulate('matches.winner'))
  .populate(activeCompetitionUserPopulate('winners.team'));

const constrainToActiveTournamentHosts = async (filter = {}) => {
  const candidateHostIds = await Tournament.distinct('host', filter);
  const activeHostIds = candidateHostIds.length > 0
    ? await User.find({
        _id: { $in: candidateHostIds },
        isActive: true
      }).distinct('_id')
    : [];
  return {
    $and: [filter, { host: { $in: activeHostIds } }]
  };
};

const isTournamentHost = (tournament, userId) => (
  Boolean(tournament && userId) && idString(tournament.host) === idString(userId)
);

const publicBroadcastChannel = (channel) => ({
  name: String(channel?.name || ''),
  type: String(channel?.type || 'Text Messages'),
  description: String(channel?.description || ''),
  round: Number(channel?.round || 1),
  groupId: idString(channel?.groupId)
});

const publicTournamentViewerShape = (safeTournament) => {
  if (!safeTournament) return safeTournament;
  const publicShape = { ...safeTournament, groups: [], matches: [] };
  delete publicShape.broadcastChannels;
  return publicShape;
};

const withViewerTournamentContext = (
  safeTournament,
  sourceTournament,
  userId,
  activeTeamIds = [],
  viewerUserType = null,
  nowValue = new Date(),
  generatedDuoTeamIds = []
) => {
  if (!safeTournament) return safeTournament;
  const serverNow = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const effectivePhase = getTournamentPhase(sourceTournament, serverNow);
  const nextTransitionAt = getNextTournamentTransitionAt(sourceTournament, serverNow);
  const capacity = getTournamentCapacity(sourceTournament);
  const lifecycleContext = {
    effectivePhase,
    registrationOpen: effectivePhase === 'Registration Open',
    serverTime: serverNow.toISOString(),
    nextTransitionAt: nextTransitionAt ? nextTransitionAt.toISOString() : null,
    capacity,
    // The primary tournament pages consume `capacity`; the shared Web search
    // cards still consume these historical numeric aliases. Keep both derived
    // from one canonical calculation so search never renders undefined slots.
    currentParticipants: capacity.used,
    maxParticipants: capacity.total
  };
  if (!userId) {
    return {
      ...publicTournamentViewerShape(safeTournament),
      ...lifecycleContext,
      viewerParticipation: false,
      viewerCanJoin: false,
      viewerJoinAction: null,
      viewerJoinReason: 'AUTHENTICATION_REQUIRED',
      viewerCanWithdraw: false
    };
  }
  const viewerId = idString(userId);
  const activeTeamSet = new Set((activeTeamIds || []).map(idString));
  const generatedDuoTeamSet = new Set((generatedDuoTeamIds || []).map(idString));
  const registeredTeam = (sourceTournament?.teams || []).find((team) => {
    const teamId = idString(team);
    return teamId === viewerId || activeTeamSet.has(teamId);
  });
  const isHost = idString(sourceTournament?.host) === viewerId;
  const isDirect = (sourceTournament?.participants || [])
    .some((participant) => idString(participant) === viewerId);
  const registeredTeamId = registeredTeam ? idString(registeredTeam) : null;
  const isRegisteredTeamAccount = Boolean(registeredTeamId && registeredTeamId === viewerId);
  const isGeneratedDuoMember = Boolean(
    registeredTeamId
    && activeTeamSet.has(registeredTeamId)
    && generatedDuoTeamSet.has(registeredTeamId)
  );
  const viewerParticipation = Boolean(isDirect || registeredTeam);
  let viewerCanJoin = false;
  let viewerJoinAction = null;
  let viewerJoinReason = null;
  if (isHost) {
    viewerJoinReason = 'HOST_CANNOT_JOIN';
  } else if (viewerParticipation) {
    viewerJoinReason = 'ALREADY_REGISTERED';
  } else if (Number(sourceTournament?.entryFee) > 0) {
    viewerJoinReason = 'LEGACY_PAID_TOURNAMENT_REQUIRES_RECONCILIATION';
  } else if (effectivePhase !== 'Registration Open') {
    viewerJoinReason = 'REGISTRATION_NOT_OPEN';
  } else if (capacity.isFull) {
    viewerJoinReason = 'TOURNAMENT_FULL';
  } else if (sourceTournament?.format === 'Solo' && viewerUserType === 'team') {
    viewerJoinReason = 'SOLO_REQUIRES_PLAYER_ACCOUNT';
  } else if (sourceTournament?.format === 'Duo' && viewerUserType === 'team') {
    viewerJoinReason = 'DUO_REQUIRES_PLAYER_ACCOUNT';
  } else if (['Squad', '5v5'].includes(sourceTournament?.format) && viewerUserType !== 'team') {
    viewerJoinReason = 'TEAM_ACCOUNT_REQUIRED';
  } else {
    viewerCanJoin = true;
    viewerJoinAction = sourceTournament?.format === 'Duo' ? 'join-duo' : 'join';
  }
  const teams = (safeTournament.teams || []).map((team) => {
    const teamId = idString(team);
    if (!registeredTeamId || teamId !== registeredTeamId || !activeTeamSet.has(teamId)) return team;
    return { ...team, teamInfo: { members: [{ user: viewerId }] } };
  });
  const viewerCompetitionIds = new Set([isDirect ? viewerId : null, registeredTeamId].filter(Boolean));
  const viewerGroupKeys = new Set();
  const viewerGroupNames = new Set();
  (sourceTournament?.groups || []).forEach((group) => {
    const belongsToViewer = (group?.participants || [])
      .some((participant) => viewerCompetitionIds.has(idString(participant)));
    if (!belongsToViewer) return;
    viewerGroupKeys.add(idString(group?._id));
    viewerGroupKeys.add(String(group?.name || ''));
    viewerGroupNames.add(String(group?.name || '').toLowerCase());
  });
  const canReadParticipantChannels = Boolean(isHost || isDirect || registeredTeam);
  const broadcastChannels = canReadParticipantChannels
    ? (sourceTournament?.broadcastChannels || [])
      .filter((channel) => (
        isHost
        || !channel?.groupId
        || viewerGroupKeys.has(idString(channel.groupId))
        || viewerGroupKeys.has(String(channel.groupId || ''))
        || Array.from(viewerGroupNames).some((groupName) => (
          groupName && String(channel?.name || '').toLowerCase().includes(groupName)
        ))
      ))
      .map(publicBroadcastChannel)
    : undefined;
  return {
    ...(canReadParticipantChannels ? safeTournament : publicTournamentViewerShape(safeTournament)),
    ...lifecycleContext,
    teams,
    ...(isHost ? {
      groupResults: sanitizeTournamentGroupResults(sourceTournament?.groupResults, { includeDrafts: true })
    } : {}),
    ...(broadcastChannels ? { broadcastChannels } : {}),
    viewerParticipation,
    viewerRole: isHost ? 'host' : registeredTeam ? 'team-member' : isDirect ? 'participant' : null,
    viewerRegisteredTeamId: registeredTeamId,
    viewerCanJoin,
    viewerJoinAction,
    viewerJoinReason,
    viewerCanWithdraw: effectivePhase === 'Registration Open' && Boolean(
      isDirect || isRegisteredTeamAccount || isGeneratedDuoMember
    )
  };
};

const withoutViewerTournamentContext = (
  safeTournament,
  sourceTournament,
  nowValue = new Date()
) => {
  const contextual = withViewerTournamentContext(
    safeTournament,
    sourceTournament,
    null,
    [],
    null,
    nowValue
  );
  const {
    viewerParticipation: _viewerParticipation,
    viewerCanJoin: _viewerCanJoin,
    viewerJoinAction: _viewerJoinAction,
    viewerJoinReason: _viewerJoinReason,
    viewerCanWithdraw: _viewerCanWithdraw,
    viewerRole: _viewerRole,
    viewerRegisteredTeamId: _viewerRegisteredTeamId,
    ...publicContext
  } = contextual;
  return publicContext;
};

const getSocketIo = (req) => req?.app?.get?.('io') || global._arcSocketIO || null;

const loadPublicTournament = async (tournamentId) => {
  const tournament = await hydratePublicTournamentQuery(Tournament.findById(tournamentId));
  return tournament?.host ? tournament : null;
};

const emitTournamentUpdated = async (req, tournamentId) => {
  const io = getSocketIo(req);
  if (!io || !tournamentId) return null;
  try {
    const tournament = await loadPublicTournament(tournamentId);
    if (!tournament) return null;
    const payload = sanitizePublicTournament(processTournament(tournament));
    const emittedAt = new Date();
    io.emit(
      'tournament_updated',
      withoutViewerTournamentContext(payload, tournament, emittedAt)
    );
    // Public updates never expose team rosters. Send a second, personalized
    // payload only to registered team members so the untouched Web client can
    // preserve its own participation marker after replacing list state.
    const teamIds = (tournament.teams || []).map(idString).filter(Boolean);
    const recipientTeams = new Map();
    const addRecipient = (recipientId, teamId = null) => {
      const normalizedRecipient = idString(recipientId);
      if (!normalizedRecipient) return;
      const values = recipientTeams.get(normalizedRecipient) || [];
      if (teamId && !values.some((value) => idString(value) === idString(teamId))) values.push(teamId);
      recipientTeams.set(normalizedRecipient, values);
    };
    addRecipient(tournament.host);
    (tournament.participants || []).forEach((participant) => addRecipient(participant));
    teamIds.forEach((teamId) => addRecipient(teamId, teamId));
    let generatedDuoTeamIds = [];
    if (teamIds.length > 0) {
      const [membershipTeams, generatedTeams] = await Promise.all([
        User.find({ _id: { $in: teamIds }, userType: 'team', isActive: true })
          .select('teamInfo.members.user')
          .lean(),
        User.find({ ...generatedDuoTeamQuery(teamIds), isActive: true })
          .select('_id')
          .lean()
      ]);
      generatedDuoTeamIds = generatedTeams.map((team) => team._id);
      membershipTeams.forEach((team) => {
        (team.teamInfo?.members || []).forEach((member) => {
          addRecipient(member.user, team._id);
        });
      });
    }
    recipientTeams.forEach((activeTeamIds, memberId) => {
      io.to(`user-${memberId}`).emit(
        'tournament_updated',
        withViewerTournamentContext(
          payload,
          tournament,
          memberId,
          activeTeamIds,
          teamIds.includes(idString(memberId)) ? 'team' : 'player',
          emittedAt,
          generatedDuoTeamIds
        )
      );
    });
    return payload;
  } catch (error) {
    // Realtime refresh is supplementary. A socket outage must never turn a
    // successfully persisted tournament command into an HTTP failure.
    log.error('Tournament realtime update failed', {
      tournamentId: idString(tournamentId),
      error: String(error)
    });
    return null;
  }
};

const emitTournamentBroadcast = (req, tournament, type, message, recipientIds = null) => {
  const io = getSocketIo(req);
  if (!io || !tournament) return;
  const payload = {
    id: `${idString(tournament._id)}:${type}:${Date.now()}`,
    tournamentId: tournament._id,
    message,
    timestamp: new Date(),
    type
  };
  if (Array.isArray(recipientIds)) {
    return expandTournamentRecipientIds(recipientIds).then((expandedRecipientIds) => {
      expandedRecipientIds.forEach((recipientId) => {
        io.to(`user-${recipientId}`).emit('broadcast_message', payload);
      });
    }).catch((error) => {
      log.error('Tournament broadcast recipient expansion failed', { error: String(error) });
    });
    return;
  }
  // Registration announcements are public competition updates and are also
  // sent to every active account through the durable notification producer.
  io.emit('broadcast_message', payload);
};

const normalizePrizePoolType = (value) => (
  value === 'no_prize' ? 'without_prize' : (value || 'without_prize')
);
const tournamentScheduleTimezone = (tournament) => (
  normalizeTournamentTimezone(tournament?.timezone || tournament?.scheduleConfig?.timezone || 'UTC') || 'UTC'
);
const MAX_TOURNAMENT_MONEY_AMOUNT = Number.MAX_SAFE_INTEGER;
const isSafeTournamentMoney = (value) => (
  Number.isFinite(value) && value >= 0 && value <= MAX_TOURNAMENT_MONEY_AMOUNT
);
const parseStrictInteger = (value) => {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
};
const alphabeticGroupLabel = (index) => {
  let value = Number(index) + 1;
  if (!Number.isSafeInteger(value) || value < 1) return '';
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
};

// Canonical Web game/mode/format matrix. The API enforces the same
// combinations so neither client can invent a tournament the Web form would
// reject.
const TOURNAMENT_GAME_CONFIGS = {
  BGMI: {
    'Battle Royale': new Set(['Solo', 'Squad']),
    Deathmatch: new Set(['Solo', 'Squad'])
  },
  'Free Fire': {
    'Battle Royale': new Set(['Solo', 'Squad']),
    Deathmatch: new Set(['Solo', 'Squad'])
  },
  'Call of Duty Mobile': {
    'Battle Royale': new Set(['Solo', 'Squad']),
    Deathmatch: new Set(['5v5'])
  },
  Valorant: {
    '5v5': new Set(['5v5'])
  }
};

const validateTournamentGameConfiguration = (game, mode, format) => {
  const modes = TOURNAMENT_GAME_CONFIGS[game];
  if (!modes) return 'Invalid tournament game';
  if (!mode || !modes[mode]) return `Invalid mode for ${game}`;
  if (!format || !modes[mode].has(format)) return `Invalid format for ${game} ${mode}`;
  return null;
};

const normalizeAndValidatePrizes = ({ type, pool, distribution = [], special = [] }) => {
  if (type !== 'with_prize') return { distribution: [], special: [] };
  if (!Array.isArray(distribution) || !Array.isArray(special)) {
    return { error: 'Prize distribution must be an array' };
  }
  if (distribution.some((prize) => !prize || typeof prize !== 'object' || Array.isArray(prize)) ||
      special.some((prize) => !prize || typeof prize !== 'object' || Array.isArray(prize))) {
    return { error: 'Prize distribution entries must be objects' };
  }
  const normalizedDistribution = distribution.map((prize) => ({
    rank: Number(prize.rank),
    label: String(prize.label || ''),
    amount: Number(prize.amount || 0),
    percentage: Number(prize.percentage || 0)
  }));
  const normalizedSpecial = special.map((prize) => ({
    category: String(prize.category || '').trim(),
    amount: Number(prize.amount || 0),
    ...(prize.winnerId ? { winnerId: prize.winnerId } : {}),
    ...(prize.winnerName ? { winnerName: String(prize.winnerName) } : {})
  }));
  const ranks = normalizedDistribution.map((prize) => prize.rank);
  const categories = normalizedSpecial.map((prize) => prize.category.toLowerCase());
  const amounts = [...normalizedDistribution, ...normalizedSpecial].map((prize) => prize.amount);
  const percentages = normalizedDistribution.map((prize) => prize.percentage);
  if (ranks.some((rank) => !Number.isInteger(rank) || rank < 1)
    || new Set(ranks).size !== ranks.length
    || categories.some((category) => !category)
    || new Set(categories).size !== categories.length
    || amounts.some((amount) => !isSafeTournamentMoney(amount))
    || percentages.some((percentage) => !Number.isFinite(percentage) || percentage < 0 || percentage > 100)
    || percentages.reduce((sum, percentage) => sum + percentage, 0) > 100
    || amounts.reduce((sum, amount) => sum + amount, 0) > Number(pool || 0)) {
    return { error: 'Invalid or over-budget prize distribution' };
  }
  return { distribution: normalizedDistribution, special: normalizedSpecial };
};

const submittedRoundCoverage = (tournament, round) => {
  const roundNumber = Number(round);
  const groups = (tournament.groups || []).filter(
    (group) => Number(group.round || 1) === roundNumber && (group.participants || []).length > 0
  );
  const results = (tournament.groupResults || []).filter((result) => (
    Number(result.round) === roundNumber
    && isPublishedTournamentGroupResult(result)
  ));
  const complete = groups.length > 0 && groups.every((group) => {
    const result = results.find((candidate) => (
      String(candidate.groupName) === String(group.name)
      || String(candidate.groupId) === String(group.name)
      || String(candidate.groupId) === idString(group._id)
    ));
    if (!result) return false;
    const expected = new Set((group.participants || []).map(idString));
    const actual = (result.teams || []).map((team) => idString(team.teamId));
    return actual.length === expected.size
      && new Set(actual).size === actual.length
      && actual.every((teamId) => expected.has(teamId));
  });
  const qualifiedIds = complete
    ? Array.from(new Set(results.flatMap((result) => (
        (result.teams || []).filter((team) => team.qualified).map((team) => idString(team.teamId))
      ))))
    : [];
  return { complete, groups, results, qualifiedIds };
};

const getFreshHostPermissions = async (hostId) => {
  const host = await User.findOne({ _id: hostId, isActive: true })
    .select('isVerifiedHost')
    .lean();
  return {
    exists: Boolean(host),
    isVerifiedHost: host?.isVerifiedHost === true
  };
};

const getActiveTournamentForHost = async (hostId, excludeTournamentId = null) => {
  const query = {
    host: hostId,
    status: { $in: ACTIVE_TOURNAMENT_STATUSES }
  };
  if (excludeTournamentId) query._id = { $ne: excludeTournamentId };
  const candidates = await Tournament.find(query)
    .select('_id name status registrationStartDate registrationEndDate registrationDeadline tournamentStartDate startDate tournamentEndDate endDate')
    .lean();
  return candidates.find((candidate) => (
    !['Completed', 'Cancelled'].includes(getTournamentPhase(candidate))
  )) || null;
};

const releaseHostActiveTournament = async (hostId, tournamentId) => {
  if (!hostId || !tournamentId) return;
  await TournamentHostActiveLock.deleteOne({ host: hostId, tournament: tournamentId });
};

const reserveHostActiveTournament = async (hostId, tournamentId) => {
  try {
    await TournamentHostActiveLock.create({ host: hostId, tournament: tournamentId });
    return { ok: true };
  } catch (error) {
    if (error?.code !== 11000) throw error;

    const existingLock = await TournamentHostActiveLock.findOne({ host: hostId }).lean();
    if (!existingLock?.tournament) {
      await TournamentHostActiveLock.deleteOne({ host: hostId });
      return reserveHostActiveTournament(hostId, tournamentId);
    }

    const lockedTournament = await Tournament.findById(existingLock.tournament)
      .select('_id name status registrationStartDate registrationEndDate registrationDeadline tournamentStartDate startDate tournamentEndDate endDate')
      .lean();
    if (!lockedTournament
      || !ACTIVE_TOURNAMENT_STATUSES.includes(lockedTournament.status)
      || getTournamentPhase(lockedTournament) === 'Completed') {
      await TournamentHostActiveLock.deleteOne({ host: hostId, tournament: existingLock.tournament });
      return reserveHostActiveTournament(hostId, tournamentId);
    }

    return { ok: false, activeTournament: lockedTournament };
  }
};

const acquireHostTournamentCreateLock = async (hostId) => {
  const redis = getRedisClient();
  if (!redis) return null;
  const key = `lock:tournament:create:${hostId}`;
  const token = crypto.randomBytes(12).toString('hex');
  try {
    const result = await redis.set(key, token, { NX: true, EX: 20 });
    return result === 'OK' ? { key, token } : false;
  } catch {
    return null;
  }
};

const releaseHostTournamentCreateLock = async (lock) => {
  if (!lock) return;
  const redis = getRedisClient();
  if (!redis) return;
  try {
    const current = await redis.get(lock.key);
    if (current === lock.token) await redis.del(lock.key);
  } catch {}
};

// ─── Tournament History Helper Functions ────────────────────────────────────

const tournamentHistoryEntry = (tournament, { teamId, teamName }) => ({
  tournamentId: tournament._id,
  teamId,
  teamName,
  game: tournament.game,
  tournamentName: tournament.name,
  tournamentStartDate: tournament.tournamentStartDate || tournament.startDate,
  tournamentEndDate: tournament.tournamentEndDate || tournament.endDate,
  status: tournament.status,
  joinedAt: new Date()
});

const createHistoryEntryForPlayer = async (tournament, playerId, teamIdentity = {}) => {
  if (!playerId) return 0;
  const teamId = teamIdentity.teamId || playerId;
  const teamName = teamIdentity.teamName || 'Solo';
  const result = await User.updateOne(
    {
      _id: playerId,
      isActive: true,
      'playerInfo.tournamentHistory': {
        $not: { $elemMatch: { tournamentId: tournament._id, teamId } }
      }
    },
    {
      $push: {
        'playerInfo.tournamentHistory': tournamentHistoryEntry(tournament, { teamId, teamName })
      }
    }
  );
  return result.modifiedCount > 0 ? 1 : 0;
};

/**
 * createHistoryEntriesForTeam(tournament, team)
 * Finds the roster matching tournament.game, filters active players,
 * and pushes a Tournament_History_Entry to each player's tournamentHistory.
 * Returns the count of entries actually created (modifiedCount > 0).
 */
const createHistoryEntriesForTeam = async (tournament, team) => {
  if (!team.teamInfo || !team.teamInfo.rosters) return 0;

  const roster = team.teamInfo.rosters.find(r => r.game === tournament.game);
  const activePlayers = roster?.players?.length
    ? roster.players.filter(p => p.isActive !== false)
    : team.teamInfo.isGeneratedDuo === true
      ? (team.teamInfo.members || [])
      : [];
  if (activePlayers.length === 0) return 0;

  let created = 0;
  for (const player of activePlayers) {
    if (!player.user) continue;
    created += await createHistoryEntryForPlayer(
      tournament,
      player.user,
      {
        teamId: team._id,
        teamName: team.profile?.displayName || team.username || 'Team'
      }
    );
  }
  return created;
};

/**
 * removeHistoryEntriesForTeam(tournamentId, teamId)
 * Removes all Tournament_History_Entry records matching (tournamentId, teamId)
 * from every player's tournamentHistory array.
 */
const removeHistoryEntriesForTeam = async (tournamentId, teamId) => {
  await User.updateMany(
    {
      'playerInfo.tournamentHistory': {
        $elemMatch: { tournamentId, teamId }
      }
    },
    {
      $pull: {
        'playerInfo.tournamentHistory': { tournamentId, teamId }
      }
    }
  );
};

/**
 * propagateFinalResult(tournament)
 * Iterates tournament.finalResult.standings and updates each player's
 * matching history entry with rank, points, and prizeWon.
 */
const propagateFinalResult = async (tournament) => {
  if (!tournament.finalResult || !tournament.finalResult.standings) return;

  for (const standing of tournament.finalResult.standings) {
    const teamId = standing.teamId;
    if (!teamId) continue;

    const result = await User.updateMany(
      {
        'playerInfo.tournamentHistory': {
          $elemMatch: { tournamentId: tournament._id, teamId }
        }
      },
      {
        $set: {
          'playerInfo.tournamentHistory.$[elem].result.rank':     standing.rank,
          'playerInfo.tournamentHistory.$[elem].result.points':   standing.totalPoints,
          'playerInfo.tournamentHistory.$[elem].result.prizeWon': standing.prizeAmount
        }
      },
      {
        arrayFilters: [
          { 'elem.tournamentId': tournament._id, 'elem.teamId': teamId }
        ]
      }
    );

    if (result.modifiedCount === 0) {
      console.warn(
        `[propagateFinalResult] No player entries updated for teamId=${teamId} in tournament=${tournament._id}`
      );
    }
  }
};

/**
 * propagateSpecialPrize(tournamentId, teamId, specialPrize)
 * Sets result.specialPrize on all player history entries matching
 * (tournamentId, teamId).
 */
const propagateSpecialPrize = async (tournamentId, teamId, specialPrize) => {
  await User.updateMany(
    {
      'playerInfo.tournamentHistory': {
        $elemMatch: { tournamentId, teamId }
      }
    },
    {
      $set: {
        'playerInfo.tournamentHistory.$[elem].result.specialPrize': specialPrize
      }
    },
    {
      arrayFilters: [
        { 'elem.tournamentId': tournamentId, 'elem.teamId': teamId }
      ]
    }
  );
};

/**
 * propagateTournamentUpdate(tournamentId, updateFields)
 * Syncs tournamentName, tournamentStartDate, and/or tournamentEndDate
 * on all player history entries for the given tournament.
 * updateFields may contain: { name, startDate, endDate }
 */
const propagateTournamentUpdate = async (tournamentId, updateFields) => {
  const setFields = {};

  if (updateFields.name !== undefined) {
    setFields['playerInfo.tournamentHistory.$[elem].tournamentName'] = updateFields.name;
  }
  if (updateFields.startDate !== undefined || updateFields.tournamentStartDate !== undefined) {
    setFields['playerInfo.tournamentHistory.$[elem].tournamentStartDate'] =
      updateFields.startDate || updateFields.tournamentStartDate;
  }
  if (updateFields.endDate !== undefined || updateFields.tournamentEndDate !== undefined) {
    setFields['playerInfo.tournamentHistory.$[elem].tournamentEndDate'] =
      updateFields.endDate || updateFields.tournamentEndDate;
  }

  if (Object.keys(setFields).length === 0) return;

  await User.updateMany(
    {
      'playerInfo.tournamentHistory': {
        $elemMatch: { tournamentId }
      }
    },
    { $set: setFields },
    {
      arrayFilters: [{ 'elem.tournamentId': tournamentId }]
    }
  );
};

/**
 * propagateStatusChange(tournamentId, newStatus)
 * Updates the status field on all player history entries for the given tournament.
 */
const propagateStatusChange = async (tournamentId, newStatus) => {
  await User.updateMany(
    {
      'playerInfo.tournamentHistory': {
        $elemMatch: { tournamentId }
      }
    },
    {
      $set: {
        'playerInfo.tournamentHistory.$[elem].status': newStatus
      }
    },
    {
      arrayFilters: [{ 'elem.tournamentId': tournamentId }]
    }
  );
};

// ─── End Tournament History Helper Functions ─────────────────────────────────

// Create new tournament
const createTournament = async (req, res) => {
  let createLock = null;
  let reservedTournamentId = null;
  let tournamentSaved = false;
  let newBannerPublicId = null;
  try {
    await new Promise((resolve, reject) => {
      upload(req, res, (uploadError) => uploadError ? reject(uploadError) : resolve());
    });

      // Debug: Log the request body
      if (process.env.NODE_ENV === 'development') { console.log('Request body:', req.body);}
      if (process.env.NODE_ENV === 'development') { console.log('Request file:', req.file);
}
      const {
        name,
        description,
        game,
        mode,
        format,
        registrationStartDate,
        registrationEndDate,
        tournamentStartDate,
        tournamentEndDate,
        startDate, // Fallback
        endDate, // Fallback
        registrationDeadline, // Fallback
        location,
        timezone,
        prizePool,
        totalSlots,
        teamsPerGroup,
        numberOfGroups,
        prizePoolType,
        prizePoolCurrency,
        prizeDistribution,
        specialPrizes,
        rules
      } = req.body;

    if (typeof name !== 'string' || typeof description !== 'string' ||
        (rules !== undefined && typeof rules !== 'string') ||
        (location !== undefined && typeof location !== 'string') ||
        (timezone !== undefined && typeof timezone !== 'string') ||
        (prizePoolCurrency !== undefined && typeof prizePoolCurrency !== 'string')) {
      return res.status(400).json({ success: false, message: 'Invalid tournament field type' });
    }
    if (name.length > 200 || description.length > 5000 || (rules && rules.length > 10000) ||
        (location && location.length > 200) || (timezone && timezone.length > 100)) {
      return res.status(400).json({ success: false, message: 'Tournament field exceeds the allowed length' });
    }

    const hostId = req.user._id;
    const validGames = ['BGMI', 'Valorant', 'Free Fire', 'Call of Duty Mobile'];
    const validModes = ['Battle Royale', 'Deathmatch', '5v5', 'Solo'];
    const validFormats = ['Solo', 'Duo', 'Squad', '5v5'];
    const normalizedPrizePoolType = normalizePrizePoolType(prizePoolType);
    const parsedPrizePool = prizePool !== undefined && String(prizePool).trim() !== ''
      ? Number(String(prizePool).trim())
      : 0;
    const parsedTotalSlots = parseStrictInteger(totalSlots);
    const parsedTeamsPerGroup = parseStrictInteger(teamsPerGroup);
    const parsedNumberOfGroups = numberOfGroups !== undefined && String(numberOfGroups).trim() !== ''
      ? parseStrictInteger(numberOfGroups)
      : Math.ceil(parsedTotalSlots / parsedTeamsPerGroup);
    const totalRounds = req.body.totalRounds !== undefined && String(req.body.totalRounds).trim() !== ''
      ? parseStrictInteger(req.body.totalRounds)
      : 1;

    if (!name || String(name).trim().length < 3) {
      return res.status(400).json({ success: false, message: 'Tournament name must be at least 3 characters' });
    }

    if (!description || String(description).trim().length < 10) {
      return res.status(400).json({ success: false, message: 'Tournament description must be at least 10 characters' });
    }

    if (!validGames.includes(game)) {
      return res.status(400).json({ success: false, message: 'Invalid tournament game' });
    }

    if (!mode || !validModes.includes(mode)) {
      return res.status(400).json({ success: false, message: 'Invalid tournament mode' });
    }

    if (!validFormats.includes(format)) {
      return res.status(400).json({ success: false, message: 'Invalid tournament format' });
    }

    const gameConfigurationError = validateTournamentGameConfiguration(game, mode, format);
    if (gameConfigurationError) {
      return res.status(400).json({ success: false, message: gameConfigurationError });
    }

    if (!Number.isSafeInteger(parsedTotalSlots) || parsedTotalSlots < 4 || parsedTotalSlots > 128) {
      return res.status(400).json({ success: false, message: 'Total slots must be between 4 and 128' });
    }

    if (!Number.isSafeInteger(parsedTeamsPerGroup) || parsedTeamsPerGroup < 2 || parsedTeamsPerGroup > 100) {
      return res.status(400).json({ success: false, message: 'Teams per group must be between 2 and 100' });
    }

    if (parsedTeamsPerGroup > parsedTotalSlots) {
      return res.status(400).json({ success: false, message: 'Teams per group cannot exceed total slots' });
    }

    if (!Number.isSafeInteger(parsedNumberOfGroups) || parsedNumberOfGroups < 1) {
      return res.status(400).json({ success: false, message: 'At least one group is required' });
    }

    const expectedNumberOfGroups = Math.ceil(parsedTotalSlots / parsedTeamsPerGroup);
    if (parsedNumberOfGroups !== expectedNumberOfGroups) {
      return res.status(400).json({
        success: false,
        message: `Number of groups must be ${expectedNumberOfGroups} for this slot configuration`
      });
    }

    if (!Number.isSafeInteger(totalRounds) || totalRounds < 1 || totalRounds > 10) {
      return res.status(400).json({ success: false, message: 'Total rounds must be between 1 and 10' });
    }

    if (!['with_prize', 'without_prize'].includes(normalizedPrizePoolType)) {
      return res.status(400).json({ success: false, message: 'Invalid tournament prize type' });
    }

    // Persist absolute UTC instants. Browser datetime-local values carry no
    // offset, so interpret them in the explicit tournament timezone instead
    // of the ECS container timezone. ISO values with Z/offset remain as-is.
    const now = new Date();
    const canonicalTimezone = normalizeTournamentTimezone(timezone || 'UTC');
    if (!canonicalTimezone) {
      return res.status(400).json({ success: false, message: 'Invalid tournament timezone' });
    }

    // Legacy clients use startDate/endDate for the tournament itself. They
    // must never also become registrationStartDate: that produced inverted
    // windows whenever registrationDeadline preceded startDate.
    const tourStartInput = tournamentStartDate || startDate;
    const regStartInput = registrationStartDate || now;
    const regEndInput = registrationEndDate || registrationDeadline || new Date(now.getTime() + 86400000);
    const tourStartDefault = new Date(
      (parseTournamentDateTime(regEndInput, canonicalTimezone) || now).getTime() + 86400000
    );
    const tourStartResolvedInput = tourStartInput || tourStartDefault;
    const tourEndDefault = new Date(
      (parseTournamentDateTime(tourStartResolvedInput, canonicalTimezone) || now).getTime() + 86400000
    );
    const tourEndInput = tournamentEndDate || endDate || tourEndDefault;

    const regStart = parseTournamentDateTime(regStartInput, canonicalTimezone);
    const regEnd = parseTournamentDateTime(regEndInput, canonicalTimezone);
    const tourStart = parseTournamentDateTime(tourStartResolvedInput, canonicalTimezone);
    const tourEnd = parseTournamentDateTime(tourEndInput, canonicalTimezone);

    if ([regStart, regEnd, tourStart, tourEnd].some(date => !date)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid tournament date'
      });
    }

    if (regEnd <= regStart) {
      return res.status(400).json({
        success: false,
        message: 'Registration end date must be after registration start date'
      });
    }

    if (tourStart < regEnd) {
      return res.status(400).json({
        success: false,
        message: 'Tournament start date must be after registration ends'
      });
    }

    if (tourEnd <= tourStart) {
      return res.status(400).json({
        success: false,
        message: 'Tournament end date must be after start date'
      });
    }

    const hostPermissions = await getFreshHostPermissions(hostId);
    if (!hostPermissions.exists) {
      return res.status(401).json({
        success: false,
        message: 'Authenticated user not found'
      });
    }

    createLock = hostPermissions.isVerifiedHost
      ? null
      : await acquireHostTournamentCreateLock(hostId);
    if (createLock === false) {
      return res.status(409).json({
        success: false,
        message: 'A tournament creation request is already in progress. Please wait a moment and try again.'
      });
    }

    // Enforce isVerifiedHost for prize pool tournaments using fresh DB state.
    if (normalizedPrizePoolType === 'with_prize' && hostPermissions.isVerifiedHost !== true) {
      await releaseHostTournamentCreateLock(createLock);
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to host prize pool tournaments. Please apply for Verified Host status.'
      });
    }

    // Normal users can host only one active fun tournament at a time.
    if (!hostPermissions.isVerifiedHost) {
      const activeTournament = await getActiveTournamentForHost(hostId);
      if (activeTournament) {
        await releaseHostTournamentCreateLock(createLock);
        return res.status(409).json({
          success: false,
          message: 'You already have an active tournament. Complete or cancel it before creating another one.',
          limitType: 'active_tournament',
          activeTournamentId: activeTournament._id,
          upgradeMessage: 'Get Verified Host status to host unlimited tournaments.'
        });
      }
    }

    // Validate prize pool for prize tournaments
    if (normalizedPrizePoolType === 'with_prize'
      && (!isSafeTournamentMoney(parsedPrizePool) || parsedPrizePool < 100)) {
      await releaseHostTournamentCreateLock(createLock);
      return res.status(400).json({
        success: false,
        message: 'Prize pool must be at least ₹100 for prize tournaments'
      });
    }

    const prizeConfig = normalizeAndValidatePrizes({
      type: normalizedPrizePoolType,
      pool: parsedPrizePool,
      distribution: prizeDistribution || [],
      special: specialPrizes || []
    });
    if (prizeConfig.error) {
      await releaseHostTournamentCreateLock(createLock);
      return res.status(400).json({ success: false, message: prizeConfig.error });
    }

    const bannerUpload = req.file
      ? await uploadImage(req.file, 'gaming-social/tournaments', { width: 1600, height: 900 })
      : null;
    newBannerPublicId = bannerUpload?.publicId || null;

    // Create tournament
    const tournamentData = {
      name,
      description,
      game,
      mode: mode || null,
      format,
      registrationStartDate: regStart,
      registrationEndDate: regEnd,
      tournamentStartDate: tourStart,
      tournamentEndDate: tourEnd,
      startDate: tourStart,
      endDate: tourEnd,
      registrationDeadline: regEnd,
      location: location || 'Online',
      timezone: canonicalTimezone,
      prizePool: normalizedPrizePoolType === 'with_prize' ? parsedPrizePool : 0,
      totalSlots: parsedTotalSlots,
      teamsPerGroup: parsedTeamsPerGroup,
      numberOfGroups: parsedNumberOfGroups,
      totalRounds: totalRounds,
      prizePoolType: normalizedPrizePoolType,
      prizePoolCurrency: prizePoolCurrency || 'INR',
      prizeDistribution: prizeConfig.distribution,
      specialPrizes: prizeConfig.special,
      host: hostId,
      banner: bannerUpload?.url || null,
      bannerPublicId: newBannerPublicId,
      rules: rules ? rules.split(',').map(rule => rule.trim()) : [],
      status: now >= regStart && now <= regEnd ? 'Registration Open' : 'Upcoming'
    };

    const tournament = new Tournament(tournamentData);
    let activeTournamentReserved = false;
    if (!hostPermissions.isVerifiedHost) {
      const reservation = await reserveHostActiveTournament(hostId, tournament._id);
      if (!reservation.ok) {
        await releaseHostTournamentCreateLock(createLock);
        if (newBannerPublicId) {
          await deleteFile(newBannerPublicId).catch(() => {});
          newBannerPublicId = null;
        }
        return res.status(409).json({
          success: false,
          message: 'You already have an active tournament. Complete or cancel it before creating another one.',
          limitType: 'active_tournament',
          activeTournamentId: reservation.activeTournament?._id,
          upgradeMessage: 'Get Verified Host status to host unlimited tournaments.'
        });
      }
      activeTournamentReserved = true;
      reservedTournamentId = tournament._id;
    }
    
    // Calculate number of groups based on totalSlots and teamsPerGroup
    const calculatedGroups = parsedNumberOfGroups;
    if (process.env.NODE_ENV === 'development') { console.log('Creating tournament with:', { totalSlots, teamsPerGroup, calculatedGroups, totalRounds });
    }
    // Create groups only for Round 1 initially
    const groups = [];
    for (let i = 0; i < calculatedGroups; i++) {
      groups.push({
        name: `Group ${alphabeticGroupLabel(i)}`,
        round: 1,
        groupLetter: alphabeticGroupLabel(i),
        participants: [],
        broadcastChannelId: null
      });
    }
    if (process.env.NODE_ENV === 'development') { console.log('Created Round 1 groups:', groups);
    }
    tournament.groups = groups;
    // Create broadcast channels only for Round 1
    const broadcastChannels = [];
    for (let i = 0; i < calculatedGroups; i++) {
      const channelName = `Group ${alphabeticGroupLabel(i)} - Round 1`;
      broadcastChannels.push({
        name: channelName,
        type: 'Text Messages',
        description: `Broadcast channel for Group ${alphabeticGroupLabel(i)} in Round 1`,
        round: 1,
        groupId: tournament.groups[i]._id,
        channelId: null
      });
    }
    if (process.env.NODE_ENV === 'development') { console.log('Created Round 1 broadcast channels:', broadcastChannels);
    }
    // Update tournament with groups and broadcast channels
    tournament.broadcastChannels = broadcastChannels;
    try {
      await tournament.save();
      tournamentSaved = true;
    } catch (saveError) {
      if (activeTournamentReserved) {
        await releaseHostActiveTournament(hostId, tournament._id);
      }
      throw saveError;
    } finally {
      await releaseHostTournamentCreateLock(createLock);
    }
    if (process.env.NODE_ENV === 'development') { console.log('Tournament saved with groups and channels');
    }
    // Populate host info
    await tournament.populate('host', 'username profile.displayName profile.avatar');

    // Process tournament to ensure banner URL is correct
    const processedTournament = withViewerTournamentContext(
      processTournament(tournament),
      tournament,
      req.user._id,
      [],
      req.user.userType || null
    );

    res.status(201).json({
      success: true,
      message: 'Tournament created successfully with groups and broadcast channels',
      data: {
        tournament: processedTournament
      }
    });
  } catch (error) {
    log.error('Tournament creation error:', { error: String(error) });

    if (!tournamentSaved && reservedTournamentId && req.user?._id) {
      await releaseHostActiveTournament(req.user._id, reservedTournamentId).catch(() => {});
    }
    await releaseHostTournamentCreateLock(createLock).catch(() => {});

    if (!tournamentSaved && newBannerPublicId) {
      await deleteFile(newBannerPublicId).catch((cleanupError) => {
        log.warn('[createTournament] Failed to remove unsuccessful S3 upload', { error: String(cleanupError) });
      });
    }

    if (error instanceof multer.MulterError || error?.message === 'Only image files are allowed') {
      return sendTournamentUploadError(res, error);
    }
    
    return sendTournamentPersistenceError(res, error, 'Failed to create tournament');
  }
};

// Get all tournaments
const getTournaments = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    // Mobile intentionally requests 200 records for its summary counts. Keep
    // that supported while preventing unbounded public aggregation requests.
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const skip = (page - 1) * limit;

    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const game = typeof req.query.game === 'string' ? req.query.game.trim() : '';
    const format = typeof req.query.format === 'string' ? req.query.format.trim() : '';
    const filter = typeof req.query.filter === 'string' ? req.query.filter.trim() : '';
    const allowedStatuses = new Set(['Upcoming', 'Registration Open', 'Ongoing', 'Completed', 'Cancelled']);
    const allowedGames = new Set(['BGMI', 'Valorant', 'Free Fire', 'Call of Duty Mobile']);
    const allowedFormats = new Set(['Solo', 'Duo', 'Squad', '5v5']);
    const allowedFilters = new Set(['upcoming', 'recent', 'completed', 'hosted', 'participating', 'all']);
    if ((req.query.status !== undefined && (typeof req.query.status !== 'string' || (status && !allowedStatuses.has(status)))) ||
        (req.query.game !== undefined && (typeof req.query.game !== 'string' || (game && !allowedGames.has(game)))) ||
        (req.query.format !== undefined && (typeof req.query.format !== 'string' || (format && !allowedFormats.has(format)))) ||
        (req.query.filter !== undefined && (typeof req.query.filter !== 'string' || (filter && !allowedFilters.has(filter))))) {
      return res.status(400).json({ success: false, message: 'Invalid tournament filter' });
    }
    const search = normalizeQuerySearch(
      req.query.search !== undefined ? req.query.search : req.query.q
    );
    const viewerUserId = req.user?.userType === 'guest' ? null : (req.user?._id || req.user?.id);
    const {
      activeTeamIds: viewerTeamIds,
      generatedDuoTeamIds: viewerGeneratedDuoTeamIds
    } = viewerUserId
      ? await getActiveTeamWithdrawalContextForUser(viewerUserId)
      : { activeTeamIds: [], generatedDuoTeamIds: [] };

    // Build filter object
    const queryFilter = {};
    const now = new Date();

    // Handle special filter for "recent" or "completed" tournaments
    if (filter === 'upcoming') {
      // The Web Upcoming tab uses `filter=upcoming`. Apply the canonical
      // registration-start window rather than relying on the legacy status,
      // which may remain Upcoming after registration has already opened.
      Object.assign(queryFilter, upcomingWindowQuery(now));
    } else if (filter === 'recent') {
      // Show completed tournaments from last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      queryFilter.$and = [
        completedWindowQuery(now),
        {
          $or: [
            { tournamentEndDate: { $gte: thirtyDaysAgo } },
            { tournamentEndDate: null, endDate: { $gte: thirtyDaysAgo } }
          ]
        }
      ];
    } else if (filter === 'completed') {
      Object.assign(queryFilter, completedWindowQuery(now));
    } else if (filter === 'hosted') {
      // Filter tournaments hosted by the authenticated user
      const userId = viewerUserId;
      if (userId) {
        queryFilter.host = userId;
      } else {
        queryFilter._id = { $exists: false };
      }
    } else if (filter === 'participating') {
      // Filter tournaments where user is participating
      const userId = viewerUserId;
      if (userId) {
        queryFilter.$or = [
          { participants: userId },
          { teams: { $in: [userId, ...viewerTeamIds] } }
        ];
      } else {
        queryFilter._id = { $exists: false };
      }
    } else if (filter === 'all') {
      // For "all", exclude old completed tournaments (older than 30 days) and cancelled
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      queryFilter.$and = [
        { status: { $in: [...ACTIVE_TOURNAMENT_STATUSES, 'Completed'] } },
        {
          $or: [
            { tournamentEndDate: { $gte: thirtyDaysAgo } },
            { tournamentEndDate: null, endDate: { $gte: thirtyDaysAgo } },
            { tournamentEndDate: null, endDate: null }
          ]
        }
      ];
    } else if (status) {
      queryFilter.status = status;
      // Registration availability is date-derived and may be open while a
      // legacy row still carries `Upcoming`. Match the same policy used by
      // detail metadata and the join command.
      if (status === 'Registration Open') {
        const windowQuery = registrationWindowQuery(now);
        queryFilter.status = windowQuery.status;
        queryFilter.$and = windowQuery.$and;
      } else if (status === 'Ongoing') {
        Object.keys(queryFilter).forEach((key) => delete queryFilter[key]);
        Object.assign(queryFilter, ongoingWindowQuery(now));
      } else if (status === 'Completed') {
        Object.keys(queryFilter).forEach((key) => delete queryFilter[key]);
        Object.assign(queryFilter, completedWindowQuery(now));
      } else if (status === 'Upcoming') {
        Object.assign(queryFilter, upcomingWindowQuery(now));
      }
    }
    
    if (game) queryFilter.game = game;
    if (format) queryFilter.format = format;

    if (search) {
      const pattern = buildPrefixRegex(search);
      const searchCondition = {
        $or: [
          { name: { $regex: pattern, $options: 'i' } },
          { description: { $regex: pattern, $options: 'i' } },
          { game: { $regex: pattern, $options: 'i' } },
          { mode: { $regex: pattern, $options: 'i' } },
          { format: { $regex: pattern, $options: 'i' } },
          { tournamentCode: { $regex: pattern, $options: 'i' } },
        ],
      };
      // If $or already exists from filter, merge using $and
      if (queryFilter.$or) {
        const existingOr = queryFilter.$or;
        delete queryFilter.$or;
        queryFilter.$and = [
          { $or: existingOr },
          searchCondition
        ];
      } else {
        queryFilter.$or = searchCondition.$or;
      }
    }

    // Public discovery excludes tournaments whose owner is missing or no
    // longer active. Constraining before pagination keeps page totals aligned
    // instead of filtering null populated hosts after the query.
    const publicQueryFilter = await constrainToActiveTournamentHosts(queryFilter);
    let tournaments = await Tournament.find(publicQueryFilter)
      .select(PUBLIC_TOURNAMENT_SELECT)
      .populate(PUBLIC_HOST_POPULATE)
      .populate(PUBLIC_PARTICIPANT_POPULATE)
      .populate(PUBLIC_TEAM_POPULATE)
      .sort(filter === 'recent' || filter === 'completed' ? { endDate: -1 } : { startDate: -1 }) // Sort by end date for completed, start date for others
      .skip(skip)
      .limit(limit);

    // Auto-mark tournaments as Completed if endDate has passed
    // Also auto-close registration if deadline has passed
    const tournamentsToUpdate = [];
    // now is already declared above
    
    for (let tournament of tournaments) {
      const beforeStatus = tournament.status;
      
      // Check if tournament should be marked as Completed
      await checkAndMarkCompletedTournaments(tournament);
      if (tournament.status !== beforeStatus) {
        tournamentsToUpdate.push(tournament._id);
      }
    }
    
    // If any tournaments were updated, refresh the query
    if (tournamentsToUpdate.length > 0) {
      // Rebuild query filter to exclude tournaments that no longer match
      const refreshedFilter = { ...publicQueryFilter };
      if (refreshedFilter.status === 'Registration Open') {
        refreshedFilter.registrationDeadline = { $gte: now };
      }
      
      tournaments = await Tournament.find(refreshedFilter)
        .select(PUBLIC_TOURNAMENT_SELECT)
        .populate(PUBLIC_HOST_POPULATE)
        .populate(PUBLIC_PARTICIPANT_POPULATE)
        .populate(PUBLIC_TEAM_POPULATE)
        .sort(filter === 'recent' || filter === 'completed' ? { endDate: -1 } : { startDate: -1 })
        .skip(skip)
        .limit(limit);
    }
    
    // Final filter: Remove tournaments from results if they don't match the criteria
    // This handles cases where status changed after initial query
    let finalTournaments = tournaments;
    if (status === 'Registration Open') {
      finalTournaments = tournaments.filter(tournament => {
        const end = new Date(tournament.tournamentEndDate || tournament.endDate || 0);
        return isTournamentRegistrationOpen(tournament, now)
          && !Number.isNaN(end.getTime())
          && end >= now;
      });
    } else if (status === 'Ongoing') {
      finalTournaments = tournaments.filter(
        (tournament) => getTournamentPhase(tournament, now) === 'Ongoing'
      );
    } else if (status === 'Completed' || filter === 'completed' || filter === 'recent') {
      finalTournaments = tournaments.filter(
        (tournament) => getTournamentPhase(tournament, now) === 'Completed'
      );
    }
    
    // Use final filtered tournaments
    const tournamentsToReturn = finalTournaments;
    
    const total = await Tournament.countDocuments(publicQueryFilter);

    // Process tournaments to convert banner filenames to URLs
    const processedTournaments = tournamentsToReturn.map((tournament) => {
      const safeTournament = sanitizePublicTournament(processTournament(tournament));
      return withViewerTournamentContext(
        safeTournament,
        tournament,
        viewerUserId,
        viewerTeamIds,
        req.user?.userType || null,
        now,
        viewerGeneratedDuoTeamIds
      );
    });

    res.status(200).json({
      success: true,
      data: {
        tournaments: processedTournaments,
        pagination: {
          current: page,
          total: Math.ceil(total / limit),
          count: processedTournaments.length,
          totalTournaments: total
        }
      }
    });

  } catch (error) {
    console.error("GET TOURNAMENTS ERROR:", error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tournaments',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get single tournament (by ID or code)
const getTournament = async (req, res) => {
  try {
    // Support both :id and :code route parameters
    const id = req.params.id || req.params.code;
    const isCodeRoute = !!req.params.code; // If :code param exists, it's the shareable link route

    let tournament;
    const mongoose = require('mongoose');
    
    // If it's the /code/:code route, ONLY search by code (no ID fallback)
    if (isCodeRoute) {
      // Shareable link route - must be a code
      // Trim and ensure uppercase for consistency
      const codeToSearch = id.trim().toUpperCase();
      tournament = await hydratePublicTournamentQuery(
        Tournament.findOne({ tournamentCode: codeToSearch })
      );
    } else {
      // Regular route - can be either code or ID
      // Check if it's a code format: TRN-XXX-XXXXXXXX (contains dashes)
      if (isTournamentCode(id)) {
        // Looks like a tournament code (format: TRN-BGM-A1B2C3D4)
        tournament = await hydratePublicTournamentQuery(
          Tournament.findOne({ tournamentCode: id.toUpperCase() })
        );
        
        // Don't try findById if it's a code format - it will fail with CastError
      } else if (id && mongoose.Types.ObjectId.isValid(id)) {
        // Try as MongoDB ObjectId (only if it's a valid ObjectId format)
        tournament = await hydratePublicTournamentQuery(Tournament.findById(id));
      }
    }

    if (!tournament?.host) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found. The link may be invalid or the tournament has been removed.'
      });
    }

    // Auto-mark as Completed if endDate has passed
    await checkAndMarkCompletedTournaments(tournament);
    
    // Refresh tournament from DB to get updated status
    tournament = await hydratePublicTournamentQuery(Tournament.findById(tournament._id));
    if (!tournament?.host) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found. The host account is no longer active.'
      });
    }

    // If tournament doesn't have a code yet (old posts), generate one
    if (!tournament.tournamentCode) {
      const prefix = 'TRN';
      let gameAbbr = '';
      if (tournament.game) {
        const gameMap = {
          'BGMI': 'BGM',
          'Valorant': 'VAL',
          'Free Fire': 'FF',
          'Call of Duty Mobile': 'COD',
          'CS:GO': 'CSG',
          'Fortnite': 'FTN',
          'Apex Legends': 'APX',
          'League of Legends': 'LOL',
          'Dota 2': 'DOT'
        };
        gameAbbr = gameMap[tournament.game] || tournament.game.substring(0, 3).toUpperCase().replace(/\s/g, '');
      } else {
        gameAbbr = 'GEN';
      }
      const crypto = require('crypto');
      const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase();
      tournament.tournamentCode = `${prefix}-${gameAbbr}-${randomPart}`.toUpperCase();
      await Tournament.updateOne(
        { _id: tournament._id },
        { $set: { tournamentCode: tournament.tournamentCode } }
      );
    }

    // Process tournament to convert banner filename to URL and attach only
    // viewer-specific participation facts. Roster/staff membership remains
    // private and is evaluated server-side.
    const viewerUserId = req.user?.userType === 'guest' ? null : (req.user?._id || req.user?.id);
    const {
      activeTeamIds: viewerTeamIds,
      generatedDuoTeamIds: viewerGeneratedDuoTeamIds
    } = viewerUserId
      ? await getActiveTeamWithdrawalContextForUser(viewerUserId)
      : { activeTeamIds: [], generatedDuoTeamIds: [] };
    let processedTournament = withViewerTournamentContext(
      sanitizePublicTournament(processTournament(tournament)),
      tournament,
      viewerUserId,
      viewerTeamIds,
      req.user?.userType || null,
      new Date(),
      viewerGeneratedDuoTeamIds
    );
    if (processedTournament.viewerRole === 'host' || processedTournament.viewerParticipation === true) {
      const messageState = await loadTournamentMessageState(tournament._id);
      processedTournament = attachViewerMessageHistory(
        processedTournament,
        tournament,
        messageState,
        viewerUserId
      );
    }

    res.status(200).json({
      success: true,
      data: {
        tournament: processedTournament
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tournament',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get tournament by name and host username
const getTournamentByName = async (req, res) => {
  try {
    const { tournamentName, hostUsername } = req.params;
    
    if (process.env.NODE_ENV === 'development') { console.log('getTournamentByName - Request params:', { tournamentName, hostUsername });}
    log.debug('getTournamentByName - Decoded params:', {
      tournamentName,
      hostUsername
    });

    // Express already decodes route parameters. Decoding again corrupts valid
    // percent characters and can throw URIError for otherwise valid names.
    const host = await User.findOne({ username: hostUsername, isActive: true })
      .select('_id')
      .lean();
    if (!host) {
      return res.status(404).json({ success: false, message: 'Tournament not found' });
    }

    // Tournament.host is an ObjectId reference; querying host.username on the
    // tournament document silently returned no records for this public route.
    const tournament = await hydratePublicTournamentQuery(Tournament.findOne({
      name: tournamentName,
      host: host._id
    }));

    if (process.env.NODE_ENV === 'development') { console.log('getTournamentByName - Tournament found:', !!tournament);}
    if (tournament) {
      if (process.env.NODE_ENV === 'development') { console.log('getTournamentByName - Tournament ID:', tournament._id);}
      if (process.env.NODE_ENV === 'development') { console.log('getTournamentByName - Tournament name:', tournament.name);}
    }

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Process tournament to convert banner filename to URL.
    const viewerUserId = req.user?.userType === 'guest' ? null : (req.user?._id || req.user?.id);
    const {
      activeTeamIds: viewerTeamIds,
      generatedDuoTeamIds: viewerGeneratedDuoTeamIds
    } = viewerUserId
      ? await getActiveTeamWithdrawalContextForUser(viewerUserId)
      : { activeTeamIds: [], generatedDuoTeamIds: [] };
    let processedTournament = withViewerTournamentContext(
      sanitizePublicTournament(processTournament(tournament)),
      tournament,
      viewerUserId,
      viewerTeamIds,
      req.user?.userType || null,
      new Date(),
      viewerGeneratedDuoTeamIds
    );
    if (processedTournament.viewerRole === 'host' || processedTournament.viewerParticipation === true) {
      const messageState = await loadTournamentMessageState(tournament._id);
      processedTournament = attachViewerMessageHistory(
        processedTournament,
        tournament,
        messageState,
        viewerUserId
      );
    }

    res.status(200).json({
      success: true,
      data: {
        tournament: processedTournament
      }
    });

  } catch (error) {
    log.error('getTournamentByName - Error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tournament',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Update tournament
const updateTournament = async (req, res) => {
  try {
    upload(req, res, async (err) => {
      if (err) {
        return sendTournamentUploadError(res, err);
      }

      let newBannerPublicId = null;
      try {
        let tournament = await Tournament.findById(req.params.id).select('+bannerPublicId');

        if (!tournament) {
          return res.status(404).json({
            success: false,
            message: 'Tournament not found'
          });
        }

        // Check if user is the host
        if (tournament.host.toString() !== req.user._id.toString()) {
          return res.status(403).json({
            success: false,
            message: 'Only tournament host can update tournament'
          });
        }

        // Auto-mark as Completed if endDate has passed
        await checkAndMarkCompletedTournaments(tournament);
        
        // Refresh tournament from DB to get updated status
        tournament = await Tournament.findById(req.params.id).select('+bannerPublicId');
        const registrationWasOpen = getTournamentPhase(tournament) === 'Registration Open';

        // Check if tournament can be edited (within 5 days of end if completed)
        if (!canEditTournament(tournament)) {
          return res.status(400).json({
            success: false,
            message: 'Cannot update tournament. Tournament has ended and the 5-day editing period has expired.'
          });
        }

        const rawRemoveBanner = req.body.removeBanner;
        const removeBanner = rawRemoveBanner === true
          || rawRemoveBanner === 'true'
          || rawRemoveBanner === '1';
        const validRemoveBanner = rawRemoveBanner === undefined
          || rawRemoveBanner === true
          || rawRemoveBanner === false
          || ['true', 'false', '1', '0'].includes(rawRemoveBanner);
        if (!validRemoveBanner || (removeBanner && req.file)) {
          return res.status(400).json({
            success: false,
            message: removeBanner && req.file
              ? 'Upload a replacement banner or remove the current banner, not both'
              : 'removeBanner must be a boolean'
          });
        }

        // Whitelist allowed fields to prevent injection of protected fields
        const allowedUpdateFields = [
          'name', 'description', 'game', 'format', 'mode', 'status',
          'registrationStartDate', 'registrationEndDate', 'tournamentStartDate', 'tournamentEndDate',
          'startDate', 'endDate', 'registrationDeadline', 'location', 'timezone',
          'prizePool', 'prizePoolCurrency', 'totalSlots', 'teamsPerGroup',
          'numberOfGroups', 'totalRounds', 'prizePoolType', 'prizeDistribution', 'specialPrizes', 'rules'
        ];
        const updateData = {};
        allowedUpdateFields.forEach(field => {
          if (req.body[field] !== undefined) {
            updateData[field] = req.body[field];
          }
        });

        const stringFields = [
          'name', 'description', 'game', 'format', 'status', 'location',
          'timezone', 'prizePoolCurrency', 'prizePoolType'
        ];
        const invalidStringField = stringFields.find(
          (field) => updateData[field] !== undefined && typeof updateData[field] !== 'string'
        );
        if (invalidStringField
          || (updateData.mode !== undefined && updateData.mode !== null && typeof updateData.mode !== 'string')) {
          return res.status(400).json({ success: false, message: 'Invalid tournament field type' });
        }
        const invalidRules = updateData.rules !== undefined
          && typeof updateData.rules !== 'string'
          && (!Array.isArray(updateData.rules) || updateData.rules.some((rule) => typeof rule !== 'string'));
        if (invalidRules) {
          return res.status(400).json({ success: false, message: 'Tournament rules must be text values' });
        }
        const rulesLength = Array.isArray(updateData.rules)
          ? updateData.rules.join(',').length
          : String(updateData.rules || '').length;
        if ((updateData.name && updateData.name.length > 200)
          || (updateData.description && updateData.description.length > 5000)
          || rulesLength > 10000
          || (updateData.location && updateData.location.length > 200)
          || (updateData.timezone && updateData.timezone.length > 100)) {
          return res.status(400).json({ success: false, message: 'Tournament field exceeds the allowed length' });
        }
        
        // The body can never select a server-side object key or URL.
        const oldBannerPath = req.file || removeBanner
          ? localTournamentBannerPath(tournament.banner)
          : null;
        const oldBannerPublicId = tournament.bannerPublicId || null;

        // Handle rules if it's a string (comma-separated)
        if (updateData.rules !== undefined && typeof updateData.rules === 'string') {
          updateData.rules = updateData.rules.split(',').map(rule => rule.trim()).filter(rule => rule);
        }

        const validGames = ['BGMI', 'Valorant', 'Free Fire', 'Call of Duty Mobile'];
        const validModes = ['Battle Royale', 'Deathmatch', '5v5', 'Solo'];
        const validFormats = ['Solo', 'Duo', 'Squad', '5v5'];
        const validStatuses = ['Upcoming', 'Registration Open', 'Ongoing', 'Completed', 'Cancelled'];
        const validPrizeCurrencies = ['INR', 'USD', 'EUR', 'GBP'];
        if (updateData.name !== undefined && String(updateData.name).trim().length < 3) {
          return res.status(400).json({ success: false, message: 'Tournament name must be at least 3 characters' });
        }
        if (updateData.description !== undefined && String(updateData.description).trim().length < 10) {
          return res.status(400).json({ success: false, message: 'Tournament description must be at least 10 characters' });
        }
        if (updateData.game !== undefined && !validGames.includes(updateData.game)) {
          return res.status(400).json({ success: false, message: 'Invalid tournament game' });
        }
        if (updateData.mode !== undefined && updateData.mode && !validModes.includes(updateData.mode)) {
          return res.status(400).json({ success: false, message: 'Invalid tournament mode' });
        }
        if (updateData.format !== undefined && !validFormats.includes(updateData.format)) {
          return res.status(400).json({ success: false, message: 'Invalid tournament format' });
        }
        const nextGame = updateData.game ?? tournament.game;
        const nextMode = updateData.mode ?? tournament.mode;
        const rawNextFormat = updateData.format ?? tournament.format;
        const nextFormat = rawNextFormat === 'Squadh' ? 'Squad' : rawNextFormat;
        const gameConfigurationError = validateTournamentGameConfiguration(nextGame, nextMode, nextFormat);
        if (gameConfigurationError) {
          return res.status(400).json({ success: false, message: gameConfigurationError });
        }
        if (updateData.status !== undefined && !validStatuses.includes(updateData.status)) {
          return res.status(400).json({ success: false, message: 'Invalid tournament status' });
        }
        if (updateData.prizePoolCurrency !== undefined
          && !validPrizeCurrencies.includes(updateData.prizePoolCurrency)) {
          return res.status(400).json({ success: false, message: 'Invalid prize pool currency' });
        }
        const allowedStatusTransitions = {
          Upcoming: new Set(['Upcoming', 'Registration Open', 'Cancelled']),
          'Registration Open': new Set(['Registration Open', 'Ongoing', 'Cancelled']),
          Ongoing: new Set(['Ongoing', 'Completed', 'Cancelled']),
          Completed: new Set(['Completed']),
          Cancelled: new Set(['Cancelled'])
        };
        if (updateData.status !== undefined
          && !allowedStatusTransitions[tournament.status]?.has(updateData.status)) {
          return res.status(409).json({
            success: false,
            message: `Tournament status cannot change from ${tournament.status} to ${updateData.status}`
          });
        }
        if (updateData.status === 'Completed' && !tournament.finalResult?.generatedAt) {
          return res.status(409).json({
            success: false,
            message: 'Generate complete final standings before marking the tournament Completed'
          });
        }
        if (['Completed', 'Cancelled'].includes(tournament.status)
          && updateData.status !== undefined
          && updateData.status !== tournament.status) {
          return res.status(409).json({
            success: false,
            message: `A ${tournament.status.toLowerCase()} tournament cannot be reopened`
          });
        }
        const nextTotalSlots = updateData.totalSlots !== undefined ? Number(updateData.totalSlots) : tournament.totalSlots;
        const nextTeamsPerGroup = updateData.teamsPerGroup !== undefined ? Number(updateData.teamsPerGroup) : tournament.teamsPerGroup;
        const nextTotalRounds = updateData.totalRounds !== undefined ? Number(updateData.totalRounds) : tournament.totalRounds;
        if (!Number.isSafeInteger(nextTotalSlots) || nextTotalSlots < 4 || nextTotalSlots > 128) {
          return res.status(400).json({ success: false, message: 'Total slots must be between 4 and 128' });
        }
        if (!Number.isSafeInteger(nextTeamsPerGroup) || nextTeamsPerGroup < 2 || nextTeamsPerGroup > 100) {
          return res.status(400).json({ success: false, message: 'Teams per group must be between 2 and 100' });
        }
        if (nextTeamsPerGroup > nextTotalSlots) {
          return res.status(400).json({ success: false, message: 'Teams per group cannot exceed total slots' });
        }
        if (!Number.isSafeInteger(nextTotalRounds) || nextTotalRounds < 1 || nextTotalRounds > 10) {
          return res.status(400).json({ success: false, message: 'Total rounds must be between 1 and 10' });
        }
        const nextPrizePool = updateData.prizePool !== undefined
          ? Number(updateData.prizePool)
          : (tournament.prizePool || 0);
        const nextNumberOfGroups = updateData.numberOfGroups !== undefined
          ? Number(updateData.numberOfGroups)
          : Math.ceil(nextTotalSlots / nextTeamsPerGroup);
        if (!Number.isSafeInteger(nextNumberOfGroups) || nextNumberOfGroups < 1) {
          return res.status(400).json({ success: false, message: 'At least one group is required' });
        }
        const nextPrizePoolType = normalizePrizePoolType(updateData.prizePoolType || tournament.prizePoolType);
        if (!['with_prize', 'without_prize'].includes(nextPrizePoolType)) {
          return res.status(400).json({ success: false, message: 'Invalid tournament prize type' });
        }
        updateData.prizePoolType = nextPrizePoolType;
        const hostPermissions = await getFreshHostPermissions(req.user._id);
        if (nextPrizePoolType === 'with_prize' && hostPermissions.isVerifiedHost !== true) {
          return res.status(403).json({
            success: false,
            message: 'You are not authorized to host prize pool tournaments. Please apply for Verified Host status.'
          });
        }
        if (nextPrizePoolType === 'with_prize'
          && (!isSafeTournamentMoney(nextPrizePool) || nextPrizePool < 100)) {
          return res.status(400).json({ success: false, message: 'Prize pool must be at least ₹100 for prize tournaments' });
        }

        const canonicalTimezone = normalizeTournamentTimezone(
          updateData.timezone || tournament.timezone || 'UTC'
        );
        if (!canonicalTimezone) {
          return res.status(400).json({ success: false, message: 'Invalid tournament timezone' });
        }
        let nextRegEnd = parseTournamentDateTime(
          updateData.registrationEndDate || updateData.registrationDeadline
            || tournament.registrationEndDate || tournament.registrationDeadline,
          canonicalTimezone
        );
        let nextRegStart = parseTournamentDateTime(
          updateData.registrationStartDate || tournament.registrationStartDate,
          canonicalTimezone
        );
        // Historical rows sometimes predate registrationStartDate. Preserve an
        // explicit invalid edit as an error, but repair an absent legacy value
        // deterministically from createdAt, bounded strictly before reg-end.
        if (!nextRegStart
          && updateData.registrationStartDate === undefined
          && !tournament.registrationStartDate
          && nextRegEnd) {
          const createdAt = parseTournamentDateTime(tournament.createdAt, canonicalTimezone);
          nextRegStart = createdAt && createdAt < nextRegEnd
            ? createdAt
            : new Date(nextRegEnd.getTime() - 60_000);
        }
        const nextTourStart = parseTournamentDateTime(
          updateData.tournamentStartDate || updateData.startDate
            || tournament.tournamentStartDate || tournament.startDate,
          canonicalTimezone
        );
        const nextTourEnd = parseTournamentDateTime(
          updateData.tournamentEndDate || updateData.endDate
            || tournament.tournamentEndDate || tournament.endDate,
          canonicalTimezone
        );
        if ([nextRegStart, nextRegEnd, nextTourStart, nextTourEnd].some(date => !date)) {
          return res.status(400).json({ success: false, message: 'Invalid tournament date' });
        }
        const opensRegistrationWindow = updateData.status === 'Registration Open'
          && !registrationWasOpen;
        if (opensRegistrationWindow) {
          const now = new Date();
          if (nextTourStart <= now) {
            return res.status(409).json({
              success: false,
              code: 'TOURNAMENT_ALREADY_STARTED',
              message: 'Registration cannot open after the tournament start time'
            });
          }
          // The existing Web management command opens registration by status.
          // Keep that contract useful even when its scheduled window elapsed,
          // while never extending registration beyond tournament start.
          nextRegStart = now;
          if (nextRegEnd <= now || nextRegEnd > nextTourStart) nextRegEnd = nextTourStart;
        }
        if (nextRegEnd <= nextRegStart) {
          return res.status(400).json({ success: false, message: 'Registration end date must be after registration start date' });
        }
        if (nextTourStart < nextRegEnd) {
          return res.status(400).json({ success: false, message: 'Tournament start date must be after registration ends' });
        }
        if (nextTourEnd <= nextTourStart) {
          return res.status(400).json({ success: false, message: 'Tournament end date must be after start date' });
        }

        // Canonical and legacy date fields are still consumed by different
        // Web/Mobile views. Persist them atomically so one edit cannot leave
        // sorting, registration, and schedule generation on stale dates.
        updateData.registrationStartDate = nextRegStart;
        updateData.registrationEndDate = nextRegEnd;
        updateData.registrationDeadline = nextRegEnd;
        updateData.tournamentStartDate = nextTourStart;
        updateData.startDate = nextTourStart;
        updateData.tournamentEndDate = nextTourEnd;
        updateData.endDate = nextTourEnd;
        updateData.timezone = canonicalTimezone;

        const hasCompetitionState = (tournament.participants || []).length > 0
          || (tournament.teams || []).length > 0
          || (tournament.matches || []).length > 0
          || (tournament.groupResults || []).length > 0;
        if (hasCompetitionState) {
          const protectedStructure = {
            game: tournament.game,
            mode: tournament.mode,
            format: tournament.format,
            totalSlots: tournament.totalSlots,
            teamsPerGroup: tournament.teamsPerGroup,
            numberOfGroups: tournament.numberOfGroups,
            totalRounds: tournament.totalRounds,
            prizePoolType: tournament.prizePoolType
          };
          const changedProtectedField = Object.entries(protectedStructure).find(([field, current]) => (
            req.body[field] !== undefined && String(req.body[field]) !== String(current ?? '')
          ));
          if (changedProtectedField) {
            return res.status(409).json({
              success: false,
              message: `${changedProtectedField[0]} cannot change after registration activity begins`
            });
          }
        }
        updateData.totalSlots = nextTotalSlots;
        updateData.teamsPerGroup = nextTeamsPerGroup;
        updateData.numberOfGroups = nextNumberOfGroups;
        updateData.totalRounds = nextTotalRounds;
        updateData.prizePool = nextPrizePoolType === 'with_prize'
          ? nextPrizePool
          : 0;
        const prizeConfig = normalizeAndValidatePrizes({
          type: nextPrizePoolType,
          pool: updateData.prizePool,
          distribution: updateData.prizeDistribution ?? tournament.prizeDistribution ?? [],
          special: updateData.specialPrizes ?? tournament.specialPrizes ?? []
        });
        if (tournament.finalResult?.generatedAt) {
          const immutableAfterPublication = [
            'prizePool', 'prizePoolCurrency', 'prizePoolType', 'prizeDistribution', 'specialPrizes'
          ];
          const changedPublishedField = immutableAfterPublication.find(
            (field) => req.body[field] !== undefined
          );
          if (changedPublishedField) {
            return res.status(409).json({
              success: false,
              message: `${changedPublishedField} cannot change after final results are published`
            });
          }
        }
        if (prizeConfig.error) {
          return res.status(400).json({ success: false, message: prizeConfig.error });
        }
        updateData.prizeDistribution = prizeConfig.distribution;
        updateData.specialPrizes = prizeConfig.special;

        if (req.file) {
          const bannerUpload = await uploadImage(
            req.file,
            'gaming-social/tournaments',
            { width: 1600, height: 900 }
          );
          updateData.banner = bannerUpload.url;
          updateData.bannerPublicId = bannerUpload.publicId;
          newBannerPublicId = bannerUpload.publicId;
        } else if (removeBanner) {
          updateData.banner = null;
          updateData.bannerPublicId = null;
        }

        // Capture original values before update for history propagation
        const originalName = tournament.name;
        const originalStartDate = tournament.tournamentStartDate || tournament.startDate;
        const originalEndDate = tournament.tournamentEndDate || tournament.endDate;
        const originalStatus = tournament.status;

        const updatedTournament = await Tournament.findOneAndUpdate(
          {
            _id: req.params.id,
            status: tournament.status,
            ...(tournament.updatedAt ? { updatedAt: tournament.updatedAt } : {})
          },
          updateData,
          { new: true, runValidators: true }
        ).populate('host', 'username profile.displayName profile.avatar');

        if (!updatedTournament) {
          if (newBannerPublicId) {
            await deleteFile(newBannerPublicId).catch(() => {});
            newBannerPublicId = null;
          }
          return res.status(409).json({
            success: false,
            code: 'TOURNAMENT_UPDATE_CONFLICT',
            message: 'Tournament changed while it was being edited. Refresh and try again.'
          });
        }

        if ((newBannerPublicId || removeBanner)
          && oldBannerPublicId
          && oldBannerPublicId !== newBannerPublicId) {
          await deleteFile(oldBannerPublicId).catch((bannerCleanupError) => {
            log.warn('[updateTournament] Failed to remove previous S3 banner', {
              error: String(bannerCleanupError),
              tournamentId: String(tournament._id)
            });
          });
        }
        // From this point the new object is the committed live banner and must
        // not be removed by compensation for a later, unrelated side effect.
        newBannerPublicId = null;

        // Delete the previous local banner only after the database update has
        // succeeded, and only when it resolves inside the fixed upload root.
        if (oldBannerPath && fs.existsSync(oldBannerPath)) {
          try {
            fs.unlinkSync(oldBannerPath);
          } catch (bannerCleanupError) {
            log.warn('[updateTournament] Failed to remove previous banner', {
              error: String(bannerCleanupError),
              tournamentId: String(tournament._id)
            });
          }
        }

        if (!ACTIVE_TOURNAMENT_STATUSES.includes(updatedTournament.status)) {
          await releaseHostActiveTournament(tournament.host, tournament._id);
        }

        // Propagate relevant field changes to player history (non-blocking)
        try {
          const changedFields = {};
          if (updateData.name !== undefined && updateData.name !== originalName) {
            changedFields.name = updateData.name;
          }
          const newStartDate = updateData.tournamentStartDate || updateData.startDate;
          if (newStartDate !== undefined && String(newStartDate) !== String(originalStartDate)) {
            changedFields.startDate = newStartDate;
          }
          const newEndDate = updateData.tournamentEndDate || updateData.endDate;
          if (newEndDate !== undefined && String(newEndDate) !== String(originalEndDate)) {
            changedFields.endDate = newEndDate;
          }
          if (Object.keys(changedFields).length > 0) {
            await propagateTournamentUpdate(tournament._id, changedFields);
          }
          if (updateData.status !== undefined && updateData.status !== originalStatus) {
            await propagateStatusChange(tournament._id, updatedTournament.status);
          }
        } catch (historyErr) {
          log.error('[updateTournament] Failed to propagate update to player history:', { error: String(historyErr) });
        }

        // Process tournament to convert banner filename to URL
        const processedTournament = withViewerTournamentContext(
          processTournament(updatedTournament),
          updatedTournament,
          req.user._id,
          [],
          req.user.userType || null
        );

        await emitTournamentUpdated(req, updatedTournament._id);

        if (opensRegistrationWindow && updatedTournament.status === 'Registration Open') {
          emitTournamentBroadcast(
            req,
            updatedTournament,
            'registration_opened',
            `Registration opened for "${updatedTournament.name}"! Join now to participate.`
          );
          await enqueueRegistrationOpenedNotifications(updatedTournament).catch((notificationError) => {
            log.error('[updateTournament] Failed to enqueue registration-open notifications', {
              tournamentId: idString(updatedTournament._id),
              error: String(notificationError)
            });
          });
        } else if (originalStatus !== updatedTournament.status && updatedTournament.status === 'Ongoing') {
          emitTournamentBroadcast(
            req,
            updatedTournament,
            'tournament_started',
            `Tournament "${updatedTournament.name}" has started! Good luck to all participants.`,
            [updatedTournament.host, ...(updatedTournament.participants || []), ...(updatedTournament.teams || [])]
          );
          await notifyTournamentRecipients({
            tournament: updatedTournament,
            recipients: [...(updatedTournament.participants || []), ...(updatedTournament.teams || [])],
            sender: req.user._id,
            title: `Tournament Started: ${updatedTournament.name}`,
            message: 'The tournament has started. Check your round, group, and schedule.',
            eventType: 'tournament_started',
            revision: updatedTournament.updatedAt
          });
        } else if (originalStatus !== updatedTournament.status && updatedTournament.status === 'Completed') {
          emitTournamentBroadcast(
            req,
            updatedTournament,
            'tournament_completed',
            `Tournament "${updatedTournament.name}" has ended. Results are available.`,
            [updatedTournament.host, ...(updatedTournament.participants || []), ...(updatedTournament.teams || [])]
          );
        } else if (originalStatus !== updatedTournament.status && updatedTournament.status === 'Cancelled') {
          emitTournamentBroadcast(
            req,
            updatedTournament,
            'tournament_cancelled',
            `Tournament "${updatedTournament.name}" has been cancelled.`,
            [updatedTournament.host, ...(updatedTournament.participants || []), ...(updatedTournament.teams || [])]
          );
          await notifyTournamentRecipients({
            tournament: updatedTournament,
            recipients: [...(updatedTournament.participants || []), ...(updatedTournament.teams || [])],
            sender: req.user._id,
            title: `Tournament Cancelled: ${updatedTournament.name}`,
            message: 'This tournament has been cancelled by the host.',
            eventType: 'tournament_cancelled',
            revision: updatedTournament.updatedAt
          });
        }

        res.status(200).json({
          success: true,
          message: 'Tournament updated successfully',
          data: {
            tournament: processedTournament
          }
        });

      } catch (error) {
        if (newBannerPublicId) {
          await deleteFile(newBannerPublicId).catch((cleanupError) => {
            log.warn('[updateTournament] Failed to compensate unsuccessful S3 upload', {
              error: String(cleanupError),
              tournamentId: String(req.params.id)
            });
          });
        }
        return sendTournamentPersistenceError(res, error, 'Failed to update tournament');
      }
    });
  } catch (error) {
    return sendTournamentPersistenceError(res, error, 'Failed to update tournament');
  }
};

// Join tournament
const joinTournament = async (req, res) => {
  try {
    log.debug('Join tournament request:', {
      tournamentId: req.params.id,
      userId: req.user._id,
      userType: req.user.userType,
      username: req.user.username
    });

    const id = req.params.id;
    const tournament = isTournamentCode(id)
      ? await Tournament.findOne({ tournamentCode: id.toUpperCase() }).select('+entryFee')
      : await Tournament.findById(id).select('+entryFee');

    if (!tournament?.host) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }
    if (!await User.exists({ _id: tournament.host, isActive: true })) {
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_HOST_INACTIVE',
        message: 'Tournament registration is unavailable because the host account is inactive.'
      });
    }

    if (Number(tournament.entryFee) > 0) {
      return res.status(409).json({
        success: false,
        code: 'LEGACY_PAID_TOURNAMENT_REQUIRES_RECONCILIATION',
        message: 'Registration is unavailable while this legacy paid tournament is reconciled.'
      });
    }

    log.debug('Tournament found:', {
      id: tournament._id,
      name: tournament.name,
      status: tournament.status,
      currentParticipants: registeredCountForFormat(tournament),
      totalSlots: tournament.totalSlots
    });

    const registrationNow = new Date();

    // Date-derived registration is authoritative. This also supports a
    // scheduled tournament whose stored legacy status is still `Upcoming`,
    // while preserving a host's explicit early `Registration Open` override.
    if (!isTournamentRegistrationOpen(tournament, registrationNow)) {
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_REGISTRATION_CLOSED',
        message: `Tournament registration is not open. Current status: ${tournament.status}`
      });
    }

    // Check canonical and legacy deadline fields consistently.
    const registrationDeadline = new Date(tournament.registrationEndDate || tournament.registrationDeadline || 0);
    if (Number.isNaN(registrationDeadline.getTime()) || registrationNow > registrationDeadline) {
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_REGISTRATION_CLOSED',
        message: 'Registration deadline has passed'
      });
    }

    const userId = req.user._id;

    if (idString(tournament.host) === idString(userId)) {
      return res.status(400).json({
        success: false,
        message: 'Tournament hosts cannot register as participants'
      });
    }

    // Check if user is already registered
    const isAlreadyRegistered = tournament.participants.some(p => p.toString() === userId.toString()) || 
                               tournament.teams.some(t => t.toString() === userId.toString());

    if (isAlreadyRegistered) {
      return res.status(400).json({
        success: false,
        message: 'You are already registered for this tournament'
      });
    }

    // Check if tournament is full
    const currentParticipants = registeredCountForFormat(tournament);
    if (currentParticipants >= tournament.totalSlots) {
      return res.status(400).json({
        success: false,
        message: 'Tournament is full'
      });
    }

    if (tournament.format === 'Duo') {
      return res.status(400).json({
        success: false,
        message: 'Create a Duo team with one of your followers to join this tournament'
      });
    }

    let registrationField;
    if (tournament.format === 'Solo') {
      if (req.user.userType === 'team') {
        return res.status(400).json({
          success: false,
          message: 'Solo tournaments must be joined from an individual player account.'
        });
      }
      registrationField = 'participants';
    } else if (req.user.userType === 'team') {
      registrationField = 'teams';
    } else {
      return res.status(400).json({
        success: false,
        message: 'Players can only join Solo tournaments directly. Team formats must be joined as a team.'
      });
    }

    // Reserve the slot and registration atomically. A read/push/save sequence
    // can oversubscribe the final slot or acknowledge a lost concurrent write.
    const now = registrationNow;
    const windowQuery = registrationWindowQuery(now);
    const capacityExpression = mongoCapacityUsedExpression(tournament.format);
    const registeredTournament = await Tournament.findOneAndUpdate(
      {
        _id: tournament._id,
        status: windowQuery.status,
        host: { $ne: userId },
        participants: { $ne: userId },
        teams: { $ne: userId },
        $and: [
          ...windowQuery.$and,
          {
            $expr: {
              $lt: [
                capacityExpression,
                '$totalSlots'
              ]
            }
          }
        ]
      },
      { $addToSet: { [registrationField]: userId } },
      { new: true }
    );
    if (!registeredTournament) {
      return res.status(409).json({
        success: false,
        message: 'Registration changed or the tournament became full. Refresh and try again.'
      });
    }

    await emitTournamentUpdated(req, registeredTournament._id);

    // Create the same profile history record for every registration mode.
    try {
      if (req.user.userType === 'team') {
        await createHistoryEntriesForTeam(registeredTournament, req.user);
      } else {
        await createHistoryEntryForPlayer(registeredTournament, req.user._id, {
          teamId: req.user._id,
          teamName: req.user.profile?.displayName || req.user.username || 'Solo'
        });
      }
    } catch (historyErr) {
      log.error('[joinTournament] Failed to create history entries:', { error: String(historyErr) });
      await removeHistoryEntriesForTeam(tournament._id, req.user._id);
    }

    // Send notification to host
    await createAndEmitNotification({
      recipient: tournament.host,
      sender: userId,
      type: 'tournament',
      title: 'New Tournament Registration',
      message: `${req.user.username} has joined your tournament "${tournament.name}"`,
      data: {
        tournamentId: tournament._id,
        customData: { action: 'tournament_join' }
      }
    }).catch((notificationError) => {
      log.error('[joinTournament] Host notification failed after registration commit', {
        error: String(notificationError),
        tournamentId: String(tournament._id)
      });
    });

    res.status(200).json({
      success: true,
      message: 'Successfully joined tournament'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to join tournament',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Canonical Duo registration contract used by the Web and Mobile clients.
// Delegate to the hardened team creation service so all callers share one
// follower, capacity, duplicate, and host-role implementation.
const joinDuoTournament = async (req, res) => {
  const { teamName, teammateId } = req.body || {};
  if (isTournamentCode(req.params.id)) {
    const tournament = await Tournament.findOne({
      tournamentCode: String(req.params.id).toUpperCase()
    }).select('_id +entryFee').lean();
    if (!tournament) {
      return res.status(404).json({ success: false, message: 'Tournament not found' });
    }

    if (Number(tournament.entryFee) > 0) {
      return res.status(409).json({
        success: false,
        code: 'LEGACY_PAID_TOURNAMENT_REQUIRES_RECONCILIATION',
        message: 'Registration is unavailable while this legacy paid tournament is reconciled.'
      });
    }
    req.params.id = String(tournament._id);
  }
  req.body = {
    username: teamName,
    teamType: 'duo',
    members: teammateId ? [teammateId] : [],
    tournamentId: req.params.id
  };
  const { createTeam } = require('./userController');
  return createTeam(req, res);
};

// Leave tournament
const leaveTournament = async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    const withdrawalDeadline = new Date(
      tournament.registrationEndDate || tournament.registrationDeadline || 0
    );
    if (!isTournamentRegistrationOpen(tournament)
      || Number.isNaN(withdrawalDeadline.getTime())
      || Date.now() > withdrawalDeadline.getTime()) {
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_WITHDRAWAL_CLOSED',
        message: 'Tournament withdrawal is only available while registration is open'
      });
    }

    const userId = req.user._id;

    // Check if user is registered as individual participant or directly as a team
    const isIndividualParticipant = tournament.participants.some(p => p.toString() === userId.toString());
    const isTeamParticipant = tournament.teams.some(t => t.toString() === userId.toString());

    if (!isIndividualParticipant && !isTeamParticipant) {
      return res.status(400).json({
        success: false,
        message: 'You are not registered for this tournament'
      });
    }

    let teamMemberIds = [];
    if (isTeamParticipant) {
      const registeredTeam = await User.findById(userId).select('teamInfo.members.user').lean();
      teamMemberIds = (registeredTeam?.teamInfo?.members || []).map((member) => member.user);
    }

    // Remove registration and every derived competition reference in one
    // atomic write. The previous read/filter/save sequence allowed concurrent
    // withdrawals to overwrite each other and reintroduce a removed entrant.
    const registrationQuery = registrationWindowQuery(new Date());
    const updatedTournament = await Tournament.findOneAndUpdate(
      {
        _id: tournament._id,
        status: registrationQuery.status,
        $and: registrationQuery.$and,
        $or: [{ participants: userId }, { teams: userId }]
      },
      buildTournamentEntrantRemovalUpdate(userId, teamMemberIds),
      { new: true }
    );
    if (!updatedTournament) {
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_WITHDRAWAL_CONFLICT',
        message: 'Registration changed or withdrawal is no longer available. Refresh and try again.'
      });
    }

    await emitTournamentUpdated(req, updatedTournament._id);

    const cleanupResults = await Promise.allSettled([
      removeHistoryEntriesForTeam(updatedTournament._id, userId),
      ...(isTeamParticipant ? [cleanupGeneratedDuoTeams([userId])] : [])
    ]);
    cleanupResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        log.error('[leaveTournament] Post-withdrawal cleanup failed', {
          operation: index === 0 ? 'history' : 'generated-duo-team',
          error: String(result.reason)
        });
      }
    });

    if (String(updatedTournament.host) !== String(userId)) {
      await notifyTournamentRecipients({
        tournament: updatedTournament,
        recipients: [updatedTournament.host],
        sender: userId,
        title: 'Tournament Registration Withdrawn',
        message: `${req.user.profile?.displayName || req.user.username} left "${updatedTournament.name}"`,
        eventType: 'tournament_registration_left',
        revision: updatedTournament.updatedAt,
        extraData: { participantId: userId }
      });
    }

    res.status(200).json({
      success: true,
      message: 'Successfully left tournament'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to leave tournament',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Leave tournament as team
const leaveTournamentAsTeam = async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    const withdrawalDeadline = new Date(
      tournament.registrationEndDate || tournament.registrationDeadline || 0
    );
    if (!isTournamentRegistrationOpen(tournament)
      || Number.isNaN(withdrawalDeadline.getTime())
      || Date.now() > withdrawalDeadline.getTime()) {
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_WITHDRAWAL_CLOSED',
        message: 'Tournament withdrawal is only available while registration is open'
      });
    }

    const { teamId } = req.body;
    const userId = req.user._id;

    if (!teamId) {
      return res.status(400).json({
        success: false,
        message: 'Team ID is required'
      });
    }
    if (!/^[0-9a-fA-F]{24}$/.test(String(teamId))) {
      return res.status(400).json({
        success: false,
        message: 'Valid Team ID is required'
      });
    }

    // `/leave-team` exists only for generated Duo registrations because the
    // players authenticate as themselves, not as the generated team account.
    // Normal Squad/5v5 registrations are owned by a real team account and
    // must use the canonical `/leave` command as that account.
    const team = await User.findOne({
      ...generatedDuoTeamQuery([teamId]),
      isActive: true
    }).select('username email userType profile teamInfo.members.user');
    if (!team) {
      return res.status(403).json({
        success: false,
        code: 'GENERATED_DUO_WITHDRAWAL_ONLY',
        message: 'This withdrawal route is only available for generated Duo registrations'
      });
    }

    const isGeneratedDuoAccount = idString(team._id) === idString(userId);
    const isTeamMember = team.teamInfo?.members?.some((member) => (
      idString(member?.user) === idString(userId)
    ));

    if (!isGeneratedDuoAccount && !isTeamMember) {
      return res.status(403).json({
        success: false,
        code: 'DUO_WITHDRAWAL_FORBIDDEN',
        message: 'Only the generated Duo account or one of its members can withdraw it'
      });
    }

    // Check if team is registered for this tournament
    const isTeamRegistered = tournament.teams.some((registeredTeamId) => (
      idString(registeredTeamId) === idString(teamId)
    ));
    if (!isTeamRegistered) {
      return res.status(400).json({
        success: false,
        message: 'This team is not registered for this tournament'
      });
    }

    const teamMemberIds = (team.teamInfo?.members || []).map((member) => member.user);
    const registrationQuery = registrationWindowQuery(new Date());
    const updatedTournament = await Tournament.findOneAndUpdate(
      {
        _id: tournament._id,
        status: registrationQuery.status,
        $and: registrationQuery.$and,
        teams: teamId
      },
      buildTournamentEntrantRemovalUpdate(teamId, teamMemberIds),
      { new: true }
    );
    if (!updatedTournament) {
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_WITHDRAWAL_CONFLICT',
        message: 'Registration changed or withdrawal is no longer available. Refresh and try again.'
      });
    }

    await emitTournamentUpdated(req, updatedTournament._id);

    // Keep supplementary cleanup independent: a history write failure must not
    // strand the inaccessible generated Duo account.
    const cleanupResults = await Promise.allSettled([
      removeHistoryEntriesForTeam(updatedTournament._id, teamId),
      cleanupGeneratedDuoTeams([teamId])
    ]);
    cleanupResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        log.error('[leaveTournamentAsTeam] Post-withdrawal cleanup failed', {
          operation: index === 0 ? 'history' : 'generated-duo-team',
          error: String(result.reason)
        });
      }
    });

    if (String(updatedTournament.host) !== String(teamId)) {
      await notifyTournamentRecipients({
        tournament: updatedTournament,
        recipients: [updatedTournament.host],
        sender: teamId,
        title: 'Tournament Registration Withdrawn',
        message: `${team.profile?.displayName || team.username} left "${updatedTournament.name}"`,
        eventType: 'tournament_registration_left',
        revision: updatedTournament.updatedAt,
        extraData: { participantId: teamId }
      });
    }

    res.status(200).json({
      success: true,
      message: 'Successfully left tournament as team'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to leave tournament as team',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Auto assign groups
const autoAssignGroups = async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Check if user is the host
    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can assign groups'
      });
    }

    if (!isTournamentBeforeStart(tournament)
      || (tournament.matches || []).length > 0
      || (tournament.groupResults || []).some(isPublishedTournamentGroupResult)) {
      return res.status(409).json({
        success: false,
        message: 'Round 1 groups cannot be reassigned after competition activity begins'
      });
    }

    // For duo tournaments, only consider teams (not individual participants)
    // For solo tournaments, consider both individual participants and teams
    let allParticipants;
    if (tournament.format === 'Duo') {
      allParticipants = [...tournament.teams];
    } else {
      allParticipants = [...tournament.participants, ...tournament.teams];
    }
    
    if (allParticipants.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No participants to assign to groups'
      });
    }

    // Group assignment configures Round 1 only. Historical/later-round groups
    // must never be erased when a host rebalances initial registrations.
    const laterRoundGroups = (tournament.groups || []).filter(
      (group) => Number(group.round || 1) !== 1
    );
    let groups = (tournament.groups || []).filter(
      (group) => Number(group.round || 1) === 1
    );
    
    // If no groups exist, create them based on teamsPerGroup
    if (groups.length === 0) {
      const totalGroups = Math.ceil(tournament.totalSlots / tournament.teamsPerGroup);
      for (let i = 0; i < totalGroups; i++) {
        groups.push({
          name: `Group ${i + 1}`,
          participants: [],
          round: 1,
          groupLetter: alphabeticGroupLabel(i)
        });
      }
    }

    const roundOneCapacity = groups.length * Number(tournament.teamsPerGroup || 0);
    if (roundOneCapacity < allParticipants.length) {
      return res.status(409).json({
        success: false,
        message: 'Round 1 groups do not have enough capacity for all registered participants'
      });
    }

    // Clear existing participants from all groups
    groups.forEach(group => {
      group.participants = [];
    });
    
    // Assign participants to groups, filling one group completely before moving to the next
    let currentGroupIndex = 0;
    let currentGroupParticipants = 0;
    
    for (const participant of allParticipants) {
      // If current group is full, move to next group
      if (currentGroupParticipants >= tournament.teamsPerGroup) {
        currentGroupIndex++;
        currentGroupParticipants = 0;
      }
      
      // If we've filled all groups, start over (shouldn't happen with proper validation)
      if (currentGroupIndex >= groups.length) {
        currentGroupIndex = 0;
      }
      
      // Add participant ID to current group (consistent with assignParticipantToGroup)
      groups[currentGroupIndex].participants.push(participant._id || participant);
      currentGroupParticipants++;
    }

    tournament.groups = [...laterRoundGroups, ...groups];
    
    // Automatically create broadcast channels for each group
    tournament.broadcastChannels = (tournament.broadcastChannels || []).filter(
      (channel) => Number(channel.round || 1) !== 1
    );
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const channelName = `Round ${group.round || 1} - ${group.name}`;
      
      const broadcastChannel = {
        name: channelName,
        type: 'Text Messages',
        description: `Broadcast channel for ${group.name} in Round ${group.round || 1}`,
        groupId: group._id || `group_${i + 1}`,
        round: group.round || 1,
        channelId: null // This would be set when integrating with actual messaging system
      };

      tournament.broadcastChannels.push(broadcastChannel);
    }

    await tournament.save();
    await emitTournamentUpdated(req, tournament._id);

    // Send notifications to all participants about group assignment and broadcast channels
    // For duo tournaments, only notify teams (not individual participants)
    // For solo tournaments, notify both individual participants and teams
    let allTournamentParticipants;
    if (tournament.format === 'Duo') {
      allTournamentParticipants = [...tournament.teams];
    } else {
      allTournamentParticipants = [...tournament.participants, ...tournament.teams];
    }
    allTournamentParticipants = await expandTournamentRecipientIds(allTournamentParticipants);
    const notificationPromises = allTournamentParticipants.map(async (participantId) => {
      return createAndEmitNotification({
        recipient: participantId,
        sender: req.user._id,
        type: 'tournament',
        title: `Groups Assigned: ${tournament.name}`,
        message: `You have been assigned to a group! Check your group details and broadcast channels.`,
        data: {
          tournamentId: tournament._id,
          customData: { action: 'groups_assigned' }
        }
      });
    });

    await Promise.allSettled(notificationPromises);

    res.status(200).json({
      success: true,
      message: 'Groups assigned and broadcast channels created successfully',
      data: {
        groups: tournament.groups,
        broadcastChannels: tournament.broadcastChannels
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to assign groups',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Send tournament-wide message
const sendTournamentMessage = async (req, res) => {
  try {
    const { message, type = 'text' } = req.body;
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Authorize the tournament host.
    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can send messages'
      });
    }

    const normalizedMessage = String(message || '').trim();
    const normalizedType = normalizeTournamentMessageType(type);
    if (!normalizedMessage || normalizedMessage.length > 1000) {
      return res.status(400).json({ success: false, message: 'Message must be between 1 and 1000 characters' });
    }
    if (!normalizedType) {
      return res.status(400).json({ success: false, message: 'Invalid tournament message type' });
    }

    // Initialize tournamentMessages array if it doesn't exist
    if (!tournament.tournamentMessages) {
      tournament.tournamentMessages = [];
    }

    // Add message to tournament messages
    const newMessage = {
      sender: req.user._id,
      message: normalizedMessage,
      type: normalizedType,
      timestamp: new Date()
    };

    tournament.tournamentMessages.push(newMessage);
    await tournament.save();
    emitTournamentBroadcast(
      req,
      tournament,
      'tournament_message',
      normalizedMessage,
      [tournament.host, ...tournament.participants, ...tournament.teams]
    );
    await emitTournamentUpdated(req, tournament._id);

    // Send notifications to all participants
    const allParticipants = await expandTournamentRecipientIds([...tournament.participants, ...tournament.teams]);
    
    const notificationPromises = allParticipants.map(async (participantId) => {
      return createAndEmitNotification({
        recipient: participantId,
        sender: req.user._id,
        type: 'tournament',
        title: `Tournament Update: ${tournament.name}`,
        message: normalizedMessage,
        data: {
          tournamentId: tournament._id,
          customData: { action: 'tournament_message' }
        }
      });
    });

    await Promise.allSettled(notificationPromises);

    res.status(200).json({
      success: true,
      message: 'Tournament message sent successfully',
      data: { message: newMessage }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to send tournament message',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Send group message
const sendGroupMessage = async (req, res) => {
  try {
    const { groupId, round, message, type = 'text' } = req.body;
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Check if user is the host
    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can send group messages'
      });
    }

    const normalizedMessage = String(message || '').trim();
    const normalizedType = normalizeTournamentMessageType(type);
    if (!normalizedMessage || normalizedMessage.length > 1000) {
      return res.status(400).json({ success: false, message: 'Message must be between 1 and 1000 characters' });
    }
    if (!normalizedType) {
      return res.status(400).json({ success: false, message: 'Invalid tournament message type' });
    }

    const normalizedRound = parseStrictInteger(round);
    const group = (tournament.groups || []).find((candidate) => (
      (idString(candidate._id) === String(groupId) || String(candidate.name) === String(groupId))
      && Number(candidate.round || 1) === normalizedRound
    ));
    if (!group || !Number.isInteger(normalizedRound) || normalizedRound < 1) {
      return res.status(400).json({
        success: false,
        message: 'Valid tournament group and round are required'
      });
    }

    // Initialize groupMessages array if it doesn't exist
    if (!tournament.groupMessages) {
      tournament.groupMessages = [];
    }

    // Find or create group message thread
    let groupMessageThread = tournament.groupMessages.find(
      gm => String(gm.groupId) === String(groupId) && gm.round === normalizedRound
    );

    if (!groupMessageThread) {
      groupMessageThread = {
        groupId,
        round: normalizedRound,
        messages: []
      };
      tournament.groupMessages.push(groupMessageThread);
    }

    // Add message to group thread
    const newMessage = {
      sender: req.user._id,
      message: normalizedMessage,
      type: normalizedType,
      timestamp: new Date()
    };

    groupMessageThread.messages.push(newMessage);
    await tournament.save();
    emitTournamentBroadcast(
      req,
      tournament,
      'group_message',
      normalizedMessage,
      [tournament.host, ...(group.participants || [])]
    );
    await emitTournamentUpdated(req, tournament._id);

    // Send notifications to group participants
    if (group && group.participants) {
      const notificationPromises = (await expandTournamentRecipientIds(group.participants)).map(async (participantId) => {
        return createAndEmitNotification({
          recipient: participantId,
          sender: req.user._id,
          type: 'tournament',
          title: `Group Update: ${group.name}`,
          message: normalizedMessage,
          data: {
            tournamentId: tournament._id,
            groupId,
            customData: { action: 'group_message' }
          }
        });
      });

      await Promise.allSettled(notificationPromises);
    }

    res.status(200).json({
      success: true,
      message: 'Group message sent successfully',
      data: { message: newMessage }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to send group message',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get tournament messages
const getTournamentMessages = async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id)
      .populate('tournamentMessages.sender', 'username userType profile.displayName profile.avatar');

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    if (!await canReadTournamentMessages(tournament, req.user._id)) {
      return res.status(403).json({
        success: false,
        code: 'TOURNAMENT_MESSAGE_ACCESS_DENIED',
        message: 'Only tournament participants can view tournament messages'
      });
    }

    res.status(200).json({
      success: true,
      data: { messages: sanitizeTournamentMessages(tournament.tournamentMessages || []) }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get tournament messages',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get group messages
const getGroupMessages = async (req, res) => {
  try {
    const { groupId, round } = req.query;
    const tournament = await Tournament.findById(req.params.id)
      .populate('groupMessages.messages.sender', 'username userType profile.displayName profile.avatar');

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    const normalizedRound = parseStrictInteger(round);
    const group = (tournament.groups || []).find(
      (candidate) => (idString(candidate._id) === String(groupId)
        || String(candidate.name) === String(groupId))
        && Number(candidate.round || 1) === normalizedRound
    );
    if (!group) {
      return res.status(404).json({ success: false, message: 'Tournament group not found' });
    }
    if (!await canReadGroupMessages(tournament, group, req.user._id)) {
      return res.status(403).json({
        success: false,
        code: 'GROUP_MESSAGE_ACCESS_DENIED',
        message: 'Only members of this tournament group can view group messages'
      });
    }

    const groupMessageThread = tournament.groupMessages.find(
      gm => String(gm.groupId) === String(groupId) && gm.round === normalizedRound
    );

    res.status(200).json({
      success: true,
      data: { messages: sanitizeTournamentMessages(groupMessageThread?.messages || []) }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get group messages',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Delete tournament message
const deleteTournamentMessage = async (req, res) => {
  try {
    const { messageIndex } = req.params;
    const tournament = await Tournament.findById(req.params.id);
    
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Check if user is the host
    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only the host can delete messages'
      });
    }

    const parsedMessageIndex = parseEmbeddedArrayIndex(
      messageIndex,
      tournament.tournamentMessages?.length || 0
    );
    if (parsedMessageIndex === null) {
      return res.status(404).json({
        success: false,
        message: 'Message not found'
      });
    }

    tournament.tournamentMessages.splice(parsedMessageIndex, 1);
    await tournament.save();
    await emitTournamentUpdated(req, tournament._id);

    res.status(200).json({
      success: true,
      message: 'Message deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to delete message',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Delete group message
const deleteGroupMessage = async (req, res) => {
  try {
    const { groupId, round, messageIndex } = req.params;
    const tournament = await Tournament.findById(req.params.id);
    
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Check if user is the host
    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only the host can delete messages'
      });
    }

    const normalizedRound = parseStrictInteger(round);
    const groupThread = tournament.groupMessages.find(
      gm => String(gm.groupId) === String(groupId) && Number(gm.round) === normalizedRound
    );

    const parsedMessageIndex = parseEmbeddedArrayIndex(
      messageIndex,
      groupThread?.messages?.length || 0
    );
    if (!groupThread || parsedMessageIndex === null) {
      return res.status(404).json({
        success: false,
        message: 'Message not found'
      });
    }

    groupThread.messages.splice(parsedMessageIndex, 1);
    await tournament.save();
    await emitTournamentUpdated(req, tournament._id);

    res.status(200).json({
      success: true,
      message: 'Message deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to delete message',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};



// Delete tournament
const deleteTournament = async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id).select('host');

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Check if user is the host
    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can delete tournament'
      });
    }

    // Claim deletion atomically so concurrent retries cannot fan out duplicate
    // notifications. The shared service also removes host locks, player
    // history references, and the stored banner for both host and admin paths.
    const deletion = await deleteTournamentAndCleanup({
      tournamentId: req.params.id,
      expectedHostId: req.user._id
    });
    if (!deletion) {
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_DELETE_CONFLICT',
        message: 'Tournament was already deleted or changed. Refresh and try again.'
      });
    }
    if (deletion.blocked) {
      return res.status(409).json({
        success: false,
        code: deletion.code,
        message: 'This legacy paid tournament must be financially reconciled before deletion.'
      });
    }
    const deletedTournament = deletion.tournament;
    const recipients = deletion.notificationRecipientIds || await expandTournamentRecipientIds([
      ...(deletedTournament.participants || []),
      ...(deletedTournament.teams || [])
    ]);
    await notifyTournamentRecipients({
      tournament: deletedTournament,
      recipients,
      sender: req.user._id,
      title: `Tournament Deleted: ${deletedTournament.name}`,
      message: 'This tournament has been deleted by the host.',
      eventType: 'tournament_deleted',
      revision: 'deleted'
    });

    res.status(200).json({
      success: true,
      message: 'Tournament deleted successfully',
      data: { cleanupPending: deletion.cleanupFailures.length > 0 }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to delete tournament',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const cancelTournament = async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Check if user is the host
    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can cancel tournament'
      });
    }

    if (tournament.status === 'Cancelled') {
      return res.status(200).json({
        success: true,
        message: 'Tournament is already cancelled'
      });
    }

    // Only allow cancellation if tournament hasn't ended
    if (isTerminalTournament(tournament)) {
      return res.status(400).json({
        success: false,
        message: 'Cannot cancel tournament that has already ended or been cancelled'
      });
    }

    // Claim the transition atomically so retries cannot fan out duplicate
    // broadcasts or notifications after a stale read.
    const cancelledTournament = await Tournament.findOneAndUpdate(
      {
        _id: tournament._id,
        host: req.user._id,
        status: tournament.status,
        ...tournamentRevisionFilter(tournament)
      },
      { $set: { status: 'Cancelled' } },
      { new: true, runValidators: true }
    );
    if (!cancelledTournament) {
      const latestTournament = await Tournament.findById(tournament._id).select('status');
      if (latestTournament?.status === 'Cancelled') {
        return res.status(200).json({
          success: true,
          message: 'Tournament is already cancelled'
        });
      }
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_CANCEL_CONFLICT',
        message: 'Tournament state changed while cancelling. Refresh and try again.'
      });
    }
    await propagateStatusChange(cancelledTournament._id, 'Cancelled').catch((error) => {
      log.error('Failed to propagate cancelled tournament status', {
        tournamentId: idString(cancelledTournament._id),
        error: String(error)
      });
    });
    await emitTournamentBroadcast(
      req,
      cancelledTournament,
      'tournament_cancelled',
      `Tournament "${cancelledTournament.name}" has been cancelled.`,
      [cancelledTournament.host, ...cancelledTournament.participants, ...cancelledTournament.teams]
    );
    await emitTournamentUpdated(req, cancelledTournament._id);
    await releaseHostActiveTournament(cancelledTournament.host, cancelledTournament._id);
    await notifyTournamentRecipients({
      tournament: cancelledTournament,
      recipients: [...cancelledTournament.participants, ...cancelledTournament.teams],
      sender: req.user._id,
      title: `Tournament Cancelled: ${cancelledTournament.name}`,
      message: 'This tournament has been cancelled by the host.',
      eventType: 'tournament_cancelled',
      revision: cancelledTournament.updatedAt || 'cancelled'
    });

    res.status(200).json({
      success: true,
      message: 'Tournament cancelled successfully'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to cancel tournament',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Schedule matches for tournament
const scheduleMatches = async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Check if user is the host
    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can schedule matches'
      });
    }
    if (getTournamentPhase(tournament) !== 'Ongoing') {
      return res.status(409).json({ success: false, message: 'Automatic match generation is available only after the tournament starts' });
    }

    // Check if tournament has groups assigned
    if (!tournament.groups || tournament.groups.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please assign groups before scheduling matches'
      });
    }

    const scheduleRound = Math.max(1, Number(tournament.currentRound) || 1);
    if ((tournament.matches || []).some((match) => Number(match.round || 1) === scheduleRound)) {
      return res.status(409).json({
        success: false,
        message: `A schedule already exists for Round ${scheduleRound}. Delete it explicitly before generating another.`
      });
    }

    const roundGroupsForSchedule = (tournament.groups || []).filter(
      (group) => Number(group.round || 1) === scheduleRound
    );
    const groupedRoundParticipants = roundGroupsForSchedule.flatMap(
      (group) => group.participants || []
    );
    const eliminationParticipants = scheduleRound > 1 && groupedRoundParticipants.length > 0
      ? groupedRoundParticipants
      : [...tournament.participants, ...tournament.teams];
    const generatedMatchCount = tournament.format === 'Solo' || tournament.format === 'Duo'
      ? Math.ceil(eliminationParticipants.length / 2)
      : roundGroupsForSchedule.reduce((count, group) => {
          const size = (group.participants || []).length;
          return count + ((size * (size - 1)) / 2);
        }, 0);
    if (generatedMatchCount > MAX_GENERATED_MATCHES_PER_ROUND) {
      return res.status(409).json({
        success: false,
        message: `Round ${scheduleRound} would create ${generatedMatchCount} matches. Reduce teams per group before generating the schedule.`
      });
    }

    // Append the current round only. Earlier schedules are immutable history.
    const initialMatchCount = (tournament.matches || []).length;
    const configuredScheduleStart = new Date(tournament.tournamentStartDate || tournament.startDate);
    if (Number.isNaN(configuredScheduleStart.getTime())) {
      return res.status(400).json({ success: false, message: 'Tournament start date is invalid' });
    }
    const minimumScheduleStart = new Date(Date.now() + 5 * 60 * 1000);
    const scheduleStart = configuredScheduleStart > minimumScheduleStart
      ? configuredScheduleStart
      : minimumScheduleStart;
    const scheduleTimezone = tournamentScheduleTimezone(tournament);
    const localSchedule = formatTournamentLocalDateTime(scheduleStart, scheduleTimezone);
    const scheduleDate = localSchedule.scheduledDate;
    const scheduleTimeString = localSchedule.scheduledTimeString;

    // Generate matches based on tournament format
    if (tournament.format === 'Solo' || tournament.format === 'Duo') {
      // Single elimination bracket
      const allParticipants = eliminationParticipants;
      if (allParticipants.length < 2) {
        return res.status(409).json({ success: false, message: 'At least two participants are required to create matches' });
      }
      
      // Create first round matches
      for (let i = 0; i < allParticipants.length; i += 2) {
        const hasOpponent = i + 1 < allParticipants.length;
        tournament.matches.push({
          round: scheduleRound,
          team1: allParticipants[i],
          team2: hasOpponent ? allParticipants[i + 1] : null,
          winner: hasOpponent ? null : allParticipants[i],
          status: hasOpponent ? 'Scheduled' : 'Completed',
          scheduledTime: scheduleStart,
          scheduledDate: scheduleDate,
          scheduledTimeString,
          createdBy: req.user._id,
          lastModifiedBy: req.user._id
        });
      }
      
    } else {
      // Group stage format
      roundGroupsForSchedule.forEach((group) => {
        const participants = group.participants;
        
        // Create round-robin matches within each group
        for (let i = 0; i < participants.length; i++) {
          for (let j = i + 1; j < participants.length; j++) {
            tournament.matches.push({
              round: scheduleRound,
              groupId: group._id || group.name,
              groupName: group.name,
              team1: participants[i],
              team2: participants[j],
              status: 'Scheduled',
              scheduledTime: scheduleStart,
              scheduledDate: scheduleDate,
              scheduledTimeString,
              createdBy: req.user._id,
              lastModifiedBy: req.user._id
            });
          }
        }
      });
      
    }

    if (tournament.matches.length === initialMatchCount) {
      return res.status(409).json({ success: false, message: 'Current groups do not contain enough participants to create matches' });
    }

    const scheduledTournament = await Tournament.findOneAndUpdate(
      {
        _id: tournament._id,
        host: req.user._id,
        currentRound: scheduleRound,
        'finalResult.generatedAt': null,
        ...tournamentRevisionFilter(tournament)
      },
      { $set: { matches: tournament.matches } },
      { new: true, runValidators: true }
    );
    if (!scheduledTournament) {
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_SCHEDULE_CONFLICT',
        message: 'Tournament schedule changed while matches were generated. Refresh and try again.'
      });
    }
    await emitTournamentUpdated(req, scheduledTournament._id);

    res.status(200).json({
      success: true,
      message: 'Matches scheduled successfully',
      data: {
        matches: scheduledTournament.matches,
        totalRounds: scheduledTournament.totalRounds
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to schedule matches',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Create detailed match schedule
const createMatchSchedule = async (req, res) => {
  try {
    const { round, groupId, matches } = req.body;
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Check if user is the host
    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can create match schedules'
      });
    }
    if (isTerminalTournament(tournament)) {
      return res.status(409).json({ success: false, message: 'Match schedules cannot be changed for a terminal tournament' });
    }

    // Validate matches data
    if (!matches || !Array.isArray(matches) || matches.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Matches data is required'
      });
    }
    if (matches.length > 100) {
      return res.status(400).json({
        success: false,
        message: 'Create at most 100 scheduled matches per request'
      });
    }
    const roundNumber = round === undefined ? 1 : parseStrictInteger(round);
    if (!Number.isInteger(roundNumber) || roundNumber < 1 || roundNumber > 10) {
      return res.status(400).json({ success: false, message: 'Invalid tournament round' });
    }
    const existingRoundMatchCount = (tournament.matches || []).filter(
      (match) => Number(match.round || 1) === roundNumber
    ).length;
    if (existingRoundMatchCount + matches.length > MAX_GENERATED_MATCHES_PER_ROUND) {
      return res.status(409).json({
        success: false,
        message: `Round ${roundNumber} supports at most ${MAX_GENERATED_MATCHES_PER_ROUND} matches`
      });
    }
    if (roundNumber !== Number(tournament.currentRound || 1)
      || (tournament.groupResults || []).some(
        (result) => Number(result.round || 1) === roundNumber && isPublishedTournamentGroupResult(result)
      )) {
      return res.status(409).json({
        success: false,
        message: 'Only the current round can be scheduled before results are submitted'
      });
    }

    // Find the group
    const group = tournament.groups.find(g => 
      (g._id && g._id.toString() === groupId) || g.name === groupId
    );

    if (!group) {
      return res.status(404).json({
        success: false,
        message: 'Group not found'
      });
    }

    if (Number(group.round || 1) !== roundNumber) {
      return res.status(400).json({
        success: false,
        message: 'Selected group does not belong to this round'
      });
    }

    const scheduleTimezone = tournamentScheduleTimezone(tournament);
    const invalidMatch = matches.find((matchData) => {
      const scheduledTime = resolveTournamentMatchDateTime(matchData, scheduleTimezone);
      const duration = parseStrictInteger(
        matchData?.matchDuration ?? tournament.scheduleConfig?.defaultMatchDuration ?? 30
      );
      return !scheduledTime
        || !Number.isInteger(duration)
        || duration < 1
        || duration > 1440;
    });
    if (invalidMatch) {
      return res.status(400).json({
        success: false,
        message: 'Every match needs a valid date, time, and duration'
      });
    }
    const groupParticipantIds = new Set((group.participants || []).map(idString));
    const invalidParticipantMatch = matches.find((matchData) => {
      const team1 = idString(matchData?.team1);
      const team2 = idString(matchData?.team2);
      return (team1 && !groupParticipantIds.has(team1))
        || (team2 && !groupParticipantIds.has(team2))
        || (team1 && team2 && team1 === team2)
        || (matchData?.venue !== undefined && (
          typeof matchData.venue !== 'string' || matchData.venue.length > 200
        ))
        || (matchData?.description !== undefined && (
          typeof matchData.description !== 'string' || matchData.description.length > 1000
        ));
    });
    if (invalidParticipantMatch) {
      return res.status(400).json({
        success: false,
        message: 'Scheduled match participants or details are invalid for this group'
      });
    }

    // Create matches with detailed scheduling
    const newMatches = matches.map(matchData => {
      const scheduledTime = resolveTournamentMatchDateTime(matchData, scheduleTimezone);
      const localSchedule = formatTournamentLocalDateTime(scheduledTime, scheduleTimezone);
      const scheduledDate = localSchedule.scheduledDate;
      const scheduledTimeString = localSchedule.scheduledTimeString;

      return {
        round: roundNumber,
        groupId: groupId,
        groupName: group.name,
        team1: matchData.team1 || null, // Optional for group matches
        team2: matchData.team2 || null, // Optional for group matches
        status: 'Scheduled',
        scheduledTime: scheduledTime,
        scheduledDate: scheduledDate,
        scheduledTimeString: scheduledTimeString,
        matchDuration: parseStrictInteger(
          matchData.matchDuration ?? tournament.scheduleConfig?.defaultMatchDuration ?? 30
        ),
        venue: matchData.venue || 'Online',
        description: matchData.description || '',
        createdBy: req.user._id,
        lastModifiedBy: req.user._id
      };
    });

    // Add new matches to tournament
    tournament.matches.push(...newMatches);
    const scheduledTournament = await Tournament.findOneAndUpdate(
      {
        _id: tournament._id,
        host: req.user._id,
        currentRound: roundNumber,
        'finalResult.generatedAt': null,
        ...tournamentRevisionFilter(tournament)
      },
      { $set: { matches: tournament.matches } },
      { new: true, runValidators: true }
    );
    if (!scheduledTournament) {
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_SCHEDULE_CONFLICT',
        message: 'Tournament schedule changed while matches were added. Refresh and try again.'
      });
    }
    await emitTournamentUpdated(req, scheduledTournament._id);

    res.status(201).json({
      success: true,
      message: 'Match schedule created successfully',
      data: {
        matches: newMatches,
        group: group.name,
        round: roundNumber
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to create match schedule',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Update match schedule
const updateMatchSchedule = async (req, res) => {
  try {
    const { matchId } = req.params;
    const {
      scheduledTime,
      scheduledDate,
      scheduledTimeString,
      venue,
      description,
      matchDuration
    } = req.body;
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Check if user is the host
    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can update match schedules'
      });
    }
    if (isTerminalTournament(tournament)) {
      return res.status(409).json({ success: false, message: 'Match schedules cannot be changed for a terminal tournament' });
    }

    const match = tournament.matches.id(matchId);
    if (!match) {
      return res.status(404).json({
        success: false,
        message: 'Match not found'
      });
    }
    if (match.status !== 'Scheduled') {
      return res.status(409).json({
        success: false,
        message: 'Only scheduled matches can be rescheduled'
      });
    }
    if (Number(match.round || 1) !== Number(tournament.currentRound || 1)
      || (tournament.groupResults || []).some(
        (result) => Number(result.round || 1) === Number(match.round || 1) && isPublishedTournamentGroupResult(result)
      )) {
      return res.status(409).json({
        success: false,
        message: 'Historical or completed round schedules are read-only'
      });
    }

    const scheduleTimezone = tournamentScheduleTimezone(tournament);
    const hasScheduledTimeUpdate = Boolean(
      scheduledTime || (scheduledDate && scheduledTimeString)
    );
    const parsedScheduledTime = hasScheduledTimeUpdate
      ? resolveTournamentMatchDateTime({
          scheduledTime,
          scheduledDate,
          scheduledTimeString
        }, scheduleTimezone)
      : null;
    if (hasScheduledTimeUpdate && !parsedScheduledTime) {
      return res.status(400).json({ success: false, message: 'Invalid match date or time' });
    }
    const parsedDuration = matchDuration !== undefined ? parseStrictInteger(matchDuration) : null;
    if (matchDuration !== undefined
      && (!Number.isInteger(parsedDuration) || parsedDuration < 1 || parsedDuration > 1440)) {
      return res.status(400).json({ success: false, message: 'Match duration must be between 1 and 1440 minutes' });
    }
    if ((venue !== undefined && (typeof venue !== 'string' || venue.length > 200))
      || (description !== undefined && (typeof description !== 'string' || description.length > 1000))) {
      return res.status(400).json({ success: false, message: 'Invalid match venue or description' });
    }

    // Store original time if rescheduling
    if (parsedScheduledTime && parsedScheduledTime.getTime() !== match.scheduledTime?.getTime()) {
      match.originalScheduledTime = match.scheduledTime;
      match.isRescheduled = true;
    }

    // Update match details
    if (parsedScheduledTime) {
      match.scheduledTime = parsedScheduledTime;
      const localSchedule = formatTournamentLocalDateTime(parsedScheduledTime, scheduleTimezone);
      match.scheduledDate = localSchedule.scheduledDate;
      match.scheduledTimeString = localSchedule.scheduledTimeString;
    }

    if (venue !== undefined) match.venue = venue;
    if (description !== undefined) match.description = description;
    if (parsedDuration !== null) match.matchDuration = parsedDuration;
    
    match.lastModifiedBy = req.user._id;

    await tournament.save();
    await emitTournamentUpdated(req, tournament._id);

    res.status(200).json({
      success: true,
      message: 'Match schedule updated successfully',
      data: {
        match: match
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update match schedule',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get tournament schedule
const getTournamentSchedule = async (req, res) => {
  try {
    const { round, groupId, date } = req.query;
    const tournament = await Tournament.findById(req.params.id)
      .populate('matches.team1', 'username profile.displayName profile.avatar')
      .populate('matches.team2', 'username profile.displayName profile.avatar')
      .populate('matches.winner', 'username profile.displayName profile.avatar')
      .populate('matches.createdBy', 'username profile.displayName')
      .populate('matches.lastModifiedBy', 'username profile.displayName');

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    const canViewSchedule = isTournamentHost(tournament, req.user._id)
      || await canReadTournamentMessages(tournament, req.user._id);
    if (!canViewSchedule) {
      return res.status(403).json({
        success: false,
        code: 'TOURNAMENT_SCHEDULE_FORBIDDEN',
        message: 'Tournament schedule is available only to the host and registered participants'
      });
    }

    let filteredMatches = tournament.matches;

    // Filter by round
    if (round) {
      const roundNumber = parseStrictInteger(round);
      if (!roundNumber || roundNumber < 1) {
        return res.status(400).json({ success: false, message: 'Invalid tournament round' });
      }
      filteredMatches = filteredMatches.filter(match => match.round === roundNumber);
    }

    // Filter by group
    if (groupId) {
      filteredMatches = filteredMatches.filter(match => 
        match.groupId === groupId || match.groupName === groupId
      );
    }

    // Filter by date
    if (date) {
      filteredMatches = filteredMatches.filter(match => match.scheduledDate === date);
    }

    // Group matches by date and time
    const safeMatches = filteredMatches.map((match) => {
      const safeMatch = match?.toObject ? match.toObject() : { ...match };
      delete safeMatch.createdBy;
      delete safeMatch.lastModifiedBy;
      return safeMatch;
    });
    const scheduleByDate = safeMatches.reduce((acc, match) => {
      const date = match.scheduledDate;
      if (!acc[date]) {
        acc[date] = [];
      }
      acc[date].push(match);
      return acc;
    }, {});

    // Sort matches within each date by time
    Object.keys(scheduleByDate).forEach(date => {
      scheduleByDate[date].sort((a, b) => 
        new Date(a.scheduledTime).getTime() - new Date(b.scheduledTime).getTime()
      );
    });

    res.status(200).json({
      success: true,
      data: {
        schedule: scheduleByDate,
        totalMatches: safeMatches.length,
        scheduleConfig: tournament.scheduleConfig
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get tournament schedule',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Configure schedule settings
const configureScheduleSettings = async (req, res) => {
  try {
    const { timeSlots, availableDates, defaultMatchDuration, timezone } = req.body;
    const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const duration = defaultMatchDuration === undefined ? undefined : Number(defaultMatchDuration);
    const normalizedScheduleTimezone = timezone === undefined
      ? undefined
      : normalizeTournamentTimezone(timezone);
    const validTimeSlots = timeSlots === undefined || (
      Array.isArray(timeSlots) && timeSlots.length <= 100 && timeSlots.every((slot) => (
        slot && typeof slot === 'object' && !Array.isArray(slot)
        && timePattern.test(String(slot.startTime || ''))
        && timePattern.test(String(slot.endTime || ''))
        && String(slot.startTime) < String(slot.endTime)
        && (slot.isActive === undefined || typeof slot.isActive === 'boolean')
      ))
    );
    const validAvailableDates = availableDates === undefined || (
      Array.isArray(availableDates) && availableDates.length <= 366 && availableDates.every((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !datePattern.test(String(entry.date || ''))) return false;
        const date = new Date(`${entry.date}T00:00:00.000Z`);
        const maxMatches = entry.maxMatches === undefined ? 10 : Number(entry.maxMatches);
        return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === entry.date
          && Number.isInteger(maxMatches) && maxMatches >= 1 && maxMatches <= 1000
          && (entry.isActive === undefined || typeof entry.isActive === 'boolean');
      })
    );
    if (!validTimeSlots || !validAvailableDates ||
        (duration !== undefined && (!Number.isInteger(duration) || duration < 5 || duration > 480)) ||
        (timezone !== undefined && (
          typeof timezone !== 'string'
          || !timezone.trim()
          || timezone.length > 100
          || !normalizedScheduleTimezone
        ))) {
      return res.status(400).json({ success: false, message: 'Invalid tournament schedule configuration' });
    }
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Check if user is the host
    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can configure schedule settings'
      });
    }
    if (isTerminalTournament(tournament)) {
      return res.status(409).json({
        success: false,
        message: 'Schedule settings cannot be changed for a terminal tournament'
      });
    }

    // Initialize scheduleConfig if it doesn't exist
    if (!tournament.scheduleConfig) {
      tournament.scheduleConfig = {};
    }

    // Update schedule configuration
    if (timeSlots !== undefined) tournament.scheduleConfig.timeSlots = timeSlots;
    if (availableDates !== undefined) tournament.scheduleConfig.availableDates = availableDates;
    if (duration !== undefined) tournament.scheduleConfig.defaultMatchDuration = duration;
    if (normalizedScheduleTimezone !== undefined) {
      tournament.scheduleConfig.timezone = normalizedScheduleTimezone;
      tournament.timezone = normalizedScheduleTimezone;
    }

    await tournament.save();
    await emitTournamentUpdated(req, tournament._id);

    res.status(200).json({
      success: true,
      message: 'Schedule settings configured successfully',
      data: {
        scheduleConfig: tournament.scheduleConfig
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to configure schedule settings',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Delete match from schedule
const deleteMatchFromSchedule = async (req, res) => {
  try {
    const { matchId } = req.params;
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Check if user is the host
    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can delete matches'
      });
    }
    if (isTerminalTournament(tournament)) {
      return res.status(409).json({ success: false, message: 'Match schedules cannot be changed for a terminal tournament' });
    }

    const match = tournament.matches.id(matchId);
    if (!match) {
      return res.status(404).json({
        success: false,
        message: 'Match not found'
      });
    }

    if (match.status !== 'Scheduled') {
      return res.status(409).json({
        success: false,
        message: 'Started or completed matches cannot be deleted'
      });
    }
    if (Number(match.round || 1) !== Number(tournament.currentRound || 1)) {
      return res.status(409).json({
        success: false,
        message: 'Historical round schedules are read-only'
      });
    }

    // Remove match
    tournament.matches.pull(matchId);
    await tournament.save();
    await emitTournamentUpdated(req, tournament._id);

    res.status(200).json({
      success: true,
      message: 'Match deleted successfully'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to delete match',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Delete all matches for a specific round
const deleteRoundSchedule = async (req, res) => {
  try {
    const { round } = req.params;
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Check if user is the host
    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only the tournament host can delete round schedule'
      });
    }
    if (isTerminalTournament(tournament)) {
      return res.status(409).json({ success: false, message: 'Match schedules cannot be changed for a terminal tournament' });
    }

    const roundNumber = parseStrictInteger(round);
    if (roundNumber !== Number(tournament.currentRound || 1)) {
      return res.status(409).json({
        success: false,
        message: 'Historical round schedules are read-only'
      });
    }

    const roundMatches = tournament.matches.filter(
      (match) => Number(match.round || 1) === roundNumber
    );
    const hasHistoricalState = roundMatches.some((match) => match.status !== 'Scheduled')
      || (tournament.groupResults || []).some(
        (result) => Number(result.round || 1) === roundNumber && isPublishedTournamentGroupResult(result)
      );
    if (hasHistoricalState) {
      return res.status(409).json({
        success: false,
        message: 'A round schedule cannot be cleared after matches or results begin'
      });
    }

    // Remove all still-scheduled matches for the specified round
    const initialCount = tournament.matches.length;
    tournament.matches = tournament.matches.filter(
      (match) => Number(match.round || 1) !== roundNumber
    );
    const deletedCount = initialCount - tournament.matches.length;

    await tournament.save();
    await emitTournamentUpdated(req, tournament._id);

    res.status(200).json({
      success: true,
      message: `Deleted ${deletedCount} matches from Round ${round}`,
      deletedCount: deletedCount
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to delete round schedule',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Update match result
const updateMatchResult = async (req, res) => {
  try {
    const { matchId, team1Score, team2Score } = req.body;
    let tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Check if user is the host
    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can update match results'
      });
    }

    // Auto-mark as Completed if endDate has passed
    await checkAndMarkCompletedTournaments(tournament);
    
    // Refresh tournament from DB to get updated status
    tournament = await Tournament.findById(req.params.id);

    // Check if tournament can be edited (within 5 days of end if completed)
    if (!canEditTournament(tournament)) {
      return res.status(400).json({
        success: false,
        message: 'Cannot update match results. Tournament has ended and the 5-day editing period has expired.'
      });
    }

    if (tournament.finalResult?.generatedAt) {
      return res.status(409).json({
        success: false,
        message: 'Match results cannot change after final standings are published'
      });
    }
    if (!['Ongoing', 'Completed'].includes(tournament.status)) {
      return res.status(409).json({ success: false, message: 'Match results can only be recorded after the tournament starts' });
    }

    const match = tournament.matches.id(matchId);
    if (!match) {
      return res.status(404).json({
        success: false,
        message: 'Match not found'
      });
    }
    if (Number(match.round || 1) !== Number(tournament.currentRound || 1)) {
      return res.status(409).json({
        success: false,
        message: 'Historical round match results are read-only'
      });
    }

    const parsedTeam1Score = Number(team1Score);
    const parsedTeam2Score = Number(team2Score);
    if (!Number.isInteger(parsedTeam1Score) || parsedTeam1Score < 0
      || !Number.isInteger(parsedTeam2Score) || parsedTeam2Score < 0) {
      return res.status(400).json({
        success: false,
        message: 'Scores must be non-negative whole numbers'
      });
    }
    if (parsedTeam1Score === parsedTeam2Score) {
      return res.status(400).json({
        success: false,
        message: 'A completed elimination match must have a winner'
      });
    }

    // Update match result
    match.result = {
      team1Score: parsedTeam1Score,
      team2Score: parsedTeam2Score
    };
    
    // Determine winner
    if (parsedTeam1Score > parsedTeam2Score) {
      match.winner = match.team1;
    } else {
      match.winner = match.team2;
    }
    
    match.status = 'Completed';
    const updatedTournament = await Tournament.findOneAndUpdate(
      {
        _id: tournament._id,
        host: req.user._id,
        'finalResult.generatedAt': null,
        ...tournamentRevisionFilter(tournament)
      },
      { $set: { matches: tournament.matches } },
      { new: true, runValidators: true }
    );
    if (!updatedTournament) {
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_RESULT_CONFLICT',
        message: 'Tournament results changed or final standings were published. Refresh and try again.'
      });
    }
    const updatedMatch = updatedTournament.matches.id(matchId);
    await emitTournamentUpdated(req, updatedTournament._id);

    res.status(200).json({
      success: true,
      message: 'Match result updated successfully',
      data: {
        match: updatedMatch
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update match result',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Start match
const startMatch = async (req, res) => {
  try {
    const { matchId } = req.body;
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Check if user is the host
    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can start matches'
      });
    }
    if (getTournamentPhase(tournament) !== 'Ongoing') {
      return res.status(409).json({ success: false, message: 'Matches can only start while the tournament is ongoing' });
    }

    const match = tournament.matches.id(matchId);
    if (!match) {
      return res.status(404).json({
        success: false,
        message: 'Match not found'
      });
    }
    if (match.status !== 'Scheduled') {
      return res.status(409).json({ success: false, message: `A ${match.status} match cannot be started` });
    }
    if (Number(match.round || 1) !== Number(tournament.currentRound || 1)
      || (tournament.groupResults || []).some(
        (result) => Number(result.round || 1) === Number(match.round || 1) && isPublishedTournamentGroupResult(result)
      )) {
      return res.status(409).json({
        success: false,
        message: 'Only a current-round match can be started before results are submitted'
      });
    }

    match.status = 'In Progress';
    await tournament.save();
    await emitTournamentUpdated(req, tournament._id);

    res.status(200).json({
      success: true,
      message: 'Match started successfully',
      data: {
        match: match
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to start match',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get tournament participants with groups
const getTournamentParticipants = async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id)
      .populate(activeCompetitionUserPopulate('participants'))
      .populate(AUTHORIZED_TEAM_POPULATE)
      .populate(activeCompetitionUserPopulate('groups.participants'));

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    const canViewCompetition = isTournamentHost(tournament, req.user._id)
      || await canReadTournamentMessages(tournament, req.user._id);
    if (!canViewCompetition) {
      return res.status(403).json({
        success: false,
        code: 'TOURNAMENT_PARTICIPANTS_FORBIDDEN',
        message: 'Detailed participant groups are available only to the host and registered participants'
      });
    }

    const safeTournament = sanitizePublicTournament(tournament);

    res.status(200).json({
      success: true,
      data: {
        participants: safeTournament.participants,
        teams: safeTournament.teams,
        groups: safeTournament.groups,
        totalParticipants: safeTournament.participants.length + safeTournament.teams.length
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tournament participants',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Remove participant from tournament
const removeParticipant = async (req, res) => {
  try {
    const { participantId } = req.body;
    let tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Check if user is the host
    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can remove participants'
      });
    }
    if (!isTournamentBeforeStart(tournament)) {
      return res.status(409).json({
        success: false,
        message: 'Participants can only be removed before the tournament starts'
      });
    }

    if (!/^[0-9a-fA-F]{24}$/.test(String(participantId || ''))) {
      return res.status(400).json({ success: false, message: 'Valid participant ID is required' });
    }
    const isRegistered = [...(tournament.participants || []), ...(tournament.teams || [])]
      .some((candidate) => idString(candidate) === idString(participantId));
    if (!participantId || !isRegistered) {
      return res.status(404).json({
        success: false,
        message: 'Registered participant not found'
      });
    }
    const wasTeamEntry = (tournament.teams || [])
      .some((candidate) => idString(candidate) === idString(participantId));
    const removedTeam = wasTeamEntry
      ? await User.findById(participantId).select('teamInfo.members.user').lean()
      : null;
    const memberIds = (removedTeam?.teamInfo?.members || []).map((member) => member.user);
    const removalNotificationRecipients = wasTeamEntry
      ? [participantId, ...memberIds]
      : [participantId];
    const removalNow = new Date();
    const updatedTournament = await Tournament.findOneAndUpdate(
      {
        _id: tournament._id,
        status: { $in: ['Upcoming', 'Registration Open'] },
        $and: [
          {
            $or: [
              { tournamentStartDate: { $gt: removalNow } },
              { tournamentStartDate: null, startDate: { $gt: removalNow } }
            ]
          },
          { $or: [{ participants: participantId }, { teams: participantId }] }
        ]
      },
      buildTournamentEntrantRemovalUpdate(participantId, memberIds),
      { new: true }
    );
    if (!updatedTournament) {
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_PARTICIPANT_REMOVE_CONFLICT',
        message: 'Tournament registration changed or the tournament already started. Refresh and try again.'
      });
    }
    tournament = updatedTournament;
    if (wasTeamEntry) {
      await cleanupGeneratedDuoTeams([participantId]).catch((cleanupError) => {
        log.error('[removeParticipant] Generated Duo cleanup failed after removal', {
          participantId: String(participantId),
          error: String(cleanupError)
        });
      });
    }
    await emitTournamentUpdated(req, tournament._id);
    if (wasTeamEntry) {
      try {
        await removeHistoryEntriesForTeam(tournament._id, participantId);
      } catch (historyErr) {
        log.error('[removeParticipant] Failed to remove team history entries:', { error: String(historyErr) });
      }
    }

    await notifyTournamentRecipients({
      tournament,
      recipients: removalNotificationRecipients,
      sender: req.user._id,
      title: `Removed from ${tournament.name}`,
      message: 'The host removed you from this tournament.',
      eventType: 'tournament_participant_removed',
      revision: tournament.updatedAt,
      extraData: { participantId }
    });

    res.status(200).json({
      success: true,
      message: 'Participant removed successfully'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to remove participant',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const assignParticipantToGroup = async (req, res) => {
  try {
    const { participantId, groupId, round } = req.body;
    const tournament = await Tournament.findById(req.params.id);
    
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    if (!isTournamentHost(tournament, req.user._id)) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can assign participants to groups'
      });
    }

    const registeredParticipant = [...(tournament.participants || []), ...(tournament.teams || [])]
      .some((candidate) => idString(candidate) === idString(participantId));
    if (!registeredParticipant) {
      return res.status(400).json({
        success: false,
        message: 'Participant is not registered for this tournament'
      });
    }

    let group;
    
    if (!groupId) {
      // Auto-assign: Find the first group that's not full
      group = tournament.groups.find(g => 
        g.round === (round || 1) && 
        (!g.participants || g.participants.length < tournament.teamsPerGroup)
      );
      
      if (!group) {
        return res.status(400).json({
          success: false,
          message: 'No available groups. All groups are full!'
        });
      }
    } else {
      // Manual assign: Find the specific group
      group = tournament.groups.find(g => 
        (g._id && g._id.toString() === groupId) || g.name === groupId
      );
      
      if (!group) {
        return res.status(404).json({
          success: false,
          message: 'Group not found'
        });
      }

      if (round && Number(group.round || 1) !== Number(round)) {
        return res.status(400).json({
          success: false,
          message: 'Selected group does not belong to this round'
        });
      }
    }

    const targetRound = Number(group.round || round || 1);
    const roundHasCompetitionState = (tournament.matches || []).some(
      (match) => Number(match.round || 1) === targetRound
    ) || (tournament.groupResults || []).some(
      (result) => Number(result.round || 1) === targetRound && isPublishedTournamentGroupResult(result)
    );
    if (roundHasCompetitionState
      || (targetRound === 1 && !isTournamentBeforeStart(tournament))) {
      return res.status(409).json({
        success: false,
        message: 'Participants cannot move after round competition activity begins'
      });
    }
    if (targetRound > 1) {
      const previousCoverage = submittedRoundCoverage(tournament, targetRound - 1);
      if (!previousCoverage.complete
        || !previousCoverage.qualifiedIds.includes(idString(participantId))) {
        return res.status(409).json({
          success: false,
          message: 'Only server-qualified participants can be assigned to a later round'
        });
      }
    }

    // Check if participant is already in this group
    const alreadyInGroup = group.participants.some(p => p.toString() === participantId);
    if (alreadyInGroup) {
      return res.status(400).json({
        success: false,
        message: 'Participant already in this group'
      });
    }

    const roundSetting = (tournament.roundSettings || []).find(
      (setting) => Number(setting.round) === Number(group.round || round || 1)
    );
    const groupCapacity = Number(roundSetting?.teamsPerGroup || tournament.teamsPerGroup || 0);
    if (groupCapacity > 0 && group.participants.length >= groupCapacity) {
      return res.status(400).json({
        success: false,
        message: 'Selected group is full'
      });
    }

    // Move within the target round only. Earlier rounds are immutable history
    // and must retain their participant assignments.
    tournament.groups.forEach(g => {
      if (Number(g.round || 1) === targetRound) {
        g.participants = g.participants.filter(p => p.toString() !== participantId);
      }
    });

    // Add participant to the selected group
    group.participants.push(participantId);

    await tournament.save();
    await emitTournamentUpdated(req, tournament._id);
    await notifyTournamentRecipients({
      tournament,
      recipients: [participantId],
      sender: req.user._id,
      title: `Group Assignment: ${tournament.name}`,
      message: `You were assigned to ${group.name}.`,
      eventType: 'tournament_group_assigned',
      revision: tournament.updatedAt,
      extraData: { participantId, groupId: group._id || group.name, round: group.round || round || 1 }
    });

    res.status(200).json({
      success: true,
      message: 'Participant assigned to group successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to assign participant to group',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const updateRoundSettings = async (req, res) => {
  try {
    const { round, roundName, teamsPerGroup, totalSlots, numberOfGroups } = req.body;
    const tournament = await Tournament.findById(req.params.id);
    
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Check if user is the host
    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can update round settings'
      });
    }

    const roundNumber = parseStrictInteger(round);
    const parsedTeamsPerGroup = parseStrictInteger(teamsPerGroup);
    const parsedTotalSlots = parseStrictInteger(totalSlots);
    const parsedNumberOfGroups = parseStrictInteger(numberOfGroups);
    if (!Number.isInteger(roundNumber) || roundNumber < 1 || roundNumber > Number(tournament.totalRounds || 1)) {
      return res.status(400).json({
        success: false,
        message: `Round must be between 1 and ${Math.max(1, Number(tournament.totalRounds) || 1)}`
      });
    }
    const roundHasCompetitionState = (tournament.matches || []).some(
      (match) => Number(match.round || 1) === roundNumber
    ) || (tournament.groupResults || []).some(
      (result) => Number(result.round) === roundNumber && isPublishedTournamentGroupResult(result)
    );
    if (roundHasCompetitionState || (roundNumber === 1 && !isTournamentBeforeStart(tournament))) {
      return res.status(409).json({
        success: false,
        message: 'Round structure cannot change after competition activity begins'
      });
    }
    const minimumTeamsPerGroup = roundNumber === 1 ? 2 : 1;
    const minimumTotalSlots = roundNumber === 1 ? 4 : 1;
    if (!Number.isInteger(parsedTeamsPerGroup)
      || parsedTeamsPerGroup < minimumTeamsPerGroup
      || parsedTeamsPerGroup > 100) {
      return res.status(400).json({
        success: false,
        message: `Teams per group must be between ${minimumTeamsPerGroup} and 100`
      });
    }
    if (!Number.isInteger(parsedTotalSlots) || parsedTotalSlots < minimumTotalSlots || parsedTotalSlots > 128
      || parsedTeamsPerGroup > parsedTotalSlots) {
      return res.status(400).json({ success: false, message: 'Invalid round slot configuration' });
    }
    const registeredCount = (tournament.participants || []).length + (tournament.teams || []).length;
    if (roundNumber === 1 && parsedTotalSlots < registeredCount) {
      return res.status(409).json({
        success: false,
        message: `Round 1 requires at least ${registeredCount} slots for current registrations`
      });
    }
    if (roundName !== undefined && (typeof roundName !== 'string' || roundName.trim().length > 120)) {
      return res.status(400).json({ success: false, message: 'Round name cannot exceed 120 characters' });
    }
    const expectedNumberOfGroups = Math.ceil(parsedTotalSlots / parsedTeamsPerGroup);
    if (!Number.isInteger(parsedNumberOfGroups) || parsedNumberOfGroups !== expectedNumberOfGroups) {
      return res.status(400).json({
        success: false,
        message: `Number of groups must be ${expectedNumberOfGroups} for this round`
      });
    }

    let savedRoundSetting = (tournament.roundSettings || []).find(
      (setting) => Number(setting.round) === roundNumber
    );
    const settingData = {
      round: roundNumber,
      roundName: String(roundName || `Round ${roundNumber}`).trim(),
      teamsPerGroup: parsedTeamsPerGroup,
      qualificationCriteria: savedRoundSetting?.qualificationCriteria || parsedTeamsPerGroup,
      totalGroups: parsedNumberOfGroups,
      totalTeams: parsedTotalSlots,
      totalSlots: parsedTotalSlots,
      numberOfGroups: parsedNumberOfGroups
    };
    if (savedRoundSetting) {
      Object.assign(savedRoundSetting, settingData);
    } else {
      tournament.roundSettings.push(settingData);
      savedRoundSetting = tournament.roundSettings[tournament.roundSettings.length - 1];
    }

    // Round 1 also controls the tournament's initial structure.
    if (roundNumber === 1) {
      tournament.teamsPerGroup = parsedTeamsPerGroup;
      tournament.totalSlots = parsedTotalSlots;
      tournament.numberOfGroups = parsedNumberOfGroups;
    }

    await tournament.save();
    await emitTournamentUpdated(req, tournament._id);

    res.status(200).json({
      success: true,
      message: 'Round settings updated successfully',
      data: {
        roundSettings: savedRoundSetting,
        tournament: sanitizePublicTournament(tournament)
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update round settings',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const recreateGroups = async (req, res) => {
  try {
    const { teamsPerGroup, totalSlots } = req.body;
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Authorize the tournament host.
    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can recreate groups'
      });
    }

    if (!isTournamentBeforeStart(tournament)
      || (tournament.matches || []).length > 0
      || (tournament.groupResults || []).some(isPublishedTournamentGroupResult)) {
      return res.status(409).json({
        success: false,
        message: 'Round 1 groups cannot be recreated after competition activity begins'
      });
    }
    const parsedTeamsPerGroup = parseStrictInteger(teamsPerGroup);
    const parsedTotalSlots = parseStrictInteger(totalSlots);
    // This command writes the root tournament fields whose schema minimums
    // are 2 teams per group and 4 total slots. Reject smaller values as a
    // recoverable client error before Mongoose turns them into a 500.
    if (!Number.isInteger(parsedTeamsPerGroup) || parsedTeamsPerGroup < 2 || parsedTeamsPerGroup > 100
      || !Number.isInteger(parsedTotalSlots) || parsedTotalSlots < 4 || parsedTotalSlots > 128
      || parsedTeamsPerGroup > parsedTotalSlots) {
      return res.status(400).json({ success: false, message: 'Invalid group configuration' });
    }
    const registeredCount = (tournament.participants || []).length + (tournament.teams || []).length;
    if (parsedTotalSlots < registeredCount) {
      return res.status(409).json({
        success: false,
        message: `Group configuration requires at least ${registeredCount} slots for current registrations`
      });
    }

    // Calculate number of groups
    const numberOfGroups = Math.ceil(parsedTotalSlots / parsedTeamsPerGroup);
    
    // Clear existing groups for Round 1
    tournament.groups = tournament.groups.filter(group => Number(group.round || 1) !== 1);
    
    // Create new groups for Round 1
    const newGroups = [];
    for (let i = 0; i < numberOfGroups; i++) {
      newGroups.push({
        name: `Group ${i + 1}`,
        participants: [],
        round: 1,
        groupLetter: alphabeticGroupLabel(i)
      });
    }
    
    tournament.groups = [...tournament.groups, ...newGroups];
    
    // Recreate broadcast channels for Round 1
    tournament.broadcastChannels = (tournament.broadcastChannels || []).filter(
      channel => Number(channel.round || 1) !== 1
    );
    
    for (let i = 0; i < numberOfGroups; i++) {
      const group = newGroups[i];
      const channelName = `Round 1 - ${group.name}`;
      
      const broadcastChannel = {
        name: channelName,
        type: 'Text Messages',
        description: `Broadcast channel for ${group.name} in Round 1`,
        groupId: group._id || `group_${i + 1}`,
        round: 1,
        channelId: null
      };

      tournament.broadcastChannels.push(broadcastChannel);
    }

    tournament.teamsPerGroup = parsedTeamsPerGroup;
    tournament.totalSlots = parsedTotalSlots;
    tournament.numberOfGroups = numberOfGroups;

    await tournament.save();
    await emitTournamentUpdated(req, tournament._id);

    res.status(200).json({
      success: true,
      message: 'Groups recreated successfully',
      data: { tournament: sanitizePublicTournament(tournament) }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to recreate groups',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Submit group results
const submitGroupResults = async (req, res) => {
  try {
    const { round, groupId, groupName, teams } = req.body;
    if (process.env.NODE_ENV === 'development') { console.log('SubmitGroupResults - Received data:', { round, groupId, groupName, teams: teams?.length });
    }
    let tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      if (process.env.NODE_ENV === 'development') { console.log('Tournament not found:', req.params.id);}
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Check if user is the host
    if (tournament.host.toString() !== req.user._id.toString()) {
      if (process.env.NODE_ENV === 'development') { console.log('User not authorized:', req.user._id, 'vs', tournament.host);}
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can submit results'
      });
    }

    // Auto-mark as Completed if endDate has passed
    await checkAndMarkCompletedTournaments(tournament);
    
    // Refresh tournament from DB to get updated status
    tournament = await Tournament.findById(req.params.id);

    if (competitionMutationBlocked(tournament)) {
      return res.status(409).json({
        success: false,
        message: 'Group results cannot change after the tournament is completed, cancelled, or published'
      });
    }

    // Check if tournament can be edited (within 5 days of end if completed)
    if (!canEditTournament(tournament)) {
      return res.status(400).json({
        success: false,
        message: 'Cannot submit results. Tournament has ended and the 5-day editing period has expired.'
      });
    }

    // Validate teams data
    if (!teams || !Array.isArray(teams) || teams.length === 0) {
      if (process.env.NODE_ENV === 'development') { console.log('Invalid teams data:', teams);}
      return res.status(400).json({
        success: false,
        message: 'Teams data is required'
      });
    }
    if (teams.length > MAX_ROUND_PARTICIPANTS
      || teams.some((team) => !isPlainObject(team) || !isCompetitionId(team.teamId))) {
      return res.status(400).json({
        success: false,
        message: 'Every result entry must be an object with a valid teamId'
      });
    }

    if (tournament.status !== 'Ongoing') {
      return res.status(409).json({
        success: false,
        message: 'Results can only be submitted after the tournament starts'
      });
    }

    const roundNumber = parseStrictInteger(round);
    const targetGroup = (tournament.groups || []).find((group) => (
      Number(group.round || 1) === roundNumber
      && (idString(group._id) === idString(groupId) || String(group.name) === String(groupId))
    ));
    if (!Number.isInteger(roundNumber) || roundNumber < 1 || !targetGroup) {
      return res.status(400).json({ success: false, message: 'Valid tournament round and group are required' });
    }
    const canonicalGroupId = idString(targetGroup._id) || String(targetGroup.name);
    const canonicalGroupName = String(targetGroup.name || groupName || `Round ${roundNumber} Group`);
    if (roundNumber !== Number(tournament.currentRound || 1)) {
      return res.status(409).json({
        success: false,
        message: 'Historical and future round results are read-only'
      });
    }

    const registeredIds = new Set((targetGroup.participants || []).map(idString));
    const submittedIds = teams.map((team) => idString(team.teamId));
    if (submittedIds.length !== registeredIds.size
      || new Set(submittedIds).size !== submittedIds.length
      || submittedIds.some((teamId) => !registeredIds.has(teamId))) {
      return res.status(400).json({
        success: false,
        message: 'Results must contain every group participant exactly once'
      });
    }

    // Calculate total points from validated numeric inputs. Do not persist
    // arbitrary client fields into embedded result documents.
    const teamsWithPoints = [];
    for (const team of teams) {
      const wins = Number(team.wins || 0);
      const finishPoints = Number(team.finishPoints || 0);
      const positionPoints = Number(team.positionPoints || 0);
      if (![wins, finishPoints, positionPoints].every(Number.isFinite)
        || [wins, finishPoints, positionPoints].some((value) => value < 0)) {
        return res.status(400).json({ success: false, message: 'Result values must be non-negative numbers' });
      }
      teamsWithPoints.push({
        teamId: team.teamId,
        teamName: String(team.teamName || 'Participant').trim().slice(0, 200),
        teamLogo: typeof team.teamLogo === 'string' ? team.teamLogo.slice(0, 2048) : null,
        wins,
        finishPoints,
        positionPoints,
        totalPoints: finishPoints + positionPoints,
        qualified: Boolean(team.qualified)
      });
    }

    // Sort by total points (descending) and assign ranks
    teamsWithPoints.sort((a, b) => b.totalPoints - a.totalPoints);
    teamsWithPoints.forEach((team, index) => {
      team.rank = index + 1;
    });

    // Log qualification status
    log.debug('Teams with qualification status:', teamsWithPoints.map(t => ({
      teamName: t.teamName,
      qualified: t.qualified,
      totalPoints: t.totalPoints,
      rank: t.rank
    })));

    // Find existing group results or create new
    let groupResults = tournament.groupResults.find(
      (result) => Number(result.round) === roundNumber && (
        String(result.groupId) === canonicalGroupId
        || String(result.groupName) === canonicalGroupName
        || String(result.groupId) === canonicalGroupName
      )
    );

    if (groupResults) {
      // Update existing results
      if (process.env.NODE_ENV === 'development') { console.log('Updating existing group results');}
      groupResults.groupId = canonicalGroupId;
      groupResults.groupName = canonicalGroupName;
      groupResults.teams = teamsWithPoints;
      groupResults.submittedAt = new Date();
      groupResults.isSubmitted = true;
    } else {
      // Create new group results
      if (process.env.NODE_ENV === 'development') { console.log('Creating new group results');}
      tournament.groupResults.push({
        round: roundNumber,
        groupId: canonicalGroupId,
        groupName: canonicalGroupName,
        teams: teamsWithPoints,
        submittedAt: new Date(),
        isSubmitted: true
      });
    }

    if (process.env.NODE_ENV === 'development') { console.log('Saving tournament with groupResults length:', tournament.groupResults.length);}
    const submittedTournament = await Tournament.findOneAndUpdate(
      {
        _id: tournament._id,
        host: req.user._id,
        status: 'Ongoing',
        currentRound: roundNumber,
        'finalResult.generatedAt': null,
        ...tournamentRevisionFilter(tournament)
      },
      { $set: { groupResults: tournament.groupResults } },
      { new: true, runValidators: true }
    );
    if (!submittedTournament) {
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_RESULT_CONFLICT',
        message: 'Tournament results changed or final standings were published. Refresh and try again.'
      });
    }
    const submittedGroupResult = submittedTournament.groupResults.find(
      (result) => Number(result.round) === roundNumber
        && (String(result.groupId) === canonicalGroupId || String(result.groupName) === canonicalGroupName)
    );
    await emitTournamentUpdated(req, submittedTournament._id);
    if (process.env.NODE_ENV === 'development') { console.log('Tournament saved successfully');
}
    // Send notifications to group participants about results
    if (targetGroup.participants && targetGroup.participants.length > 0) {
      const notificationPromises = (await expandTournamentRecipientIds(targetGroup.participants)).map(async (participantId) => {
        return createAndEmitNotification({
          recipient: participantId,
          sender: req.user._id,
          type: 'tournament',
          title: `Results Update: ${submittedTournament.name}`,
          message: `Round ${round} results have been published for ${canonicalGroupName}`,
          data: {
            tournamentId: submittedTournament._id,
            groupId: canonicalGroupId,
            round: round,
            customData: { action: 'results_update' }
          }
        });
      });

      await Promise.allSettled(notificationPromises);
    }

    res.status(200).json({
      success: true,
      message: 'Group results submitted successfully',
      data: {
        groupResults: submittedGroupResult
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to submit group results',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get round results
const getRoundResults = async (req, res) => {
  try {
    const { round } = req.params;
    if (process.env.NODE_ENV === 'development') { console.log('GetRoundResults - Fetching for round:', round, 'tournament:', req.params.id);
    }
    const tournament = await Tournament.findById(req.params.id)
      .populate('groupResults.teams.teamId', 'username profile.displayName profile.avatar');

    if (!tournament) {
      if (process.env.NODE_ENV === 'development') { console.log('Tournament not found for getRoundResults');}
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    const roundNumber = parseStrictInteger(round);
    if (!Number.isInteger(roundNumber) || roundNumber < 1 || roundNumber > Number(tournament.totalRounds || 1)) {
      return res.status(400).json({ success: false, message: 'Invalid tournament round' });
    }
    const canViewDraftResults = isTournamentHost(tournament, req.user._id);
    const roundResults = tournament.groupResults
      .filter((groupResult) => (
        Number(groupResult.round) === roundNumber
        && (canViewDraftResults || isPublishedTournamentGroupResult(groupResult))
      ))
      .map((groupResult) => ({
        round: Number(groupResult.round),
        groupId: String(groupResult.groupId || ''),
        groupName: String(groupResult.groupName || ''),
        submittedAt: groupResult.submittedAt,
        isSubmitted: isPublishedTournamentGroupResult(groupResult),
        teams: (groupResult.teams || []).map(tournamentResultTeamDto)
      }));

    // Calculate overall standings
    const allTeams = [];
    roundResults.forEach(groupResult => {
      groupResult.teams.forEach(team => {
        allTeams.push({
          ...team,
          groupName: groupResult.groupName,
          groupId: groupResult.groupId
        });
      });
    });

    // Sort by total points for overall standings
    allTeams.sort((a, b) => b.totalPoints - a.totalPoints);
    allTeams.forEach((team, index) => {
      team.overallRank = index + 1;
    });

    res.status(200).json({
      success: true,
      data: {
        roundResults,
        overallStandings: allTeams,
        round: roundNumber
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get round results',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Broadcast schedule to all groups
const broadcastSchedule = async (req, res) => {
  try {
    const { round } = req.body;
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can broadcast schedule'
      });
    }

    const roundNumber = parseStrictInteger(round);
    if (!roundNumber || roundNumber < 1 || roundNumber > Number(tournament.totalRounds || 1)) {
      return res.status(400).json({ success: false, message: 'Invalid tournament round' });
    }
    const roundMatches = tournament.matches.filter(match => match.round === roundNumber);
    
    if (roundMatches.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No schedule found for this round'
      });
    }

    const roundGroups = tournament.groups.filter(group => group.round === roundNumber);
    let broadcastCount = 0;
    const pendingScheduleNotifications = [];

    // Initialize groupMessages if it doesn't exist
    if (!tournament.groupMessages) {
      tournament.groupMessages = [];
    }

    for (const group of roundGroups) {
      const groupMatches = roundMatches.filter(match => 
        match.groupName === group.name || match.groupName === group.groupLetter
      );
      
      if (groupMatches.length > 0) {
        let scheduleMessage = `Your group will play ${groupMatches.length} matches in Round ${round}\n\n`;
        const scheduleTimezone = tournamentScheduleTimezone(tournament);

        groupMatches.forEach((match, index) => {
          const localSchedule = match.scheduledTime
            ? formatTournamentLocalDateTime(match.scheduledTime, scheduleTimezone)
            : null;
          const matchDate = localSchedule?.scheduledDate || match.scheduledDate || 'TBD';
          const matchTime = localSchedule?.scheduledTimeString || match.scheduledTimeString || 'TBD';
          scheduleMessage += `Match ${index + 1}\n`;
          scheduleMessage += `Date - ${matchDate}\n`;
          scheduleMessage += `Time - ${matchTime}\n\n`;
        });

        const groupId = group._id || group.name;
        
        let groupMessageThread = tournament.groupMessages.find(
          gm => String(gm.groupId) === String(groupId) && gm.round === roundNumber
        );

        if (!groupMessageThread) {
          groupMessageThread = {
            groupId: groupId,
            round: roundNumber,
            messages: []
          };
          tournament.groupMessages.push(groupMessageThread);
        }

        groupMessageThread.messages.push({
          sender: req.user._id,
          message: scheduleMessage,
          timestamp: new Date(),
          type: 'announcement'
        });

        // Defer external delivery until the schedule announcement is durable.
        if (group.participants && group.participants.length > 0) {
          pendingScheduleNotifications.push({
            participants: [...group.participants],
            groupId
          });
        }

        broadcastCount++;
      }
    }

    await tournament.save();
    for (const notification of pendingScheduleNotifications) {
      const notificationPromises = (await expandTournamentRecipientIds(notification.participants))
        .map((participantId) => createAndEmitNotification({
          recipient: participantId,
          sender: req.user._id,
          type: 'tournament',
          title: `Schedule Update: ${tournament.name}`,
          message: `Round ${round} schedule has been updated for your group`,
          data: {
            tournamentId: tournament._id,
            groupId: notification.groupId,
            round: roundNumber,
            customData: { action: 'schedule_update' }
          }
        }));
      await Promise.allSettled(notificationPromises);
    }
    const scheduleRecipients = roundGroups.flatMap((group) => group.participants || []);
    emitTournamentBroadcast(
      req,
      tournament,
      'schedule_updated',
      `Round ${round} schedule has been updated.`,
      [tournament.host, ...scheduleRecipients]
    );
    await emitTournamentUpdated(req, tournament._id);

    res.status(200).json({
      success: true,
      message: `Schedule broadcasted to ${broadcastCount} groups`,
      data: {
        round: roundNumber,
        groupsBroadcasted: broadcastCount
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
};

// Qualify teams for next round
const qualifyTeams = async (req, res) => {
  try {
    const { round, qualifiedTeams, qualificationCriteria } = req.body;
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Check if user is the host
    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can qualify teams'
      });
    }

    if (competitionMutationBlocked(tournament)) {
      return res.status(409).json({
        success: false,
        message: 'Qualifications cannot change after the tournament is completed, cancelled, or published'
      });
    }

    // Validate qualified teams
    if (!qualifiedTeams || !Array.isArray(qualifiedTeams) || qualifiedTeams.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Qualified teams data is required'
      });
    }

    if (qualifiedTeams.length > MAX_ROUND_PARTICIPANTS
      || qualifiedTeams.some((teamId) => !isCompetitionId(teamId))) {
      return res.status(400).json({ success: false, message: 'Qualified team IDs are invalid' });
    }

    const roundNumber = parseStrictInteger(round);
    const parsedCriteria = parseStrictInteger(qualificationCriteria);
    if (!Number.isInteger(roundNumber) || roundNumber < 1 || roundNumber > Number(tournament.currentRound || 1)
      || !Number.isInteger(parsedCriteria) || parsedCriteria < 1 || parsedCriteria > 128) {
      return res.status(400).json({ success: false, message: 'Invalid qualification round or criteria' });
    }
    const coverage = submittedRoundCoverage(tournament, roundNumber);
    const eligibleIds = new Set(coverage.qualifiedIds);
    const requestedIds = qualifiedTeams.map(idString);
    if (!coverage.complete || eligibleIds.size === 0
      || requestedIds.length !== eligibleIds.size
      || new Set(requestedIds).size !== requestedIds.length
      || requestedIds.some((teamId) => !eligibleIds.has(teamId))) {
      return res.status(400).json({ success: false, message: 'Qualified teams must match the submitted round results' });
    }

    // Find existing qualification or create new
    let qualification = tournament.qualifications.find(q => Number(q.round) === roundNumber);

    if (qualification) {
      // Update existing qualification
      qualification.qualifiedTeams = qualifiedTeams;
      qualification.qualificationCriteria = parsedCriteria;
      qualification.totalQualified = qualifiedTeams.length;
      qualification.qualifiedAt = new Date();
    } else {
      // Create new qualification
      tournament.qualifications.push({
        round: roundNumber,
        qualifiedTeams,
        qualificationCriteria: parsedCriteria,
        totalQualified: qualifiedTeams.length,
        qualifiedAt: new Date()
      });
    }

    // Update groupResults to mark teams as qualified
    if (process.env.NODE_ENV === 'development') { console.log('Qualifying teams:', qualifiedTeams);
    }
    let teamsUpdated = 0;
    tournament.groupResults.forEach(groupResult => {
      if (Number(groupResult.round) === roundNumber) {
        if (process.env.NODE_ENV === 'development') { console.log(`Processing group ${groupResult.groupName} for round ${round}`);}
        groupResult.teams.forEach(team => {
          const wasQualified = team.qualified;
          const teamIdStr = team.teamId.toString();
          
          // Convert qualified teams to strings for comparison
          const qualifiedTeamsStr = qualifiedTeams.map(id => id.toString());
          const isQualified = qualifiedTeamsStr.includes(teamIdStr);
          
          team.qualified = isQualified;
          
          if (team.qualified !== wasQualified) {
            teamsUpdated++;
            if (process.env.NODE_ENV === 'development') { console.log(`Team ${team.teamName} qualified: ${team.qualified}`);}
          }
        });
      }
    });
    
    if (process.env.NODE_ENV === 'development') { console.log(`Total teams updated: ${teamsUpdated}`);
}
    const qualifiedTournament = await Tournament.findOneAndUpdate(
      {
        _id: tournament._id,
        host: req.user._id,
        status: { $nin: ['Completed', 'Cancelled'] },
        'finalResult.generatedAt': null,
        ...tournamentRevisionFilter(tournament)
      },
      {
        $set: {
          qualifications: tournament.qualifications,
          groupResults: tournament.groupResults
        }
      },
      { new: true, runValidators: true }
    );
    if (!qualifiedTournament) {
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_QUALIFICATION_CONFLICT',
        message: 'Tournament qualification state changed. Refresh and try again.'
      });
    }
    const savedQualification = qualifiedTournament.qualifications.find(
      (candidate) => Number(candidate.round) === roundNumber
    );
    await emitTournamentUpdated(req, qualifiedTournament._id);

    await notifyTournamentRecipients({
      tournament: qualifiedTournament,
      recipients: qualifiedTeams,
      sender: req.user._id,
      title: `Qualified: ${qualifiedTournament.name}`,
      message: `You qualified from round ${round}.`,
      eventType: 'tournament_qualified',
      revision: qualifiedTournament.updatedAt,
      extraData: { round: Number(round) }
    });

    res.status(200).json({
      success: true,
      message: 'Teams qualified successfully',
      data: {
        qualification: savedQualification
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to qualify teams',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Create next round groups
const createNextRoundGroups = async (req, res) => {
  try {
    const { currentRound, nextRound, teamsPerGroup } = req.body;
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Check if user is the host
    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can create next round groups'
      });
    }

    if (competitionMutationBlocked(tournament)) {
      return res.status(409).json({
        success: false,
        message: 'Rounds cannot be created after the tournament is completed, cancelled, or published'
      });
    }

    const currentRoundNumber = parseStrictInteger(currentRound);
    const nextRoundNumber = parseStrictInteger(nextRound);
    const parsedTeamsPerGroup = parseStrictInteger(teamsPerGroup);
    const configuredRounds = Math.max(1, Number(tournament.totalRounds) || 1);
    if (!Number.isInteger(currentRoundNumber)
      || !Number.isInteger(nextRoundNumber)
      || nextRoundNumber !== currentRoundNumber + 1
      || nextRoundNumber > configuredRounds
      || currentRoundNumber !== Number(tournament.currentRound || 1)
      || !Number.isInteger(parsedTeamsPerGroup)
      || parsedTeamsPerGroup < 1
      || parsedTeamsPerGroup > 100) {
      return res.status(409).json({
        success: false,
        message: 'Tournament cannot advance beyond its configured round lifecycle'
      });
    }
    if ((tournament.groups || []).some((group) => Number(group.round) === nextRoundNumber)) {
      return res.status(409).json({ success: false, message: 'Next round has already been created' });
    }

    // Derive advancement from complete, submitted server results. Untouched
    // Web advances directly and does not call the optional /qualify endpoint.
    const coverage = submittedRoundCoverage(tournament, currentRoundNumber);
    if (!coverage.complete || coverage.qualifiedIds.length === 0) {
      return res.status(409).json({
        success: false,
        message: 'Every current-round group must submit results before advancement'
      });
    }
    const qualifiedTeams = coverage.qualifiedIds;
    const qualificationData = {
      round: currentRoundNumber,
      qualifiedTeams,
      totalQualified: qualifiedTeams.length,
      qualifiedAt: new Date()
    };
    const qualification = (tournament.qualifications || [])
      .find((candidate) => Number(candidate.round) === currentRoundNumber);
    if (qualification) Object.assign(qualification, qualificationData);
    else tournament.qualifications.push(qualificationData);
    const totalGroups = Math.ceil(qualifiedTeams.length / parsedTeamsPerGroup);

    // Create groups for next round
    const newGroups = [];
    for (let i = 0; i < totalGroups; i++) {
      newGroups.push({
        name: `Group ${alphabeticGroupLabel(i)}`,
        round: nextRoundNumber,
        groupLetter: alphabeticGroupLabel(i),
        participants: [],
        broadcastChannelId: null
      });
    }

    // Distribute qualified teams to groups
    let currentGroupIndex = 0;
    qualifiedTeams.forEach((teamId, index) => {
      if (currentGroupIndex >= totalGroups) {
        currentGroupIndex = 0;
      }
      newGroups[currentGroupIndex].participants.push(teamId);
      currentGroupIndex++;
    });

    // Add new groups to tournament
    tournament.groups.push(...newGroups);

    // Create broadcast channels for new groups
    newGroups.forEach((group, index) => {
      const channelName = `Round ${nextRoundNumber} - ${group.name}`;
      const broadcastChannel = {
        name: channelName,
        type: 'Text Messages',
        description: `Broadcast channel for ${group.name} in Round ${nextRoundNumber}`,
        groupId: group._id || `group_${index + 1}`,
        round: nextRoundNumber,
        channelId: null
      };
      tournament.broadcastChannels.push(broadcastChannel);
    });

    // Update tournament current round
    tournament.currentRound = nextRoundNumber;
    const advancedTournament = await Tournament.findOneAndUpdate(
      {
        _id: tournament._id,
        host: req.user._id,
        currentRound: currentRoundNumber,
        status: { $nin: ['Completed', 'Cancelled'] },
        'finalResult.generatedAt': null,
        ...tournamentRevisionFilter(tournament)
      },
      {
        $set: {
          groups: tournament.groups,
          broadcastChannels: tournament.broadcastChannels,
          qualifications: tournament.qualifications,
          currentRound: nextRoundNumber
        }
      },
      { new: true, runValidators: true }
    );
    if (!advancedTournament) {
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_ROUND_CONFLICT',
        message: 'Tournament round changed while advancing. Refresh and try again.'
      });
    }
    await emitTournamentUpdated(req, advancedTournament._id);

    // Send notifications to all qualified participants about new round and broadcast channels
    const allQualifiedParticipants = await expandTournamentRecipientIds(qualifiedTeams);
    const notificationPromises = allQualifiedParticipants.map(async (participantId) => {
      return createAndEmitNotification({
        recipient: participantId,
        sender: req.user._id,
        type: 'tournament',
        title: `New Round Started: ${tournament.name}`,
        message: `Round ${nextRoundNumber} has started! Check your new group and broadcast channels.`,
        data: {
          tournamentId: advancedTournament._id,
          round: nextRoundNumber,
          customData: { action: 'new_round_started' }
        }
      });
    });

    await Promise.allSettled(notificationPromises);

    res.status(200).json({
      success: true,
      message: 'Next round groups created successfully',
      data: {
        groups: newGroups,
        totalGroups,
        qualifiedTeams: qualifiedTeams.length
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to create next round groups',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get qualification status
const getQualificationStatus = async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id)
      .populate('qualifications.qualifiedTeams', 'username profile.displayName profile.avatar');

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        qualifications: tournament.qualifications,
        currentRound: tournament.currentRound,
        totalRounds: tournament.totalRounds
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get qualification status',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Save qualification settings
const saveQualificationSettings = async (req, res) => {
  try {
    const { round, teamsPerGroup, nextRoundTeamsPerGroup } = req.body;
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Check if user is the host
    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can save qualification settings'
      });
    }

    if (competitionMutationBlocked(tournament)) {
      return res.status(409).json({
        success: false,
        message: 'Qualification settings cannot change after the tournament is completed, cancelled, or published'
      });
    }

    const roundNumber = parseStrictInteger(round);
    const qualifiedPerGroup = parseStrictInteger(teamsPerGroup);
    const nextGroupSize = parseStrictInteger(nextRoundTeamsPerGroup);
    if (!Number.isInteger(roundNumber) || roundNumber < 1 || roundNumber > Number(tournament.totalRounds || 1)
      || !Number.isInteger(qualifiedPerGroup) || qualifiedPerGroup < 1 || qualifiedPerGroup > 128
      || !Number.isInteger(nextGroupSize) || nextGroupSize < 1 || nextGroupSize > 128) {
      return res.status(400).json({ success: false, message: 'Invalid qualification settings' });
    }

    // Find existing round settings or create new
    let roundSetting = tournament.roundSettings.find(rs => Number(rs.round) === roundNumber);

    if (roundSetting) {
      // Update existing settings
      roundSetting.qualificationCriteria = qualifiedPerGroup;
    } else {
      // Create new round settings
      const roundGroups = tournament.groups.filter(g => Number(g.round) === roundNumber);
      const structuralGroupSize = Math.max(
        1,
        ...roundGroups.map(group => Number(group.participants?.length || 0)),
        Number(tournament.teamsPerGroup || 1)
      );
      tournament.roundSettings.push({
        round: roundNumber,
        teamsPerGroup: structuralGroupSize,
        qualificationCriteria: qualifiedPerGroup,
        totalGroups: roundGroups.length,
        totalTeams: roundGroups.reduce((sum, g) => sum + g.participants.length, 0)
      });
    }

    // Store next round settings in tournament metadata
    tournament.qualificationSettings = {
      teamsPerGroup: qualifiedPerGroup,
      nextRoundTeamsPerGroup: nextGroupSize
    };

    const settingsTournament = await Tournament.findOneAndUpdate(
      {
        _id: tournament._id,
        host: req.user._id,
        status: { $nin: ['Completed', 'Cancelled'] },
        'finalResult.generatedAt': null,
        ...tournamentRevisionFilter(tournament)
      },
      {
        $set: {
          roundSettings: tournament.roundSettings,
          qualificationSettings: tournament.qualificationSettings
        }
      },
      { new: true, runValidators: true }
    );
    if (!settingsTournament) {
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_QUALIFICATION_CONFLICT',
        message: 'Tournament qualification state changed. Refresh and try again.'
      });
    }
    await emitTournamentUpdated(req, settingsTournament._id);

    res.status(200).json({
      success: true,
      message: 'Qualification settings saved successfully',
      data: {
        roundSettings: settingsTournament.roundSettings,
        qualificationSettings: settingsTournament.qualificationSettings
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to save qualification settings',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get qualification settings
const getQualificationSettings = async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        roundSettings: tournament.roundSettings,
        qualificationSettings: tournament.qualificationSettings || {
          teamsPerGroup: 8,
          nextRoundTeamsPerGroup: 16
        }
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get qualification settings',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Create Round 2 with qualified teams
const createRound2 = async (req, res) => {
  try {
    const tournamentId = req.params.id || req.params.tournamentId;
    const { groups, round } = req.body;

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    if (!isTournamentHost(tournament, req.user._id)) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can create tournament rounds'
      });
    }
    if (competitionMutationBlocked(tournament)) {
      return res.status(409).json({
        success: false,
        message: 'Rounds cannot be created after the tournament is completed, cancelled, or published'
      });
    }

    const roundNumber = parseStrictInteger(round);
    if (!Array.isArray(groups) || groups.length === 0 || !Number.isInteger(roundNumber) || roundNumber < 2) {
      return res.status(400).json({
        success: false,
        message: 'Valid groups and round are required'
      });
    }

    if (roundNumber !== Number(tournament.currentRound || 1) + 1
      || roundNumber > Number(tournament.totalRounds || 1)
      || (tournament.groups || []).some((group) => Number(group.round) === roundNumber)
      || (tournament.matches || []).some((match) => Number(match.round) === roundNumber)) {
      return res.status(409).json({ success: false, message: 'This round cannot be created or overwritten' });
    }
    const normalizedGroupPayload = normalizeRoundGroupsInput(groups);
    if (normalizedGroupPayload.error) {
      return res.status(400).json({ success: false, message: normalizedGroupPayload.error });
    }
    const inputGroups = normalizedGroupPayload.groups;
    const coverage = submittedRoundCoverage(tournament, roundNumber - 1);
    const qualifiedIds = new Set(coverage.qualifiedIds);
    const assignedIds = inputGroups.flatMap((group) => (
      group.participants.map((participant) => idString(participant.teamId))
    ));
    if (!coverage.complete || qualifiedIds.size === 0
      || assignedIds.length !== qualifiedIds.size
      || new Set(assignedIds).size !== assignedIds.length
      || assignedIds.some((teamId) => !qualifiedIds.has(teamId))) {
      return res.status(409).json({
        success: false,
        message: 'Round groups must contain every server-qualified team exactly once'
      });
    }

    // Clear existing groups for this round before creating new ones
    tournament.groups = tournament.groups.filter(group => Number(group.round) !== roundNumber);
    
    // Clear existing group results for this round
    if (tournament.groupResults) {
      tournament.groupResults = tournament.groupResults.filter(result => Number(result.round) !== roundNumber);
    }

    // Add new groups to the tournament
    const newGroups = inputGroups.map(group => ({
      name: group.name,
      round: roundNumber,
      participants: group.participants.map((participant) => participant.teamId)
    }));

    tournament.groups.push(...newGroups);
    tournament.currentRound = roundNumber;

    const createdTournament = await Tournament.findOneAndUpdate(
      {
        _id: tournament._id,
        host: req.user._id,
        currentRound: roundNumber - 1,
        status: { $nin: ['Completed', 'Cancelled'] },
        'finalResult.generatedAt': null,
        ...tournamentRevisionFilter(tournament)
      },
      {
        $set: {
          groups: tournament.groups,
          groupResults: tournament.groupResults,
          currentRound: roundNumber
        }
      },
      { new: true, runValidators: true }
    );
    if (!createdTournament) {
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_ROUND_CONFLICT',
        message: 'Tournament round changed while creating groups. Refresh and try again.'
      });
    }
    await emitTournamentUpdated(req, createdTournament._id);

    res.json({
      success: true,
      message: `Round ${round} created successfully with ${inputGroups.length} groups`,
      data: {
        groups: newGroups,
        totalGroups: inputGroups.length,
        round: round
      }
    });

  } catch (error) {
    log.error('Error creating Round 2:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to create Round 2',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Auto assign Round 2 with full functionality (groups, broadcast, results)
const autoAssignRound2 = async (req, res) => {
  try {
    const { id } = req.params;
    const { groups, round, qualifiedTeams } = req.body;

    log.debug('Auto assign Round 2 - Request received:', {
      tournamentId: id,
      groupsCount: groups?.length,
      round,
      qualifiedTeamsCount: qualifiedTeams?.length
    });

    // Validate tournament ID
    if (!id) {
      log.error('Auto assign Round 2 - Tournament ID missing');
      return res.status(400).json({
        success: false,
        message: 'Tournament ID is required'
      });
    }

    if (!Array.isArray(groups) || groups.length === 0) {
      log.error('Auto assign Round 2 - Groups data invalid:', { error: String(groups) });
      return res.status(400).json({
        success: false,
        message: 'Groups data is required and must be an array'
      });
    }
    if (!Array.isArray(qualifiedTeams)) {
      log.error('Auto assign Round 2 - Qualified teams data invalid:', { error: String(qualifiedTeams) });
      return res.status(400).json({
        success: false,
        message: 'Qualified teams data is required'
      });
    }

    if (process.env.NODE_ENV === 'development') { console.log('Auto assign Round 2 - Looking for tournament with ID:', id);}
    const tournament = await Tournament.findById(id);
    if (!tournament) {
      log.error('Auto assign Round 2 - Tournament not found for ID:', { error: String(id) });
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    if (!isTournamentHost(tournament, req.user._id)) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can auto-assign tournament rounds'
      });
    }
    if (competitionMutationBlocked(tournament)) {
      return res.status(409).json({
        success: false,
        message: 'Rounds cannot be created after the tournament is completed, cancelled, or published'
      });
    }

    // Perform strict nested validation only after authorization so malformed
    // requests cannot be used to probe a tournament the caller does not own.
    const normalizedGroupPayload = normalizeRoundGroupsInput(groups);
    const normalizedQualifiedTeams = normalizeCompetitionList(qualifiedTeams);
    if (normalizedGroupPayload.error || !normalizedQualifiedTeams) {
      return res.status(400).json({
        success: false,
        message: normalizedGroupPayload.error || 'Qualified teams must contain valid team IDs'
      });
    }
    const inputGroups = normalizedGroupPayload.groups;
    const qualifiedTeamIds = normalizedQualifiedTeams.map((team) => team.teamId);

    const roundNumber = parseStrictInteger(round);
    const configuredRounds = Math.max(1, Number(tournament.totalRounds) || 1);
    if (!Number.isInteger(roundNumber)
      || roundNumber !== Number(tournament.currentRound || 1) + 1
      || roundNumber > configuredRounds) {
      return res.status(409).json({
        success: false,
        message: 'Tournament cannot advance beyond its configured round lifecycle'
      });
    }
    const previousCoverage = submittedRoundCoverage(tournament, roundNumber - 1);
    const serverQualifiedIds = new Set(previousCoverage.qualifiedIds);
    const qualifiedIdSet = new Set(qualifiedTeamIds.map(idString));
    if (!previousCoverage.complete
      || serverQualifiedIds.size === 0
      || qualifiedIdSet.size !== serverQualifiedIds.size
      || Array.from(qualifiedIdSet).some((teamId) => !serverQualifiedIds.has(teamId))) {
      return res.status(409).json({
        success: false,
        message: 'Every current-round group must submit results before advancement'
      });
    }
    const assignedIds = inputGroups.flatMap((group) => group.participants.map(
      (participant) => idString(participant.teamId)
    ));
    if (assignedIds.length !== qualifiedIdSet.size
      || new Set(assignedIds).size !== assignedIds.length
      || assignedIds.some((teamId) => !qualifiedIdSet.has(teamId))) {
      return res.status(400).json({
        success: false,
        message: 'Round groups must contain every qualified team exactly once'
      });
    }

    if (process.env.NODE_ENV === 'development') { console.log('Auto assign Round 2 - Tournament found:', tournament.name);
}
    // Clear existing Round 2 groups before creating new ones
    tournament.groups = tournament.groups.filter(group => Number(group.round) !== roundNumber);
    
    // Clear existing Round 2 group results
    if (tournament.groupResults) {
      tournament.groupResults = tournament.groupResults.filter(result => Number(result.round) !== roundNumber);
    }

    // Add new groups to the tournament
    const newGroups = inputGroups.map(group => ({
      name: group.name,
      round: roundNumber,
      participants: group.participants.map(participant => participant.teamId)
    }));

    tournament.groups.push(...newGroups);
    tournament.currentRound = roundNumber;

    // Create broadcast message for Round 2
    if (process.env.NODE_ENV === 'development') { console.log('Auto assign Round 2 - Creating broadcast message');}
    const broadcastMessage = {
      type: 'round_start',
      title: `Round ${roundNumber} Started!`,
      message: `Round ${roundNumber} has begun with ${inputGroups.length} groups. ${qualifiedTeamIds.length} qualified teams are competing!`,
      timestamp: new Date(),
      round: roundNumber
    };

    // Persist the announcement in the canonical tournament message history.
    // `broadcasts` is not a Tournament schema path and was silently discarded
    // by Mongoose, leaving the UI response out of sync after refresh.
    if (!tournament.tournamentMessages) tournament.tournamentMessages = [];
    tournament.tournamentMessages.push({
      sender: req.user._id,
      message: broadcastMessage.message,
      timestamp: broadcastMessage.timestamp,
      type: 'announcement'
    });

    if (!tournament.broadcastChannels) tournament.broadcastChannels = [];
    tournament.broadcastChannels = tournament.broadcastChannels.filter(
      (channel) => Number(channel.round || 1) !== roundNumber
    );
    tournament.broadcastChannels.push(...newGroups.map((group) => ({
      name: `Round ${roundNumber} - ${group.name}`,
      type: 'Text Messages',
      description: `Broadcast channel for ${group.name} in Round ${roundNumber}`,
      groupId: group.name,
      round: roundNumber,
      channelId: null
    })));

    // Initialize group results for Round 2
    if (process.env.NODE_ENV === 'development') { console.log('Auto assign Round 2 - Creating group results');}
    const groupResults = inputGroups.map(group => ({
      groupId: group.name,
      groupName: group.name,
      round: roundNumber,
      teams: group.participants.map(participant => ({
        teamId: participant.teamId,
        teamName: participant.teamName,
        wins: 0,
        finishPoints: 0,
        positionPoints: 0,
        totalPoints: 0,
        rank: 0,
        qualified: false
      })),
      submittedAt: null,
      isSubmitted: false
    }));

    // Add group results to tournament
    if (!tournament.groupResults) {
      tournament.groupResults = [];
    }
    tournament.groupResults.push(...groupResults);

    if (process.env.NODE_ENV === 'development') { console.log('Auto assign Round 2 - Saving tournament');}
    const advancedTournament = await Tournament.findOneAndUpdate(
      {
        _id: tournament._id,
        host: req.user._id,
        currentRound: roundNumber - 1,
        status: { $nin: ['Completed', 'Cancelled'] },
        'finalResult.generatedAt': null,
        ...tournamentRevisionFilter(tournament)
      },
      {
        $set: {
          groups: tournament.groups,
          groupResults: tournament.groupResults,
          broadcastChannels: tournament.broadcastChannels,
          tournamentMessages: tournament.tournamentMessages,
          currentRound: roundNumber
        }
      },
      { new: true, runValidators: true }
    );
    if (!advancedTournament) {
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_ROUND_CONFLICT',
        message: 'Tournament round changed while auto-assigning groups. Refresh and try again.'
      });
    }
    emitTournamentBroadcast(
      req,
      advancedTournament,
      'round_started',
      broadcastMessage.message,
      [advancedTournament.host, ...qualifiedTeamIds]
    );
    await notifyTournamentRecipients({
      tournament: advancedTournament,
      recipients: qualifiedTeamIds,
      sender: req.user._id,
      title: `New Round Started: ${advancedTournament.name}`,
      message: `Round ${roundNumber} has started! Check your new group and broadcast channel.`,
      eventType: 'tournament_round_started',
      revision: `${advancedTournament.updatedAt || ''}:round:${roundNumber}`,
      extraData: { round: roundNumber }
    });
    await emitTournamentUpdated(req, advancedTournament._id);
    if (process.env.NODE_ENV === 'development') { console.log('Auto assign Round 2 - Tournament saved successfully');
}
    res.json({
      success: true,
      message: `Round ${round} created successfully with full functionality!`,
      data: {
        groups: newGroups,
        totalGroups: inputGroups.length,
        round: round,
        qualifiedTeams: qualifiedTeamIds.length,
        broadcast: broadcastMessage,
        groupResults: groupResults
      }
    });

  } catch (error) {
    log.error('Auto assign Round 2 - Error:', { error: String(error) });
    console.error('Auto assign Round 2 - Error stack:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to auto assign Round 2',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Open registration for a tournament
const openRegistration = async (req, res) => {
  try {
    const { id: tournamentId } = req.params;
    const userId = req.user._id.toString();
    
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }
    
    // Check if user is the host
    if (tournament.host.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Only the host can open registration'
      });
    }

    const now = new Date();
    const effectivePhase = getTournamentPhase(tournament, now);
    if (effectivePhase === 'Registration Open') {
      // Safe recovery path for a request retried after the state commit but
      // before queue acknowledgement. The stable delivery key prevents
      // duplicate in-app rows and push attempts.
      await enqueueRegistrationOpenedNotifications(tournament).catch((notificationError) => {
        log.error('Failed to recover registration-open notifications', {
          tournamentId: idString(tournament._id),
          error: String(notificationError)
        });
      });
      return res.status(200).json({
        success: true,
        message: 'Tournament registration is already open'
      });
    }
    if (!['Upcoming', 'Registration Open'].includes(tournament.status)
      || !['Upcoming Registration', 'Registration Closed'].includes(effectivePhase)) {
      return res.status(409).json({
        success: false,
        message: `Registration cannot be opened during ${effectivePhase}`
      });
    }
    
    // Update tournament status to Registration Open
    // Also update registrationStartDate to now so it moves out of "Upcoming Registration"
    const tournamentStart = new Date(tournament.tournamentStartDate || tournament.startDate || 0);
    if (Number.isNaN(tournamentStart.getTime()) || tournamentStart <= now) {
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_ALREADY_STARTED',
        message: 'Registration cannot open after the tournament start time'
      });
    }
    // Keep canonical and legacy deadline fields synchronized. Reopening with
    // a stale deadline otherwise succeeds but every join is rejected.
    let registrationEnd = new Date(tournament.registrationEndDate || tournament.registrationDeadline || 0);
    if (Number.isNaN(registrationEnd.getTime()) || registrationEnd <= now) {
      registrationEnd = tournamentStart;
    }
    if (registrationEnd > tournamentStart) registrationEnd = tournamentStart;
    const openedTournament = await Tournament.findOneAndUpdate(
      {
        _id: tournament._id,
        host: req.user._id,
        status: tournament.status,
        ...tournamentRevisionFilter(tournament)
      },
      {
        $set: {
          status: 'Registration Open',
          registrationStartDate: now,
          registrationEndDate: registrationEnd,
          registrationDeadline: registrationEnd
        }
      },
      { new: true, runValidators: true }
    );
    if (!openedTournament) {
      const latestTournament = await Tournament.findById(tournament._id)
        .select('name status registrationStartDate registrationEndDate registrationDeadline tournamentStartDate startDate updatedAt');
      if (latestTournament && getTournamentPhase(latestTournament) === 'Registration Open') {
        await enqueueRegistrationOpenedNotifications(latestTournament).catch((notificationError) => {
          log.error('Failed to recover registration-open notifications after conflict', {
            tournamentId: idString(latestTournament._id),
            error: String(notificationError)
          });
        });
        return res.status(200).json({
          success: true,
          message: 'Tournament registration is already open'
        });
      }
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_REGISTRATION_CONFLICT',
        message: 'Tournament state changed while opening registration. Refresh and try again.'
      });
    }
    await propagateStatusChange(openedTournament._id, 'Registration Open').catch((error) => {
      log.error('Failed to propagate open registration status', {
        tournamentId: idString(openedTournament._id),
        error: String(error)
      });
    });
    await emitTournamentBroadcast(
      req,
      openedTournament,
      'registration_opened',
      `Registration opened for "${openedTournament.name}"! Join now to participate.`
    );
    await emitTournamentUpdated(req, openedTournament._id);
    
    await enqueueRegistrationOpenedNotifications(openedTournament).catch((notificationError) => {
      // Realtime and the tournament state are already committed. Keep the
      // command successful; a retry takes the idempotent recovery branch.
      log.error('Failed to enqueue registration-open notifications', {
        tournamentId: idString(openedTournament._id),
        error: String(notificationError)
      });
    });
    
    res.status(200).json({
      success: true,
      message: 'Registration opened successfully'
    });
  } catch (error) {
    log.error('Error opening registration:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to open registration'
    });
  }
};

// Start tournament
const startTournament = async (req, res) => {
  try {
    const { id: tournamentId } = req.params;
    const userId = req.user._id.toString();
    
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }
    
    // Check if user is the host
    if (tournament.host.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Only the host can start tournament'
      });
    }

    const now = new Date();
    const effectivePhase = getTournamentPhase(tournament, now);
    // Idempotency is based on the persisted state, not the derived clock
    // phase. At the scheduled start instant the phase is already Ongoing even
    // when the stored status is still Upcoming/Registration Open; returning
    // here used to skip persistence and every tournament-start notification.
    if (tournament.status === 'Ongoing' && effectivePhase === 'Ongoing') {
      return res.status(200).json({ success: true, message: 'Tournament is already ongoing' });
    }
    if (!canTournamentStart(tournament, now)) {
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_CANNOT_START',
        message: `Tournament cannot start during ${effectivePhase}`
      });
    }
    
    // Claim the transition atomically so simultaneous Start requests cannot
    // emit duplicate broadcasts or push notifications.
    const startedTournament = await Tournament.findOneAndUpdate(
      {
        _id: tournament._id,
        host: req.user._id,
        status: tournament.status,
        ...tournamentRevisionFilter(tournament)
      },
      { $set: { status: 'Ongoing' } },
      { new: true, runValidators: true }
    );
    if (!startedTournament) {
      const latestTournament = await Tournament.findById(tournament._id).select('status');
      if (latestTournament?.status === 'Ongoing') {
        return res.status(200).json({ success: true, message: 'Tournament is already ongoing' });
      }
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_START_CONFLICT',
        message: 'Tournament state changed while starting. Refresh and try again.'
      });
    }
    await propagateStatusChange(startedTournament._id, 'Ongoing').catch((error) => {
      log.error('Failed to propagate started tournament status', {
        tournamentId: idString(startedTournament._id),
        error: String(error)
      });
    });

    // Send notification to all participants
    const participants = await expandTournamentRecipientIds([
      ...startedTournament.participants,
      ...startedTournament.teams
    ]);
    await emitTournamentBroadcast(
      req,
      startedTournament,
      'tournament_started',
      `Tournament "${startedTournament.name}" has started! Good luck to all participants.`,
      [startedTournament.host, ...participants]
    );
    await emitTournamentUpdated(req, startedTournament._id);
    await Promise.allSettled(participants.map(async (participantId) => {
      await createAndEmitNotification({
        recipient: participantId,
        sender: req.user._id,
        type: 'tournament',
        title: 'Tournament Started',
        message: `Tournament "${startedTournament.name}" has started! Good luck!`,
        data: {
          tournamentId: startedTournament._id,
          customData: {
            action: 'tournament_started',
            notificationDedupeKey: `tournament-started:${startedTournament._id}`,
            pushRequestId: `tournament-started:${startedTournament._id}`
          }
        }
      });
    }));
    
    res.status(200).json({
      success: true,
      message: 'Tournament started successfully'
    });
  } catch (error) {
    log.error('Error starting tournament:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to start tournament'
    });
  }
};

// -----------------------------------------------------------------------------
// Prize & Final Result Management
// -----------------------------------------------------------------------------

// Update prize distribution
const updatePrizeDistribution = async (req, res) => {
  try {
    const { prizeDistribution, specialPrizes } = req.body;
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({ success: false, message: 'Tournament not found' });
    }

    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Only host can update prize distribution' });
    }

    if (!['Ongoing', 'Completed'].includes(tournament.status)) {
      return res.status(409).json({ success: false, message: 'Prizes can only be finalized after the tournament starts' });
    }

    if (tournament.finalResult?.generatedAt) {
      return res.status(409).json({
        success: false,
        message: 'Prize distribution cannot change after final standings are published'
      });
    }

    const nextDistribution = prizeDistribution === undefined ? tournament.prizeDistribution : prizeDistribution;
    const nextSpecialPrizes = specialPrizes === undefined ? tournament.specialPrizes : specialPrizes;
    const prizeConfig = normalizeAndValidatePrizes({
      type: tournament.prizePoolType,
      pool: tournament.prizePool,
      distribution: nextDistribution,
      special: nextSpecialPrizes
    });
    if (prizeConfig.error) {
      return res.status(400).json({ success: false, message: prizeConfig.error });
    }

    tournament.prizeDistribution = prizeConfig.distribution;
    tournament.specialPrizes = prizeConfig.special;

    await tournament.save();
    await emitTournamentUpdated(req, tournament._id);

    res.status(200).json({
      success: true,
      message: 'Prize distribution updated successfully',
      data: {
        prizeDistribution: tournament.prizeDistribution,
        specialPrizes: tournament.specialPrizes
      }
    });
  } catch (error) {
    log.error('Error updating prize distribution:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to update prize distribution' });
  }
};

// Generate final result by compiling overall standings
const generateFinalResult = async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({ success: false, message: 'Tournament not found' });
    }

    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Only host can generate final result' });
    }

    if (!['Ongoing', 'Completed'].includes(tournament.status)) {
      return res.status(409).json({
        success: false,
        message: 'Final results can only be generated after the tournament starts'
      });
    }

    const configuredFinalRound = Math.max(1, Number(tournament.totalRounds) || 1);
    if (Number(tournament.currentRound || 1) !== configuredFinalRound) {
      return res.status(409).json({
        success: false,
        message: `Final results can only be generated after Round ${configuredFinalRound}`
      });
    }
    if (tournament.finalResult?.generatedAt) {
      return res.status(409).json({ success: false, message: 'Final result has already been generated' });
    }
    const finalRoundGroups = (tournament.groups || []).filter(
      (group) => Number(group.round || 1) === configuredFinalRound && (group.participants || []).length > 0
    );
    const finalRoundResults = (tournament.groupResults || []).filter(
      (result) => Number(result.round) === configuredFinalRound
        && (result.teams || []).length > 0
        && isPublishedTournamentGroupResult(result)
    );
    const missingOrIncompleteGroup = finalRoundGroups.some((group) => {
      const result = finalRoundResults.find((candidate) => (
        String(candidate.groupName) === String(group.name)
        || String(candidate.groupId) === String(group.name)
        || String(candidate.groupId) === idString(group._id)
      ));
      if (!result) return true;
      const expectedIds = new Set((group.participants || []).map(idString));
      const resultIds = (result.teams || []).map((team) => idString(team.teamId));
      return resultIds.length !== expectedIds.size
        || new Set(resultIds).size !== resultIds.length
        || resultIds.some((teamId) => !expectedIds.has(teamId));
    });
    if (finalRoundResults.length === 0 || missingOrIncompleteGroup) {
      return res.status(409).json({
        success: false,
        message: 'Publish results for every final-round group before generating final standings'
      });
    }

    // Combine all round group results to get overall standings
    const teamStats = {};

    tournament.groupResults.forEach(groupResult => {
      groupResult.teams.forEach(team => {
        const teamId = team.teamId.toString();
        
        if (!teamStats[teamId]) {
          teamStats[teamId] = {
            teamId: team.teamId,
            teamName: team.teamName,
            teamLogo: team.teamLogo,
            totalPoints: 0,
            wins: 0,
            finishPoints: 0,
            positionPoints: 0
          };
        }
        
        teamStats[teamId].totalPoints += (team.totalPoints || 0);
        teamStats[teamId].wins += (team.wins || 0);
        teamStats[teamId].finishPoints += (team.finishPoints || 0);
        teamStats[teamId].positionPoints += (team.positionPoints || 0);
      });
    });

    // Convert to array and sort by total points
    const standings = Object.values(teamStats).sort((a, b) => b.totalPoints - a.totalPoints);
    
    // Assign ranks and prize money based on prize distribution
    standings.forEach((team, index) => {
      team.rank = index + 1;
      
      const prizeSplit = tournament.prizeDistribution.find(p => p.rank === team.rank);
      team.prizeAmount = prizeSplit ? prizeSplit.amount : 0;
    });

    const generatedAt = new Date();
    const finalResult = {
      standings,
      specialPrizeWinners: tournament.specialPrizes,
      generatedAt
    };

    // Claim publication atomically. Previously two host requests could both
    // pass the generatedAt check, save different standings, and emit duplicate
    // completion notifications. updatedAt also acts as a compare-and-swap so
    // a concurrent result edit cannot be overwritten by a stale calculation.
    const generatedTournament = await Tournament.findOneAndUpdate(
      {
        _id: tournament._id,
        host: req.user._id,
        status: { $in: ['Ongoing', 'Completed'] },
        'finalResult.generatedAt': null,
        ...(tournament.updatedAt ? { updatedAt: tournament.updatedAt } : {})
      },
      {
        $set: {
          finalResult,
          status: 'Completed'
        }
      },
      { new: true, runValidators: true }
    );
    if (!generatedTournament) {
      return res.status(409).json({
        success: false,
        code: 'TOURNAMENT_FINAL_RESULT_CONFLICT',
        message: 'Tournament results changed or final standings were already generated. Refresh and try again.'
      });
    }

    await emitTournamentUpdated(req, generatedTournament._id);
    await releaseHostActiveTournament(generatedTournament.host, generatedTournament._id);

    // Propagate final results and status to player history (non-blocking)
    try {
      await propagateFinalResult(generatedTournament);
      await propagateStatusChange(generatedTournament._id, 'Completed');
    } catch (historyErr) {
      log.error('[generateFinalResult] Failed to propagate results to player history:', { error: String(historyErr) });
    }

    await notifyTournamentRecipients({
      tournament: generatedTournament,
      recipients: [...generatedTournament.participants, ...generatedTournament.teams],
      sender: req.user._id,
      title: `Final Results: ${generatedTournament.name}`,
      message: 'The final tournament standings are now available.',
      eventType: 'tournament_final_results',
      revision: generatedTournament.finalResult.generatedAt
    });

    res.status(200).json({
      success: true,
      message: 'Final result generated successfully',
      data: { finalResult: generatedTournament.finalResult }
    });
  } catch (error) {
    log.error('Error generating final result:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to generate final result' });
  }
};

// Assign special prize winner
const assignSpecialPrize = async (req, res) => {
  try {
    const { category, winnerId, winnerName } = req.body;
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({ success: false, message: 'Tournament not found' });
    }

    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Only host can assign special prizes' });
    }

    if (!['Ongoing', 'Completed'].includes(tournament.status)) {
      return res.status(409).json({ success: false, message: 'Special prizes can only be assigned after the tournament starts' });
    }

    const prizeIndex = tournament.specialPrizes.findIndex(p => p.category === category);
    if (prizeIndex === -1) {
      return res.status(404).json({ success: false, message: 'Special prize category not found' });
    }

    const eligibleIds = new Set([
      ...(tournament.participants || []).map(idString),
      ...(tournament.teams || []).map(idString)
    ]);
    if (!winnerId || !eligibleIds.has(idString(winnerId))) {
      return res.status(400).json({ success: false, message: 'Special prize winner must be a registered participant' });
    }

    tournament.specialPrizes[prizeIndex].winnerId = winnerId;
    tournament.specialPrizes[prizeIndex].winnerName = winnerName;

    // Optional: update finalResult if it exists
    if (tournament.finalResult && tournament.finalResult.specialPrizeWinners) {
      const frIndex = tournament.finalResult.specialPrizeWinners.findIndex(p => p.category === category);
      if (frIndex !== -1) {
        tournament.finalResult.specialPrizeWinners[frIndex].winnerId = winnerId;
        tournament.finalResult.specialPrizeWinners[frIndex].winnerName = winnerName;
      }
    }

    await tournament.save();
    await emitTournamentUpdated(req, tournament._id);

    // Propagate special prize to player history (non-blocking)
    try {
      await propagateSpecialPrize(tournament._id, winnerId, tournament.specialPrizes[prizeIndex].amount);
    } catch (historyErr) {
      log.error('[assignSpecialPrize] Failed to propagate special prize to player history:', { error: String(historyErr) });
    }

    res.status(200).json({
      success: true,
      message: 'Special prize assigned successfully',
      data: { specialPrizes: tournament.specialPrizes }
    });
  } catch (error) {
    log.error('Error assigning special prize:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to assign special prize' });
  }
};

// ── Get hosting limits for current user ──────────────────────────────────────
const getHostingLimits = async (req, res) => {
  try {
    const hostId = req.user._id;
    const { isVerifiedHost: isVerified } = await getFreshHostPermissions(hostId);

    if (isVerified) {
      return res.json({
        success: true,
        data: {
          tournament: { allowed: true, isVerified: true },
          scrim: { allowed: true, isVerified: true }
        }
      });
    }

    // Tournament: one active fun tournament at a time for unverified hosts.
    const activeTournament = await getActiveTournamentForHost(hostId);
    const tournamentAllowed = !activeTournament;

    // Scrim: 5 per day
    const Scrim = require('../models/Scrim');
    const { start: startOfDay, end: nextDay } = getTimezoneDayBounds('Asia/Kolkata');
    const todayScrimCount = await Scrim.countDocuments({
      host: hostId,
      createdAt: { $gte: startOfDay, $lt: nextDay }
    });
    const scrimAllowed = todayScrimCount < 5;
    const scrimNextAt = scrimAllowed ? null : nextDay;

    return res.json({
      success: true,
      data: {
        tournament: {
          allowed: tournamentAllowed,
          isVerified: false,
          used: activeTournament ? 1 : 0,
          limit: 1,
          period: 'active_tournament',
          activeTournamentId: activeTournament?._id || null,
          activeTournamentName: activeTournament?.name || null,
          nextAllowedAt: null
        },
        scrim: {
          allowed: scrimAllowed,
          isVerified: false,
          used: todayScrimCount,
          limit: 5,
          period: 'day',
          nextAllowedAt: scrimNextAt
        }
      }
    });
  } catch (error) {
    log.error('Get hosting limits error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to get hosting limits' });
  }
};

module.exports = {
  createTournament,
  getTournaments,
  getTournament,
  getTournamentByName,
  updateTournament,
  joinTournament,
  joinDuoTournament,
  leaveTournament,
  leaveTournamentAsTeam,
  autoAssignGroups,
  startTournament,
  deleteTournament,
  cancelTournament,
  scheduleMatches,
  createMatchSchedule,
  updateMatchSchedule,
  getTournamentSchedule,
  configureScheduleSettings,
  deleteMatchFromSchedule,
  deleteRoundSchedule,
  updateMatchResult,
  startMatch,
  getTournamentParticipants,
  removeParticipant,
  assignParticipantToGroup,
  updateRoundSettings,
  recreateGroups,
  submitGroupResults,
  getRoundResults,
  broadcastSchedule,
  qualifyTeams,
  createNextRoundGroups,
  getQualificationStatus,
  saveQualificationSettings,
  getQualificationSettings,
  createRound2,
  autoAssignRound2,
  openRegistration,
  sendTournamentMessage,
  sendGroupMessage,
  getTournamentMessages,
  getGroupMessages,
  deleteTournamentMessage,
  deleteGroupMessage,
  updatePrizeDistribution,
  generateFinalResult,
  assignSpecialPrize,
  getHostingLimits,
  _private: {
    isTournamentHost,
    getSocketIo,
    emitTournamentUpdated,
    emitTournamentBroadcast,
    sendTournamentUploadError,
    withViewerTournamentContext,
    withoutViewerTournamentContext,
    isDirectTournamentParticipant,
    canReadTournamentMessages,
    canReadGroupMessages,
    sanitizeTournamentMessages,
    attachViewerMessageHistory,
    enqueueRegistrationOpenedNotifications,
    normalizeTournamentMessageType,
    notificationRecipientId,
    parseEmbeddedArrayIndex,
    parseStrictInteger,
    alphabeticGroupLabel,
    normalizeRoundGroupsInput,
    normalizeCompetitionList,
    tournamentResultTeamDto,
    competitionMutationBlocked,
    tournamentRevisionFilter,
    createHistoryEntryForPlayer,
    createHistoryEntriesForTeam,
    isTerminalTournament,
    isTournamentBeforeStart,
    isTournamentCode
  }
};
