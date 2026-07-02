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

const uniqueNotificationRecipients = (values = []) =>
  Array.from(new Set(values.map((value) => String(value?._id || value)).filter(Boolean)));

const notifyTournamentRecipients = async ({ tournament, recipients, sender, title, message, eventType, revision, extraData = {} }) => {
  const recipientIds = uniqueNotificationRecipients(recipients);
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

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/tournaments';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'banner-' + uniqueSuffix + path.extname(file.originalname));
  }
});

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

// Helper function to auto-mark tournaments as Completed when endDate passes
const checkAndMarkCompletedTournaments = async (tournament) => {
  if (!tournament) return tournament;
  
  const now = new Date();
  const endDate = tournament.tournamentEndDate ? new Date(tournament.tournamentEndDate) : new Date(tournament.endDate);
  
  // If tournament has ended and is not already completed or cancelled
  if (now >= endDate && tournament.status !== 'Completed' && tournament.status !== 'Cancelled') {
    await Tournament.updateOne(
      { _id: tournament._id }, 
      { $set: { status: 'Completed' } }
    );
    tournament.status = 'Completed';
    await releaseHostActiveTournament(tournament.host, tournament._id);
  }
  
  return tournament;
};

const ACTIVE_TOURNAMENT_STATUSES = ['Upcoming', 'Registration Open', 'Ongoing'];

