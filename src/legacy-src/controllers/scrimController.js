const Scrim = require('../models/Scrim');
const User = require('../models/User'); // Required for populate()
const { createAndEmitNotification } = require('../utils/notificationEmitter');
const { calculateBGMIPoints } = require('../utils/bgmiPoints');
const mongoose = require('mongoose');
const log = require('../utils/logger');
const { sanitizePublicScrim } = require('../utils/tournamentPublicDto');
const { normalizePagination } = require('../utils/pagination');
const { normalizeQuerySearch, escapeRegex } = require('../utils/searchQuery');
const { getTimezoneDayBounds } = require('../utils/timezoneDayBounds');

const uniqueRecipientIds = (values = []) =>
  Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => idString(value))
    .filter(Boolean)));

const idString = (value) => String(value?._id || value || '');
const scrimParticipants = (scrim) => (Array.isArray(scrim?.registeredTeams) ? scrim.registeredTeams : []);

const SCRIM_MATCH_COUNTS = Object.freeze([1, 2, 3, 4, 5, 6]);
const SCRIM_TYPES = new Set(['Daily', 'Weekly']);
const SCRIM_STATUSES = new Set(['Open', 'Full', 'In Progress', 'Completed', 'Cancelled']);
const SCRIM_LIST_FILTERS = new Set(['hosted', 'participating', 'all', 'completed']);
const SCRIM_FORMATS = new Set(['Solo', 'Squad']);
const SCRIM_BROADCAST_TYPES = new Set(['info', 'warning', 'match_starting', 'custom']);
const SCRIM_PRIZE_CURRENCIES = new Set(['INR', 'USD']);
const BGMI_MAPS = new Set(['Erangel', 'Miramar', 'Sanhok', 'Vikendi', 'Livik', 'Karakin', 'Nusa']);
const TIME_OF_DAY_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_SCRIM_TIMEZONE = 'Asia/Kolkata';
const MAX_BROADCAST_MESSAGE_LENGTH = 2000;
const SCRIM_CODE_PATTERN = /^SCR-BGM-[A-F0-9]{8}$/i;
const SCRIM_EDITABLE_FIELDS = new Set([
  'name',
  'description',
  'date',
  'endDate',
  'maxTeams',
  'timezone',
  'matches',
  'prizePool',
  'prizePoolType',
  'prizePoolCurrency',
  'prizeDistribution',
  'specialPrizes'
]);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

const isValidScrimIdentifier = (value) => {
  if (typeof value !== 'string' || !value.trim()) return false;
  const normalized = value.trim();
  return mongoose.Types.ObjectId.isValid(normalized) || SCRIM_CODE_PATTERN.test(normalized);
};

const validateScrimIdentifierParam = (req, res, next, value, name) => {
  if (!isValidScrimIdentifier(value)) {
    return res.status(400).json({ success: false, message: 'Invalid scrim identifier' });
  }
  req.params[name] = String(value).trim();
  return next();
};

const normalizeScrimPrizes = ({ prizeDistribution = [], specialPrizes = [], prizePool = 0 }) => {
  if (!Array.isArray(prizeDistribution) || !Array.isArray(specialPrizes)) {
    return { error: 'Prize distribution and special prizes must be arrays' };
  }
  if (prizeDistribution.length > 100 || specialPrizes.length > 100 ||
      prizeDistribution.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry)) ||
      specialPrizes.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
    return { error: 'Invalid prize entries' };
  }
  const distribution = prizeDistribution.map((entry) => ({
    rank: Number(entry.rank),
    label: String(entry.label || '').trim().slice(0, 120),
    amount: Number(entry.amount || 0),
    percentage: Number(entry.percentage || 0)
  }));
  const special = specialPrizes.map((entry) => ({
    category: typeof entry.category === 'string' ? entry.category.trim().slice(0, 120) : '',
    amount: Number(entry.amount || 0)
  }));
  const ranks = distribution.map((entry) => entry.rank);
  const categories = special.map((entry) => entry.category.toLowerCase());
  const amounts = [...distribution, ...special].map((entry) => entry.amount);
  const percentages = distribution.map((entry) => entry.percentage);
  if (ranks.some((rank) => !Number.isInteger(rank) || rank < 1) || new Set(ranks).size !== ranks.length ||
      categories.some((category) => !category) || new Set(categories).size !== categories.length ||
      amounts.some((amount) => !Number.isFinite(amount) || amount < 0) ||
      percentages.some((percentage) => !Number.isFinite(percentage) || percentage < 0 || percentage > 100) ||
      amounts.reduce((sum, amount) => sum + amount, 0) > Number(prizePool || 0)) {
    return { error: 'Invalid or over-budget prize distribution' };
  }
  return { value: { prizeDistribution: distribution, specialPrizes: special } };
};

