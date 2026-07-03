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
const {
  minimalTournamentUser,
  sanitizePublicTournament
} = require('../utils/tournamentPublicDto');

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

const uniqueNotificationRecipients = (values = []) =>
  Array.from(new Set(values.map((value) => String(value?._id || value)).filter(Boolean)));

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
  
  // If tournament is not completed, check based on status
  if (tournament.status !== 'Completed') {
    return tournament.status === 'Upcoming' || tournament.status === 'Registration Open' || tournament.status === 'Ongoing';
  }
  
  // If completed, check if within 5 days of end date
  const endDate = tournament.tournamentEndDate ? new Date(tournament.tournamentEndDate) : new Date(tournament.endDate);
  const now = new Date();
  const daysSinceEnd = (now - endDate) / (1000 * 60 * 60 * 24); // Convert to days
  
  return daysSinceEnd <= 5;
};

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

const ACTIVE_TOURNAMENT_STATUSES = ['Upcoming', 'Registration Open', 'Ongoing'];
const MAX_GENERATED_MATCHES_PER_ROUND = 512;
const PUBLIC_TOURNAMENT_SELECT = '-groupMessages -tournamentMessages';
const PUBLIC_TEAM_POPULATE = {
  path: 'teams',
  select: 'username userType profile.displayName profile.avatar'
};
const AUTHORIZED_TEAM_POPULATE = {
  path: 'teams',
  select: 'username userType profile.displayName profile.avatar teamInfo.members.user teamInfo.members.role',
  populate: {
    path: 'teamInfo.members.user',
    select: 'username userType profile.displayName profile.avatar'
  }
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

const withViewerTournamentContext = (safeTournament, sourceTournament, userId, activeTeamIds = []) => {
  if (!safeTournament) return safeTournament;
  if (!userId) return publicTournamentViewerShape(safeTournament);
  const viewerId = idString(userId);
  const activeTeamSet = new Set((activeTeamIds || []).map(idString));
  const registeredTeam = (sourceTournament?.teams || []).find((team) => {
    const teamId = idString(team);
    return teamId === viewerId || activeTeamSet.has(teamId);
  });
  const isHost = idString(sourceTournament?.host) === viewerId;
  const isDirect = (sourceTournament?.participants || [])
    .some((participant) => idString(participant) === viewerId);
  const registeredTeamId = registeredTeam ? idString(registeredTeam) : null;
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
    teams,
    ...(broadcastChannels ? { broadcastChannels } : {}),
    viewerParticipation: Boolean(isDirect || registeredTeam),
    viewerRole: isHost ? 'host' : registeredTeam ? 'team-member' : isDirect ? 'participant' : null,
    viewerRegisteredTeamId: registeredTeamId,
    viewerCanWithdraw: Boolean(isDirect || registeredTeam)
  };
};

const getSocketIo = (req) => req?.app?.get?.('io') || global._arcSocketIO || null;

const loadPublicTournament = async (tournamentId) => Tournament.findById(tournamentId)
  .select(PUBLIC_TOURNAMENT_SELECT)
  .populate('host', 'username profile.displayName profile.avatar')
  .populate('participants', 'username profile.displayName profile.avatar')
  .populate(PUBLIC_TEAM_POPULATE)
  .populate('groups.participants', 'username profile.displayName profile.avatar')
  .populate('matches.team1', 'username profile.displayName profile.avatar')
  .populate('matches.team2', 'username profile.displayName profile.avatar')
  .populate('matches.winner', 'username profile.displayName profile.avatar')
  .populate('winners.team', 'username profile.displayName profile.avatar');

