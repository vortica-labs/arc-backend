const Scrim = require('../models/Scrim');
const User = require('../models/User'); // Required for populate()
const { createAndEmitNotification } = require('../utils/notificationEmitter');
const { calculateBGMIPoints } = require('../utils/bgmiPoints');
const mongoose = require('mongoose');
const log = require('../utils/logger');
const { sanitizePublicScrim } = require('../utils/tournamentPublicDto');

const uniqueRecipientIds = (values = []) =>
  Array.from(new Set(values.map((value) => String(value?._id || value)).filter(Boolean)));

const idString = (value) => String(value?._id || value || '');

const SCRIM_MATCH_COUNTS = Object.freeze([1, 2, 3, 4, 5, 6]);
const SCRIM_TYPES = new Set(['Daily', 'Weekly']);
const SCRIM_FORMATS = new Set(['Solo', 'Squad']);
const SCRIM_BROADCAST_TYPES = new Set(['info', 'warning', 'match_starting', 'custom']);
const SCRIM_PRIZE_CURRENCIES = new Set(['INR', 'USD']);
const BGMI_MAPS = new Set(['Erangel', 'Miramar', 'Sanhok', 'Vikendi', 'Livik', 'Karakin', 'Nusa']);
const TIME_OF_DAY_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_SCRIM_TIMEZONE = 'Asia/Kolkata';
const MAX_BROADCAST_MESSAGE_LENGTH = 2000;

const DAILY_TIME_SLOTS_BY_MATCH_COUNT = Object.freeze({
  1: new Set(['1-2', '2-3', '3-4', '4-5', '5-6', '6-7', '7-8', '8-9', '9-10']),
  2: new Set(['1-2', '2-3', '3-4', '4-5', '5-6', '6-7', '7-8', '8-9', '9-10']),
  3: new Set(['1-3', '2-4', '3-5', '4-6', '5-7', '6-8', '7-9', '8-10']),
  4: new Set(['1-3', '2-4', '3-5', '4-6', '5-7', '6-8', '7-9', '8-10']),
  5: new Set(['1-4', '2-5', '3-6', '4-7', '5-8', '6-9', '7-10']),
  6: new Set(['1-4', '2-5', '3-6', '4-7', '5-8', '6-9', '7-10'])
});

const parseInteger = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
};

const isSupportedTimeZone = (timeZone) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch (_error) {
    return false;
  }
};

const dateKeyInTimeZone = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
};