const preserveSpecialPrizeWinners = (existingPrizes = [], normalizedPrizes = []) => (
  (Array.isArray(normalizedPrizes) ? normalizedPrizes : []).map((prize) => {
    const existing = (Array.isArray(existingPrizes) ? existingPrizes : [])
      .find((entry) => String(entry?.category || '').trim().toLowerCase()
        === String(prize?.category || '').trim().toLowerCase());
    return {
      category: prize.category,
      amount: prize.amount,
      ...(existing?.winnerId ? { winnerId: existing.winnerId } : {}),
      ...(existing?.winnerName ? { winnerName: String(existing.winnerName).slice(0, 120) } : {})
    };
  })
);

const scrimPrizeConfigurationFingerprint = (value = {}) => {
  const prizePoolType = value.prizePoolType === 'no_prize'
    ? 'without_prize'
    : (value.prizePoolType || 'without_prize');
  const prizePool = prizePoolType === 'with_prize' ? Number(value.prizePool || 0) : 0;
  const prizes = normalizeScrimPrizes({
    prizeDistribution: prizePoolType === 'with_prize' ? (value.prizeDistribution || []) : [],
    specialPrizes: prizePoolType === 'with_prize' ? (value.specialPrizes || []) : [],
    prizePool
  });
  return JSON.stringify({
    prizePoolType,
    prizePool,
    prizePoolCurrency: String(value.prizePoolCurrency || 'INR').toUpperCase(),
    prizes: prizes.value || { invalid: prizes.error }
  });
};

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
  if (name.length > 200) return { error: 'Scrim name cannot exceed 200 characters' };
  if (payload.description !== undefined && (typeof payload.description !== 'string' || payload.description.length > 5000)) {
    return { error: 'Scrim description must be text and cannot exceed 5000 characters' };
  }

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
  if (!options.allowPastDate && scrimDateKey < todayKey) return { error: 'Scrim date cannot be in the past' };

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
  const prizes = normalizeScrimPrizes({
    prizeDistribution: payload.prizeDistribution || [],
    specialPrizes: payload.specialPrizes || [],
    prizePool: normalizedPrizePoolType === 'with_prize' ? requestedPrizePool : 0
  });
  if (prizes.error) return prizes;

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
      prizeDistribution: prizes.value.prizeDistribution,
      specialPrizes: prizes.value.specialPrizes,
      matches: payload.matches.map((match, index) => ({
        matchNumber: index + 1,
        map: match.map,
        idpTime: match.idpTime,
        startTime: match.startTime
      }))
    }
  };
};

/**
 * Validate an edit against the same canonical contract used for creation.
 *
 * The edit endpoint is intentionally partial, so the persisted values are
 * merged before validation. Workflow-owned match fields (status/results) are
 * retained server-side and cannot be overwritten through the configuration
 * payload. This also keeps legacy scrims with an unchanged historical date
 * editable without permitting a new past date.
 */