const normalizePrizePoolType = (value) => (
  value === 'no_prize' ? 'without_prize' : (value || 'without_prize')
);

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
  try {
    upload(req, res, async (err) => {
      if (err) {
        return res.status(400).json({
          success: false,
          message: err.message
        });
      }

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

    if (mode && !validModes.includes(mode)) {
      return res.status(400).json({ success: false, message: 'Invalid tournament mode' });
    }

    if (!validFormats.includes(format)) {
      return res.status(400).json({ success: false, message: 'Invalid tournament format' });
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

    const createLock = hostPermissions.isVerifiedHost
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
      prizeDistribution: prizeDistribution || [],
      specialPrizes: specialPrizes || [],
      host: hostId,
      banner: req.file ? req.file.filename : null,
      rules: rules ? rules.split(',').map(rule => rule.trim()) : [],
      status: 'Upcoming'
    };

    const tournament = new Tournament(tournamentData);
    let activeTournamentReserved = false;
    if (!hostPermissions.isVerifiedHost) {
      const reservation = await reserveHostActiveTournament(hostId, tournament._id);
      if (!reservation.ok) {
        await releaseHostTournamentCreateLock(createLock);
        return res.status(409).json({
          success: false,
          message: 'You already have an active tournament. Complete or cancel it before creating another one.',
          limitType: 'active_tournament',
          activeTournamentId: reservation.activeTournament?._id,
          upgradeMessage: 'Get Verified Host status to host unlimited tournaments.'
        });
      }
      activeTournamentReserved = true;
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
    // Create broadcast channels only for Round 1
    const broadcastChannels = [];
    for (let i = 0; i < calculatedGroups; i++) {
      const channelName = `Group ${String.fromCharCode(65 + i)} - Round 1`;
      broadcastChannels.push({
        name: channelName,
        type: 'Text Messages',
        description: `Broadcast channel for Group ${String.fromCharCode(65 + i)} in Round 1`,
        round: 1,
        groupId: `round_1_group_${i + 1}`,
        channelId: null
      });
    }
    if (process.env.NODE_ENV === 'development') { console.log('Created Round 1 broadcast channels:', broadcastChannels);
    }
    // Update tournament with groups and broadcast channels
    tournament.groups = groups;
    tournament.broadcastChannels = broadcastChannels;
    try {
      await tournament.save();
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
    });
  } catch (error) {
    log.error('Tournament creation error:', { error: String(error) });
    
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
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100; // Increased default limit to show more tournaments
    const skip = (page - 1) * limit;

    const { status, game, format, filter } = req.query;
    const search = normalizeQuerySearch(
      req.query.search !== undefined ? req.query.search : req.query.q
    );

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
      const userId = req.user?._id || req.user?.id;
      if (userId) {
        queryFilter.host = userId;
      } else {
        queryFilter._id = { $exists: false };
      }
    } else if (filter === 'participating') {
      // Filter tournaments where user is participating
      const userId = req.user?._id || req.user?.id;
      if (userId) {
        queryFilter.$or = [
          { participants: userId },
          { teams: userId }
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
      .populate('host', 'username profile.displayName profile.avatar')
      .populate('participants', 'username profile.displayName profile.avatar')
      .populate('teams', 'username profile.displayName profile.avatar')
      .sort(filter === 'recent' || filter === 'completed' ? { endDate: -1 } : { startDate: -1 }) // Sort by end date for completed, start date for others
      .skip(skip)
      .limit(limit);

    // Auto-mark tournaments as Completed if endDate has passed
    // Also auto-close registration if deadline has passed
    const tournamentsToUpdate = [];
    // now is already declared above
    
    for (let tournament of tournaments) {
      const beforeStatus = tournament.status;
      
      // Check if registration deadline has passed but status is still "Registration Open"
      if (tournament.status === 'Registration Open' && new Date(tournament.registrationDeadline) < now) {
        // Registration deadline passed, but tournament hasn't started yet
        // Keep it as "Registration Open" for now, but we'll filter it out
        // Actually, let's mark it as "Upcoming" if start date hasn't arrived
        if (new Date(tournament.startDate) > now) {
          await Tournament.updateOne(
            { _id: tournament._id }, 
            { $set: { status: 'Upcoming' } }
          );
          tournament.status = 'Upcoming';
          tournamentsToUpdate.push(tournament._id);
        }
      }
      
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
        .populate('host', 'username profile.displayName profile.avatar')
        .populate('participants', 'username profile.displayName profile.avatar')
        .populate('teams', 'username profile.displayName profile.avatar')
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
    const processedTournaments = tournamentsToReturn.map(processTournament);

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
      error: error.message,
      stack: error.stack
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
        .populate('host', 'username profile.displayName profile.avatar')
        .populate('participants', 'username profile.displayName profile.avatar')
        .populate({
          path: 'teams',
          select: 'username profile.displayName profile.avatar teamInfo',
          populate: {
            path: 'teamInfo.members.user',
            select: 'username profile.displayName profile.avatar'
          }
        })
        .populate('groups.participants', 'username profile.displayName profile.avatar')
        .populate('matches.team1', 'username profile.displayName profile.avatar')
        .populate('matches.team2', 'username profile.displayName profile.avatar')
        .populate('matches.winner', 'username profile.displayName profile.avatar')
        .populate('winners.team', 'username profile.displayName profile.avatar')
        .populate('groupMessages.messages.sender', 'username profile.displayName profile.avatar');
    } else {
      // Regular route - can be either code or ID
      // Check if it's a code format: TRN-XXX-XXXXXXXX (contains dashes)
      if (id && (id.includes('-') || id.length > 20)) {
        // Looks like a tournament code (format: TRN-BGM-A1B2C3D4)
        tournament = await Tournament.findOne({ tournamentCode: id.toUpperCase() })
          .populate('host', 'username profile.displayName profile.avatar')
          .populate('participants', 'username profile.displayName profile.avatar')
          .populate({
            path: 'teams',
            select: 'username profile.displayName profile.avatar teamInfo',
            populate: {
              path: 'teamInfo.members.user',
              select: 'username profile.displayName profile.avatar'
            }
          })
          .populate('groups.participants', 'username profile.displayName profile.avatar')
          .populate('matches.team1', 'username profile.displayName profile.avatar')
          .populate('matches.team2', 'username profile.displayName profile.avatar')
          .populate('matches.winner', 'username profile.displayName profile.avatar')
          .populate('winners.team', 'username profile.displayName profile.avatar')
          .populate('groupMessages.messages.sender', 'username profile.displayName profile.avatar');
        
        // Don't try findById if it's a code format - it will fail with CastError
      } else if (id && mongoose.Types.ObjectId.isValid(id)) {
        // Try as MongoDB ObjectId (only if it's a valid ObjectId format)
        tournament = await Tournament.findById(id)
          .populate('host', 'username profile.displayName profile.avatar')
          .populate('participants', 'username profile.displayName profile.avatar')
          .populate({
            path: 'teams',
            select: 'username profile.displayName profile.avatar teamInfo',
            populate: {
              path: 'teamInfo.members.user',
              select: 'username profile.displayName profile.avatar'
            }
          })
          .populate('groups.participants', 'username profile.displayName profile.avatar')
          .populate('matches.team1', 'username profile.displayName profile.avatar')
          .populate('matches.team2', 'username profile.displayName profile.avatar')
          .populate('matches.winner', 'username profile.displayName profile.avatar')
          .populate('winners.team', 'username profile.displayName profile.avatar')
          .populate('groupMessages.messages.sender', 'username profile.displayName profile.avatar');
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
      .populate('host', 'username profile.displayName profile.avatar')
      .populate('participants', 'username profile.displayName profile.avatar')
      .populate({
        path: 'teams',
        select: 'username profile.displayName profile.avatar teamInfo',
        populate: {
          path: 'teamInfo.members.user',
          select: 'username profile.displayName profile.avatar'
        }
      })
      .populate('groups.participants', 'username profile.displayName profile.avatar')
      .populate('matches.team1', 'username profile.displayName profile.avatar')
      .populate('matches.team2', 'username profile.displayName profile.avatar')
      .populate('matches.winner', 'username profile.displayName profile.avatar')
      .populate('winners.team', 'username profile.displayName profile.avatar')
      .populate('groupMessages.messages.sender', 'username profile.displayName profile.avatar');

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

    // Process tournament to convert banner filename to URL
    const processedTournament = processTournament(tournament);

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
    
    // Find tournament by name and host username
    const tournament = await Tournament.findOne({
      name: decodeURIComponent(tournamentName),
      'host.username': decodeURIComponent(hostUsername)
    })
      .populate('host', 'username profile.displayName profile.avatar')
      .populate('participants', 'username profile.displayName profile.avatar')
      .populate({
        path: 'teams',
        select: 'username profile.displayName profile.avatar teamInfo',
        populate: {
          path: 'teamInfo.members.user',
          select: 'username profile.displayName profile.avatar'
        }
      })
      .populate('groups.participants', 'username profile.displayName profile.avatar')
      .populate('matches.team1', 'username profile.displayName profile.avatar')
      .populate('matches.team2', 'username profile.displayName profile.avatar')
      .populate('matches.winner', 'username profile.displayName profile.avatar')
      .populate('winners.team', 'username profile.displayName profile.avatar')
      .populate('groupMessages.messages.sender', 'username profile.displayName profile.avatar');

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

    // Process tournament to convert banner filename to URL
    const processedTournament = processTournament(tournament);

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

      try {
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
            message: 'Only tournament host can update tournament'
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
            message: 'Cannot update tournament. Tournament has ended and the 5-day editing period has expired.'
          });
        }

        // Whitelist allowed fields to prevent injection of protected fields
        const allowedUpdateFields = [
          'name', 'description', 'game', 'format', 'mode', 'status',
          'registrationStartDate', 'registrationEndDate', 'tournamentStartDate', 'tournamentEndDate',
          'startDate', 'endDate', 'registrationDeadline', 'location', 'timezone',
          'prizePool', 'prizePoolCurrency', 'totalSlots', 'teamsPerGroup',
          'numberOfGroups', 'totalRounds', 'prizePoolType', 'prizeDistribution', 'specialPrizes', 'rules', 'banner'
        ];
        const updateData = {};
        allowedUpdateFields.forEach(field => {
          if (req.body[field] !== undefined) {
            updateData[field] = req.body[field];
          }
        });
        
        // If a new banner file is uploaded, update the banner field
        if (req.file) {
          // Delete old banner file if it exists
          if (tournament.banner) {
            const oldBannerPath = path.join('uploads/tournaments', tournament.banner);
            if (fs.existsSync(oldBannerPath)) {
              fs.unlinkSync(oldBannerPath);
            }
          }
          updateData.banner = req.file.filename;
        }

        // Handle rules if it's a string (comma-separated)
        if (updateData.rules && typeof updateData.rules === 'string') {
          updateData.rules = updateData.rules.split(',').map(rule => rule.trim()).filter(rule => rule);
        }

        const validGames = ['BGMI', 'Valorant', 'Free Fire', 'Call of Duty Mobile'];
        const validModes = ['Battle Royale', 'Deathmatch', '5v5', 'Solo'];
        const validFormats = ['Solo', 'Duo', 'Squad', '5v5'];
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
        updateData.totalSlots = nextTotalSlots;
        updateData.teamsPerGroup = nextTeamsPerGroup;
        updateData.numberOfGroups = nextNumberOfGroups;
        updateData.totalRounds = nextTotalRounds;
        updateData.prizePool = nextPrizePoolType === 'with_prize'
          ? nextPrizePool
          : 0;
        if (nextPrizePoolType !== 'with_prize') {
          updateData.prizeDistribution = [];
          updateData.specialPrizes = [];
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

        res.status(200).json({
          success: true,
          message: 'Tournament updated successfully',
          data: {
            tournament: processedTournament
          }
        });

      } catch (error) {
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
    const tournament = (id && (id.includes('-') || id.length > 20))
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

    // Check if registration deadline has passed
    if (new Date() > tournament.registrationDeadline) {
      return res.status(400).json({
        success: false,
        message: 'Registration deadline has passed'
      });
    }

    const userId = req.user._id;

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

    // Add user to tournament based on their type and tournament format
    if (req.user.userType === 'team') {
      // Teams can join all tournament formats
      tournament.teams.push(userId);
    } else {
      // Players can only join Solo and Duo tournaments
      if (tournament.format === 'Solo' || tournament.format === 'Duo') {
        tournament.participants.push(userId);
      } else {
        return res.status(400).json({
          success: false,
          message: 'Players can only join Solo and Duo tournaments. For Squad tournaments, please join as a team.'
        });
      }
    }

    await tournament.save();

    // Create history entries for team members (non-blocking)
    if (req.user.userType === 'team') {
      try {
        await createHistoryEntriesForTeam(tournament, req.user);
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

    await tournament.save();

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
    const isTeamMember = team.teamInfo?.members?.some(member => 
      (typeof member.user === 'string' ? member.user : member.user._id).toString() === userId.toString()
    );

    if (!isTeamMember) {
      return res.status(400).json({
        success: false,
        message: 'You are not a member of this team'
      });
    }

    // Check if team is registered for this tournament
    const isTeamRegistered = tournament.teams.includes(teamId);
    if (!isTeamRegistered) {
      return res.status(400).json({
        success: false,
        message: 'This team is not registered for this tournament'
      });
    }

    // Remove team from tournament
    tournament.teams = tournament.teams.filter(id => id.toString() !== teamId.toString());

    // Remove team from all members' joinedTeams
    if (team.teamInfo?.members) {
      for (const member of team.teamInfo.members) {
        const memberUserId = typeof member.user === 'string' ? member.user : member.user._id;
        const memberUser = await User.findById(memberUserId);
        if (memberUser) {
          memberUser.playerInfo.joinedTeams = memberUser.playerInfo.joinedTeams.filter(
            joinedTeamId => joinedTeamId.toString() !== teamId.toString()
          );
          await memberUser.save();
        }
      }
    }

    await tournament.save();

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

    // Get existing groups or create new ones
    let groups = tournament.groups || [];
    
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

    tournament.groups = groups;
    
    // Automatically create broadcast channels for each group
    tournament.broadcastChannels = [];
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

    // Send notifications to all participants about group assignment and broadcast channels
    // For duo tournaments, only notify teams (not individual participants)
    // For solo tournaments, notify both individual participants and teams
    let allTournamentParticipants;
    if (tournament.format === 'Duo') {
      allTournamentParticipants = [...tournament.teams];
    } else {
      allTournamentParticipants = [...tournament.participants, ...tournament.teams];
    }
    allTournamentParticipants = uniqueNotificationRecipients(allTournamentParticipants);
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

    await Promise.all(notificationPromises);

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

    // Check if user is the host
    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can send messages'
      });
    }

    // Initialize tournamentMessages array if it doesn't exist
    if (!tournament.tournamentMessages) {
      tournament.tournamentMessages = [];
    }

    // Add message to tournament messages
    const newMessage = {
      sender: req.user._id,
      message,
      type,
      timestamp: new Date()
    };

    tournament.tournamentMessages.push(newMessage);
    await tournament.save();

    // Send notifications to all participants
    const allParticipants = uniqueNotificationRecipients([...tournament.participants, ...tournament.teams]);
    
    const notificationPromises = allParticipants.map(async (participantId) => {
      return createAndEmitNotification({
        recipient: participantId,
        sender: req.user._id,
        type: 'tournament',
        title: `Tournament Update: ${tournament.name}`,
        message: message,
        data: {
          tournamentId: tournament._id,
          customData: { action: 'tournament_message' }
        }
      });
    });

    await Promise.all(notificationPromises);

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

    // Initialize groupMessages array if it doesn't exist
    if (!tournament.groupMessages) {
      tournament.groupMessages = [];
    }

    // Find or create group message thread
    let groupMessageThread = tournament.groupMessages.find(
      gm => gm.groupId === groupId && gm.round === round
    );

    if (!groupMessageThread) {
      groupMessageThread = {
        groupId,
        round,
        messages: []
      };
      tournament.groupMessages.push(groupMessageThread);
    }

    // Add message to group thread
    const newMessage = {
      sender: req.user._id,
      message,
      type,
      timestamp: new Date()
    };

    groupMessageThread.messages.push(newMessage);
    await tournament.save();

    // Send notifications to group participants
    const group = tournament.groups.find(g => g._id === groupId || g.name === groupId);
    if (group && group.participants) {
      const notificationPromises = uniqueNotificationRecipients(group.participants).map(async (participantId) => {
        return createAndEmitNotification({
          recipient: participantId,
          sender: req.user._id,
          type: 'tournament',
          title: `Group Update: ${group.name}`,
          message: message,
          data: {
            tournamentId: tournament._id,
            groupId,
            customData: { action: 'group_message' }
          }
        });
      });

      await Promise.all(notificationPromises);
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
      .populate('tournamentMessages.sender', 'username profile');

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    res.status(200).json({
      success: true,
      data: { messages: tournament.tournamentMessages || [] }
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
      .populate('groupMessages.messages.sender', 'username profile');

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    const groupMessageThread = tournament.groupMessages.find(
      gm => gm.groupId === groupId && gm.round === parseInt(round)
    );

    res.status(200).json({
      success: true,
      data: { messages: groupMessageThread?.messages || [] }
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
        message: 'Only tournament host can delete tournament'
      });
    }

    // Host can delete any tournament regardless of status
    // No status restrictions for deletion

    const recipients = uniqueNotificationRecipients([...tournament.participants, ...tournament.teams]);
    await Tournament.findByIdAndDelete(req.params.id);
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

    // Check if tournament has groups assigned
    if (!tournament.groups || tournament.groups.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please assign groups before scheduling matches'
      });
    }

    // Clear existing matches
    tournament.matches = [];

    // Generate matches based on tournament format
    if (tournament.format === 'Solo' || tournament.format === 'Duo') {
      // Single elimination bracket
      const allParticipants = [...tournament.participants, ...tournament.teams];
      const totalRounds = Math.ceil(Math.log2(allParticipants.length));
      
      // Create first round matches
      for (let i = 0; i < allParticipants.length; i += 2) {
        if (i + 1 < allParticipants.length) {
          tournament.matches.push({
            round: 1,
            team1: allParticipants[i],
            team2: allParticipants[i + 1],
            status: 'Scheduled',
            scheduledTime: new Date(tournament.startDate),
            createdBy: req.user._id,
            lastModifiedBy: req.user._id
          });
        }
      }
      
      tournament.totalRounds = totalRounds;
    } else {
      // Group stage format
      tournament.groups.forEach((group, groupIndex) => {
        const participants = group.participants;
        
        // Create round-robin matches within each group
        for (let i = 0; i < participants.length; i++) {
          for (let j = i + 1; j < participants.length; j++) {
            tournament.matches.push({
              round: 1,
              groupId: group._id || group.name,
              groupName: group.name,
              team1: participants[i],
              team2: participants[j],
              status: 'Scheduled',
              scheduledTime: new Date(tournament.startDate),
              createdBy: req.user._id,
              lastModifiedBy: req.user._id
            });
          }
        }
      });
      
      tournament.totalRounds = 1; // Will be updated when knockout stage starts
    }

    await tournament.save();

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

    // Validate matches data
    if (!matches || !Array.isArray(matches) || matches.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Matches data is required'
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

    // Create matches with detailed scheduling
    const newMatches = matches.map(matchData => {
      const scheduledTime = new Date(matchData.scheduledTime);
      const scheduledDate = scheduledTime.toISOString().split('T')[0];
      const scheduledTimeString = scheduledTime.toTimeString().split(' ')[0].substring(0, 5);

      return {
        round: round || 1,
        groupId: groupId,
        groupName: group.name,
        team1: matchData.team1 || null, // Optional for group matches
        team2: matchData.team2 || null, // Optional for group matches
        status: 'Scheduled',
        scheduledTime: scheduledTime,
        scheduledDate: scheduledDate,
        scheduledTimeString: scheduledTimeString,
        matchDuration: matchData.matchDuration || tournament.scheduleConfig?.defaultMatchDuration || 30,
        venue: matchData.venue || 'Online',
        description: matchData.description || '',
        createdBy: req.user._id,
        lastModifiedBy: req.user._id
      };
    });

    // Add new matches to tournament
    tournament.matches.push(...newMatches);
    await tournament.save();

    res.status(201).json({
      success: true,
      message: 'Match schedule created successfully',
      data: {
        matches: newMatches,
        group: group.name,
        round: round || 1
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

    const match = tournament.matches.id(matchId);
    if (!match) {
      return res.status(404).json({
        success: false,
        message: 'Match not found'
      });
    }

    // Store original time if rescheduling
    if (scheduledTime && new Date(scheduledTime).getTime() !== match.scheduledTime.getTime()) {
      match.originalScheduledTime = match.scheduledTime;
      match.isRescheduled = true;
    }

    // Update match details
    if (scheduledTime) {
      const newScheduledTime = new Date(scheduledTime);
      match.scheduledTime = newScheduledTime;
      match.scheduledDate = newScheduledTime.toISOString().split('T')[0];
      match.scheduledTimeString = newScheduledTime.toTimeString().split(' ')[0].substring(0, 5);
    }

    if (venue !== undefined) match.venue = venue;
    if (description !== undefined) match.description = description;
    if (matchDuration !== undefined) match.matchDuration = matchDuration;
    
    match.lastModifiedBy = req.user._id;

    await tournament.save();

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

    const match = tournament.matches.id(matchId);
    if (!match) {
      return res.status(404).json({
        success: false,
        message: 'Match not found'
      });
    }

    // Remove match
    tournament.matches.pull(matchId);
    await tournament.save();

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

    // Remove all matches for the specified round
    const initialCount = tournament.matches.length;
    tournament.matches = tournament.matches.filter(match => match.round !== parseInt(round));
    const deletedCount = initialCount - tournament.matches.length;
    
    await tournament.save();

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

    const match = tournament.matches.id(matchId);
    if (!match) {
      return res.status(404).json({
        success: false,
        message: 'Match not found'
      });
    }

    // Update match result
    match.result = {
      team1Score: parseInt(team1Score),
      team2Score: parseInt(team2Score)
    };
    
    // Determine winner
    if (team1Score > team2Score) {
      match.winner = match.team1;
    } else if (team2Score > team1Score) {
      match.winner = match.team2;
    }
    
    match.status = 'Completed';
    await tournament.save();

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

    const match = tournament.matches.id(matchId);
    if (!match) {
      return res.status(404).json({
        success: false,
        message: 'Match not found'
      });
    }

    match.status = 'In Progress';
    await tournament.save();

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
      .populate('teams', 'username profile.displayName profile.avatar')
      .populate('groups.participants', 'username profile.displayName profile.avatar');

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        participants: tournament.participants,
        teams: tournament.teams,
        groups: tournament.groups,
        totalParticipants: tournament.participants.length + tournament.teams.length
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

    // Remove from participants array
    tournament.participants = tournament.participants.filter(
      id => id.toString() !== participantId
    );
    
    // Remove from teams array
    tournament.teams = tournament.teams.filter(
      id => id.toString() !== participantId
    );

    // Remove from groups
    tournament.groups.forEach(group => {
      group.participants = group.participants.filter(
        id => id.toString() !== participantId
      );
    });

    await tournament.save();
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
    }

    // Check if participant is already in this group
    const alreadyInGroup = group.participants.some(p => p.toString() === participantId);
    if (alreadyInGroup) {
      return res.status(400).json({
        success: false,
        message: 'Participant already in this group'
      });
    }

    // Remove participant from any other group first
    tournament.groups.forEach(g => {
      g.participants = g.participants.filter(p => p.toString() !== participantId);
    });

    // Add participant to the selected group
    group.participants.push(participantId);

    await tournament.save();
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

    // Update tournament settings for Round 1
    if (round === 1) {
      tournament.teamsPerGroup = teamsPerGroup;
      tournament.totalSlots = totalSlots;
      tournament.numberOfGroups = numberOfGroups;
    }

    await tournament.save();

    res.status(200).json({
      success: true,
      message: 'Round settings updated successfully',
      tournament
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

    // Check if user is the host
    if (tournament.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only tournament host can recreate groups'
      });
    }

    // Calculate number of groups
    const numberOfGroups = Math.ceil(totalSlots / teamsPerGroup);
    
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

    res.status(200).json({
      success: true,
      message: 'Groups recreated successfully',
      tournament
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

    // Validate teams data
    if (!teams || !Array.isArray(teams) || teams.length === 0) {
      if (process.env.NODE_ENV === 'development') { console.log('Invalid teams data:', teams);}
      return res.status(400).json({
        success: false,
        message: 'Teams data is required'
      });
    }

    // Calculate total points and rank teams
    const teamsWithPoints = teams.map(team => ({
      ...team,
      totalPoints: (team.finishPoints || 0) + (team.positionPoints || 0),
      qualified: team.qualified || false // Preserve qualified status
    }));

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
      gr => gr.round === round && gr.groupId === groupId
    );

    if (groupResults) {
      // Update existing results
      if (process.env.NODE_ENV === 'development') { console.log('Updating existing group results');}
      groupResults.teams = teamsWithPoints;
      groupResults.submittedAt = new Date();
    } else {
      // Create new group results
      if (process.env.NODE_ENV === 'development') { console.log('Creating new group results');}
      tournament.groupResults.push({
        round,
        groupId,
        groupName,
        teams: teamsWithPoints,
        submittedAt: new Date()
      });
    }

    if (process.env.NODE_ENV === 'development') { console.log('Saving tournament with groupResults length:', tournament.groupResults.length);}
    await tournament.save();
    if (process.env.NODE_ENV === 'development') { console.log('Tournament saved successfully');
}
    // Send notifications to group participants about results
    const group = tournament.groups.find(g => g._id === groupId || g.name === groupId);
    if (group && group.participants && group.participants.length > 0) {
      const notificationPromises = uniqueNotificationRecipients(group.participants).map(async (participantId) => {
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

      await Promise.all(notificationPromises);
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

    const roundResults = tournament.groupResults.filter(gr => gr.round === parseInt(round));

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
        round: parseInt(round)
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
          gm => gm.groupId === groupId && gm.round === parseInt(round)
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
          const notificationPromises = uniqueNotificationRecipients(group.participants).map(async (participantId) => {
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

          await Promise.all(notificationPromises);
        }

        broadcastCount++;
      }
    }

    await tournament.save();

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

    // Find existing qualification or create new
    let qualification = tournament.qualifications.find(q => q.round === round);

    if (qualification) {
      // Update existing qualification
      qualification.qualifiedTeams = qualifiedTeams;
      qualification.qualificationCriteria = qualificationCriteria || 8;
      qualification.totalQualified = qualifiedTeams.length;
      qualification.qualifiedAt = new Date();
    } else {
      // Create new qualification
      tournament.qualifications.push({
        round,
        qualifiedTeams,
        qualificationCriteria: qualificationCriteria || 8,
        totalQualified: qualifiedTeams.length,
        qualifiedAt: new Date()
      });
    }

    // Update groupResults to mark teams as qualified
    if (process.env.NODE_ENV === 'development') { console.log('Qualifying teams:', qualifiedTeams);
    }
    let teamsUpdated = 0;
    tournament.groupResults.forEach(groupResult => {
      if (groupResult.round === parseInt(round)) {
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

    // Get qualified teams from current round
    const qualification = tournament.qualifications.find(q => q.round === currentRound);
    if (!qualification) {
      return res.status(400).json({
        success: false,
        message: 'No qualified teams found for current round'
      });
    }

    const qualifiedTeams = qualification.qualifiedTeams;
    const totalGroups = Math.ceil(qualifiedTeams.length / teamsPerGroup);

    // Create groups for next round
    const newGroups = [];
    for (let i = 0; i < totalGroups; i++) {
      newGroups.push({
        name: `Group ${String.fromCharCode(65 + i)}`,
        round: nextRound,
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
      const channelName = `Round ${nextRound} - ${group.name}`;
      const broadcastChannel = {
        name: channelName,
        type: 'Text Messages',
        description: `Broadcast channel for ${group.name} in Round ${nextRound}`,
        groupId: group._id || `group_${index + 1}`,
        round: nextRound,
        channelId: null
      };
      tournament.broadcastChannels.push(broadcastChannel);
    });

    // Update tournament current round
    tournament.currentRound = nextRound;
    await tournament.save();

    // Send notifications to all qualified participants about new round and broadcast channels
    const allQualifiedParticipants = uniqueNotificationRecipients(qualifiedTeams);
    const notificationPromises = allQualifiedParticipants.map(async (participantId) => {
      return createAndEmitNotification({
        recipient: participantId,
        sender: req.user._id,
        type: 'tournament',
        title: `New Round Started: ${tournament.name}`,
        message: `Round ${nextRound} has started! Check your new group and broadcast channels.`,
        data: {
          tournamentId: tournament._id,
          round: nextRound,
          customData: { action: 'new_round_started' }
        }
      });
    });

    await Promise.all(notificationPromises);

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

    // Find existing round settings or create new
    let roundSetting = tournament.roundSettings.find(rs => rs.round === round);

    if (roundSetting) {
      // Update existing settings
      roundSetting.teamsPerGroup = teamsPerGroup;
      roundSetting.qualificationCriteria = teamsPerGroup;
    } else {
      // Create new round settings
      tournament.roundSettings.push({
        round,
        teamsPerGroup,
        qualificationCriteria: teamsPerGroup,
        totalGroups: tournament.groups.filter(g => g.round === round).length,
        totalTeams: tournament.groups.filter(g => g.round === round).reduce((sum, g) => sum + g.participants.length, 0)
      });
    }

    // Store next round settings in tournament metadata
    tournament.qualificationSettings = {
      teamsPerGroup,
      nextRoundTeamsPerGroup
    };

    await tournament.save();

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
    const { tournamentId } = req.params;
    const { groups, round } = req.body;

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    // Clear existing groups for this round before creating new ones
    tournament.groups = tournament.groups.filter(group => group.round !== round);
    
    // Clear existing group results for this round
    if (tournament.groupResults) {
      tournament.groupResults = tournament.groupResults.filter(result => result.round !== round);
    }

    // Add new groups to the tournament
    const newGroups = groups.map(group => ({
      name: group.name,
      round: round,
      participants: group.participants
    }));

    tournament.groups.push(...newGroups);
    tournament.currentRound = round;

    await tournament.save();

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

    if (process.env.NODE_ENV === 'development') { console.log('Auto assign Round 2 - Tournament found:', tournament.name);
}
    // Clear existing Round 2 groups before creating new ones
    tournament.groups = tournament.groups.filter(group => group.round !== round);
    
    // Clear existing Round 2 group results
    if (tournament.groupResults) {
      tournament.groupResults = tournament.groupResults.filter(result => result.round !== round);
    }

    // Add new groups to the tournament
    const newGroups = groups.map(group => ({
      name: group.name,
      round: round,
      participants: group.participants.map(participant => participant.teamId) // Extract teamId only
    }));

    tournament.groups.push(...newGroups);
    tournament.currentRound = round;

    // Create broadcast message for Round 2
    if (process.env.NODE_ENV === 'development') { console.log('Auto assign Round 2 - Creating broadcast message');}
    const broadcastMessage = {
      type: 'round_start',
      title: `Round ${round} Started!`,
      message: `Round ${round} has begun with ${groups.length} groups. ${qualifiedTeams.length} qualified teams are competing!`,
      timestamp: new Date(),
      round: round
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
      round: round,
      teams: group.participants.map(participant => ({
        teamId: participant.teamId,
        teamName: participant.teamName,
        wins: 0,
        finishPoints: 0,
        positionPoints: 0,
        totalPoints: 0,
        rank: 0,
        qualified: false
      }))
    }));

    // Add group results to tournament
    if (!tournament.groupResults) {
      tournament.groupResults = [];
    }
    tournament.groupResults.push(...groupResults);

    if (process.env.NODE_ENV === 'development') { console.log('Auto assign Round 2 - Saving tournament');}
    await tournament.save();
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
    
    // Update tournament status to Registration Open
    // Also update registrationStartDate to now so it moves out of "Upcoming Registration"
    tournament.status = 'Registration Open';
    const now = new Date();
    tournament.registrationStartDate = now;
    // If registrationEndDate is in the past or not set, extend it
    if (!tournament.registrationEndDate || new Date(tournament.registrationEndDate) <= now) {
      // Default: keep registration open for 24 hours from now if no end date set
      if (!tournament.registrationEndDate) {
        tournament.registrationEndDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      }
    }
    await tournament.save();
    
    // Emit real-time broadcast message
    const io = require('../server').getIO();
    if (io) {
      io.emit('broadcast_message', {
        id: Date.now().toString(),
        message: `Registration opened for "${tournament.name}"! Join now to participate.`,
        timestamp: new Date(),
        type: 'registration_opened'
      });
    }
    
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
    
    // Update tournament status to Ongoing
    tournament.status = 'Ongoing';
    await tournament.save();
    
    // Get socket instance
    const { getIO } = require('../server');
    const io = getIO();
    
    // Emit real-time broadcast message
    io.emit('broadcast_message', {
      id: Date.now().toString(),
      message: `Tournament "${tournament.name}" has started! Good luck to all participants.`,
      timestamp: new Date(),
      type: 'tournament_started'
    });
    
    // Send notification to all participants
    const participants = uniqueNotificationRecipients([...tournament.participants, ...tournament.teams]);
    await Promise.all(participants.map(async (participantId) => {
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

    if (prizeDistribution) tournament.prizeDistribution = prizeDistribution;
    if (specialPrizes) tournament.specialPrizes = specialPrizes;

    await tournament.save();

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

    const prizeIndex = tournament.specialPrizes.findIndex(p => p.category === category);
    if (prizeIndex === -1) {
      return res.status(404).json({ success: false, message: 'Special prize category not found' });
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
  getHostingLimits
};