const parseScrimDate = (value) => {
  if (typeof value === 'string' && DATE_ONLY_PATTERN.test(value)) {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
      ? null
      : { date: parsed, dateKey: value };
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : { date: parsed, dateKey: null };
};

const validateScrimCreationInput = (payload = {}, options = {}) => {
  const now = options.now instanceof Date ? options.now : new Date();
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  if (!name) return { error: 'Scrim name is required' };

  const scrimType = typeof payload.scrimType === 'string' ? payload.scrimType.trim() : '';
  if (!SCRIM_TYPES.has(scrimType)) return { error: 'Scrim type must be either Daily or Weekly' };

  const format = typeof payload.format === 'string' ? payload.format.trim() : 'Squad';
  if (!SCRIM_FORMATS.has(format)) return { error: 'Scrim format must be either Solo or Squad' };

  const numberOfMatches = parseInteger(payload.numberOfMatches);
  if (!SCRIM_MATCH_COUNTS.includes(numberOfMatches)) {
    return { error: 'Number of matches must be between 1 and 6' };
  }

  const maxTeams = parseInteger(payload.maxTeams);
  if (maxTeams === null || maxTeams < 16 || maxTeams > 25) {
    return { error: 'Maximum teams must be between 16 and 25' };
  }

  const timezone = typeof payload.timezone === 'string' && payload.timezone.trim()
    ? payload.timezone.trim()
    : DEFAULT_SCRIM_TIMEZONE;
  if (!isSupportedTimeZone(timezone)) return { error: 'Invalid scrim timezone' };

  const parsedDate = parseScrimDate(payload.date);
  if (!parsedDate) return { error: 'A valid scrim date is required' };
  const scrimDateKey = parsedDate.dateKey || dateKeyInTimeZone(parsedDate.date, timezone);
  const todayKey = dateKeyInTimeZone(now, timezone);
  if (scrimDateKey < todayKey) return { error: 'Scrim date cannot be in the past' };

  let endDate = null;
  if (scrimType === 'Weekly') {
    const parsedEndDate = parseScrimDate(payload.endDate);
    if (!parsedEndDate) return { error: 'End date is required for Weekly scrims' };
    const endDateKey = parsedEndDate.dateKey || dateKeyInTimeZone(parsedEndDate.date, timezone);
    if (endDateKey < scrimDateKey) return { error: 'End date cannot be before the scrim date' };
    endDate = parsedEndDate.date;
  }

  const timeSlot = typeof payload.timeSlot === 'string' ? payload.timeSlot.trim() : '';
  if (scrimType === 'Daily' && !DAILY_TIME_SLOTS_BY_MATCH_COUNT[numberOfMatches].has(timeSlot)) {
    return { error: `Select a valid Daily time slot for ${numberOfMatches} match${numberOfMatches === 1 ? '' : 'es'}` };
  }

  if (!Array.isArray(payload.matches) || payload.matches.length !== numberOfMatches) {
    return { error: `Matches array must contain exactly ${numberOfMatches} matches` };
  }
  for (let index = 0; index < payload.matches.length; index += 1) {
    const match = payload.matches[index] || {};
    if (!BGMI_MAPS.has(match.map)) return { error: `Match ${index + 1} has an invalid BGMI map` };
    if (!TIME_OF_DAY_PATTERN.test(String(match.idpTime || '')) || !TIME_OF_DAY_PATTERN.test(String(match.startTime || ''))) {
      return { error: `Match ${index + 1} must have valid IDP and start times in HH:MM format` };
    }
  }

  const normalizedPrizePoolType = payload.prizePoolType === 'no_prize'
    ? 'without_prize'
    : (payload.prizePoolType || 'without_prize');
  if (!['with_prize', 'without_prize'].includes(normalizedPrizePoolType)) {
    return { error: 'Invalid prize pool type' };
  }
  const prizePoolCurrency = typeof payload.prizePoolCurrency === 'string'
    ? payload.prizePoolCurrency.trim().toUpperCase()
    : 'INR';
  if (!SCRIM_PRIZE_CURRENCIES.has(prizePoolCurrency)) {
    return { error: 'Prize pool currency must be INR or USD' };
  }
  const requestedPrizePool = payload.prizePool === undefined || payload.prizePool === null || payload.prizePool === ''
    ? 0
    : Number(payload.prizePool);
  if (!Number.isFinite(requestedPrizePool) || requestedPrizePool < 0) {
    return { error: 'Prize pool amount must be a valid non-negative number' };
  }
  if (normalizedPrizePoolType === 'with_prize' && requestedPrizePool <= 0) {
    return { error: 'Prize pool amount must be greater than zero for prize scrims' };
  }

  return {
    value: {
      name,
      scrimType,
      format,
      numberOfMatches,
      maxTeams,
      timezone,
      date: parsedDate.date,
      endDate,
      timeSlot: scrimType === 'Daily' ? timeSlot : null,
      prizePoolType: normalizedPrizePoolType,
      prizePool: normalizedPrizePoolType === 'with_prize' ? requestedPrizePool : 0,
      prizePoolCurrency,
      matches: payload.matches.map((match, index) => ({
        matchNumber: index + 1,
        map: match.map,
        idpTime: match.idpTime,
        startTime: match.startTime
      }))
    }
  };
};

const validateScrimResultInput = (teams, registeredParticipants) => {
  const registeredIds = uniqueRecipientIds(registeredParticipants);
  if (registeredIds.length === 0) return { error: 'Cannot submit results without registered participants' };
  if (!Array.isArray(teams) || teams.length === 0) return { error: 'Teams data is required' };
  if (teams.length !== registeredIds.length) return { error: 'Results must include every registered participant exactly once' };

  const registeredSet = new Set(registeredIds);
  const participantIds = new Set();
  const placements = new Set();
  const normalized = [];
  for (const team of teams) {
    const teamId = idString(team?.teamId);
    if (!registeredSet.has(teamId)) return { error: `Participant ${teamId || 'unknown'} is not registered for this scrim` };
    if (participantIds.has(teamId)) return { error: 'Each registered participant can appear only once in match results' };

    const placement = parseInteger(team?.placement);
    if (placement === null || placement < 1 || placement > registeredIds.length) {
      return { error: `Placement must be an integer between 1 and ${registeredIds.length}` };
    }
    if (placements.has(placement)) return { error: 'Each participant must have a unique placement' };

    const kills = parseInteger(team?.kills ?? 0);
    if (kills === null || kills < 0 || kills > 50) return { error: 'Kills must be an integer between 0 and 50' };

    participantIds.add(teamId);
    placements.add(placement);
    normalized.push({ teamId, placement, kills });
  }
  return { value: normalized };
};

const hasSubmittedResultsForEveryMatch = (matches) => (
  Array.isArray(matches)
  && matches.length > 0
  && matches.every((match) => (
    Boolean(match?.results?.submittedAt)
    && Array.isArray(match?.results?.teams)
    && match.results.teams.length > 0
  ))
);

const refreshScrimFinalResult = (scrim, generatedAt = new Date()) => {
  const standings = (scrim.overallStandings?.teams || []).map((entry, index) => {
    const team = typeof entry?.toObject === 'function' ? entry.toObject() : { ...entry };
    const rank = index + 1;
    const prizeSplit = (scrim.prizeDistribution || []).find((prize) => prize.rank === rank);
    return {
      ...team,
      rank,
      prizeAmount: prizeSplit ? prizeSplit.amount : 0
    };
  });
  scrim.finalResult = {
    standings,
    specialPrizeWinners: scrim.specialPrizes || [],
    generatedAt
  };
  return scrim.finalResult;
};

const canReadScrimBroadcasts = async (scrim, userId) => {
  const viewerId = idString(userId);
  if (!viewerId || !scrim) return false;
  if (idString(scrim.host) === viewerId) return true;
  const participantIds = (scrim.registeredTeams || []).map(idString).filter(Boolean);
  if (participantIds.includes(viewerId)) return true;
  return Boolean(await User.exists({
    _id: { $in: participantIds },
    userType: 'team',
    isActive: true,
    $or: [
      { 'teamInfo.members': { $elemMatch: { user: userId } } },
      {
        'teamInfo.rosters': {
          $elemMatch: {
            isActive: { $ne: false },
            players: { $elemMatch: { user: userId, isActive: { $ne: false }, leftAt: null } }
          }
        }
      },
      { 'teamInfo.staff': { $elemMatch: { user: userId, isActive: { $ne: false }, leftAt: null } } }
    ]
  }));
};

const notifyScrimRecipients = async ({ scrim, recipients, sender, title, message, eventType, revision, extraData = {} }) => {
  const recipientIds = uniqueRecipientIds(recipients);
  if (recipientIds.length === 0) return [];
  const dedupeKey = `scrim:${scrim._id}:${eventType}:${String(revision || scrim.updatedAt || '').slice(0, 80)}`;
  const results = await Promise.allSettled(recipientIds.map((recipient) => (
    Promise.resolve().then(() => createAndEmitNotification({
      recipient,
      sender,
      type: 'tournament',
      title,
      message,
      data: {
        deepLink: `/scrim/${scrim.scrimCode || scrim._id}`,
        customData: {
          eventType,
          scrimId: scrim._id,
          scrimCode: scrim.scrimCode,
          notificationDedupeKey: dedupeKey,
          pushRequestId: dedupeKey,
          ...extraData
        }
      }
    }))
  )));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      log.error('Scrim notification delivery failed after persistence', {
        error: String(result.reason),
        recipientId: recipientIds[index],
        scrimId: String(scrim._id),
        eventType
      });
    }
  });
  return results;
};