const validateScrimUpdateInput = (scrim, payload = {}, options = {}) => {
  if (!scrim || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: 'A valid scrim update payload is required' };
  }

  const suppliedFields = Object.keys(payload).filter((field) => SCRIM_EDITABLE_FIELDS.has(field));
  if (suppliedFields.length === 0) return { error: 'No supported scrim fields were provided' };

  const existingMatches = Array.isArray(scrim.matches) ? scrim.matches : [];
  const requestedMatches = hasOwn(payload, 'matches') ? payload.matches : existingMatches;
  const requestedPrizePoolType = hasOwn(payload, 'prizePoolType') ? payload.prizePoolType : scrim.prizePoolType;
  const disablingPrizePool = ['without_prize', 'no_prize'].includes(requestedPrizePoolType);
  const comparisonTimezone = typeof (hasOwn(payload, 'timezone') ? payload.timezone : scrim.timezone) === 'string'
    && isSupportedTimeZone(hasOwn(payload, 'timezone') ? payload.timezone : scrim.timezone)
    ? (hasOwn(payload, 'timezone') ? payload.timezone : scrim.timezone)
    : DEFAULT_SCRIM_TIMEZONE;
  const suppliedDate = hasOwn(payload, 'date') ? parseScrimDate(payload.date) : null;
  const persistedDate = parseScrimDate(scrim.date);
  const suppliedDateMatchesPersisted = Boolean(suppliedDate && persistedDate)
    && (suppliedDate.dateKey || dateKeyInTimeZone(suppliedDate.date, comparisonTimezone))
      === (persistedDate.dateKey || dateKeyInTimeZone(persistedDate.date, comparisonTimezone));
  const mergedPayload = {
    name: hasOwn(payload, 'name') ? payload.name : scrim.name,
    description: hasOwn(payload, 'description') ? payload.description : scrim.description,
    scrimType: scrim.scrimType,
    format: scrim.format,
    timeSlot: scrim.timeSlot,
    numberOfMatches: scrim.numberOfMatches,
    date: hasOwn(payload, 'date') ? payload.date : scrim.date,
    endDate: hasOwn(payload, 'endDate') ? payload.endDate : scrim.endDate,
    maxTeams: hasOwn(payload, 'maxTeams') ? payload.maxTeams : scrim.maxTeams,
    timezone: hasOwn(payload, 'timezone') ? payload.timezone : scrim.timezone,
    prizePoolType: requestedPrizePoolType,
    prizePool: disablingPrizePool ? 0 : (hasOwn(payload, 'prizePool') ? payload.prizePool : scrim.prizePool),
    prizePoolCurrency: hasOwn(payload, 'prizePoolCurrency') ? payload.prizePoolCurrency : scrim.prizePoolCurrency,
    prizeDistribution: disablingPrizePool ? [] : (hasOwn(payload, 'prizeDistribution') ? payload.prizeDistribution : scrim.prizeDistribution),
    specialPrizes: disablingPrizePool ? [] : (hasOwn(payload, 'specialPrizes') ? payload.specialPrizes : scrim.specialPrizes),
    matches: Array.isArray(requestedMatches)
      ? requestedMatches.map((match) => ({
          matchNumber: match?.matchNumber,
          map: match?.map,
          idpTime: match?.idpTime,
          startTime: match?.startTime
        }))
      : requestedMatches
  };

  const validation = validateScrimCreationInput(mergedPayload, {
    ...options,
    // Unchanged legacy dates remain idempotently editable even when a client
    // echoes the full persisted form. A newly changed past date is rejected.
    allowPastDate: !hasOwn(payload, 'date') || suppliedDateMatchesPersisted
  });
  if (validation.error) return validation;

  const registeredCount = Array.isArray(scrim.registeredTeams) ? scrim.registeredTeams.length : 0;
  if (validation.value.maxTeams < registeredCount) {
    return { error: `Maximum teams cannot be lower than the ${registeredCount} registered participants` };
  }

  const normalized = validation.value;
  const updates = {};
  if (hasOwn(payload, 'name')) updates.name = normalized.name;
  if (hasOwn(payload, 'description')) updates.description = String(payload.description || '');
  if (hasOwn(payload, 'date')) updates.date = normalized.date;
  if (hasOwn(payload, 'endDate')) updates.endDate = normalized.endDate;
  if (hasOwn(payload, 'maxTeams')) updates.maxTeams = normalized.maxTeams;
  if (hasOwn(payload, 'timezone')) updates.timezone = normalized.timezone;
  if (hasOwn(payload, 'prizePool')) updates.prizePool = normalized.prizePool;
  if (hasOwn(payload, 'prizePoolType')) {
    updates.prizePoolType = normalized.prizePoolType;
    if (normalized.prizePoolType === 'without_prize') {
      updates.prizePool = 0;
      updates.prizeDistribution = [];
      updates.specialPrizes = [];
    }
  }
  if (hasOwn(payload, 'prizePoolCurrency')) updates.prizePoolCurrency = normalized.prizePoolCurrency;
  if (hasOwn(payload, 'prizeDistribution')) updates.prizeDistribution = normalized.prizeDistribution;
  if (hasOwn(payload, 'specialPrizes')) {
    updates.specialPrizes = preserveSpecialPrizeWinners(scrim.specialPrizes, normalized.specialPrizes);
  }
  if (hasOwn(payload, 'matches')) {
    updates.matches = normalized.matches.map((match) => {
      const existing = existingMatches.find((entry) => Number(entry?.matchNumber) === match.matchNumber);
      return {
        ...match,
        status: existing?.status || 'Scheduled',
        results: existing?.results?.toObject?.() || existing?.results || { teams: [], submittedAt: null }
      };
    });
  }

  return { value: updates, normalized };
};

const scrimCapacityArrayPath = (maxTeams) => `registeredTeams.${Math.max(0, Number(maxTeams) - 1)}`;

// A classic modifier update is mandatory here: production runs on Amazon
// DocumentDB, which rejects aggregation-pipeline updates passed as an array.
const buildScrimJoinAdmission = ({ scrimId, userId, maxTeams }) => ({
  filter: {
    _id: scrimId,
    host: { $ne: userId },
    status: 'Open',
    maxTeams,
    $and: [
      { registeredTeams: { $ne: userId } },
      {
        $or: [
          { registeredTeams: { $exists: false } },
          { registeredTeams: { $type: 'array' } }
        ]
      }
    ],
    [scrimCapacityArrayPath(maxTeams)]: { $exists: false }
  },
  update: { $addToSet: { registeredTeams: userId } }
});

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

const advanceScrimStatusForResult = (scrim) => {
  if (scrim && (scrim.status === 'Open' || scrim.status === 'Full')) {
    scrim.status = 'In Progress';
  }
  return scrim?.status;
};

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
  const participantIds = (Array.isArray(scrim.registeredTeams) ? scrim.registeredTeams : [])
    .map(idString)
    .filter(Boolean);
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