const emitTournamentUpdated = async (req, tournamentId) => {
  const io = getSocketIo(req);
  if (!io || !tournamentId) return null;
  try {
    const tournament = await loadPublicTournament(tournamentId);
    if (!tournament) return null;
    const payload = sanitizePublicTournament(processTournament(tournament));
    io.emit('tournament_updated', publicTournamentViewerShape(payload));
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
    if (teamIds.length > 0) {
      const membershipTeams = await User.find({ _id: { $in: teamIds }, userType: 'team', isActive: true })
        .select('teamInfo.members.user')
        .lean();
      membershipTeams.forEach((team) => {
        (team.teamInfo?.members || []).forEach((member) => {
          addRecipient(member.user, team._id);
        });
      });
    }
    recipientTeams.forEach((activeTeamIds, memberId) => {
      io.to(`user-${memberId}`).emit(
        'tournament_updated',
        withViewerTournamentContext(payload, tournament, memberId, activeTeamIds)
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
    || amounts.some((amount) => !Number.isFinite(amount) || amount < 0)
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
    && (result.isSubmitted === true || (result.teams || []).every((team) => Number(team.rank) > 0))
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
  const host = await User.findById(hostId).select('isVerifiedHost').lean();
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
  return Tournament.findOne(query).select('_id name status').lean();
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

    const lockedTournament = await Tournament.findById(existingLock.tournament).select('_id name status').lean();
    if (!lockedTournament || !ACTIVE_TOURNAMENT_STATUSES.includes(lockedTournament.status)) {
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

/**
 * createHistoryEntriesForTeam(tournament, team)
 * Finds the roster matching tournament.game, filters active players,
 * and pushes a Tournament_History_Entry to each player's tournamentHistory.
 * Returns the count of entries actually created (modifiedCount > 0).
 */
const createHistoryEntriesForTeam = async (tournament, team) => {
  if (!team.teamInfo || !team.teamInfo.rosters) return 0;

  const roster = team.teamInfo.rosters.find(r => r.game === tournament.game);
  if (!roster || !roster.players || roster.players.length === 0) return 0;

  const activePlayers = roster.players.filter(p => p.isActive !== false);
  if (activePlayers.length === 0) return 0;

  const entry = {
    tournamentId:        tournament._id,
    teamId:              team._id,
    teamName:            team.profile.displayName,
    game:                tournament.game,
    tournamentName:      tournament.name,
    tournamentStartDate: tournament.startDate || tournament.tournamentStartDate,
    tournamentEndDate:   tournament.endDate   || tournament.tournamentEndDate,
    status:              tournament.status,
    joinedAt:            new Date()
  };

  let created = 0;
  for (const player of activePlayers) {
    if (!player.user) continue;
    const result = await User.updateOne(
      {
        _id: player.user,
        'playerInfo.tournamentHistory': {
          $not: {
            $elemMatch: { tournamentId: tournament._id, teamId: team._id }
          }
        }
      },
      { $push: { 'playerInfo.tournamentHistory': entry } }
    );
    if (result.modifiedCount > 0) created++;
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

    const hostId = req.user._id;
    const validGames = ['BGMI', 'Valorant', 'Free Fire', 'Call of Duty Mobile'];
    const validModes = ['Battle Royale', 'Deathmatch', '5v5', 'Solo'];
    const validFormats = ['Solo', 'Duo', 'Squad', '5v5'];
    const normalizedPrizePoolType = normalizePrizePoolType(prizePoolType);
    const parsedPrizePool = prizePool !== undefined && String(prizePool).trim() !== ''
      ? parseFloat(prizePool)
      : 0;
    const parsedTotalSlots = parseInt(totalSlots, 10);
    const parsedTeamsPerGroup = parseInt(teamsPerGroup, 10);
    const parsedNumberOfGroups = numberOfGroups !== undefined && String(numberOfGroups).trim() !== ''
      ? parseInt(numberOfGroups, 10)
      : Math.ceil(parsedTotalSlots / parsedTeamsPerGroup);
    const totalRounds = req.body.totalRounds !== undefined && String(req.body.totalRounds).trim() !== ''
      ? parseInt(req.body.totalRounds, 10)
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

    if (Number.isNaN(parsedTotalSlots) || parsedTotalSlots < 4 || parsedTotalSlots > 128) {
      return res.status(400).json({ success: false, message: 'Total slots must be between 4 and 128' });
    }

    if (Number.isNaN(parsedTeamsPerGroup) || parsedTeamsPerGroup < 2 || parsedTeamsPerGroup > 100) {
      return res.status(400).json({ success: false, message: 'Teams per group must be between 2 and 100' });
    }

    if (parsedTeamsPerGroup > parsedTotalSlots) {
      return res.status(400).json({ success: false, message: 'Teams per group cannot exceed total slots' });
    }

    if (Number.isNaN(parsedNumberOfGroups) || parsedNumberOfGroups < 1) {
      return res.status(400).json({ success: false, message: 'At least one group is required' });
    }

    const expectedNumberOfGroups = Math.ceil(parsedTotalSlots / parsedTeamsPerGroup);
    if (parsedNumberOfGroups !== expectedNumberOfGroups) {
      return res.status(400).json({
        success: false,
        message: `Number of groups must be ${expectedNumberOfGroups} for this slot configuration`
      });
    }

    if (Number.isNaN(totalRounds) || totalRounds < 1 || totalRounds > 10) {
      return res.status(400).json({ success: false, message: 'Total rounds must be between 1 and 10' });
    }

    if (!['with_prize', 'without_prize'].includes(normalizedPrizePoolType)) {
      return res.status(400).json({ success: false, message: 'Invalid tournament prize type' });
    }

    // Validate dates
    const now = new Date();
    
    // Fallbacks
    const regStartStr = registrationStartDate || startDate || now;
    const regEndStr = registrationEndDate || registrationDeadline || new Date(now.getTime() + 86400000);
    const tourStartStr = tournamentStartDate || startDate || new Date(new Date(regEndStr).getTime() + 86400000);
    const tourEndStr = tournamentEndDate || endDate || new Date(new Date(tourStartStr).getTime() + 86400000);

    const regStart = new Date(regStartStr);
    const regEnd = new Date(regEndStr);
    const tourStart = new Date(tourStartStr);
    const tourEnd = new Date(tourEndStr);

    if ([regStart, regEnd, tourStart, tourEnd].some(date => Number.isNaN(date.getTime()))) {
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
    if (normalizedPrizePoolType === 'with_prize' && (Number.isNaN(parsedPrizePool) || parsedPrizePool < 100)) {
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
      timezone: timezone || 'UTC',
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
      status: 'Upcoming'
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
        name: `Group ${String.fromCharCode(65 + i)}`, // Group A, B, C, D
        round: 1,
        groupLetter: String.fromCharCode(65 + i),
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
      const channelName = `Group ${String.fromCharCode(65 + i)} - Round 1`;
      broadcastChannels.push({
        name: channelName,
        type: 'Text Messages',
        description: `Broadcast channel for Group ${String.fromCharCode(65 + i)} in Round 1`,
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
    const processedTournament = processTournament(tournament);

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
      return res.status(400).json({ success: false, message: error.message });
    }
    
    // Handle validation errors specifically
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validationErrors
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to create tournament',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
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

    const { status, game, format, filter } = req.query;
    const search = normalizeQuerySearch(
      req.query.search !== undefined ? req.query.search : req.query.q
    );
    const viewerUserId = req.user?.userType === 'guest' ? null : (req.user?._id || req.user?.id);
    const viewerTeamIds = viewerUserId ? await getActiveTeamIdsForUser(viewerUserId) : [];

    // Build filter object
    const queryFilter = {};
    const now = new Date();

    // Handle special filter for "recent" or "completed" tournaments
    if (filter === 'recent') {
      // Show completed tournaments from last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      queryFilter.status = 'Completed';
      queryFilter.$or = [
        { tournamentEndDate: { $gte: thirtyDaysAgo } },
        { endDate: { $gte: thirtyDaysAgo } }
      ];
    } else if (filter === 'completed') {
      queryFilter.status = 'Completed';
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
        { status: { $ne: 'Cancelled' } },
        {
          $or: [
            { status: { $in: ['Upcoming', 'Registration Open', 'Ongoing'] } },
            { status: 'Completed', tournamentEndDate: { $gte: thirtyDaysAgo } },
            { status: 'Completed', endDate: { $gte: thirtyDaysAgo } }
          ]
        }
      ];
    } else if (status) {
      queryFilter.status = status;
      // If filtering by "Registration Open", also check that registration deadline hasn't passed
      if (status === 'Registration Open') {
        queryFilter.$or = [
          { registrationDeadline: { $gte: now } },
          { registrationEndDate: { $gte: now } }
        ];
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

    let tournaments = await Tournament.find(queryFilter)
      .select(PUBLIC_TOURNAMENT_SELECT)
      .populate('host', 'username profile.displayName profile.avatar')
      .populate('participants', 'username profile.displayName profile.avatar')
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
      const refreshedFilter = { ...queryFilter };
      if (refreshedFilter.status === 'Registration Open') {
        refreshedFilter.registrationDeadline = { $gte: now };
      }
      
      tournaments = await Tournament.find(refreshedFilter)
        .select(PUBLIC_TOURNAMENT_SELECT)
        .populate('host', 'username profile.displayName profile.avatar')
        .populate('participants', 'username profile.displayName profile.avatar')
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
        // If filtering by "Registration Open", ensure deadline hasn't passed and tournament hasn't ended
        return tournament.status === 'Registration Open' && 
               new Date(tournament.registrationDeadline) >= now &&
               new Date(tournament.endDate) >= now;
      });
    }
    
    // Use final filtered tournaments
    const tournamentsToReturn = finalTournaments;
    
    const total = await Tournament.countDocuments(queryFilter);

    // Process tournaments to convert banner filenames to URLs
    const processedTournaments = tournamentsToReturn.map((tournament) => {
      const safeTournament = sanitizePublicTournament(processTournament(tournament));
      return withViewerTournamentContext(safeTournament, tournament, viewerUserId, viewerTeamIds);
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
      tournament = await Tournament.findOne({ tournamentCode: codeToSearch })
        .select(PUBLIC_TOURNAMENT_SELECT)
        .populate('host', 'username profile.displayName profile.avatar')
        .populate('participants', 'username profile.displayName profile.avatar')
        .populate(PUBLIC_TEAM_POPULATE)
        .populate('groups.participants', 'username profile.displayName profile.avatar')
        .populate('matches.team1', 'username profile.displayName profile.avatar')
        .populate('matches.team2', 'username profile.displayName profile.avatar')
        .populate('matches.winner', 'username profile.displayName profile.avatar')
        .populate('winners.team', 'username profile.displayName profile.avatar');
    } else {
      // Regular route - can be either code or ID
      // Check if it's a code format: TRN-XXX-XXXXXXXX (contains dashes)
      if (isTournamentCode(id)) {
        // Looks like a tournament code (format: TRN-BGM-A1B2C3D4)
        tournament = await Tournament.findOne({ tournamentCode: id.toUpperCase() })
          .select(PUBLIC_TOURNAMENT_SELECT)
          .populate('host', 'username profile.displayName profile.avatar')
          .populate('participants', 'username profile.displayName profile.avatar')
          .populate(PUBLIC_TEAM_POPULATE)
          .populate('groups.participants', 'username profile.displayName profile.avatar')
          .populate('matches.team1', 'username profile.displayName profile.avatar')
          .populate('matches.team2', 'username profile.displayName profile.avatar')
          .populate('matches.winner', 'username profile.displayName profile.avatar')
          .populate('winners.team', 'username profile.displayName profile.avatar');
        
        // Don't try findById if it's a code format - it will fail with CastError
      } else if (id && mongoose.Types.ObjectId.isValid(id)) {
        // Try as MongoDB ObjectId (only if it's a valid ObjectId format)
        tournament = await Tournament.findById(id)
          .select(PUBLIC_TOURNAMENT_SELECT)
          .populate('host', 'username profile.displayName profile.avatar')
          .populate('participants', 'username profile.displayName profile.avatar')
          .populate(PUBLIC_TEAM_POPULATE)
          .populate('groups.participants', 'username profile.displayName profile.avatar')
          .populate('matches.team1', 'username profile.displayName profile.avatar')
          .populate('matches.team2', 'username profile.displayName profile.avatar')
          .populate('matches.winner', 'username profile.displayName profile.avatar')
          .populate('winners.team', 'username profile.displayName profile.avatar');
      }
    }

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found. The link may be invalid or the tournament has been removed.'
      });
    }

    // Auto-mark as Completed if endDate has passed
    await checkAndMarkCompletedTournaments(tournament);
    
    // Refresh tournament from DB to get updated status
    tournament = await Tournament.findById(tournament._id)
      .select(PUBLIC_TOURNAMENT_SELECT)
      .populate('host', 'username profile.displayName profile.avatar')
      .populate('participants', 'username profile.displayName profile.avatar')
      .populate(PUBLIC_TEAM_POPULATE)
      .populate('groups.participants', 'username profile.displayName profile.avatar')
      .populate('matches.team1', 'username profile.displayName profile.avatar')
      .populate('matches.team2', 'username profile.displayName profile.avatar')
      .populate('matches.winner', 'username profile.displayName profile.avatar')
      .populate('winners.team', 'username profile.displayName profile.avatar');

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
    const viewerTeamIds = viewerUserId ? await getActiveTeamIdsForUser(viewerUserId) : [];
    const processedTournament = withViewerTournamentContext(
      sanitizePublicTournament(processTournament(tournament)),
      tournament,
      viewerUserId,
      viewerTeamIds
    );

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
      tournamentName: decodeURIComponent(tournamentName), 
      hostUsername: decodeURIComponent(hostUsername) 
    });
    
    const decodedHostUsername = decodeURIComponent(hostUsername);
    const host = await User.findOne({ username: decodedHostUsername, isActive: true })
      .select('_id')
      .lean();
    if (!host) {
      return res.status(404).json({ success: false, message: 'Tournament not found' });
    }

    // Tournament.host is an ObjectId reference; querying host.username on the
    // tournament document silently returned no records for this public route.
    const tournament = await Tournament.findOne({
      name: decodeURIComponent(tournamentName),
      host: host._id
    })
      .select(PUBLIC_TOURNAMENT_SELECT)
      .populate('host', 'username profile.displayName profile.avatar')
      .populate('participants', 'username profile.displayName profile.avatar')
      .populate(PUBLIC_TEAM_POPULATE)
      .populate('groups.participants', 'username profile.displayName profile.avatar')
      .populate('matches.team1', 'username profile.displayName profile.avatar')
      .populate('matches.team2', 'username profile.displayName profile.avatar')
      .populate('matches.winner', 'username profile.displayName profile.avatar')
      .populate('winners.team', 'username profile.displayName profile.avatar');

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
    const viewerTeamIds = viewerUserId ? await getActiveTeamIdsForUser(viewerUserId) : [];
    const processedTournament = withViewerTournamentContext(
      sanitizePublicTournament(processTournament(tournament)),
      tournament,
      viewerUserId,
      viewerTeamIds
    );

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
        return res.status(400).json({
          success: false,
          message: err.message
        });
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

        // Check if tournament can be edited (within 5 days of end if completed)
        if (!canEditTournament(tournament)) {
          return res.status(400).json({
            success: false,
            message: 'Cannot update tournament. Tournament has ended and the 5-day editing period has expired.'
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
        
        // The body can never select a server-side object key or URL.
        const oldBannerPath = req.file ? localTournamentBannerPath(tournament.banner) : null;
        const oldBannerPublicId = tournament.bannerPublicId || null;

        // Handle rules if it's a string (comma-separated)
        if (updateData.rules !== undefined && typeof updateData.rules === 'string') {
          updateData.rules = updateData.rules.split(',').map(rule => rule.trim()).filter(rule => rule);
        }

        const validGames = ['BGMI', 'Valorant', 'Free Fire', 'Call of Duty Mobile'];
        const validModes = ['Battle Royale', 'Deathmatch', '5v5', 'Solo'];
        const validFormats = ['Solo', 'Duo', 'Squad', '5v5'];
        const validStatuses = ['Upcoming', 'Registration Open', 'Ongoing', 'Completed', 'Cancelled'];
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
        const nextTotalSlots = updateData.totalSlots !== undefined ? parseInt(updateData.totalSlots) : tournament.totalSlots;
        const nextTeamsPerGroup = updateData.teamsPerGroup !== undefined ? parseInt(updateData.teamsPerGroup) : tournament.teamsPerGroup;
        const nextTotalRounds = updateData.totalRounds !== undefined ? parseInt(updateData.totalRounds) : tournament.totalRounds;
        if (Number.isNaN(nextTotalSlots) || nextTotalSlots < 4 || nextTotalSlots > 128) {
          return res.status(400).json({ success: false, message: 'Total slots must be between 4 and 128' });
        }
        if (Number.isNaN(nextTeamsPerGroup) || nextTeamsPerGroup < 2 || nextTeamsPerGroup > 100) {
          return res.status(400).json({ success: false, message: 'Teams per group must be between 2 and 100' });
        }
        if (nextTeamsPerGroup > nextTotalSlots) {
          return res.status(400).json({ success: false, message: 'Teams per group cannot exceed total slots' });
        }
        if (Number.isNaN(nextTotalRounds) || nextTotalRounds < 1 || nextTotalRounds > 10) {
          return res.status(400).json({ success: false, message: 'Total rounds must be between 1 and 10' });
        }
        const nextPrizePool = updateData.prizePool !== undefined
          ? parseFloat(updateData.prizePool)
          : (tournament.prizePool || 0);
        const nextNumberOfGroups = updateData.numberOfGroups !== undefined
          ? parseInt(updateData.numberOfGroups, 10)
          : Math.ceil(nextTotalSlots / nextTeamsPerGroup);
        if (Number.isNaN(nextNumberOfGroups) || nextNumberOfGroups < 1) {
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
        if (nextPrizePoolType === 'with_prize' && (Number.isNaN(nextPrizePool) || nextPrizePool < 100)) {
          return res.status(400).json({ success: false, message: 'Prize pool must be at least ₹100 for prize tournaments' });
        }

        const nextRegStart = new Date(updateData.registrationStartDate || updateData.startDate || tournament.registrationStartDate || tournament.startDate);
        const nextRegEnd = new Date(updateData.registrationEndDate || updateData.registrationDeadline || tournament.registrationEndDate || tournament.registrationDeadline);
        const nextTourStart = new Date(updateData.tournamentStartDate || updateData.startDate || tournament.tournamentStartDate || tournament.startDate);
        const nextTourEnd = new Date(updateData.tournamentEndDate || updateData.endDate || tournament.tournamentEndDate || tournament.endDate);
        if ([nextRegStart, nextRegEnd, nextTourStart, nextTourEnd].some(date => Number.isNaN(date.getTime()))) {
          return res.status(400).json({ success: false, message: 'Invalid tournament date' });
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
        }

        // Capture original values before update for history propagation
        const originalName = tournament.name;
        const originalStartDate = tournament.tournamentStartDate || tournament.startDate;
        const originalEndDate = tournament.tournamentEndDate || tournament.endDate;
        const originalStatus = tournament.status;

        const updatedTournament = await Tournament.findByIdAndUpdate(
          req.params.id,
          updateData,
          { new: true, runValidators: true }
        ).populate('host', 'username profile.displayName profile.avatar');

        if (!updatedTournament) {
          throw new Error('Tournament disappeared while it was being updated');
        }

        if (newBannerPublicId && oldBannerPublicId && oldBannerPublicId !== newBannerPublicId) {
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
        const processedTournament = processTournament(updatedTournament);

        await emitTournamentUpdated(req, updatedTournament._id);

        if (originalStatus !== updatedTournament.status && updatedTournament.status === 'Registration Open') {
          emitTournamentBroadcast(
            req,
            updatedTournament,
            'registration_opened',
            `Registration opened for "${updatedTournament.name}"! Join now to participate.`
          );
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
        res.status(500).json({
          success: false,
          message: 'Failed to update tournament',
          error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to update tournament',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
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
      ? await Tournament.findOne({ tournamentCode: id.toUpperCase() })
      : await Tournament.findById(id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    log.debug('Tournament found:', {
      id: tournament._id,
      name: tournament.name,
      status: tournament.status,
      currentParticipants: tournament.participants.length + tournament.teams.length,
      totalSlots: tournament.totalSlots
    });

    // Check if registration is open
    if (tournament.status !== 'Registration Open') {
      return res.status(400).json({
        success: false,
        message: `Tournament registration is not open. Current status: ${tournament.status}`
      });
    }

    // Check canonical and legacy deadline fields consistently.
    const registrationDeadline = new Date(tournament.registrationEndDate || tournament.registrationDeadline || 0);
    if (Number.isNaN(registrationDeadline.getTime()) || new Date() > registrationDeadline) {
      return res.status(400).json({
        success: false,
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
    const currentParticipants = tournament.participants.length + tournament.teams.length;
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
    const now = new Date();
    const registeredTournament = await Tournament.findOneAndUpdate(
      {
        _id: tournament._id,
        status: 'Registration Open',
        host: { $ne: userId },
        participants: { $ne: userId },
        teams: { $ne: userId },
        $and: [
          {
            $or: [
              { registrationEndDate: { $gte: now } },
              { registrationEndDate: null, registrationDeadline: { $gte: now } }
            ]
          },
          {
            $expr: {
              $lt: [
                { $add: [{ $size: { $ifNull: ['$participants', []] } }, { $size: { $ifNull: ['$teams', []] } }] },
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

    // Create history entries for team members (non-blocking)
    if (req.user.userType === 'team') {
      try {
        await createHistoryEntriesForTeam(registeredTournament, req.user);
      } catch (historyErr) {
        log.error('[joinTournament] Failed to create history entries:', { error: String(historyErr) });
        await removeHistoryEntriesForTeam(tournament._id, req.user._id);
      }
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
    let tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    const withdrawalDeadline = new Date(
      tournament.registrationEndDate || tournament.registrationDeadline || 0
    );
    if (tournament.status !== 'Registration Open'
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

    // Remove user from individual participants
    if (isIndividualParticipant) {
      tournament.participants = tournament.participants.filter(id => id.toString() !== userId.toString());
    }
    if (isTeamParticipant) {
      tournament.teams = tournament.teams.filter(id => id.toString() !== userId.toString());
    }
    removeParticipantFromCompetitionState(tournament, userId);

    await tournament.save();

    if (isTeamParticipant) {
      const registeredTeam = await User.findById(userId).select('teamInfo.members.user').lean();
      const memberIds = (registeredTeam?.teamInfo?.members || []).map((member) => member.user);
      if (memberIds.length > 0) {
        await Tournament.updateOne(
          { _id: tournament._id },
          { $pull: { duoRegistrationMembers: { $in: memberIds } } }
        );
      }
    }

    await emitTournamentUpdated(req, tournament._id);

    if (isTeamParticipant) {
      try {
        await removeHistoryEntriesForTeam(tournament._id, userId);
      } catch (historyErr) {
        log.error('[leaveTournament] Failed to remove direct team history entries:', { error: String(historyErr) });
      }
    }

    if (String(tournament.host) !== String(userId)) {
      await notifyTournamentRecipients({
        tournament,
        recipients: [tournament.host],
        sender: userId,
        title: 'Tournament Registration Withdrawn',
        message: `${req.user.profile?.displayName || req.user.username} left "${tournament.name}"`,
        eventType: 'tournament_registration_left',
        revision: tournament.updatedAt,
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
    let tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    const withdrawalDeadline = new Date(
      tournament.registrationEndDate || tournament.registrationDeadline || 0
    );
    if (tournament.status !== 'Registration Open'
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

    // Find the team and verify user is a member
    const team = await User.findById(teamId);
    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    // Check if user is a member of this team
    const isTeamMember = team.teamInfo?.members?.some((member) => (
      idString(member?.user) === idString(userId)
    ));

    if (!isTeamMember) {
      return res.status(400).json({
        success: false,
        message: 'You are not a member of this team'
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

    // Remove team from tournament
    tournament.teams = tournament.teams.filter(id => id.toString() !== teamId.toString());
    removeParticipantFromCompetitionState(tournament, teamId);

    await tournament.save();

    const teamMemberIds = (team.teamInfo?.members || []).map((member) => member.user);
    if (teamMemberIds.length > 0) {
      await Tournament.updateOne(
        { _id: tournament._id },
        { $pull: { duoRegistrationMembers: { $in: teamMemberIds } } }
      );
    }

    await emitTournamentUpdated(req, tournament._id);

    // Remove history entries for team members (non-blocking)
    try {
      await removeHistoryEntriesForTeam(tournament._id, teamId);
    } catch (historyErr) {
      log.error('[leaveTournamentAsTeam] Failed to remove history entries:', { error: String(historyErr) });
    }

    if (String(tournament.host) !== String(teamId)) {
      await notifyTournamentRecipients({
        tournament,
        recipients: [tournament.host],
        sender: teamId,
        title: 'Tournament Registration Withdrawn',
        message: `${team.profile?.displayName || team.username} left "${tournament.name}"`,
        eventType: 'tournament_registration_left',
        revision: tournament.updatedAt,
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

    if (!['Upcoming', 'Registration Open'].includes(tournament.status)
      || (tournament.matches || []).length > 0
      || (tournament.groupResults || []).some((result) => result.isSubmitted === true)) {
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
          groupLetter: String.fromCharCode(65 + i) // A, B, C, D...
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
    if (wasTeamEntry) {
      const removedTeam = await User.findById(participantId).select('teamInfo.members.user').lean();
      const memberIds = (removedTeam?.teamInfo?.members || []).map((member) => member.user);
      if (memberIds.length > 0) {
        await Tournament.updateOne(
          { _id: tournament._id },
          { $pull: { duoRegistrationMembers: { $in: memberIds } } }
        );
      }
    }
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
    if (!normalizedMessage || normalizedMessage.length > 1000) {
      return res.status(400).json({ success: false, message: 'Message must be between 1 and 1000 characters' });
    }

    // Initialize tournamentMessages array if it doesn't exist
    if (!tournament.tournamentMessages) {
      tournament.tournamentMessages = [];
    }

    // Add message to tournament messages
    const newMessage = {
      sender: req.user._id,
      message: normalizedMessage,
      type,
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
    if (!normalizedMessage || normalizedMessage.length > 1000) {
      return res.status(400).json({ success: false, message: 'Message must be between 1 and 1000 characters' });
    }

    const normalizedRound = parseInt(round, 10);
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
      type,
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

    const normalizedRound = Number.parseInt(round, 10);
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

    if (!tournament.tournamentMessages || tournament.tournamentMessages.length <= messageIndex) {
      return res.status(404).json({
        success: false,
        message: 'Message not found'
      });
    }

    tournament.tournamentMessages.splice(messageIndex, 1);
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

    const groupThread = tournament.groupMessages.find(
      gm => gm.groupId === groupId && gm.round === parseInt(round)
    );

    if (!groupThread || !groupThread.messages || groupThread.messages.length <= messageIndex) {
      return res.status(404).json({
        success: false,
        message: 'Message not found'
      });
    }

    groupThread.messages.splice(messageIndex, 1);
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
    const tournament = await Tournament.findById(req.params.id).select('+bannerPublicId');

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

    // Host can delete any tournament regardless of status
    // No status restrictions for deletion

    const recipients = await expandTournamentRecipientIds([...tournament.participants, ...tournament.teams]);
    await Tournament.findByIdAndDelete(req.params.id);
    if (tournament.bannerPublicId) {
      await deleteFile(tournament.bannerPublicId).catch((bannerCleanupError) => {
        log.warn('[deleteTournament] Failed to remove S3 banner', {
          error: String(bannerCleanupError),
          tournamentId: String(tournament._id)
        });
      });
    }
    await notifyTournamentRecipients({
      tournament,
      recipients,
      sender: req.user._id,
      title: `Tournament Deleted: ${tournament.name}`,
      message: 'This tournament has been deleted by the host.',
      eventType: 'tournament_deleted',
      revision: 'deleted'
    });

    res.status(200).json({
      success: true,
      message: 'Tournament deleted successfully'
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

    // Only allow cancellation if tournament hasn't ended
    if (tournament.status === 'Completed' || tournament.status === 'Cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Cannot cancel tournament that has already ended or been cancelled'
      });
    }

    // Update tournament status to cancelled
    tournament.status = 'Cancelled';
    await tournament.save();
    emitTournamentBroadcast(
      req,
      tournament,
      'tournament_cancelled',
      `Tournament "${tournament.name}" has been cancelled.`,
      [tournament.host, ...tournament.participants, ...tournament.teams]
    );
    await emitTournamentUpdated(req, tournament._id);
    await releaseHostActiveTournament(tournament.host, tournament._id);
    await notifyTournamentRecipients({
      tournament,
      recipients: [...tournament.participants, ...tournament.teams],
      sender: req.user._id,
      title: `Tournament Cancelled: ${tournament.name}`,
      message: 'This tournament has been cancelled by the host.',
      eventType: 'tournament_cancelled',
      revision: 'cancelled'
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
    if (tournament.status !== 'Ongoing') {
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
    const scheduleDate = scheduleStart.toISOString().slice(0, 10);
    const scheduleTimeString = scheduleStart.toTimeString().split(' ')[0].slice(0, 5);

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

    await tournament.save();
    await emitTournamentUpdated(req, tournament._id);

    res.status(200).json({
      success: true,
      message: 'Matches scheduled successfully',
      data: {
        matches: tournament.matches,
        totalRounds: tournament.totalRounds
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
    if (!['Upcoming', 'Registration Open', 'Ongoing'].includes(tournament.status)) {
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

    const roundNumber = Number.parseInt(round, 10) || 1;
    if (roundNumber < 1 || roundNumber > 10) {
      return res.status(400).json({ success: false, message: 'Invalid tournament round' });
    }
    if (roundNumber !== Number(tournament.currentRound || 1)
      || (tournament.groupResults || []).some(
        (result) => Number(result.round || 1) === roundNumber && result.isSubmitted === true
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

    const invalidMatch = matches.find((matchData) => {
      const scheduledTime = new Date(matchData?.scheduledTime);
      const duration = Number.parseInt(
        matchData?.matchDuration || tournament.scheduleConfig?.defaultMatchDuration || 30,
        10
      );
      return Number.isNaN(scheduledTime.getTime())
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

    // Create matches with detailed scheduling
    const newMatches = matches.map(matchData => {
      const scheduledTime = new Date(matchData.scheduledTime);
      const scheduledDate = scheduledTime.toISOString().split('T')[0];
      const scheduledTimeString = scheduledTime.toTimeString().split(' ')[0].substring(0, 5);

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
        matchDuration: Number.parseInt(
          matchData.matchDuration || tournament.scheduleConfig?.defaultMatchDuration || 30,
          10
        ),
        venue: matchData.venue || 'Online',
        description: matchData.description || '',
        createdBy: req.user._id,
        lastModifiedBy: req.user._id
      };
    });

    // Add new matches to tournament
    tournament.matches.push(...newMatches);
    await tournament.save();
    await emitTournamentUpdated(req, tournament._id);

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
    const { scheduledTime, venue, description, matchDuration } = req.body;
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
    if (!['Upcoming', 'Registration Open', 'Ongoing'].includes(tournament.status)) {
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
        (result) => Number(result.round || 1) === Number(match.round || 1) && result.isSubmitted === true
      )) {
      return res.status(409).json({
        success: false,
        message: 'Historical or completed round schedules are read-only'
      });
    }

    const parsedScheduledTime = scheduledTime ? new Date(scheduledTime) : null;
    if (parsedScheduledTime && Number.isNaN(parsedScheduledTime.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid match date or time' });
    }
    const parsedDuration = matchDuration !== undefined ? Number.parseInt(matchDuration, 10) : null;
    if (parsedDuration !== null && (!Number.isInteger(parsedDuration) || parsedDuration < 1 || parsedDuration > 1440)) {
      return res.status(400).json({ success: false, message: 'Match duration must be between 1 and 1440 minutes' });
    }

    // Store original time if rescheduling
    if (parsedScheduledTime && parsedScheduledTime.getTime() !== match.scheduledTime?.getTime()) {
      match.originalScheduledTime = match.scheduledTime;
      match.isRescheduled = true;
    }

    // Update match details
    if (parsedScheduledTime) {
      match.scheduledTime = parsedScheduledTime;
      match.scheduledDate = parsedScheduledTime.toISOString().split('T')[0];
      match.scheduledTimeString = parsedScheduledTime.toTimeString().split(' ')[0].substring(0, 5);
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

    let filteredMatches = tournament.matches;

    // Filter by round
    if (round) {
      filteredMatches = filteredMatches.filter(match => match.round === parseInt(round));
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
    const scheduleByDate = filteredMatches.reduce((acc, match) => {
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
        totalMatches: filteredMatches.length,
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

    // Initialize scheduleConfig if it doesn't exist
    if (!tournament.scheduleConfig) {
      tournament.scheduleConfig = {};
    }

    // Update schedule configuration
    if (timeSlots) tournament.scheduleConfig.timeSlots = timeSlots;
    if (availableDates) tournament.scheduleConfig.availableDates = availableDates;
    if (defaultMatchDuration) tournament.scheduleConfig.defaultMatchDuration = defaultMatchDuration;
    if (timezone) tournament.scheduleConfig.timezone = timezone;

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
    if (!['Upcoming', 'Registration Open', 'Ongoing'].includes(tournament.status)) {
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
    if (!['Upcoming', 'Registration Open', 'Ongoing'].includes(tournament.status)) {
      return res.status(409).json({ success: false, message: 'Match schedules cannot be changed for a terminal tournament' });
    }

    const roundNumber = Number.parseInt(round, 10);
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
        (result) => Number(result.round || 1) === roundNumber && result.isSubmitted === true
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
        message: 'Group results cannot change after final standings are published'
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
    await tournament.save();
    await emitTournamentUpdated(req, tournament._id);

    res.status(200).json({
      success: true,
      message: 'Match result updated successfully',
      data: {
        match: match
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
    if (tournament.status !== 'Ongoing') {
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
        (result) => Number(result.round || 1) === Number(match.round || 1) && result.isSubmitted === true
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
      .populate('participants', 'username profile.displayName profile.avatar')
      .populate(AUTHORIZED_TEAM_POPULATE)
      .populate('groups.participants', 'username profile.displayName profile.avatar');

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    const safeTournament = sanitizePublicTournament(tournament);
    const canViewRoster = await canReadTournamentMessages(tournament, req.user._id);
    if (!canViewRoster) {
      safeTournament.teams = (safeTournament.teams || []).map((team) => ({
        ...team,
        teamInfo: { members: [] }
      }));
    }

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
        message: 'Only tournament host can remove participants'
      });
    }
    if (!['Upcoming', 'Registration Open'].includes(tournament.status)) {
      return res.status(409).json({
        success: false,
        message: 'Participants can only be removed before the tournament starts'
      });
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

    // Remove from participants array
    tournament.participants = tournament.participants.filter(
      id => id.toString() !== participantId
    );
    
    // Remove from teams array
    tournament.teams = tournament.teams.filter(
      id => id.toString() !== participantId
    );

    removeParticipantFromCompetitionState(tournament, participantId);

    await tournament.save();
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
      recipients: [participantId],
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
      (result) => Number(result.round || 1) === targetRound && result.isSubmitted === true
    );
    if (roundHasCompetitionState
      || (targetRound === 1 && !['Upcoming', 'Registration Open'].includes(tournament.status))) {
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

    const roundNumber = Number.parseInt(round, 10);
    const parsedTeamsPerGroup = Number.parseInt(teamsPerGroup, 10);
    const parsedTotalSlots = Number.parseInt(totalSlots, 10);
    const parsedNumberOfGroups = Number.parseInt(numberOfGroups, 10);
    if (!Number.isInteger(roundNumber) || roundNumber < 1 || roundNumber > 10) {
      return res.status(400).json({ success: false, message: 'Round must be between 1 and 10' });
    }
    const roundHasCompetitionState = (tournament.matches || []).some(
      (match) => Number(match.round || 1) === roundNumber
    ) || (tournament.groupResults || []).some(
      (result) => Number(result.round) === roundNumber && result.isSubmitted === true
    );
    if (roundHasCompetitionState || (roundNumber === 1 && !['Upcoming', 'Registration Open'].includes(tournament.status))) {
      return res.status(409).json({
        success: false,
        message: 'Round structure cannot change after competition activity begins'
      });
    }
    if (!Number.isInteger(parsedTeamsPerGroup) || parsedTeamsPerGroup < 1 || parsedTeamsPerGroup > 100) {
      return res.status(400).json({ success: false, message: 'Teams per group must be between 1 and 100' });
    }
    if (!Number.isInteger(parsedTotalSlots) || parsedTotalSlots < 1 || parsedTotalSlots > 128
      || parsedTeamsPerGroup > parsedTotalSlots) {
      return res.status(400).json({ success: false, message: 'Invalid round slot configuration' });
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

    if (!['Upcoming', 'Registration Open'].includes(tournament.status)
      || (tournament.matches || []).length > 0
      || (tournament.groupResults || []).some((result) => result.isSubmitted === true)) {
      return res.status(409).json({
        success: false,
        message: 'Round 1 groups cannot be recreated after competition activity begins'
      });
    }
    const parsedTeamsPerGroup = Number.parseInt(teamsPerGroup, 10);
    const parsedTotalSlots = Number.parseInt(totalSlots, 10);
    if (!Number.isInteger(parsedTeamsPerGroup) || parsedTeamsPerGroup < 1 || parsedTeamsPerGroup > 100
      || !Number.isInteger(parsedTotalSlots) || parsedTotalSlots < 1 || parsedTotalSlots > 128
      || parsedTeamsPerGroup > parsedTotalSlots) {
      return res.status(400).json({ success: false, message: 'Invalid group configuration' });
    }

    // Calculate number of groups
    const numberOfGroups = Math.ceil(parsedTotalSlots / parsedTeamsPerGroup);
    
    // Clear existing groups for Round 1
    tournament.groups = tournament.groups.filter(group => group.round !== 1);
    
    // Create new groups for Round 1
    const newGroups = [];
    for (let i = 0; i < numberOfGroups; i++) {
      newGroups.push({
        name: `Group ${i + 1}`,
        participants: [],
        round: 1,
        groupLetter: String.fromCharCode(65 + i) // A, B, C, D...
      });
    }
    
    tournament.groups = [...tournament.groups, ...newGroups];
    
    // Recreate broadcast channels for Round 1
    tournament.broadcastChannels = tournament.broadcastChannels.filter(channel => channel.round !== 1);
    
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
    
    // Check if tournament can be edited (within 5 days of end if completed)
    if (!canEditTournament(tournament)) {
      return res.status(400).json({
        success: false,
        message: 'Cannot submit results. Tournament has ended and the 5-day editing period has expired.'
      });
    }

    if (tournament.finalResult?.generatedAt) {
      return res.status(409).json({
        success: false,
        message: 'Group results cannot change after final standings are published'
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

    if (!['Ongoing', 'Completed'].includes(tournament.status)) {
      return res.status(409).json({
        success: false,
        message: 'Results can only be submitted after the tournament starts'
      });
    }

    const roundNumber = Number.parseInt(round, 10);
    const targetGroup = (tournament.groups || []).find((group) => (
      Number(group.round || 1) === roundNumber
      && (idString(group._id) === idString(groupId) || String(group.name) === String(groupId))
    ));
    if (!Number.isInteger(roundNumber) || roundNumber < 1 || !targetGroup) {
      return res.status(400).json({ success: false, message: 'Valid tournament round and group are required' });
    }
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
        teamName: String(team.teamName || 'Participant'),
        teamLogo: team.teamLogo || null,
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
      gr => Number(gr.round) === roundNumber && String(gr.groupId) === String(groupId)
    );

    if (groupResults) {
      // Update existing results
      if (process.env.NODE_ENV === 'development') { console.log('Updating existing group results');}
      groupResults.teams = teamsWithPoints;
      groupResults.submittedAt = new Date();
      groupResults.isSubmitted = true;
    } else {
      // Create new group results
      if (process.env.NODE_ENV === 'development') { console.log('Creating new group results');}
      tournament.groupResults.push({
        round: roundNumber,
        groupId,
        groupName,
        teams: teamsWithPoints,
        submittedAt: new Date(),
        isSubmitted: true
      });
    }

    if (process.env.NODE_ENV === 'development') { console.log('Saving tournament with groupResults length:', tournament.groupResults.length);}
    await tournament.save();
    await emitTournamentUpdated(req, tournament._id);
    if (process.env.NODE_ENV === 'development') { console.log('Tournament saved successfully');
}
    // Send notifications to group participants about results
    const group = tournament.groups.find(g => g._id === groupId || g.name === groupId);
    if (group && group.participants && group.participants.length > 0) {
      const notificationPromises = (await expandTournamentRecipientIds(group.participants)).map(async (participantId) => {
        return createAndEmitNotification({
          recipient: participantId,
          sender: req.user._id,
          type: 'tournament',
          title: `Results Update: ${tournament.name}`,
          message: `Round ${round} results have been published for ${groupName}`,
          data: {
            tournamentId: tournament._id,
            groupId: groupId,
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
        groupResults: groupResults || tournament.groupResults[tournament.groupResults.length - 1]
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

    const roundNumber = Number.parseInt(round, 10);
    const resultTeamDto = (team) => {
      const source = typeof team?.toObject === 'function' ? team.toObject() : (team || {});
      return {
        teamId: source.teamId && typeof source.teamId === 'object'
          ? minimalTournamentUser(source.teamId)
          : source.teamId,
        teamName: String(source.teamName || ''),
        teamLogo: source.teamLogo || '',
        wins: Number(source.wins) || 0,
        finishPoints: Number(source.finishPoints) || 0,
        positionPoints: Number(source.positionPoints) || 0,
        totalPoints: Number(source.totalPoints) || 0,
        rank: Number(source.rank) || 0,
        qualified: source.qualified === true
      };
    };
    const roundResults = tournament.groupResults
      .filter((groupResult) => Number(groupResult.round) === roundNumber)
      .map((groupResult) => ({
        round: Number(groupResult.round),
        groupId: String(groupResult.groupId || ''),
        groupName: String(groupResult.groupName || ''),
        submittedAt: groupResult.submittedAt,
        isSubmitted: groupResult.isSubmitted === true
          || (groupResult.teams || []).every((team) => Number(team.rank) > 0),
        teams: (groupResult.teams || []).map(resultTeamDto)
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

    const roundMatches = tournament.matches.filter(match => match.round === parseInt(round));
    
    if (roundMatches.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No schedule found for this round'
      });
    }

    const roundGroups = tournament.groups.filter(group => group.round === parseInt(round));
    let broadcastCount = 0;

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
        
        groupMatches.forEach((match, index) => {
          const matchDate = match.scheduledDate ? new Date(match.scheduledDate).toLocaleDateString() : 'TBD';
          const matchTime = match.scheduledTimeString || 'TBD';
          scheduleMessage += `Match ${index + 1}\n`;
          scheduleMessage += `Date - ${matchDate}\n`;
          scheduleMessage += `Time - ${matchTime}\n\n`;
        });

        const groupId = group._id || group.name;
        
        let groupMessageThread = tournament.groupMessages.find(
          gm => String(gm.groupId) === String(groupId) && gm.round === parseInt(round, 10)
        );

        if (!groupMessageThread) {
          groupMessageThread = {
            groupId: groupId,
            round: parseInt(round),
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

        // Send notifications to group participants
        if (group.participants && group.participants.length > 0) {
          const notificationPromises = (await expandTournamentRecipientIds(group.participants)).map(async (participantId) => {
        return createAndEmitNotification({
          recipient: participantId,
          sender: req.user._id,
          type: 'tournament',
          title: `Schedule Update: ${tournament.name}`,
          message: `Round ${round} schedule has been updated for your group`,
          data: {
            tournamentId: tournament._id,
            groupId: groupId,
            round: parseInt(round),
            customData: { action: 'schedule_update' }
          }
        });
          });

          await Promise.allSettled(notificationPromises);
        }

        broadcastCount++;
      }
    }

    await tournament.save();
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
        round: parseInt(round),
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

    // Validate qualified teams
    if (!qualifiedTeams || !Array.isArray(qualifiedTeams) || qualifiedTeams.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Qualified teams data is required'
      });
    }

    const roundNumber = Number.parseInt(round, 10);
    const parsedCriteria = Number.parseInt(qualificationCriteria, 10);
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
    await tournament.save();
    await emitTournamentUpdated(req, tournament._id);

    await notifyTournamentRecipients({
      tournament,
      recipients: qualifiedTeams,
      sender: req.user._id,
      title: `Qualified: ${tournament.name}`,
      message: `You qualified from round ${round}.`,
      eventType: 'tournament_qualified',
      revision: tournament.updatedAt,
      extraData: { round: Number(round) }
    });

    res.status(200).json({
      success: true,
      message: 'Teams qualified successfully',
      data: {
        qualification: qualification || tournament.qualifications[tournament.qualifications.length - 1]
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

    const currentRoundNumber = Number.parseInt(currentRound, 10);
    const nextRoundNumber = Number.parseInt(nextRound, 10);
    const parsedTeamsPerGroup = Number.parseInt(teamsPerGroup, 10);
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
        name: `Group ${String.fromCharCode(65 + i)}`,
        round: nextRoundNumber,
        groupLetter: String.fromCharCode(65 + i),
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
    await tournament.save();
    await emitTournamentUpdated(req, tournament._id);

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
          tournamentId: tournament._id,
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

    const roundNumber = Number.parseInt(round, 10);
    const qualifiedPerGroup = Number.parseInt(teamsPerGroup, 10);
    const nextGroupSize = Number.parseInt(nextRoundTeamsPerGroup, 10);
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

    await tournament.save();
    await emitTournamentUpdated(req, tournament._id);

    res.status(200).json({
      success: true,
      message: 'Qualification settings saved successfully',
      data: {
        roundSettings: tournament.roundSettings,
        qualificationSettings: tournament.qualificationSettings
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

    const roundNumber = Number.parseInt(round, 10);
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
    const coverage = submittedRoundCoverage(tournament, roundNumber - 1);
    const qualifiedIds = new Set(coverage.qualifiedIds);
    const assignedIds = groups.flatMap((group) => (
      (group.participants || []).map((participant) => idString(participant?.teamId || participant))
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
    const newGroups = groups.map(group => ({
      name: group.name,
      round: roundNumber,
      participants: group.participants.map((participant) => participant?.teamId || participant)
    }));

    tournament.groups.push(...newGroups);
    tournament.currentRound = roundNumber;

    await tournament.save();
    await emitTournamentUpdated(req, tournament._id);

    res.json({
      success: true,
      message: `Round ${round} created successfully with ${groups.length} groups`,
      data: {
        groups: newGroups,
        totalGroups: groups.length,
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

    // Validate input
    if (!groups || !Array.isArray(groups) || groups.length === 0) {
      log.error('Auto assign Round 2 - Groups data invalid:', { error: String(groups) });
      return res.status(400).json({
        success: false,
        message: 'Groups data is required and must be an array'
      });
    }

    if (!qualifiedTeams || !Array.isArray(qualifiedTeams)) {
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

    const roundNumber = Number.parseInt(round, 10);
    const configuredRounds = Math.max(1, Number(tournament.totalRounds) || 1);
    if (!Number.isInteger(roundNumber)
      || roundNumber !== Number(tournament.currentRound || 1) + 1
      || roundNumber > configuredRounds) {
      return res.status(409).json({
        success: false,
        message: 'Tournament cannot advance beyond its configured round lifecycle'
      });
    }
    if (qualifiedTeams.length === 0) {
      return res.status(400).json({ success: false, message: 'Qualified teams are required' });
    }
    const previousCoverage = submittedRoundCoverage(tournament, roundNumber - 1);
    const serverQualifiedIds = new Set(previousCoverage.qualifiedIds);
    const qualifiedIdSet = new Set(qualifiedTeams.map((team) => idString(team?.teamId || team)));
    if (!previousCoverage.complete
      || serverQualifiedIds.size === 0
      || qualifiedIdSet.size !== serverQualifiedIds.size
      || Array.from(qualifiedIdSet).some((teamId) => !serverQualifiedIds.has(teamId))) {
      return res.status(409).json({
        success: false,
        message: 'Every current-round group must submit results before advancement'
      });
    }
    const assignedIds = groups.flatMap((group) => (group.participants || []).map(
      (participant) => idString(participant?.teamId || participant)
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
    const newGroups = groups.map(group => ({
      name: group.name,
      round: roundNumber,
      participants: group.participants.map(participant => participant.teamId) // Extract teamId only
    }));

    tournament.groups.push(...newGroups);
    tournament.currentRound = roundNumber;

    // Create broadcast message for Round 2
    if (process.env.NODE_ENV === 'development') { console.log('Auto assign Round 2 - Creating broadcast message');}
    const broadcastMessage = {
      type: 'round_start',
      title: `Round ${roundNumber} Started!`,
      message: `Round ${roundNumber} has begun with ${groups.length} groups. ${qualifiedTeams.length} qualified teams are competing!`,
      timestamp: new Date(),
      round: roundNumber
    };

    // Add broadcast to tournament
    if (!tournament.broadcasts) {
      tournament.broadcasts = [];
    }
    tournament.broadcasts.push(broadcastMessage);

    // Initialize group results for Round 2
    if (process.env.NODE_ENV === 'development') { console.log('Auto assign Round 2 - Creating group results');}
    const groupResults = groups.map(group => ({
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
    await tournament.save();
    emitTournamentBroadcast(
      req,
      tournament,
      'round_started',
      broadcastMessage.message,
      [tournament.host, ...qualifiedTeams]
    );
    await emitTournamentUpdated(req, tournament._id);
    if (process.env.NODE_ENV === 'development') { console.log('Auto assign Round 2 - Tournament saved successfully');
}
    res.json({
      success: true,
      message: `Round ${round} created successfully with full functionality!`,
      data: {
        groups: newGroups,
        totalGroups: groups.length,
        round: round,
        qualifiedTeams: qualifiedTeams.length,
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

    if (tournament.status !== 'Upcoming') {
      return res.status(409).json({
        success: false,
        message: tournament.status === 'Registration Open'
          ? 'Tournament registration is already open'
          : `Registration cannot be opened while tournament status is ${tournament.status}`
      });
    }
    
    // Update tournament status to Registration Open
    // Also update registrationStartDate to now so it moves out of "Upcoming Registration"
    tournament.status = 'Registration Open';
    const now = new Date();
    tournament.registrationStartDate = now;
    // Keep canonical and legacy deadline fields synchronized. Reopening with
    // a stale deadline otherwise succeeds but every join is rejected.
    let registrationEnd = new Date(tournament.registrationEndDate || tournament.registrationDeadline || 0);
    if (Number.isNaN(registrationEnd.getTime()) || registrationEnd <= now) {
      registrationEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    }
    tournament.registrationEndDate = registrationEnd;
    tournament.registrationDeadline = registrationEnd;
    await tournament.save();
    emitTournamentBroadcast(
      req,
      tournament,
      'registration_opened',
      `Registration opened for "${tournament.name}"! Join now to participate.`
    );
    await emitTournamentUpdated(req, tournament._id);
    
    // Fan out through the durable, preference-aware bulk producer. A stable
    // key deduplicates both Notification rows and push attempts if a queue job
    // retries after partial processing.
    const BATCH_SIZE = 500;
    const deliveryKey = `tournament-registration-open:${tournament._id}:${tournament.registrationStartDate.toISOString()}`;
    const userCursor = User.find({ isActive: { $ne: false } }, '_id').lean().cursor({ batchSize: BATCH_SIZE });
    let batch = [];
    for await (const user of userCursor) {
      batch.push(String(user._id));
      if (batch.length >= BATCH_SIZE) {
        await enqueueBulkNotifications(
          batch,
          'Registration Opened',
          `Registration opened for "${tournament.name}"! Join now to participate.`,
          'tournament',
          { tournamentId: tournament._id, customData: { action: 'registration_opened' } },
          deliveryKey
        );
        batch = [];
      }
    }
    if (batch.length > 0) {
      await enqueueBulkNotifications(
        batch,
        'Registration Opened',
        `Registration opened for "${tournament.name}"! Join now to participate.`,
        'tournament',
        { tournamentId: tournament._id, customData: { action: 'registration_opened' } },
        deliveryKey
      );
    }
    
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

    if (tournament.status === 'Ongoing') {
      return res.status(200).json({ success: true, message: 'Tournament is already ongoing' });
    }
    const now = new Date();
    const registrationDeadline = new Date(
      tournament.registrationEndDate || tournament.registrationDeadline || 0
    );
    const isClosedUpcoming = tournament.status === 'Upcoming'
      && !Number.isNaN(registrationDeadline.getTime())
      && registrationDeadline <= now;
    if (tournament.status !== 'Registration Open' && !isClosedUpcoming) {
      return res.status(409).json({
        success: false,
        message: `Tournament cannot start while status is ${tournament.status}`
      });
    }
    
    // Update tournament status to Ongoing
    tournament.status = 'Ongoing';
    await tournament.save();
    
    // Send notification to all participants
    const participants = await expandTournamentRecipientIds([...tournament.participants, ...tournament.teams]);
    await emitTournamentBroadcast(
      req,
      tournament,
      'tournament_started',
      `Tournament "${tournament.name}" has started! Good luck to all participants.`,
      [tournament.host, ...participants]
    );
    await emitTournamentUpdated(req, tournament._id);
    await Promise.allSettled(participants.map(async (participantId) => {
      await createAndEmitNotification({
        recipient: participantId,
        sender: req.user._id,
        type: 'tournament',
        title: 'Tournament Started',
        message: `Tournament "${tournament.name}" has started! Good luck!`,
        data: {
          tournamentId: tournament._id,
          customData: {
            action: 'tournament_started',
            notificationDedupeKey: `tournament-started:${tournament._id}`,
            pushRequestId: `tournament-started:${tournament._id}`
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
        && (result.isSubmitted === true || (result.teams || []).every((team) => Number(team.rank) > 0))
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

    tournament.finalResult = {
      standings,
      specialPrizeWinners: tournament.specialPrizes,
      generatedAt: new Date()
    };

    // Auto-mark tournament as completed if not already
    if (tournament.status !== 'Completed') {
      tournament.status = 'Completed';
    }

    await tournament.save();
    await emitTournamentUpdated(req, tournament._id);
    await releaseHostActiveTournament(tournament.host, tournament._id);

    // Propagate final results and status to player history (non-blocking)
    try {
      await propagateFinalResult(tournament);
      await propagateStatusChange(tournament._id, 'Completed');
    } catch (historyErr) {
      log.error('[generateFinalResult] Failed to propagate results to player history:', { error: String(historyErr) });
    }

    await notifyTournamentRecipients({
      tournament,
      recipients: [...tournament.participants, ...tournament.teams],
      sender: req.user._id,
      title: `Final Results: ${tournament.name}`,
      message: 'The final tournament standings are now available.',
      eventType: 'tournament_final_results',
      revision: tournament.finalResult.generatedAt
    });

    res.status(200).json({
      success: true,
      message: 'Final result generated successfully',
      data: { finalResult: tournament.finalResult }
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
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayScrimCount = await Scrim.countDocuments({
      host: hostId,
      createdAt: { $gte: startOfDay }
    });
    const scrimAllowed = todayScrimCount < 5;
    const scrimNextAt = scrimAllowed ? null : new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

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
    isDirectTournamentParticipant,
    canReadTournamentMessages,
    canReadGroupMessages,
    sanitizeTournamentMessages
  }
};