// Helper to find scrim by ObjectId or Scrim Code
const findScrimByIdOrCode = async (idOrCode) => {
  if (!idOrCode) return null;
  if (mongoose.Types.ObjectId.isValid(idOrCode)) {
    return await Scrim.findById(idOrCode);
  }
  return await Scrim.findOne({ scrimCode: idOrCode.toUpperCase() });
};


// Create new scrim
const createScrim = async (req, res) => {
  try {
    const {
      description,
      prizeDistribution,
      specialPrizes
    } = req.body;

    const hostId = req.user._id;

    const validation = validateScrimCreationInput(req.body);
    if (validation.error) {
      return res.status(400).json({ success: false, message: validation.error });
    }
    const normalized = validation.value;

    const host = await User.findById(hostId).select('isVerifiedHost').lean();
    const isVerifiedHost = host?.isVerifiedHost === true;

    // Enforce isVerifiedHost for prize pool scrims
    if (normalized.prizePoolType === 'with_prize' && isVerifiedHost !== true) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to host prize pool scrims. Please apply for Verified Host status.'
      });
    }

    // ── Daily limit for unverified hosts (5 scrims per day) ──
    if (!isVerifiedHost) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const Scrim = require('../models/Scrim');
      const todayCount = await Scrim.countDocuments({
        host: hostId,
        createdAt: { $gte: startOfDay }
      });

      if (todayCount >= 5) {
        const tomorrow = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
        return res.status(429).json({
          success: false,
          message: 'Daily scrim limit reached (5/day).',
          limitType: 'scrim_daily',
          nextAllowedAt: tomorrow.toISOString(),
          upgradeMessage: 'Get Verified Host status to host unlimited scrims.'
        });
      }
    }

    // Create scrim data
    const scrimData = {
      name: normalized.name,
      description: description || '',
      game: 'BGMI',
      format: normalized.format,
      scrimType: normalized.scrimType,
      timeSlot: normalized.timeSlot,
      numberOfMatches: normalized.numberOfMatches,
      date: normalized.date,
      endDate: normalized.endDate,
      maxTeams: normalized.maxTeams,
      timezone: normalized.timezone,
      prizePool: normalized.prizePool,
      prizePoolType: normalized.prizePoolType,
      prizePoolCurrency: normalized.prizePoolCurrency,
      prizeDistribution: (prizeDistribution || []).filter(p => p.rank && p.amount),
      specialPrizes: (specialPrizes || []).filter(p => p.category && p.category.trim() !== '' && p.amount),
      host: hostId,
      status: 'Open',
      matches: normalized.matches.map((match) => ({
        matchNumber: match.matchNumber,
        map: match.map,
        idpTime: match.idpTime,
        startTime: match.startTime,
        status: 'Scheduled',
        results: {
          teams: [],
          submittedAt: null
        }
      })),
      overallStandings: {
        teams: [],
        lastUpdated: new Date()
      }
    };

    const scrim = await Scrim.create(scrimData);

    // Populate host info
    await scrim.populate('host', 'username userType profile.displayName profile.avatar');

    res.status(201).json({
      success: true,
      message: 'Scrim created successfully',
      data: {
        scrim
      }
    });
  } catch (error) {
    log.error('Scrim creation error:', { error: String(error) });
    
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
      message: 'Failed to create scrim',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get all scrims
const getScrims = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const skip = (page - 1) * limit;

    const { scrimType, status, search, filter } = req.query;

    // Build filter object
    const queryFilter = {};
    const now = new Date();

    if (filter === 'hosted') {
      const userId = req.user?._id || req.user?.id;
      if (userId) {
        queryFilter.host = userId;
      } else {
        queryFilter._id = { $exists: false };
      }
    } else if (filter === 'participating') {
      const userId = req.user?._id || req.user?.id;
      if (userId) {
        queryFilter.registeredTeams = userId;
      } else {
        queryFilter._id = { $exists: false };
      }
    } else if (filter === 'all') {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      queryFilter.$and = [
        {
          $or: [
            { status: { $in: ['Open', 'Full', 'In Progress'] } },
            {
              status: 'Completed',
              date: { $gte: thirtyDaysAgo }
            }
          ]
        },
        { status: { $ne: 'Cancelled' } }
      ];
    } else if (filter === 'completed') {
      queryFilter.status = 'Completed';
    } else if (status) {
      queryFilter.status = status;
    }

    if (scrimType) queryFilter.scrimType = scrimType;

    if (search) {
      queryFilter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { scrimCode: { $regex: search, $options: 'i' } }
      ];
    }

    let scrims = await Scrim.find(queryFilter)
      .populate('host', 'username userType profile.displayName profile.avatar')
      .populate('registeredTeams', 'username userType profile.displayName profile.avatar')
      .sort({ date: -1 })
      .skip(skip)
      .limit(limit);

    // Auto-mark scrims as Completed if date has passed
    const scrimsToUpdate = [];
    for (let scrim of scrims) {
      const beforeStatus = scrim.status;
      
      if (scrim.date < now && scrim.status !== 'Completed' && scrim.status !== 'Cancelled') {
        // Check if all matches are completed
        const allMatchesCompleted = scrim.matches.every(match => 
          match.status === 'Completed' || match.results?.submittedAt
        );
        
        if (allMatchesCompleted) {
          scrim.status = 'Completed';
          await scrim.save();
          scrimsToUpdate.push(scrim._id);
        }
      }
    }

    // Count total scrims for pagination
    const total = await Scrim.countDocuments(queryFilter);

    res.status(200).json({
      success: true,
      data: {
        scrims: scrims.map(sanitizePublicScrim),
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    log.error('Error fetching scrims:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch scrims',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get single scrim
const getScrim = async (req, res) => {
  try {
    const { id, code } = req.params;

    let scrim;
    if (code) {
      scrim = await Scrim.findOne({ scrimCode: code.toUpperCase() });
    } else if (id) {
      scrim = await findScrimByIdOrCode(id);
    }

    if (!scrim) {
      return res.status(404).json({
        success: false,
        message: 'Scrim not found'
      });
    }

    await scrim.populate('host', 'username userType profile.displayName profile.avatar');
    await scrim.populate('registeredTeams', 'username userType profile.displayName profile.avatar');
    
    // Populate team info in results
    if (scrim.matches) {
      for (let match of scrim.matches) {
        if (match.results && match.results.teams) {
          await Scrim.populate(match.results.teams, { path: 'teamId', select: 'username profile.displayName profile.avatar' });
        }
      }
    }

    // Populate team info in overall standings
    if (scrim.overallStandings && scrim.overallStandings.teams) {
      await Scrim.populate(scrim.overallStandings.teams, { path: 'teamId', select: 'username profile.displayName profile.avatar' });
    }

    const safeScrim = sanitizePublicScrim(scrim);
    if (await canReadScrimBroadcasts(scrim, req.user?._id)) {
      safeScrim.broadcasts = scrim.broadcasts || [];
    }

    res.status(200).json({
      success: true,
      data: {
        scrim: safeScrim
      }
    });
  } catch (error) {
    log.error('Error fetching scrim (full traceback):', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch scrim',
      error: process.env.NODE_ENV === 'development' ? error.stack || error.message : undefined
    });
  }
};

// Join scrim
const joinScrim = async (req, res) => {
  try {
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({
        success: false,
        message: 'Scrim not found'
      });
    }

    const userId = req.user._id;

    if (idString(scrim.host) === idString(userId)) {
      return res.status(400).json({
        success: false,
        message: 'Scrim hosts cannot register for their own scrim'
      });
    }

    // A Full status is never treated as joinable. If a participant leaves, the
    // leave command atomically reopens the scrim.
    if (scrim.status !== 'Open') {
      return res.status(400).json({
        success: false,
        message: `Cannot join scrim. Current status: ${scrim.status}`
      });
    }

    // Check if user is already registered
    if ((scrim.registeredTeams || []).some((participant) => idString(participant) === idString(userId))) {
      return res.status(400).json({
        success: false,
        message: 'You are already registered for this scrim'
      });
    }

    // Check if scrim is full
    if (scrim.registeredTeams.length >= scrim.maxTeams) {
      await Scrim.updateOne({ _id: scrim._id, status: 'Open' }, { $set: { status: 'Full' } });
      return res.status(400).json({
        success: false,
        message: 'Scrim is full'
      });
    }

    // Format-based join validation
    const joiningUser = await User.findById(userId).select('userType');
    
    if (scrim.format === 'Squad') {
      // Squad scrims: only teams can join
      if (!joiningUser || joiningUser.userType !== 'team') {
        return res.status(400).json({
          success: false,
          message: 'Only teams can join Squad scrims. Please use a team account.'
        });
      }
    }
    // Solo scrims: both players and teams can join (no restriction)

    // Capacity and duplicate admission are one database command. Concurrent
    // requests for the final slot cannot both pass the $expr guard.
    const joinedScrim = await Scrim.findOneAndUpdate(
      {
        _id: scrim._id,
        host: { $ne: userId },
        status: 'Open',
        registeredTeams: { $ne: userId },
        $expr: {
          $lt: [
            { $size: { $ifNull: ['$registeredTeams', []] } },
            '$maxTeams'
          ]
        }
      },
      [
        {
          $set: {
            registeredTeams: {
              $concatArrays: [{ $ifNull: ['$registeredTeams', []] }, [userId]]
            }
          }
        },
        {
          $set: {
            status: {
              $cond: [
                { $gte: [{ $size: '$registeredTeams' }, '$maxTeams'] },
                'Full',
                '$status'
              ]
            }
          }
        }
      ],
      { new: true }
    );

    if (!joinedScrim) {
      const latest = await Scrim.findById(scrim._id).select('host status registeredTeams maxTeams');
      if (!latest) return res.status(404).json({ success: false, message: 'Scrim not found' });
      if ((latest.registeredTeams || []).some((participant) => idString(participant) === idString(userId))) {
        return res.status(400).json({ success: false, message: 'You are already registered for this scrim' });
      }
      if (latest.status === 'Full' || latest.registeredTeams.length >= latest.maxTeams) {
        if (latest.status === 'Open') {
          await Scrim.updateOne({ _id: latest._id, status: 'Open' }, { $set: { status: 'Full' } });
        }
        return res.status(400).json({ success: false, message: 'Scrim is full' });
      }
      return res.status(409).json({ success: false, message: 'Scrim registration changed. Please try again.' });
    }

    await notifyScrimRecipients({
      scrim: joinedScrim,
      recipients: [joinedScrim.host],
      sender: userId,
      title: 'New Scrim Registration',
      message: `${req.user.profile?.displayName || req.user.username} joined "${joinedScrim.name}"`,
      eventType: 'scrim_registration_joined',
      revision: joinedScrim.updatedAt,
      extraData: { participantId: userId }
    });

    // Populate team info
    await joinedScrim.populate('registeredTeams', 'username userType profile.displayName profile.avatar');

    res.status(200).json({
      success: true,
      message: 'Successfully joined scrim',
      data: {
        scrim: joinedScrim
      }
    });
  } catch (error) {
    log.error('Error joining scrim:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to join scrim',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Leave scrim
const leaveScrim = async (req, res) => {
  try {
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({
        success: false,
        message: 'Scrim not found'
      });
    }

    const userId = req.user._id;

    // Check if user is registered
    if (!(scrim.registeredTeams || []).some((participant) => idString(participant) === idString(userId))) {
      return res.status(400).json({
        success: false,
        message: 'You are not registered for this scrim'
      });
    }

    // Remove user from registered teams
    scrim.registeredTeams = scrim.registeredTeams.filter(
      teamId => teamId.toString() !== userId.toString()
    );

    // Update status if not full anymore
    if (scrim.status === 'Full' && scrim.registeredTeams.length < scrim.maxTeams) {
      scrim.status = 'Open';
    }

    await scrim.save();

    if (String(scrim.host) !== String(userId)) {
      await notifyScrimRecipients({
        scrim,
        recipients: [scrim.host],
        sender: userId,
        title: 'Scrim Registration Withdrawn',
        message: `${req.user.profile?.displayName || req.user.username} left "${scrim.name}"`,
        eventType: 'scrim_registration_left',
        revision: scrim.updatedAt,
        extraData: { participantId: userId }
      });
    }

    // Populate team info
    await scrim.populate('registeredTeams', 'username userType profile.displayName profile.avatar');

    res.status(200).json({
      success: true,
      message: 'Successfully left scrim',
      data: {
        scrim
      }
    });
  } catch (error) {
    log.error('Error leaving scrim:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to leave scrim',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Submit match results
const submitMatchResults = async (req, res) => {
  try {
    const { matchNumber, teams } = req.body;
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({
        success: false,
        message: 'Scrim not found'
      });
    }

    // Check if user is the host
    if (scrim.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only scrim host can submit match results'
      });
    }

    const routeMatchNumber = parseInteger(req.params.matchNumber);
    const bodyMatchNumber = matchNumber === undefined ? routeMatchNumber : parseInteger(matchNumber);
    if (!SCRIM_MATCH_COUNTS.includes(routeMatchNumber) || bodyMatchNumber !== routeMatchNumber) {
      return res.status(400).json({
        success: false,
        message: 'Match number in the request body must match the route'
      });
    }

    // Find match
    const match = scrim.matches.find(m => m.matchNumber === routeMatchNumber);
    if (!match) {
      return res.status(404).json({
        success: false,
        message: `Match ${routeMatchNumber} not found`
      });
    }

    const resultValidation = validateScrimResultInput(teams, scrim.registeredTeams);
    if (resultValidation.error) {
      return res.status(400).json({
        success: false,
        message: resultValidation.error
      });
    }

    // Names and avatars are server-owned profile data. Do not persist client
    // supplied presentation fields in official standings.
    const participantRecords = await User.find({
      _id: { $in: resultValidation.value.map((team) => team.teamId) }
    }).select('username profile.displayName profile.avatar').lean();
    const participantById = new Map(participantRecords.map((participant) => [idString(participant), participant]));
    if (participantById.size !== resultValidation.value.length) {
      return res.status(400).json({
        success: false,
        message: 'Every result participant must reference an existing registered account'
      });
    }

    // Calculate points for each team
    const teamsWithPoints = resultValidation.value.map(team => {
      const participant = participantById.get(team.teamId);
      const points = calculateBGMIPoints(team.placement, team.kills);
      return {
        teamId: team.teamId,
        teamName: participant.profile?.displayName || participant.username,
        teamLogo: participant.profile?.avatar || null,
        placement: team.placement,
        kills: team.kills,
        placementPoints: points.placementPoints,
        killPoints: points.killPoints,
        totalPoints: points.totalPoints,
        rank: 0 // Will be calculated after sorting
      };
    });

    // Sort by totalPoints (descending) and assign ranks
    teamsWithPoints.sort((a, b) => b.totalPoints - a.totalPoints);
    teamsWithPoints.forEach((team, index) => {
      team.rank = index + 1;
    });

    // Update match results
    match.results = {
      teams: teamsWithPoints,
      submittedAt: new Date()
    };
    match.status = 'Completed';

    // Calculate match results using model method
    scrim.calculateMatchResults(routeMatchNumber);

    // Calculate overall standings
    scrim.calculateOverallStandings();

    // Web intentionally keeps Edit Results available after finalization. Keep
    // the published standings transactionally consistent with that workflow.
    if (scrim.finalResult?.generatedAt) {
      refreshScrimFinalResult(scrim);
    }

    await scrim.save();

    await notifyScrimRecipients({
      scrim,
      recipients: scrim.registeredTeams,
      sender: req.user._id,
      title: `Results Update: ${scrim.name}`,
      message: `Match ${routeMatchNumber} results are now available.`,
      eventType: 'scrim_match_results',
      revision: scrim.updatedAt,
      extraData: { matchNumber: routeMatchNumber }
    });

    res.status(200).json({
      success: true,
      message: `Match ${routeMatchNumber} results submitted successfully`,
      data: {
        match: match,
        overallStandings: scrim.overallStandings
      }
    });
  } catch (error) {
    log.error('Error submitting match results:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to submit match results',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Update scrim
const updateScrim = async (req, res) => {
  try {
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({
        success: false,
        message: 'Scrim not found'
      });
    }

    // Check if user is the host
    if (scrim.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only scrim host can update scrim'
      });
    }

    // Check if scrim can be updated
    if (scrim.status === 'Completed' || scrim.status === 'Cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Cannot update completed or cancelled scrim'
      });
    }

    // Update allowed fields
    const allowedUpdates = ['name', 'description', 'date', 'endDate', 'maxTeams', 'timezone', 'matches', 'prizePool', 'prizePoolType', 'prizePoolCurrency', 'prizeDistribution', 'specialPrizes'];
    allowedUpdates.forEach(field => {
      if (req.body[field] !== undefined) {
        scrim[field] = req.body[field];
      }
    });

    await scrim.save();
    await scrim.populate('host', 'username userType profile.displayName profile.avatar');

    res.status(200).json({
      success: true,
      message: 'Scrim updated successfully',
      data: {
        scrim
      }
    });
  } catch (error) {
    log.error('Error updating scrim:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to update scrim',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Delete scrim
const deleteScrim = async (req, res) => {
  try {
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({
        success: false,
        message: 'Scrim not found'
      });
    }

    // Check if user is the host
    if (scrim.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only scrim host can delete scrim'
      });
    }

    await scrim.deleteOne();

    res.status(200).json({
      success: true,
      message: 'Scrim deleted successfully'
    });
  } catch (error) {
    log.error('Error deleting scrim:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to delete scrim',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Cancel scrim
const cancelScrim = async (req, res) => {
  try {
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({
        success: false,
        message: 'Scrim not found'
      });
    }

    // Check if user is the host
    if (scrim.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only scrim host can cancel scrim'
      });
    }

    scrim.status = 'Cancelled';
    await scrim.save();

    await notifyScrimRecipients({
      scrim,
      recipients: scrim.registeredTeams,
      sender: req.user._id,
      title: `Scrim Cancelled: ${scrim.name}`,
      message: 'This scrim has been cancelled by the host.',
      eventType: 'scrim_cancelled',
      revision: 'cancelled'
    });

    res.status(200).json({
      success: true,
      message: 'Scrim cancelled successfully',
      data: {
        scrim
      }
    });
  } catch (error) {
    log.error('Error cancelling scrim:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to cancel scrim',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// -----------------------------------------------------------------------------
// Prize & Final Result Management
// -----------------------------------------------------------------------------

// Update prize distribution
const updateScrimPrizeDistribution = async (req, res) => {
  try {
    const { prizeDistribution, specialPrizes } = req.body;
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({ success: false, message: 'Scrim not found' });
    }

    if (scrim.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Only host can update prize distribution' });
    }

    if (prizeDistribution) scrim.prizeDistribution = prizeDistribution;
    if (specialPrizes) scrim.specialPrizes = specialPrizes;

    await scrim.save();

    res.status(200).json({
      success: true,
      message: 'Prize distribution updated successfully',
      data: {
        prizeDistribution: scrim.prizeDistribution,
        specialPrizes: scrim.specialPrizes
      }
    });
  } catch (error) {
    log.error('Error updating scrim prize distribution:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to update prize distribution' });
  }
};

// Generate final result by compiling overall standings
const generateScrimFinalResult = async (req, res) => {
  try {
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({ success: false, message: 'Scrim not found' });
    }

    if (scrim.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Only host can generate final result' });
    }

    if (!hasSubmittedResultsForEveryMatch(scrim.matches)) {
      return res.status(400).json({
        success: false,
        message: 'Submit results for every match before generating final standings'
      });
    }

    // Use existing calculateOverallStandings to ensure standings are up to date
    scrim.calculateOverallStandings();
    
    refreshScrimFinalResult(scrim);

    // The completeness guard above is server-authoritative. A final result is
    // therefore also the single command that marks the scrim complete.
    if (scrim.status !== 'Completed') {
      scrim.status = 'Completed';
    }

    await scrim.save();

    await notifyScrimRecipients({
      scrim,
      recipients: scrim.registeredTeams,
      sender: req.user._id,
      title: `Final Results: ${scrim.name}`,
      message: 'The final scrim standings are now available.',
      eventType: 'scrim_final_results',
      revision: scrim.finalResult.generatedAt
    });

    res.status(200).json({
      success: true,
      message: 'Final result generated successfully',
      data: { finalResult: scrim.finalResult }
    });
  } catch (error) {
    log.error('Error generating scrim final result:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to generate final result' });
  }
};

// Assign special prize winner
const assignScrimSpecialPrize = async (req, res) => {
  try {
    const { category, winnerId, winnerName } = req.body;
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({ success: false, message: 'Scrim not found' });
    }

    if (scrim.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Only host can assign special prizes' });
    }

    const prizeIndex = scrim.specialPrizes.findIndex(p => p.category === category);
    if (prizeIndex === -1) {
      return res.status(404).json({ success: false, message: 'Special prize category not found' });
    }

    scrim.specialPrizes[prizeIndex].winnerId = winnerId;
    scrim.specialPrizes[prizeIndex].winnerName = winnerName;

    // Optional: update finalResult if it exists
    if (scrim.finalResult && scrim.finalResult.specialPrizeWinners) {
      const frIndex = scrim.finalResult.specialPrizeWinners.findIndex(p => p.category === category);
      if (frIndex !== -1) {
        scrim.finalResult.specialPrizeWinners[frIndex].winnerId = winnerId;
        scrim.finalResult.specialPrizeWinners[frIndex].winnerName = winnerName;
      }
    }

    await scrim.save();

    res.status(200).json({
      success: true,
      message: 'Special prize assigned successfully',
      data: { specialPrizes: scrim.specialPrizes }
    });
  } catch (error) {
    log.error('Error assigning scrim special prize:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to assign special prize' });
  }
};