const expandScrimRecipientIds = async (values = []) => {
  const recipientIds = uniqueRecipientIds(values);
  if (recipientIds.length === 0) return [];
  try {
    const registeredTeams = await User.find({
      _id: { $in: recipientIds },
      userType: 'team',
      isActive: true
    }).select('teamInfo.members.user teamInfo.rosters.players teamInfo.rosters.isActive teamInfo.staff').lean();
    return uniqueRecipientIds([
      ...recipientIds,
      ...registeredTeams.flatMap((team) => [
        ...(team.teamInfo?.members || []).map((member) => member.user),
        ...(team.teamInfo?.rosters || [])
          .filter((roster) => roster.isActive !== false)
          .flatMap((roster) => (roster.players || [])
            .filter((player) => player.isActive !== false && !player.leftAt)
            .map((player) => player.user)),
        ...(team.teamInfo?.staff || [])
          .filter((staff) => staff.isActive !== false && !staff.leftAt)
          .map((staff) => staff.user)
      ])
    ]);
  } catch (error) {
    log.error('Failed to expand Scrim team recipients', { error: String(error) });
    return recipientIds;
  }
};

const notifyScrimRecipients = async ({ scrim, recipients, sender, title, message, eventType, revision, extraData = {} }) => {
  const recipientIds = await expandScrimRecipientIds(recipients);
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
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const { description } = payload;

    const hostId = req.user._id;

    const validation = validateScrimCreationInput(payload);
    if (validation.error) {
      return res.status(400).json({ success: false, message: validation.error });
    }
    const normalized = validation.value;

    const host = await User.findById(hostId).select('isVerifiedHost').lean();
    if (!host) {
      return res.status(401).json({ success: false, message: 'Host account is unavailable' });
    }
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
      const { start: startOfDay, end: nextDay } = getTimezoneDayBounds(DEFAULT_SCRIM_TIMEZONE);
      const todayCount = await Scrim.countDocuments({
        host: hostId,
        createdAt: { $gte: startOfDay, $lt: nextDay }
      });

      if (todayCount >= 5) {
        return res.status(429).json({
          success: false,
          message: 'Daily scrim limit reached (5/day).',
          limitType: 'scrim_daily',
          nextAllowedAt: nextDay.toISOString(),
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
      prizeDistribution: normalized.prizeDistribution,
      specialPrizes: normalized.specialPrizes,
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
    try {
      await scrim.populate('host', 'username userType profile.displayName profile.avatar');
    } catch (populateError) {
      log.error('Scrim created but host population failed', {
        error: String(populateError),
        scrimId: idString(scrim._id)
      });
    }

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
    const { page, limit, skip } = normalizePagination(req.query, { defaultLimit: 100, maxLimit: 100 });
    const scrimType = typeof req.query.scrimType === 'string' ? req.query.scrimType.trim() : '';
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const filter = typeof req.query.filter === 'string' ? req.query.filter.trim() : '';
    const search = normalizeQuerySearch(req.query.search);
    if ((req.query.scrimType !== undefined && (typeof req.query.scrimType !== 'string' || (scrimType && !SCRIM_TYPES.has(scrimType)))) ||
        (req.query.status !== undefined && (typeof req.query.status !== 'string' || (status && !SCRIM_STATUSES.has(status)))) ||
        (req.query.filter !== undefined && (typeof req.query.filter !== 'string' || (filter && !SCRIM_LIST_FILTERS.has(filter))))) {
      return res.status(400).json({ success: false, message: 'Invalid scrim filter' });
    }

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
        { name: { $regex: escapeRegex(search), $options: 'i' } },
        { description: { $regex: escapeRegex(search), $options: 'i' } },
        { scrimCode: { $regex: escapeRegex(search), $options: 'i' } }
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
        const persistedMatches = Array.isArray(scrim.matches) ? scrim.matches : [];
        const allMatchesCompleted = persistedMatches.length > 0 && persistedMatches.every(match =>
          match.status === 'Completed' || match.results?.submittedAt
        );

        if (allMatchesCompleted) {
          const completed = await Scrim.updateOne(
            { _id: scrim._id, status: beforeStatus },
            { $set: { status: 'Completed' } },
            { runValidators: true }
          );
          if (Number(completed?.modifiedCount || completed?.nModified || 0) > 0) {
            scrim.status = 'Completed';
            scrimsToUpdate.push(scrim._id);
          }
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
    if (scrimParticipants(scrim).some((participant) => idString(participant) === idString(userId))) {
      return res.status(400).json({
        success: false,
        message: 'You are already registered for this scrim'
      });
    }

    // Check if scrim is full
    if (scrimParticipants(scrim).length >= scrim.maxTeams) {
      try {
        await Scrim.updateOne({ _id: scrim._id, status: 'Open' }, { $set: { status: 'Full' } });
      } catch (statusError) {
        log.error('Failed to reconcile full Scrim status', {
          error: String(statusError),
          scrimId: idString(scrim._id)
        });
      }
      return res.status(400).json({
        success: false,
        message: 'Scrim is full'
      });
    }

    // Format-based join validation
    const joiningUser = await User.findById(userId).select('userType isActive moderationStatus');
    if (!joiningUser || joiningUser.isActive === false || ['banned', 'soft_deleted'].includes(joiningUser.moderationStatus)) {
      return res.status(403).json({ success: false, message: 'Your account is not eligible to join scrims' });
    }
    
    if (scrim.format === 'Squad') {
      // Squad scrims: only teams can join
      if (joiningUser.userType !== 'team') {
        return res.status(400).json({
          success: false,
          message: 'Only teams can join Squad scrims. Please use a team account.'
        });
      }
    }
    // Solo scrims: both players and teams can join (no restriction)

    // Capacity and duplicate admission are one classic modifier command.
    // Amazon DocumentDB rejects aggregation-pipeline updates (array updates),
    // while this positional existence guard remains atomic and compatible.
    const admission = buildScrimJoinAdmission({
      scrimId: scrim._id,
      userId,
      maxTeams: scrim.maxTeams
    });
    const joinedScrim = await Scrim.findOneAndUpdate(
      admission.filter,
      admission.update,
      { new: true, runValidators: true }
    );

    if (!joinedScrim) {
      const latest = await Scrim.findById(scrim._id).select('host status registeredTeams maxTeams');
      if (!latest) return res.status(404).json({ success: false, message: 'Scrim not found' });
      if (scrimParticipants(latest).some((participant) => idString(participant) === idString(userId))) {
        return res.status(400).json({ success: false, message: 'You are already registered for this scrim' });
      }
      if (latest.status === 'Full' || scrimParticipants(latest).length >= latest.maxTeams) {
        if (latest.status === 'Open') {
          try {
            await Scrim.updateOne({ _id: latest._id, status: 'Open' }, { $set: { status: 'Full' } });
          } catch (statusError) {
            log.error('Failed to reconcile concurrently full Scrim status', {
              error: String(statusError),
              scrimId: idString(latest._id)
            });
          }
        }
        return res.status(400).json({ success: false, message: 'Scrim is full' });
      }
      return res.status(409).json({ success: false, message: 'Scrim registration changed. Please try again.' });
    }

    // Classic modifiers cannot derive another field from the post-update array.
    // Marking the exact-capacity document Full is therefore a second guarded
    // command. A concurrent leave makes the guard false and safely keeps it Open.
    if (scrimParticipants(joinedScrim).length >= joinedScrim.maxTeams) {
      try {
        const fullResult = await Scrim.updateOne(
          {
            _id: joinedScrim._id,
            status: 'Open',
            maxTeams: joinedScrim.maxTeams,
            [scrimCapacityArrayPath(joinedScrim.maxTeams)]: { $exists: true }
          },
          { $set: { status: 'Full' } },
          { runValidators: true }
        );
        if (Number(fullResult?.modifiedCount || fullResult?.nModified || 0) > 0) {
          joinedScrim.status = 'Full';
        }
      } catch (statusError) {
        // Registration already committed. Do not report a false failure; the
        // admission capacity guard still prevents a seventeenth participant.
        log.error('Scrim joined but Full status reconciliation failed', {
          error: String(statusError),
          scrimId: idString(joinedScrim._id)
        });
      }
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

    let joinResponseScrim = joinedScrim;
    try {
      await joinedScrim.populate('registeredTeams', 'username userType profile.displayName profile.avatar');
    } catch (populateError) {
      // Admission is already durable. Optional response enrichment must never
      // turn a successful registration into a reported 500.
      log.error('Scrim joined but participant population failed', {
        error: String(populateError),
        scrimId: idString(joinedScrim._id)
      });
      joinResponseScrim = sanitizePublicScrim(joinedScrim);
    }

    res.status(200).json({
      success: true,
      message: 'Successfully joined scrim',
      data: {
        scrim: joinResponseScrim
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

    if (scrim.status !== 'Open' && scrim.status !== 'Full') {
      return res.status(400).json({
        success: false,
        message: `Cannot leave scrim. Current status: ${scrim.status}`
      });
    }

    // Check if user is registered
    if (!scrimParticipants(scrim).some((participant) => idString(participant) === idString(userId))) {
      return res.status(400).json({
        success: false,
        message: 'You are not registered for this scrim'
      });
    }

    // Do not save a stale hydrated participant array: a concurrent join would
    // otherwise be overwritten. $pull is atomic and DocumentDB-compatible.
    const leftScrim = await Scrim.findOneAndUpdate(
      {
        _id: scrim._id,
        status: { $in: ['Open', 'Full'] },
        registeredTeams: userId
      },
      { $pull: { registeredTeams: userId } },
      { new: true, runValidators: true }
    );
    if (!leftScrim) {
      const latest = await Scrim.findById(scrim._id).select('status registeredTeams');
      if (!latest) return res.status(404).json({ success: false, message: 'Scrim not found' });
      if (!scrimParticipants(latest).some((participant) => idString(participant) === idString(userId))) {
        return res.status(400).json({ success: false, message: 'You are not registered for this scrim' });
      }
      return res.status(409).json({ success: false, message: 'Scrim registration changed. Please try again.' });
    }

    if (leftScrim.status === 'Full') {
      try {
        const reopenResult = await Scrim.updateOne(
          {
            _id: leftScrim._id,
            status: 'Full',
            maxTeams: leftScrim.maxTeams,
            [scrimCapacityArrayPath(leftScrim.maxTeams)]: { $exists: false }
          },
          { $set: { status: 'Open' } },
          { runValidators: true }
        );
        if (Number(reopenResult?.modifiedCount || reopenResult?.nModified || 0) > 0) {
          leftScrim.status = 'Open';
        }
      } catch (statusError) {
        // The participant removal is already durable; return success and let a
        // later guarded reconciliation reopen registration.
        log.error('Scrim left but Open status reconciliation failed', {
          error: String(statusError),
          scrimId: idString(leftScrim._id)
        });
      }
    }

    if (String(leftScrim.host) !== String(userId)) {
      await notifyScrimRecipients({
        scrim: leftScrim,
        recipients: [leftScrim.host],
        sender: userId,
        title: 'Scrim Registration Withdrawn',
        message: `${req.user.profile?.displayName || req.user.username} left "${leftScrim.name}"`,
        eventType: 'scrim_registration_left',
        revision: leftScrim.updatedAt,
        extraData: { participantId: userId }
      });
    }

    try {
      await leftScrim.populate('registeredTeams', 'username userType profile.displayName profile.avatar');
    } catch (populateError) {
      // Removal already committed; the sanitized fallback below does not need
      // populated presentation fields to remain safe and useful.
      log.error('Scrim left but participant population failed', {
        error: String(populateError),
        scrimId: idString(leftScrim._id)
      });
    }

    res.status(200).json({
      success: true,
      message: 'Successfully left scrim',
      data: {
        // Membership has already been revoked, so do not return the private
        // broadcast archive that was present on the hydrated document.
        scrim: sanitizePublicScrim(leftScrim)
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
    const { matchNumber, teams } = req.body && typeof req.body === 'object' ? req.body : {};
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({
        success: false,
        message: 'Scrim not found'
      });
    }

    // Check if user is the host
    if (idString(scrim.host) !== idString(req.user?._id)) {
      return res.status(403).json({
        success: false,
        message: 'Only scrim host can submit match results'
      });
    }

    if (scrim.status === 'Cancelled') {
      return res.status(400).json({ success: false, message: 'Cannot submit results for a cancelled scrim' });
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
    const match = (Array.isArray(scrim.matches) ? scrim.matches : [])
      .find(m => m.matchNumber === routeMatchNumber);
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
    advanceScrimStatusForResult(scrim);

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
    if (error?.name === 'VersionError') {
      return res.status(409).json({ success: false, message: 'Scrim results changed. Refresh and try again.' });
    }
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
    if (idString(scrim.host) !== idString(req.user?._id)) {
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

    const validation = validateScrimUpdateInput(scrim, req.body);
    if (validation.error) {
      return res.status(400).json({ success: false, message: validation.error });
    }

    const prizeConfigurationChanged = scrimPrizeConfigurationFingerprint(scrim)
      !== scrimPrizeConfigurationFingerprint(validation.normalized);
    if (validation.normalized.prizePoolType === 'with_prize' && prizeConfigurationChanged) {
      const host = await User.findById(req.user._id).select('isVerifiedHost').lean();
      if (host?.isVerifiedHost !== true) {
        return res.status(403).json({
          success: false,
          message: 'You are not authorized to edit prize pool scrims. Please apply for Verified Host status.'
        });
      }
    }

    const persistedUpdates = { ...validation.value };
    const participantCount = Array.isArray(scrim.registeredTeams) ? scrim.registeredTeams.length : 0;
    if ((scrim.status === 'Open' || scrim.status === 'Full') && hasOwn(validation.value, 'maxTeams')) {
      persistedUpdates.status = participantCount >= validation.normalized.maxTeams ? 'Full' : 'Open';
    }

    const updateFilter = {
      _id: scrim._id,
      host: req.user._id,
      status: scrim.status
    };
    if (Number.isInteger(scrim.__v)) updateFilter.__v = scrim.__v;
    else if (scrim.updatedAt instanceof Date) updateFilter.updatedAt = scrim.updatedAt;
    if (hasOwn(validation.value, 'maxTeams')) {
      // A capacity edit must be based on the exact participant count that was
      // validated. A simultaneous join/leave returns 409 instead of applying
      // a stale Open/Full decision.
      if (participantCount > 0) {
        updateFilter[`registeredTeams.${participantCount - 1}`] = { $exists: true };
      }
      updateFilter[`registeredTeams.${participantCount}`] = { $exists: false };
    }

    const updateCommand = { $set: persistedUpdates };
    if (Number.isInteger(scrim.__v)) updateCommand.$inc = { __v: 1 };
    const updatedScrim = await Scrim.findOneAndUpdate(updateFilter, updateCommand, {
      new: true,
      runValidators: true
    });
    if (!updatedScrim) {
      const latest = await Scrim.findById(scrim._id).select('host status');
      if (!latest) return res.status(404).json({ success: false, message: 'Scrim not found' });
      if (idString(latest.host) !== idString(req.user?._id)) {
        return res.status(403).json({ success: false, message: 'Only scrim host can update scrim' });
      }
      if (latest.status === 'Completed' || latest.status === 'Cancelled') {
        return res.status(400).json({ success: false, message: 'Cannot update completed or cancelled scrim' });
      }
      return res.status(409).json({
        success: false,
        message: 'Scrim changed while it was being edited. Refresh and try again.'
      });
    }

    await notifyScrimRecipients({
      scrim: updatedScrim,
      recipients: updatedScrim.registeredTeams,
      sender: req.user._id,
      title: `Scrim Updated: ${updatedScrim.name}`,
      message: 'The host updated the scrim details.',
      eventType: 'scrim_updated',
      revision: updatedScrim.updatedAt,
      extraData: { changedFields: Object.keys(validation.value) }
    });

    try {
      await updatedScrim.populate('host', 'username userType profile.displayName profile.avatar');
      await updatedScrim.populate('registeredTeams', 'username userType profile.displayName profile.avatar');
    } catch (populateError) {
      log.error('Scrim updated but response population failed', {
        error: String(populateError),
        scrimId: idString(updatedScrim._id)
      });
    }

    res.status(200).json({
      success: true,
      message: 'Scrim updated successfully',
      data: {
        scrim: updatedScrim
      }
    });
  } catch (error) {
    log.error('Error updating scrim:', { error: String(error) });
    if (error?.name === 'ValidationError' || error?.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid scrim update',
        errors: error?.errors ? Object.values(error.errors).map((entry) => entry.message) : undefined
      });
    }
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
    if (idString(scrim.host) !== idString(req.user?._id)) {
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
    if (idString(scrim.host) !== idString(req.user?._id)) {
      return res.status(403).json({
        success: false,
        message: 'Only scrim host can cancel scrim'
      });
    }

    if (scrim.status === 'Completed') {
      return res.status(400).json({
        success: false,
        message: 'Completed scrims cannot be cancelled'
      });
    }
    if (scrim.status === 'Cancelled') {
      return res.status(200).json({
        success: true,
        message: 'Scrim is already cancelled',
        data: { scrim }
      });
    }

    const cancelledScrim = await Scrim.findOneAndUpdate(
      {
        _id: scrim._id,
        host: req.user._id,
        status: { $nin: ['Completed', 'Cancelled'] }
      },
      { $set: { status: 'Cancelled' } },
      { new: true, runValidators: true }
    );
    if (!cancelledScrim) {
      const latest = await Scrim.findById(scrim._id).select('host status');
      if (!latest) return res.status(404).json({ success: false, message: 'Scrim not found' });
      if (idString(latest.host) !== idString(req.user?._id)) {
        return res.status(403).json({ success: false, message: 'Only scrim host can cancel scrim' });
      }
      if (latest.status === 'Completed') {
        return res.status(400).json({ success: false, message: 'Completed scrims cannot be cancelled' });
      }
      return res.status(200).json({ success: true, message: 'Scrim is already cancelled', data: { scrim: latest } });
    }

    await notifyScrimRecipients({
      scrim: cancelledScrim,
      recipients: cancelledScrim.registeredTeams,
      sender: req.user._id,
      title: `Scrim Cancelled: ${cancelledScrim.name}`,
      message: 'This scrim has been cancelled by the host.',
      eventType: 'scrim_cancelled',
      revision: 'cancelled'
    });

    res.status(200).json({
      success: true,
      message: 'Scrim cancelled successfully',
      data: {
        scrim: cancelledScrim
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
    const { prizeDistribution, specialPrizes } = req.body && typeof req.body === 'object' ? req.body : {};
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({ success: false, message: 'Scrim not found' });
    }

    if (idString(scrim.host) !== idString(req.user?._id)) {
      return res.status(403).json({ success: false, message: 'Only host can update prize distribution' });
    }
    if (scrim.status === 'Completed' || scrim.status === 'Cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Cannot update prize distribution for a completed or cancelled scrim'
      });
    }

    const prizes = normalizeScrimPrizes({
      prizeDistribution: prizeDistribution ?? scrim.prizeDistribution ?? [],
      specialPrizes: specialPrizes ?? scrim.specialPrizes ?? [],
      prizePool: scrim.prizePool
    });
    if (prizes.error) {
      return res.status(400).json({ success: false, message: prizes.error });
    }
    const nextSpecialPrizes = preserveSpecialPrizeWinners(scrim.specialPrizes, prizes.value.specialPrizes);
    const prizeConfigurationChanged = scrimPrizeConfigurationFingerprint(scrim)
      !== scrimPrizeConfigurationFingerprint({
        prizePoolType: scrim.prizePoolType,
        prizePool: scrim.prizePool,
        prizePoolCurrency: scrim.prizePoolCurrency,
        prizeDistribution: prizes.value.prizeDistribution,
        specialPrizes: nextSpecialPrizes
      });
    if (scrim.prizePoolType === 'with_prize' && prizeConfigurationChanged) {
      const host = await User.findById(req.user._id).select('isVerifiedHost').lean();
      if (host?.isVerifiedHost !== true) {
        return res.status(403).json({
          success: false,
          message: 'You are not authorized to edit prize pool scrims. Please apply for Verified Host status.'
        });
      }
    }
    scrim.prizeDistribution = prizes.value.prizeDistribution;
    scrim.specialPrizes = nextSpecialPrizes;

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
    if (error?.name === 'VersionError') {
      return res.status(409).json({ success: false, message: 'Scrim prizes changed. Refresh and try again.' });
    }
    if (error?.name === 'ValidationError' || error?.name === 'CastError') {
      return res.status(400).json({ success: false, message: 'Invalid prize distribution' });
    }
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

    if (idString(scrim.host) !== idString(req.user?._id)) {
      return res.status(403).json({ success: false, message: 'Only host can generate final result' });
    }

    if (scrim.status === 'Cancelled') {
      return res.status(400).json({ success: false, message: 'Cannot generate results for a cancelled scrim' });
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
    if (error?.name === 'VersionError') {
      return res.status(409).json({ success: false, message: 'Scrim results changed. Refresh and try again.' });
    }
    res.status(500).json({ success: false, message: 'Failed to generate final result' });
  }
};

// Assign special prize winner
const assignScrimSpecialPrize = async (req, res) => {
  try {
    const { category, winnerId } = req.body && typeof req.body === 'object' ? req.body : {};
    if (typeof category !== 'string' || !category.trim() || category.length > 120 ||
        typeof winnerId !== 'string' || !mongoose.Types.ObjectId.isValid(winnerId)) {
      return res.status(400).json({ success: false, message: 'Valid special prize winner details are required' });
    }
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({ success: false, message: 'Scrim not found' });
    }

    if (idString(scrim.host) !== idString(req.user?._id)) {
      return res.status(403).json({ success: false, message: 'Only host can assign special prizes' });
    }
    if (scrim.status === 'Cancelled') {
      return res.status(400).json({ success: false, message: 'Cannot assign prizes for a cancelled scrim' });
    }

    if (!scrimParticipants(scrim).some((participant) => idString(participant) === idString(winnerId))) {
      return res.status(400).json({
        success: false,
        message: 'Special prize winner must be a registered scrim participant'
      });
    }

    const winner = await User.findOne({ _id: winnerId, isActive: true })
      .select('username profile.displayName')
      .lean();
    if (!winner) {
      return res.status(400).json({ success: false, message: 'Registered winner account is unavailable' });
    }

    const normalizedCategory = category.trim();
    const winnerName = winner.profile?.displayName || winner.username;
    const prizes = Array.isArray(scrim.specialPrizes) ? scrim.specialPrizes : [];
    const prizeIndex = prizes.findIndex(p => p.category === normalizedCategory);
    if (prizeIndex === -1) {
      return res.status(404).json({ success: false, message: 'Special prize category not found' });
    }

    scrim.specialPrizes[prizeIndex].winnerId = winnerId;
    scrim.specialPrizes[prizeIndex].winnerName = winnerName;

    // Optional: update finalResult if it exists
    if (scrim.finalResult && scrim.finalResult.specialPrizeWinners) {
      const frIndex = scrim.finalResult.specialPrizeWinners.findIndex(p => p.category === normalizedCategory);
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
    if (error?.name === 'VersionError') {
      return res.status(409).json({ success: false, message: 'Scrim prizes changed. Refresh and try again.' });
    }
    res.status(500).json({ success: false, message: 'Failed to assign special prize' });
  }
};

// Broadcast message to all scrim participants
const broadcastScrimMessage = async (req, res) => {
  try {
    const { message, type } = req.body && typeof req.body === 'object' ? req.body : {};
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({ success: false, message: 'Scrim not found' });
    }

    if (idString(scrim.host) !== idString(req.user?._id)) {
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
    const broadcastRecipients = await expandScrimRecipientIds(scrim.registeredTeams);
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
      message: `Broadcast sent to ${broadcastRecipients.length} recipients`,
      data: {
        sentTo: broadcastRecipients.length,
        broadcast: broadcastEntry,
        timestamp: new Date()
      }
    });
  } catch (error) {
    log.error('Error broadcasting scrim message:', { error: String(error) });
    if (error?.name === 'VersionError') {
      return res.status(409).json({ success: false, message: 'Scrim changed. Refresh and try again.' });
    }
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
  validateScrimIdentifierParam,
  __testables: {
    SCRIM_MATCH_COUNTS,
    SCRIM_BROADCAST_TYPES,
    MAX_BROADCAST_MESSAGE_LENGTH,
    validateScrimCreationInput,
    validateScrimUpdateInput,
    scrimPrizeConfigurationFingerprint,
    buildScrimJoinAdmission,
    scrimCapacityArrayPath,
    isValidScrimIdentifier,
    validateScrimResultInput,
    advanceScrimStatusForResult,
    hasSubmittedResultsForEveryMatch,
    refreshScrimFinalResult
  }
};