// Broadcast message to all scrim participants
const broadcastScrimMessage = async (req, res) => {
  try {
    const { message, type } = req.body;
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({ success: false, message: 'Scrim not found' });
    }

    if (scrim.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Only scrim host can send broadcasts' });
    }

    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Message is required' });
    }
    const normalizedMessage = message.trim();
    if (normalizedMessage.length > MAX_BROADCAST_MESSAGE_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `Broadcast message cannot exceed ${MAX_BROADCAST_MESSAGE_LENGTH} characters`
      });
    }

    const normalizedType = type || 'info';
    if (!SCRIM_BROADCAST_TYPES.has(normalizedType)) {
      return res.status(400).json({
        success: false,
        message: 'Broadcast type must be info, warning, match_starting, or custom'
      });
    }

    const senderName = req.user.profile?.displayName || req.user.username || 'Host';

    // Save broadcast to scrim document
    const broadcastEntry = {
      message: normalizedMessage,
      type: normalizedType,
      senderName,
      sentAt: new Date()
    };
    scrim.broadcasts = scrim.broadcasts || [];
    scrim.broadcasts.push(broadcastEntry);
    // Keep last 100 broadcasts
    if (scrim.broadcasts.length > 100) {
      scrim.broadcasts = scrim.broadcasts.slice(-100);
    }
    await scrim.save();

    // Send notification to all registered participants.
    const broadcastDeliveryKey = `scrim-broadcast:${scrim._id}:${broadcastEntry.sentAt.toISOString()}`;
    const broadcastRecipients = uniqueRecipientIds(scrim.registeredTeams);
    const notificationPromises = broadcastRecipients.map(teamId => (
      Promise.resolve().then(() => createAndEmitNotification({
        recipient: teamId,
        sender: req.user._id,
        type: 'tournament',
        title: `📢 ${scrim.name}`,
        message: normalizedMessage,
        data: {
          scrimId: scrim._id,
          scrimCode: scrim.scrimCode,
          broadcastType: normalizedType,
          openTab: 'broadcast',
          customData: {
            scrimId: scrim._id,
            scrimCode: scrim.scrimCode,
            broadcastType: normalizedType,
            openTab: 'broadcast',
            notificationDedupeKey: broadcastDeliveryKey,
            pushRequestId: broadcastDeliveryKey
          }
        }
      }))
    ));

    const notificationResults = await Promise.allSettled(notificationPromises);
    notificationResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        log.error('Scrim broadcast notification failed', {
          error: String(result.reason),
          recipientId: broadcastRecipients[index],
          scrimId: String(scrim._id)
        });
      }
    });

    res.status(200).json({
      success: true,
      message: `Broadcast sent to ${scrim.registeredTeams.length} participants`,
      data: {
        sentTo: scrim.registeredTeams.length,
        broadcast: broadcastEntry,
        timestamp: new Date()
      }
    });
  } catch (error) {
    log.error('Error broadcasting scrim message:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to send broadcast' });
  }
};

module.exports = {
  createScrim,
  getScrims,
  getScrim,
  joinScrim,
  leaveScrim,
  submitMatchResults,
  updateScrim,
  deleteScrim,
  cancelScrim,
  updateScrimPrizeDistribution,
  generateScrimFinalResult,
  assignScrimSpecialPrize,
  broadcastScrimMessage,
  __testables: {
    SCRIM_MATCH_COUNTS,
    SCRIM_BROADCAST_TYPES,
    MAX_BROADCAST_MESSAGE_LENGTH,
    validateScrimCreationInput,
    validateScrimResultInput,
    hasSubmittedResultsForEveryMatch,
    refreshScrimFinalResult
  }
};
