const User = require('../models/User');
const RandomConnection = require('../models/RandomConnection');
const ConnectionQueue = require('../models/ConnectionQueue');
const { createAndEmitNotification } = require('../utils/notificationEmitter');
const {
  FREE_DAILY_GENDER_MATCH_LIMIT,
  isLegacyUserPremium,
  resolveRandomConnectEntitlement,
  randomConnectEntitlementEnvelope
} = require('../services/entitlementService');
const {
  withRandomConnectAdmissions,
  withRandomConnectAdmission,
  commitRandomConnectMatch,
  ensureGenderFilterQuota,
  reserveGenderFilterSlot,
  syncAttributedUsage,
  getGenderFilterUsage
} = require('../services/randomConnectAdmissionService');
const { v4: uuidv4 } = require('uuid');
const log = require('../utils/logger');
const {
  normalizeMatchmakingGender,
  normalizePreferredGender,
  evaluateGenderCompatibility,
  buildGenderCandidateQuery,
  buildCompatiblePreferenceQuery
} = require('../utils/randomConnectGender');

// Free users: daily match limit. Premium: unlimited matches.
const FREE_DAILY_MATCH_LIMIT = FREE_DAILY_GENDER_MATCH_LIMIT;
const FREE_TO_FREE_SESSION_SECONDS = Number(process.env.RANDOM_CONNECT_FREE_SESSION_SECONDS || 180);
const SESSION_WARNING_SECONDS = 30;
const TAG_FALLBACK_MS = Number(process.env.RANDOM_CONNECT_TAG_FALLBACK_MS || 20000);
const RECENT_PARTNER_AVOID_MS = Number(process.env.RANDOM_CONNECT_RECENT_PARTNER_AVOID_MS || 10 * 60 * 1000);
const MATCH_BATCH_LIMIT = Number(process.env.RANDOM_CONNECT_MATCH_BATCH_LIMIT || 100);
const ACTIVE_SESSION_STATUSES = ['waiting', 'active'];
const sessionTimerHandles = new Map();

const isPremiumUser = isLegacyUserPremium;

const getIo = (req) => req?.app?.get?.('io') || global._arcSocketIO || null;

const normalizeTags = (tags = []) => {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags
    .map(tag => String(tag || '').trim().toLowerCase())
    .filter(tag => tag.length > 0 && tag.length <= 30))]
    .slice(0, 10);
};

const sanitizePreferredGender = normalizePreferredGender;

const matchDebugEnabled = () => process.env.RANDOM_CONNECT_MATCH_DEBUG === 'true';
const logMatchDebug = (message, meta = {}) => {
  if (matchDebugEnabled()) log.info(message, meta);
};

const requestSource = (req) => String(
  req?.get?.('x-client-platform') || req?.get?.('x-app-platform') || 'unspecified'
).trim().slice(0, 40) || 'unspecified';

const setEntitlementNoStore = (res) => {
  res.set('Cache-Control', 'private, no-store');
};

const buildGenderFilterUserIds = (...participants) => Array.from(new Map(
  participants
    .filter((participant) => participant?.userId && sanitizePreferredGender(participant.preferredGender))
    .map((participant) => [getUserIdString(participant.userId), participant.userId])
).values());

const getUserIdString = (value) => {
  if (!value) return '';
  if (value._id) return value._id.toString();
  return value.toString();
};

const hasBlockedUser = (user, otherId) => {
  const expected = getUserIdString(otherId);
  return Array.isArray(user?.blockedUsers)
    && user.blockedUsers.some((entry) => getUserIdString(entry) === expected);
};

const canPrivacyMatchUsers = (userA, userB) => Boolean(
  userA
  && userB
  && userA.isActive !== false
  && userB.isActive !== false
  && !hasBlockedUser(userA, userB._id)
  && !hasBlockedUser(userB, userA._id)
);

const getMembershipTier = (user) => user?.membership?.tier || 'free';

const getPremiumSnapshot = (user) => ({
  isPremium: isPremiumUser(user),
  membershipTier: getMembershipTier(user)
});

const buildSessionPolicy = (userA, userB) => {
  const aPremium = isPremiumUser(userA);
  const bPremium = isPremiumUser(userB);
  const isLimited = !aPremium && !bPremium;
  return {
    isLimited,
    durationLimitSeconds: isLimited ? FREE_TO_FREE_SESSION_SECONDS : null,
    limitReason: isLimited ? 'free_to_free' : 'premium_unlimited'
  };
};

const buildSessionPolicyPayload = (connection) => ({
  isLimited: Boolean(connection.durationLimitSeconds),
  durationLimitSeconds: connection.durationLimitSeconds || null,
  connectedAt: connection.connectedAt || null,
  timerStartedAt: connection.timerStartedAt || null,
  expiresAt: connection.expiresAt || null,
  serverTime: new Date(),
  warningSeconds: SESSION_WARNING_SECONDS
});

const buildConnectionPayload = (connection) => {
  const obj = connection?.toObject ? connection.toObject() : connection;
  if (!obj) return null;
  return {
    roomId: obj.roomId,
    sessionId: obj.roomId,
    participants: (obj.participants || []).map(p => ({
      userId: getUserIdString(p.userId),
      username: p.username,
      displayName: p.displayName,
      avatar: p.avatar,
      videoEnabled: p.videoEnabled,
      readyAt: p.readyAt || null
    })),
    selectedGame: obj.selectedGame || null,
    tags: obj.tags || [],
    matchedTags: obj.matchedTags || [],
    matchQuality: obj.matchQuality || 'unknown',
    status: obj.status,
    sessionPolicy: buildSessionPolicyPayload(obj),
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt
  };
};

const emitToParticipants = (io, connection, eventName, payload) => {
  if (!io || !connection) return;
  const data = {
    roomId: connection.roomId,
    sessionId: connection.roomId,
    ...payload
  };
  io.to(`random-room-${connection.roomId}`).emit(eventName, data);
  (connection.participants || []).forEach(participant => {
    const participantId = getUserIdString(participant.userId);
    if (participantId) io.to(`user-${participantId}`).emit(eventName, data);
  });
};

const clearSessionTimers = (roomId) => {
  const handles = sessionTimerHandles.get(roomId);
  if (!handles) return;
  handles.forEach(handle => clearTimeout(handle));
  sessionTimerHandles.delete(roomId);
};

const sendTimerWarning = async (roomId, io) => {
  const connection = await RandomConnection.findOneAndUpdate(
    {
      roomId,
      status: 'active',
      durationLimitSeconds: { $type: 'number' },
      timerWarningSentAt: { $exists: false }
    },
    { $set: { timerWarningSentAt: new Date() } },
    { new: true }
  );
  if (!connection) return;
  emitToParticipants(io, connection, 'random-session-timer-warning', {
    remainingSeconds: SESSION_WARNING_SECONDS,
    sessionPolicy: buildSessionPolicyPayload(connection)
  });
};

const endExpiredSession = async (roomId, io) => {
  const now = new Date();
  const connection = await RandomConnection.findOneAndUpdate(
    {
      roomId,
      status: 'active',
      durationLimitSeconds: { $type: 'number' },
      expiresAt: { $lte: now }
    },
    [
      {
        $set: {
          status: 'ended',
          endTime: now,
          endReason: 'timeout',
          duration: {
            $floor: {
              $divide: [
                { $subtract: [now, { $ifNull: ['$connectedAt', '$startTime'] }] },
                1000
              ]
            }
          }
        }
      }
    ],
    { new: true }
  );
  if (!connection) return;
  clearSessionTimers(roomId);
  emitToParticipants(io, connection, 'random-session-ended', {
    reason: 'timeout',
    message: 'Free Random Connect session limit reached.',
    sessionPolicy: buildSessionPolicyPayload(connection)
  });
};

const scheduleSessionTimers = (connection, io) => {
  if (!connection?.durationLimitSeconds || !connection.expiresAt || !io) return;
  const roomId = connection.roomId;
  clearSessionTimers(roomId);
  const expiresAtMs = new Date(connection.expiresAt).getTime();
  const warningDelay = Math.max(0, expiresAtMs - Date.now() - SESSION_WARNING_SECONDS * 1000);
  const endDelay = Math.max(0, expiresAtMs - Date.now());
  const warningHandle = setTimeout(() => {
    sendTimerWarning(roomId, io).catch(error => log.error('Random Connect timer warning error:', { error: String(error) }));
  }, warningDelay);
  const endHandle = setTimeout(() => {
    endExpiredSession(roomId, io).catch(error => log.error('Random Connect timeout error:', { error: String(error) }));
  }, endDelay);
  sessionTimerHandles.set(roomId, [warningHandle, endHandle]);
};

const syncExpiredSessions = async (io) => {
  const now = new Date();
  const warningAt = new Date(now.getTime() + SESSION_WARNING_SECONDS * 1000);
  const warningSessions = await RandomConnection.find({
    status: 'active',
    durationLimitSeconds: { $type: 'number' },
    expiresAt: { $lte: warningAt, $gt: now },
    timerWarningSentAt: { $exists: false }
  }).select('roomId');
  await Promise.all(warningSessions.map(session => sendTimerWarning(session.roomId, io)));

  const expiredSessions = await RandomConnection.find({
    status: 'active',
    durationLimitSeconds: { $type: 'number' },
    expiresAt: { $lte: now }
  }).select('roomId');
  await Promise.all(expiredSessions.map(session => endExpiredSession(session.roomId, io)));
};

const getSessionTimerState = async (roomId, userId) => {
  const connection = await RandomConnection.findOne({
    roomId,
    ...(userId ? { 'participants.userId': userId } : {}),
    status: { $in: ACTIVE_SESSION_STATUSES }
  });
  if (!connection) return null;
  return {
    roomId: connection.roomId,
    sessionId: connection.roomId,
    status: connection.status,
    sessionPolicy: buildSessionPolicyPayload(connection)
  };
};

const markSessionReady = async (roomId, userId, io) => {
  if (!roomId || !userId) return null;
  const userIdStr = userId.toString();
  const now = new Date();

  let connection = await RandomConnection.findOneAndUpdate(
    {
      roomId,
      status: 'active',
      'participants.userId': userId
    },
    {
      $set: {
        'participants.$.readyAt': now
      }
    },
    { new: true }
  );

  if (!connection) return null;

  const readyParticipantIds = new Set((connection.participants || [])
    .filter(participant => participant.readyAt)
    .map(participant => getUserIdString(participant.userId)));

  emitToParticipants(io, connection, 'random-session-ready', {
    readyUserId: userIdStr,
    readyCount: readyParticipantIds.size,
    participantCount: connection.participants.length,
    sessionPolicy: buildSessionPolicyPayload(connection)
  });

  const allReady = (connection.participants || []).length >= 2 &&
    (connection.participants || []).every(participant => participant.readyAt);

  if (allReady && !connection.timerStartedAt) {
    const expiresAt = connection.durationLimitSeconds
      ? new Date(now.getTime() + connection.durationLimitSeconds * 1000)
      : null;

    connection = await RandomConnection.findOneAndUpdate(
      {
        roomId,
        status: 'active',
        timerStartedAt: { $exists: false }
      },
      {
        $set: {
          connectedAt: now,
          timerStartedAt: now,
          startTime: now,
          ...(expiresAt ? { expiresAt } : {})
        }
      },
      { new: true }
    ) || connection;

    emitToParticipants(io, connection, 'random-session-timer-started', {
      sessionPolicy: buildSessionPolicyPayload(connection)
    });
    scheduleSessionTimers(connection, io);
  } else {
    const state = await getSessionTimerState(roomId, userId);
    if (state && io) {
      io.to(`user-${userIdStr}`).emit('random-session-timer-sync', state);
    }
  }

  return buildConnectionPayload(connection);
};

const createHttpError = (status, payload) => {
  const error = new Error(payload?.message || 'Random Connect request failed');
  error.status = status;
  error.payload = payload;
  return error;
};

const buildRequestErrorPayload = async (req, error, fallbackMessage) => {
  if (error?.payload) return error.payload;
  let entitlementResponse = {};
  if (req.user?._id) {
    try {
      const entitlement = await resolveRandomConnectEntitlement({
        userId: req.user._id,
        requestSource: requestSource(req)
      });
      entitlementResponse = randomConnectEntitlementEnvelope(entitlement);
    } catch {
      // If entitlement storage itself is unavailable, preserve the original
      // failure instead of substituting or granting a client-side decision.
    }
  }
  return {
    success: false,
    code: error?.code || 'RANDOM_CONNECT_REQUEST_FAILED',
    message: error?.message || fallbackMessage,
    retryable: error?.retryable === true || error?.status === 409,
    retryAfterMs: error?.retryAfterMs,
    ...entitlementResponse
  };
};

const runAdmissionProtectedController = async ({ req, res, operation, work, fallbackMessage }) => {
  setEntitlementNoStore(res);
  try {
    return await withRandomConnectAdmission({
      userId: req.user._id,
      operation,
      work
    });
  } catch (error) {
    if (error?.status) {
      if (error.retryAfterMs) res.set('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
      return res.status(error.status).json(await buildRequestErrorPayload(req, error, fallbackMessage));
    }
    log.error(`${operation} Random Connect admission error`, { error: String(error) });
    return res.status(500).json({
      success: false,
      message: fallbackMessage,
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const queueAndTryMatch = async ({
  user,
  body = {},
  io,
  source = 'unspecified',
  admissionLease,
  assertLease = () => {}
}) => {
  const { selectedGame, tags = [], videoEnabled = true, preferredGender } = body;
  const userId = user?._id;

  if (!userId) {
    throw createHttpError(401, {
      success: false,
      message: 'User not authenticated'
    });
  }

  // Authorization uses a short-lived cached user. Matchmaking gender must use
  // the canonical profile so a recent profile update cannot queue a stale or
  // empty value for several minutes.
  const canonicalProfile = await User.findById(userId)
    .select('profile.gender blockedUsers isActive')
    .lean();
  if (!canonicalProfile) {
    throw createHttpError(404, {
      success: false,
      message: 'User profile not found'
    });
  }
  if (canonicalProfile.isActive === false) {
    throw createHttpError(403, {
      success: false,
      message: 'Random Connect is not available for inactive accounts'
    });
  }
  const userGender = normalizeMatchmakingGender(canonicalProfile.profile?.gender);

  // Never authorize Premium behavior from req.user/JWT/client state. The
  // resolver reads the current canonical membership and a fresh User fallback.
  const entitlement = await resolveRandomConnectEntitlement({
    userId,
    requestSource: source
  });
  const entitlementResponse = randomConnectEntitlementEnvelope(entitlement);
  const refreshedEntitlementResponse = async () => {
    try {
      return randomConnectEntitlementEnvelope(await resolveRandomConnectEntitlement({
        userId,
        requestSource: source
      }));
    } catch (error) {
      // A connection/queue mutation that already committed remains successful;
      // clients can refetch the no-store entitlement endpoint if this refresh
      // encounters a transient read failure.
      log.warn('Random Connect response entitlement refresh failed', {
        userId: String(userId),
        error: String(error)
      });
      return entitlementResponse;
    }
  };
  const isPremium = entitlement.isPremium;
  assertLease();

  if (!entitlement.entitlements.randomConnect.enabled) {
    console.warn(`[RandomConnect] join-queue forbidden (not player): user=${user.username} id=${userId} type=${user.userType}`);
    throw createHttpError(403, {
      success: false,
      message: 'Random Connect is only for users. Teams cannot use this feature.',
      ...entitlementResponse
    });
  }

  const existingConnection = await RandomConnection.findOne({
    'participants.userId': userId,
    status: { $in: ACTIVE_SESSION_STATUSES }
  });
  if (existingConnection) {
    const connectionData = buildConnectionPayload(existingConnection);
    return {
      success: true,
      message: 'Existing Random Connect session restored.',
      connection: connectionData,
      matched: true,
      resumed: true,
      roomId: existingConnection.roomId,
      ...(await refreshedEntitlementResponse())
    };
  }

  const queuePreferredGender = sanitizePreferredGender(preferredGender);
  if (!isPremium && queuePreferredGender) {
    const { used: todayGenderFilterMatchCount, legacyUsageConservativelyCharged } = await getGenderFilterUsage({ userId });
    if (todayGenderFilterMatchCount >= FREE_DAILY_MATCH_LIMIT) {
      console.warn(`[RandomConnect] join-queue daily limit (gender filter): user=${user.username} count=${todayGenderFilterMatchCount}/${FREE_DAILY_MATCH_LIMIT}`);
      throw createHttpError(403, {
        success: false,
        message: `Daily limit reached (${FREE_DAILY_MATCH_LIMIT} matches per day when using Male/Female filter). Use "Any" for unlimited or upgrade to Premium.`,
        dailyLimitReached: true,
        used: todayGenderFilterMatchCount,
        limit: FREE_DAILY_MATCH_LIMIT,
        remaining: 0,
        unlimited: false,
        legacyUsageConservativelyCharged,
        ...entitlementResponse
      });
    }
  }

  const normalizedTags = normalizeTags(tags);
  logMatchDebug('Random Connect queue registration received', {
    userId: String(userId),
    source,
    gender: userGender || 'unspecified',
    preferredGender: queuePreferredGender || 'any',
    isPremium,
    conversationType: videoEnabled ? 'video' : 'audio',
    tagCount: normalizedTags.length
  });
  if (process.env.NODE_ENV === 'development') {
    console.log(`User ${userId} attempting to join queue - Game: ${selectedGame || 'none'}, Tags: ${normalizedTags.join(', ')}`);
  }

  assertLease();
  await cleanupExistingConnections(userId, io);

  const existingInQueue = await ConnectionQueue.findOne({
    userId,
    status: 'waiting'
  });

  if (existingInQueue) {
    if (process.env.NODE_ENV === 'development') { console.log(`User ${userId} already in queue, updating preferences`); }
    existingInQueue.selectedGame = selectedGame || null;
    existingInQueue.tags = normalizedTags;
    existingInQueue.videoEnabled = videoEnabled;
    existingInQueue.gender = userGender;
    existingInQueue.preferredGender = queuePreferredGender;
    existingInQueue.updatedAt = new Date();
    await existingInQueue.save();
  } else {
    try {
      await ConnectionQueue.create({
        userId,
        username: user.username,
        displayName: user.profile?.displayName,
        avatar: user.profile?.avatar,
        selectedGame: selectedGame || null,
        tags: normalizedTags,
        videoEnabled,
        gender: userGender,
        preferredGender: queuePreferredGender
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      await ConnectionQueue.updateOne(
        { userId, status: 'waiting' },
        {
          $set: {
            username: user.username,
            displayName: user.profile?.displayName,
            avatar: user.profile?.avatar,
            selectedGame: selectedGame || null,
            tags: normalizedTags,
            videoEnabled,
            gender: userGender,
            preferredGender: queuePreferredGender,
            updatedAt: new Date()
          }
        },
        { upsert: true }
      );
    }
    if (process.env.NODE_ENV === 'development') { console.log(`User ${userId} added to queue`); }
  }

  const currentEntry = await ConnectionQueue.findOne({ userId, status: 'waiting' }).lean();
  logMatchDebug('Random Connect queue registration stored', {
    userId: String(userId),
    queueEntryId: String(currentEntry?._id || ''),
    gender: normalizeMatchmakingGender(currentEntry?.gender) || 'unspecified',
    preferredGender: normalizePreferredGender(currentEntry?.preferredGender) || 'any',
    status: currentEntry?.status || 'missing'
  });
  const matchOptions = {
    preferredGender: queuePreferredGender || null,
    currentGender: userGender,
    currentEntry,
    currentPrivacyUser: canonicalProfile
  };

  const match = await findMatch(userId, selectedGame, normalizedTags, matchOptions);

  if (!match) {
    return {
      success: true,
      message: 'Added to queue. Waiting for match...',
      matched: false,
      ...(await refreshedEntitlementResponse())
    };
  }

  if (process.env.NODE_ENV === 'development') { console.log(`✅ Instant match found for ${userId} with ${match.userId}`); }
  assertLease();
  let pairOutcome;
  try {
    pairOutcome = await withRandomConnectAdmissions({
      userIds: [userId, match.userId],
      operation: 'join',
      existingLeases: admissionLease ? [admissionLease] : [],
      work: async ({ leases, assertLeases }) => {
        assertLease();
        assertLeases();
        const claimed = await claimWaitingPair(userId, match.userId);
        if (!claimed) {
          return { response: {
            success: true,
            message: 'Added to queue. Waiting for match...',
            matched: false,
            ...(await refreshedEntitlementResponse())
          } };
        }

        const genderFilterUserIds = buildGenderFilterUserIds(
          { userId, preferredGender: queuePreferredGender },
          { userId: match.userId, preferredGender: match.preferredGender }
        );
        try {
          assertLease();
          assertLeases();
          const connection = await createConnectionForPair({
            user1: {
              userId,
              username: user.username,
              displayName: user.profile?.displayName,
              avatar: user.profile?.avatar,
              videoEnabled,
              preferredGender: queuePreferredGender
            },
            user2: match,
            selectedGame: selectedGame || match.selectedGame || null,
            tags: normalizedTags,
            genderFilterUserIds,
            matchedTags: match.commonTags || [],
            matchQuality: match.matchQuality || 'unknown',
            admissionLeases: leases
          });
          return { connection };
        } catch (error) {
          if (!error?.commitOutcomeUnknown) {
            await recoverClaimedPair(userId, match.userId, error?.userId);
          }
          if (error?.commitOutcomeUnknown) throw error;
          if (error?.status && String(error.userId || '') === String(userId)) {
            throw createHttpError(error.status, {
              success: false,
              code: error.code,
              message: error.message,
              dailyLimitReached: error.code === 'RANDOM_CONNECT_GENDER_FILTER_LIMIT',
              used: error.code === 'RANDOM_CONNECT_GENDER_FILTER_LIMIT' ? FREE_DAILY_MATCH_LIMIT : undefined,
              limit: entitlement.genderFilterLimit,
              remaining: error.code === 'RANDOM_CONNECT_GENDER_FILTER_LIMIT' ? 0 : undefined,
              unlimited: entitlement.entitlements.randomConnect.genderFilter.unlimited,
              ...(await refreshedEntitlementResponse())
            });
          }
          if (error?.status) {
            return { response: {
              success: true,
              message: 'Added to queue. Waiting for another eligible match...',
              matched: false,
              ...(await refreshedEntitlementResponse())
            } };
          }
          throw error;
        }
      }
    });
  } catch (error) {
    if (error?.code === 'RANDOM_CONNECT_REQUEST_IN_PROGRESS') {
      return {
        success: true,
        message: 'Added to queue. Waiting for an available match...',
        matched: false,
        ...(await refreshedEntitlementResponse())
      };
    }
    throw error;
  }
  if (pairOutcome.response) return pairOutcome.response;
  const connection = pairOutcome.connection;

  const userIdStr = userId.toString();
  const matchUserIdStr = match.userId.toString();
  const connectionData = buildConnectionPayload(connection);

  if (process.env.NODE_ENV === 'development') { console.log('📤 Delivering connection-matched events to both users...'); }
  await emitConnectionMatched(io, userIdStr, matchUserIdStr, connectionData, connection.roomId);

  return {
    success: true,
    message: 'Connection established!',
    connection: { ...connectionData },
    matched: true,
    roomId: connection.roomId,
    ...(await refreshedEntitlementResponse())
  };
};

// Random Connect: for users only. Matches 2 users who share tags or requested filters.
const joinQueue = async (req, res) => {
  setEntitlementNoStore(res);
  try {
    const result = await withRandomConnectAdmission({
      userId: req.user._id,
      operation: 'join',
      work: ({ lease, assertLease }) => queueAndTryMatch({
        user: req.user,
        body: req.body,
        io: getIo(req),
        source: requestSource(req),
        admissionLease: lease,
        assertLease
      })
    });

    res.status(200).json(result);
  } catch (error) {
    if (error?.status) {
      if (error.retryAfterMs) res.set('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
      return res.status(error.status).json(await buildRequestErrorPayload(req, error, 'Random Connect request failed'));
    }
    log.error('Join queue error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to join queue',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const getRecentPartnerIds = async (userId) => {
  const since = new Date(Date.now() - RECENT_PARTNER_AVOID_MS);
  const recentSessions = await RandomConnection.find({
    'participants.userId': userId,
    createdAt: { $gte: since },
    status: { $in: ['active', 'ended', 'disconnected'] }
  })
    .select('participants.userId')
    .lean();

  const currentUserId = userId.toString();
  return new Set(recentSessions
    .flatMap(session => session.participants || [])
    .map(participant => getUserIdString(participant.userId))
    .filter(participantId => participantId && participantId !== currentUserId));
};

const scoreCandidate = ({ currentEntry, candidate, tags, selectedGame, currentGender, allowFallback, recentPartnerIds, onReject }) => {
  const candidateId = getUserIdString(candidate.userId);
  const reject = (reason, details = {}) => {
    if (typeof onReject === 'function') onReject(reason, details);
    return null;
  };
  if (!candidateId) return reject('candidate_user_missing');
  if (candidateId === getUserIdString(currentEntry.userId)) return reject('same_user');
  if (!allowFallback && recentPartnerIds.has(candidateId)) return reject('recent_partner');

  const genderCompatibility = evaluateGenderCompatibility(
    {
      ...currentEntry,
      gender: normalizeMatchmakingGender(currentEntry.gender || currentGender)
    },
    candidate
  );
  if (!genderCompatibility.compatible) {
    return reject(genderCompatibility.reason, genderCompatibility);
  }

  const candidateTags = Array.isArray(candidate.tags) ? candidate.tags : [];
  const commonTags = tags.filter(tag => candidateTags.includes(tag));
  const hasCurrentTags = tags.length > 0;
  const hasCandidateTags = candidateTags.length > 0;
  const sameGame = selectedGame && candidate.selectedGame && selectedGame === candidate.selectedGame;

  let score = 0;
  let matchQuality = 'random';

  if (hasCurrentTags) {
    if (commonTags.length > 0) {
      score += 100 + commonTags.length * 25;
      matchQuality = commonTags.length === tags.length && commonTags.length === candidateTags.length ? 'exact_tag' : 'partial_tag';
    } else if (!allowFallback) {
      return reject('tag_mismatch');
    } else {
      score += hasCandidateTags ? 12 : 4;
      matchQuality = 'expanded';
    }
  } else if (hasCandidateTags && !allowFallback) {
    score += 20;
    matchQuality = 'expanded';
  }

  if (sameGame) {
    score += 35;
    if (matchQuality === 'random') matchQuality = 'same_game';
  } else if (selectedGame && !allowFallback) {
    return reject('game_mismatch');
  }

  if (recentPartnerIds.has(candidateId)) score -= 200;
  const waitedSeconds = Math.max(0, (Date.now() - new Date(candidate.joinedAt || candidate.createdAt || Date.now()).getTime()) / 1000);
  score += Math.min(30, waitedSeconds / 4);

  return { candidate, score, commonTags, matchQuality };
};

// Find another player using tag priority, reciprocal gender filters, recent-partner avoidance, then fallback expansion.
const findMatch = async (userId, selectedGame, tags = [], options = {}) => {
  try {
    const userIdStr = userId.toString();
    const {
      preferredGender,
      currentGender = '',
      currentEntry: providedCurrentEntry,
      currentPrivacyUser: providedCurrentPrivacyUser
    } = options;
    const currentEntry = providedCurrentEntry || await ConnectionQueue.findOne({ userId, status: 'waiting' }).lean();
    if (!currentEntry) return null;
    const normalizedCurrentEntry = {
      ...currentEntry,
      gender: normalizeMatchmakingGender(currentEntry.gender || currentGender),
      preferredGender: normalizePreferredGender(preferredGender || currentEntry.preferredGender)
    };

    const joinedAt = new Date(normalizedCurrentEntry.joinedAt || normalizedCurrentEntry.createdAt || Date.now()).getTime();
    const allowFallback = Date.now() - joinedAt >= TAG_FALLBACK_MS;
    const recentPartnerIds = await getRecentPartnerIds(userId);

    const query = {
      userId: { $ne: userId },
      status: 'waiting',
      $and: [buildCompatiblePreferenceQuery(normalizedCurrentEntry.gender)]
    };

    const candidateGenderQuery = buildGenderCandidateQuery(normalizedCurrentEntry.preferredGender);
    if (candidateGenderQuery) {
      query.gender = candidateGenderQuery;
      if (process.env.NODE_ENV === 'development') { console.log(`🔍 Random Connect: filter by gender ${normalizedCurrentEntry.preferredGender}`);}
    }

    if (tags.length > 0 && !allowFallback) {
      query.tags = { $in: tags };
    } else if (selectedGame && !allowFallback) {
      query.selectedGame = selectedGame;
    }

    const potentialMatches = await ConnectionQueue.find(query)
      .sort({ joinedAt: 1, createdAt: 1 })
      .limit(MATCH_BATCH_LIMIT)
      .lean();

    const currentPrivacyUser = providedCurrentPrivacyUser || await User.findById(userId)
      .select('_id blockedUsers isActive')
      .lean();
    if (!currentPrivacyUser || currentPrivacyUser.isActive === false) return null;
    const candidateIds = potentialMatches.map((candidate) => candidate.userId).filter(Boolean);
    const candidateUsers = candidateIds.length
      ? await User.find({ _id: { $in: candidateIds }, isActive: { $ne: false } })
        .select('_id blockedUsers isActive')
        .lean()
      : [];
    const candidateUsersById = new Map(candidateUsers.map((candidate) => [
      getUserIdString(candidate._id),
      candidate
    ]));
    const privacyEligibleMatches = potentialMatches.filter((candidate) => {
      const candidateUser = candidateUsersById.get(getUserIdString(candidate.userId));
      const allowed = canPrivacyMatchUsers(currentPrivacyUser, candidateUser);
      if (!allowed) {
        logMatchDebug('Random Connect candidate rejected', {
          userId: userIdStr,
          candidateId: getUserIdString(candidate.userId),
          reason: candidateUser ? 'blocked_relationship' : 'inactive_or_missing_user'
        });
      }
      return allowed;
    });

    logMatchDebug('Random Connect eligible candidates loaded', {
      userId: userIdStr,
      gender: normalizedCurrentEntry.gender || 'unspecified',
      preferredGender: normalizedCurrentEntry.preferredGender || 'any',
      candidateCount: privacyEligibleMatches.length,
      fallbackExpanded: allowFallback
    });

    const scored = privacyEligibleMatches
      .map(candidate => scoreCandidate({
        currentEntry: normalizedCurrentEntry,
        candidate,
        tags,
        selectedGame,
        currentGender,
        allowFallback,
        recentPartnerIds,
        onReject: (reason, details) => logMatchDebug('Random Connect candidate rejected', {
          userId: userIdStr,
          candidateId: getUserIdString(candidate.userId),
          reason,
          ...details
        })
      }))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || new Date(a.candidate.joinedAt || a.candidate.createdAt).getTime() - new Date(b.candidate.joinedAt || b.candidate.createdAt).getTime());

    if (scored.length > 0) {
      const best = scored[0];
      const match = best.candidate;
      logMatchDebug('Random Connect candidate accepted', {
        userId: userIdStr,
        candidateId: getUserIdString(match.userId),
        matchQuality: best.matchQuality,
        score: best.score,
        commonTagCount: best.commonTags.length
      });
      if (process.env.NODE_ENV === 'development') {
        console.log(`✅ Matched user ${userIdStr} with ${match.userId} (${best.matchQuality}, score ${best.score})`);
      }
      return {
        _id: match._id,
        userId: match.userId,
        username: match.username,
        displayName: match.displayName,
        avatar: match.avatar,
        videoEnabled: match.videoEnabled,
        tags: match.tags || [],
        selectedGame: match.selectedGame,
        gender: normalizeMatchmakingGender(match.gender),
        preferredGender: match.preferredGender || '',
        commonTags: best.commonTags,
        matchQuality: best.matchQuality
      };
    }

    if (process.env.NODE_ENV === 'development') { console.log(`❌ No match found for user ${userIdStr} with tags: ${tags.join(', ')}`);}
    return null;
  } catch (error) {
    log.error('Find match error:', { error: String(error) });
    return null;
  }
};

const claimWaitingPair = async (userId1, userId2) => {
  const firstClaim = await ConnectionQueue.updateOne(
    { userId: userId1, status: 'waiting' },
    { $set: { status: 'matched', updatedAt: new Date() } }
  );
  if (firstClaim.modifiedCount !== 1) return false;

  const secondClaim = await ConnectionQueue.updateOne(
    { userId: userId2, status: 'waiting' },
    { $set: { status: 'matched', updatedAt: new Date() } }
  );
  if (secondClaim.modifiedCount !== 1) {
    await ConnectionQueue.updateOne({ userId: userId1, status: 'matched' }, { $set: { status: 'waiting' } });
    return false;
  }

  return true;
};

const recoverClaimedPair = async (userId1, userId2, blockedUserId) => {
  const blocked = String(blockedUserId || '');
  await Promise.all([userId1, userId2].map((userId) => (
    blocked && String(userId) === blocked
      ? ConnectionQueue.deleteMany({ userId, status: 'matched' })
      : ConnectionQueue.updateOne(
        { userId, status: 'matched' },
        { $set: { status: 'waiting', updatedAt: new Date() } }
      )
  )));
};

const buildParticipant = (queueLikeUser, dbUser, videoEnabled, entitlement) => {
  const premium = entitlement || getPremiumSnapshot(dbUser);
  return {
    userId: dbUser._id,
    username: queueLikeUser.username || dbUser.username,
    displayName: queueLikeUser.displayName || dbUser.profile?.displayName,
    avatar: queueLikeUser.avatar || dbUser.profile?.avatar,
    videoEnabled: videoEnabled !== undefined ? videoEnabled : queueLikeUser.videoEnabled,
    isPremium: premium.isPremium,
    membershipTier: premium.plan || premium.membershipTier || 'free'
  };
};

const cleanupCommittedPairQueue = async (connection, userIds) => {
  try {
    await ConnectionQueue.deleteMany({ userId: { $in: userIds } });
  } catch (error) {
    // The RandomConnection is already durable. Never requeue/retry the pair
    // after this point; stale matched rows are removed by the periodic cleanup.
    log.error('Random Connect post-commit queue cleanup failed', {
      roomId: String(connection?.roomId || ''),
      userIds: userIds.map(String),
      error: String(error)
    });
  }
  return connection;
};

const createConnectionForPair = async ({
  user1,
  user2,
  selectedGame,
  tags,
  genderFilterUserIds = [],
  matchedTags = [],
  matchQuality = 'unknown',
  admissionLeases = []
}) => {
  const user1Id = user1.userId || user1._id;
  const user2Id = user2.userId || user2._id;
  const [dbUser1, dbUser2, entitlement1, entitlement2] = await Promise.all([
    User.findById(user1Id).select('username profile.displayName profile.avatar isPremium membership blockedUsers isActive'),
    User.findById(user2Id).select('username profile.displayName profile.avatar isPremium membership blockedUsers isActive'),
    resolveRandomConnectEntitlement({ userId: user1Id, requestSource: 'matchmaking' }),
    resolveRandomConnectEntitlement({ userId: user2Id, requestSource: 'matchmaking' })
  ]);

  if (!dbUser1 || !dbUser2) {
    throw new Error('Matched user profile not found');
  }
  if (!canPrivacyMatchUsers(dbUser1, dbUser2)) {
    const error = new Error('Matched users are no longer mutually eligible');
    error.status = 409;
    error.code = 'RANDOM_CONNECT_PRIVACY_CONFLICT';
    throw error;
  }

  const policy = buildSessionPolicy(entitlement1, entitlement2);
  const roomId = uuidv4();
  const entitlementsByUserId = new Map([
    [String(user1Id), entitlement1],
    [String(user2Id), entitlement2]
  ]);
  for (const [participantId, participantEntitlement] of entitlementsByUserId) {
    if (!participantEntitlement?.entitlements?.randomConnect?.enabled) {
      const error = new Error('Random Connect is no longer available for this account');
      error.status = 403;
      error.code = 'RANDOM_CONNECT_NOT_ALLOWED';
      error.userId = participantId;
      throw error;
    }
  }

  // Reconcile historical, already-durable connections before entering the
  // new atomic commit. Only this match's reservation belongs in the transaction.
  for (const filteredUserId of genderFilterUserIds) {
    const filteredEntitlement = entitlementsByUserId.get(String(filteredUserId));
    const genderCapability = filteredEntitlement?.entitlements?.randomConnect?.genderFilter;
    if (!genderCapability?.enabled) {
      const error = new Error('Gender filtering is no longer available for this account');
      error.status = 403;
      error.code = 'RANDOM_CONNECT_GENDER_FILTER_NOT_ALLOWED';
      error.userId = String(filteredUserId);
      throw error;
    }
    if (!genderCapability.unlimited) {
      await syncAttributedUsage({ userId: filteredUserId });
      await ensureGenderFilterQuota({ userId: filteredUserId });
    }
  }

  const connectionDocument = {
    roomId,
    participants: [
      buildParticipant(user1, dbUser1, user1.videoEnabled, entitlement1),
      buildParticipant(user2, dbUser2, user2.videoEnabled, entitlement2)
    ],
    selectedGame: selectedGame || null,
    tags: tags || [],
    matchedTags,
    matchQuality,
    status: 'active',
    createdBy: dbUser1._id,
    usedGenderFilter: genderFilterUserIds.length > 0,
    genderFilterUserIds,
    durationLimitSeconds: policy.durationLimitSeconds,
    endReason: null
  };

  const connection = await commitRandomConnectMatch({
    leases: admissionLeases,
    userIds: [user1Id, user2Id],
    reserveQuota: async (session) => {
      // Each callback retry receives the same roomId. $addToSet plus the
      // transaction rollback makes reservations both atomic and idempotent.
      for (const filteredUserId of genderFilterUserIds) {
        const filteredEntitlement = entitlementsByUserId.get(String(filteredUserId));
        const genderCapability = filteredEntitlement?.entitlements?.randomConnect?.genderFilter;
        if (!genderCapability.unlimited) {
          await reserveGenderFilterSlot({
            userId: filteredUserId,
            reservationKey: roomId,
            session
          });
        }
      }
    },
    persistConnection: (session) => RandomConnection.findOneAndUpdate(
      { roomId },
      { $setOnInsert: connectionDocument },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
        session
      }
    ),
    findCommittedConnection: () => RandomConnection.findOne({ roomId })
  });

  logMatchDebug('Random Connect room created', {
    roomId,
    userIds: [String(user1Id), String(user2Id)],
    usedGenderFilter: genderFilterUserIds.length > 0,
    matchQuality
  });

  return cleanupCommittedPairQueue(connection, [dbUser1._id, dbUser2._id]);
};

// Match users from queue (used by periodic matcher)
const matchUsersFromQueue = async (io) => {
  try {
    await syncExpiredSessions(io);
    await ConnectionQueue.deleteMany({
      $or: [
        { expiresAt: { $lte: new Date() } },
        { status: { $in: ['matched', 'cancelled'] }, updatedAt: { $lte: new Date(Date.now() - 60 * 1000) } }
      ]
    });

    // Get all waiting users
    const waitingUsers = await ConnectionQueue.find({ status: 'waiting' })
      .sort({ joinedAt: 1, createdAt: 1 })
      .limit(MATCH_BATCH_LIMIT)
      .lean();

    if (waitingUsers.length < 2) {
      return; // Need at least 2 users to match
    }

    if (process.env.NODE_ENV === 'development') { console.log(`🔍 Periodic matching: Found ${waitingUsers.length} users in queue`);
}
    const processedUserIds = new Set();

    // Try to match each user with another
    for (let i = 0; i < waitingUsers.length; i++) {
      const user1 = waitingUsers[i];
      const user1Id = user1.userId.toString();
      if (processedUserIds.has(user1Id)) {
        continue; // Already matched
      }

      const matchOptions = (user1.preferredGender === 'male' || user1.preferredGender === 'female')
        ? { preferredGender: user1.preferredGender, currentGender: user1.gender || '', currentEntry: user1 }
        : { currentGender: user1.gender || '', currentEntry: user1 };
      const match = await findMatch(
        user1.userId,
        user1.selectedGame || null,
        user1.tags || [],
        matchOptions
      );

      if (match && !processedUserIds.has(match.userId.toString())) {
        try {
          await withRandomConnectAdmissions({
            userIds: [user1.userId, match.userId],
            operation: 'join',
            work: async ({ leases, assertLeases }) => {
              assertLeases();
              const claimed = await claimWaitingPair(user1.userId, match.userId);
              if (!claimed) return;

              const genderFilterUserIds = buildGenderFilterUserIds(user1, match);
              let connection;
              try {
                assertLeases();
                connection = await createConnectionForPair({
                  user1,
                  user2: match,
                  selectedGame: user1.selectedGame || match.selectedGame || null,
                  tags: user1.tags || [],
                  genderFilterUserIds,
                  matchedTags: match.commonTags || [],
                  matchQuality: match.matchQuality || 'unknown',
                  admissionLeases: leases
                });
              } catch (error) {
                if (!error?.commitOutcomeUnknown) {
                  await recoverClaimedPair(user1.userId, match.userId, error?.userId);
                }
                if (error?.status) return;
                throw error;
              }

              if (process.env.NODE_ENV === 'development') {
                console.log(`✅ Periodic match: Created connection ${connection.roomId} for users ${user1.userId} <-> ${match.userId}`);
              }
              const userId1Str = user1.userId.toString();
              const userId2Str = match.userId.toString();
              const connectionData = buildConnectionPayload(connection);

              await emitConnectionMatched(io, userId1Str, userId2Str, connectionData, connection.roomId);

              processedUserIds.add(userId1Str);
              processedUserIds.add(userId2Str);
            }
          });
        } catch (error) {
          if (error?.code === 'RANDOM_CONNECT_REQUEST_IN_PROGRESS') continue;
          throw error;
        }
      }
    }

    if (processedUserIds.size > 0) {
      if (process.env.NODE_ENV === 'development') { console.log(`✅ Periodic matching: Successfully matched ${processedUserIds.size / 2} pairs`);}
    }
  } catch (error) {
    log.error('❌ Periodic matching error:', { error: String(error) });
  }
};

const notifyRandomConnectMatch = async (userIds, connectionData, roomId) => {
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  const recipients = Array.from(new Set((userIds || []).map(String).filter(Boolean)));
  await Promise.all(recipients.map(async (recipientId) => {
    const partner = (connectionData?.participants || []).find((participant) => String(participant.userId) !== String(recipientId));
    await createAndEmitNotification({
      recipient: recipientId,
      type: 'call',
      title: 'Random Connect match ready',
      message: partner?.displayName || partner?.username
        ? `You matched with ${partner.displayName || partner.username}. Tap to join.`
        : 'Your Random Connect match is ready. Tap to join.',
      data: {
        deepLink: '/random-connect',
        customData: {
          eventType: 'random_connect_match',
          notificationDedupeKey: `random-connect-match:${roomId}`,
          pushRequestId: `random-connect-match:${roomId}`,
          deepLinkType: 'random_connect',
          roomId,
          randomConnectionRoomId: roomId,
          expiresAt,
          pushOptions: {
            ttl: 120,
            priority: 'high',
            collapseKey: `random-connect-${roomId}`
          }
        }
      }
    });
  }));
};

// One adapter-backed room emit is sufficient for connected installations.
// Offline/background installations receive the durable notification fallback,
// and clients can hydrate the saved session through current-connection.
const emitConnectionMatched = async (io, userId1Str, userId2Str, connectionData, roomId) => {
  try {
    if (io) {
      io.to(`user-${userId1Str}`).emit('connection-matched', connectionData);
      io.to(`user-${userId2Str}`).emit('connection-matched', connectionData);
    }
    await notifyRandomConnectMatch([userId1Str, userId2Str], connectionData, roomId);
  } catch (error) {
    log.error('❌ Error delivering connection-matched event:', { error: String(error) });
  }
};

// Clean up existing connections for a user
const cleanupExistingConnections = async (userId, io) => {
  try {
    const activeConnection = await RandomConnection.findOne({
      'participants.userId': userId,
      status: { $in: ['waiting', 'active'] }
    });

    if (activeConnection) {
      if (process.env.NODE_ENV === 'development') { console.log(`Cleaning up existing connection for user ${userId}`);
      }
      clearSessionTimers(activeConnection.roomId);
      activeConnection.status = 'disconnected';
      activeConnection.endTime = new Date();
      activeConnection.endReason = 'cleanup';
      activeConnection.duration = Math.floor((activeConnection.endTime - (activeConnection.connectedAt || activeConnection.startTime)) / 1000);
      
      const participant = activeConnection.participants.find(p => p.userId.toString() === userId.toString());
      if (participant) {
        participant.leftAt = new Date();
      }

      await activeConnection.save();

      // Notify other participants
      if (io) {
        const userIdStr = userId.toString();
        const otherParticipants = activeConnection.participants.filter(p => p.userId.toString() !== userIdStr);
        otherParticipants.forEach(participant => {
          const participantUserIdStr = participant.userId.toString();
          io.to(`user-${participantUserIdStr}`).emit('partner-disconnected', {
            roomId: activeConnection.roomId,
            disconnectedUserId: userIdStr,
            reason: 'User left'
          });
        });
      }
    }

    // Remove user from any existing queue entries
    await ConnectionQueue.deleteMany({ userId });
    
  } catch (error) {
    log.error('Cleanup existing connections error:', { error: String(error) });
    throw error;
  }
};

// Leave the queue
const leaveQueueUnlocked = async (req, res) => {
  try {
    const userId = req.user._id;

    if (process.env.NODE_ENV === 'development') { console.log(`User ${userId} leaving queue`);
}
    const result = await ConnectionQueue.deleteOne({
      userId,
      status: 'waiting'
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'You are not in the queue'
      });
    }

    if (process.env.NODE_ENV === 'development') { console.log(`User ${userId} successfully left queue`);
}
    res.status(200).json({
      success: true,
      message: 'Left the queue successfully'
    });

  } catch (error) {
    log.error('Leave queue error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to leave queue',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const leaveQueue = async (req, res) => runAdmissionProtectedController({
  req,
  res,
  operation: 'leave',
  work: () => leaveQueueUnlocked(req, res),
  fallbackMessage: 'Failed to leave queue'
});

// Get current connection - SIMPLE, return 200 with success:false instead of 404
const getCurrentConnection = async (req, res) => {
  try {
    const userId = req.user._id;

    const connection = await RandomConnection.findOne({
      'participants.userId': userId,
      status: { $in: ['waiting', 'active'] }
    }).populate('participants.userId', 'username profile.displayName profile.avatar');

    if (!connection) {
      return res.status(200).json({
        success: false,
        message: 'No active connection found'
      });
    }

    const connectionObj = connection.toObject ? connection.toObject() : connection;
    const connectionPayload = buildConnectionPayload(connectionObj);

    res.status(200).json({
      success: true,
      connection: connectionPayload
    });

  } catch (error) {
    log.error('Get current connection error:', { error: String(error) });
    res.status(200).json({
      success: false,
      message: 'Failed to get current connection',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Disconnect from current connection
const disconnectConnectionUnlocked = async (req, res) => {
  try {
    const userId = req.user._id;
    const { roomId } = req.body;

    if (process.env.NODE_ENV === 'development') { console.log(`User ${userId} disconnecting from room ${roomId}`);
}
    const connection = await RandomConnection.findOne({
      roomId,
      'participants.userId': userId,
      status: { $in: ['waiting', 'active'] }
    });

    if (!connection) {
      return res.status(404).json({
        success: false,
        message: 'Connection not found'
      });
    }

    clearSessionTimers(connection.roomId);
    // Update connection status
    connection.status = 'disconnected';
    connection.endTime = new Date();
    connection.endReason = 'user_left';
    connection.duration = Math.floor((connection.endTime - (connection.connectedAt || connection.startTime)) / 1000);
    
    const participant = connection.participants.find(p => p.userId.toString() === userId.toString());
    if (participant) {
      participant.leftAt = new Date();
    }

    await connection.save();

    // Notify other participants
    const io = getIo(req);
    if (io) {
      const userIdStr = userId.toString();
      const otherParticipants = connection.participants.filter(p => p.userId.toString() !== userIdStr);
      otherParticipants.forEach(participant => {
        const participantUserIdStr = participant.userId.toString();
        io.to(`user-${participantUserIdStr}`).emit('partner-disconnected', {
          roomId,
          disconnectedUserId: userIdStr,
          reason: 'User disconnected'
        });
      });
      emitToParticipants(io, connection, 'random-session-ended', {
        reason: 'user_left',
        disconnectedUserId: userId.toString(),
        sessionPolicy: buildSessionPolicyPayload(connection)
      });
    }

    res.status(200).json({
      success: true,
      message: 'Disconnected successfully'
    });

  } catch (error) {
    log.error('Disconnect error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to disconnect',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const disconnectConnection = async (req, res) => runAdmissionProtectedController({
  req,
  res,
  operation: 'disconnect',
  work: () => disconnectConnectionUnlocked(req, res),
  fallbackMessage: 'Failed to disconnect'
});

const endConnectionForNext = async ({ userId, roomId, io }) => {
  if (!roomId) return null;

  const connection = await RandomConnection.findOne({
    roomId,
    'participants.userId': userId,
    status: { $in: ['waiting', 'active'] }
  });

  if (!connection) return null;

  clearSessionTimers(connection.roomId);
  connection.status = 'disconnected';
  connection.endTime = new Date();
  connection.endReason = 'next';
  connection.duration = Math.floor((connection.endTime - (connection.connectedAt || connection.startTime)) / 1000);

  const userIdStr = userId.toString();
  const participant = connection.participants.find(p => p.userId.toString() === userIdStr);
  if (participant) {
    participant.leftAt = new Date();
  }

  await connection.save();

  if (io) {
    const otherParticipants = connection.participants.filter(p => p.userId.toString() !== userIdStr);
    otherParticipants.forEach(participant => {
      const participantUserIdStr = participant.userId.toString();
      io.to(`user-${participantUserIdStr}`).emit('partner-disconnected', {
        roomId: connection.roomId,
        disconnectedUserId: userIdStr,
        reason: 'next',
        message: 'Your chat partner has disconnected.'
      });
    });

    emitToParticipants(io, connection, 'random-session-ended', {
      reason: 'next',
      disconnectedUserId: userIdStr,
      message: 'Your chat partner has disconnected.',
      sessionPolicy: buildSessionPolicyPayload(connection)
    });
  }

  return connection;
};

const nextConnection = async (req, res) => {
  setEntitlementNoStore(res);
  try {
    const userId = req.user._id;
    const { roomId } = req.body;
    const io = getIo(req);

    const response = await withRandomConnectAdmission({
      userId,
      operation: 'next',
      work: async ({ lease, assertLease }) => {
        const current = await RandomConnection.findOne({
          'participants.userId': userId,
          status: { $in: ACTIVE_SESSION_STATUSES }
        });

        // A replay of Next for an older room must never tear down the newly
        // matched room. queueAndTryMatch returns that current room idempotently.
        if (current && (!roomId || String(current.roomId) !== String(roomId))) {
          const existing = await queueAndTryMatch({
            user: req.user,
            body: req.body,
            io,
            source: requestSource(req),
            admissionLease: lease,
            assertLease
          });
          return {
            ...existing,
            requeued: false,
            staleNextReplay: true,
            previousRoomId: roomId || null,
            previousSessionEnded: false
          };
        }

        assertLease();
        const endedConnection = await endConnectionForNext({ userId, roomId, io });
        await ConnectionQueue.deleteMany({ userId });
        assertLease();
        const result = await queueAndTryMatch({
          user: req.user,
          body: req.body,
          io,
          source: requestSource(req),
          admissionLease: lease,
          assertLease
        });
        return {
          ...result,
          requeued: true,
          previousRoomId: roomId || null,
          previousSessionEnded: Boolean(endedConnection)
        };
      }
    });

    res.status(200).json(response);
  } catch (error) {
    if (error?.status) {
      if (error.retryAfterMs) res.set('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
      return res.status(error.status).json(await buildRequestErrorPayload(req, error, 'Failed to find next match'));
    }
    log.error('Next connection error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to find next match',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Send message in random connection
const sendMessage = async (req, res) => {
  try {
    const userId = req.user._id;
    const { roomId, message } = req.body;

    if (!message || !roomId) {
      return res.status(400).json({
        success: false,
        message: 'Room ID and message are required'
      });
    }

    const connection = await RandomConnection.findOne({
      roomId,
      'participants.userId': userId,
      status: { $in: ['waiting', 'active'] }
    });

    if (!connection) {
      return res.status(404).json({
        success: false,
        message: 'Connection not found'
      });
    }

    // Add message to connection
    connection.messages.push({
      sender: userId,
      message,
      timestamp: new Date()
    });

    await connection.save();

    // Emit message to other participants - multiple methods for reliability
    const io = req.app.get('io');
    if (io) {
      const userIdStr = userId.toString();
      const roomIdStr = String(roomId);
      const getParticipantId = (p) => (p.userId && p.userId._id ? p.userId._id : p.userId).toString();
      const otherParticipants = connection.participants.filter(p => getParticipantId(p) !== userIdStr);

      const messageData = {
        roomId: roomIdStr,
        sender: userIdStr,
        message,
        timestamp: new Date()
      };

      // Method 1: Emit to user rooms (primary)
      otherParticipants.forEach(participant => {
        const participantUserIdStr = getParticipantId(participant);
        io.to(`user-${participantUserIdStr}`).emit('random-connection-message', messageData);
        if (process.env.NODE_ENV === 'development') { console.log(`📤 Message emitted to user-${participantUserIdStr}`);}
      });

      // Method 2: Emit to random room (backup)
      io.to(`random-room-${roomIdStr}`).emit('random-connection-message', messageData);
      if (process.env.NODE_ENV === 'development') { console.log(`📤 Message emitted to random-room-${roomIdStr}`);
}
      // Method 3: Direct socket emit (fallback)
      const allSockets = Array.from(io.sockets.sockets.values());
      otherParticipants.forEach(participant => {
        const participantUserIdStr = getParticipantId(participant);
        const userSockets = allSockets.filter(s => String(s.authUser?.userId ?? '') === participantUserIdStr);
        userSockets.forEach(sock => {
          sock.emit('random-connection-message', messageData);
          if (process.env.NODE_ENV === 'development') { console.log(`📤 Direct message emit to socket ${sock.id}`);}
        });
      });
    }

    res.status(200).json({
      success: true,
      message: 'Message sent successfully'
    });

  } catch (error) {
    log.error('Send message error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to send message',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Cleanup current connection (used when user refreshes or navigates away)
const cleanupCurrentConnectionUnlocked = async (req, res) => {
  try {
    const userId = req.user._id;
    if (process.env.NODE_ENV === 'development') { console.log(`Cleaning up current connection for user ${userId}`);
}
    const activeConnection = await RandomConnection.findOne({
      'participants.userId': userId,
      status: { $in: ['waiting', 'active'] }
    });

    if (activeConnection) {
      if (process.env.NODE_ENV === 'development') { console.log(`Found active connection ${activeConnection.roomId} for user ${userId}`);
      }
      clearSessionTimers(activeConnection.roomId);
      activeConnection.status = 'disconnected';
      activeConnection.endTime = new Date();
      activeConnection.endReason = 'cleanup';
      activeConnection.duration = Math.floor((activeConnection.endTime - (activeConnection.connectedAt || activeConnection.startTime)) / 1000);
      
      const participant = activeConnection.participants.find(p => p.userId.toString() === userId.toString());
      if (participant) {
        participant.leftAt = new Date();
      }

      await activeConnection.save();

      // Notify other participants
      const io = getIo(req);
      if (io) {
        const userIdStr = userId.toString();
        const otherParticipants = activeConnection.participants.filter(p => p.userId.toString() !== userIdStr);
        otherParticipants.forEach(participant => {
          const participantUserIdStr = participant.userId.toString();
          io.to(`user-${participantUserIdStr}`).emit('partner-disconnected', {
            roomId: activeConnection.roomId,
            disconnectedUserId: userIdStr,
            reason: 'User left'
          });
        });
        emitToParticipants(io, activeConnection, 'random-session-ended', {
          reason: 'cleanup',
          disconnectedUserId: userIdStr,
          sessionPolicy: buildSessionPolicyPayload(activeConnection)
        });
      }

      if (process.env.NODE_ENV === 'development') { console.log(`Connection ${activeConnection.roomId} cleaned up for user ${userId}`);}
    }

    // Remove user from any queue
    await ConnectionQueue.deleteMany({ userId });

    res.status(200).json({
      success: true,
      message: 'Connection cleaned up successfully'
    });

  } catch (error) {
    log.error('Cleanup current connection error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to cleanup connection',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const cleanupCurrentConnection = async (req, res) => runAdmissionProtectedController({
  req,
  res,
  operation: 'cleanup',
  work: () => cleanupCurrentConnectionUnlocked(req, res),
  fallbackMessage: 'Failed to cleanup connection'
});

// Return only sessions owned by the authenticated participant. This route is
// player-authorized, so exposing the global active-session roster would leak
// other players' display names, tags, Premium state, and activity timestamps.
const getActiveSessions = async (req, res) => {
  setEntitlementNoStore(res);
  try {
    const requesterId = String(req.user._id);
    const sessions = await RandomConnection.find({
      status: 'active',
      'participants.userId': req.user._id
    })
      .select('roomId startTime connectedAt expiresAt durationLimitSeconds participants.userId participants.username participants.displayName tags matchQuality matchedTags')
      .lean();

    // Defense in depth for mocks, unusual projections, and future query edits.
    const ownedSessions = sessions.filter((session) => (
      (session.participants || []).some((participant) => getUserIdString(participant.userId) === requesterId)
    ));
    const list = ownedSessions.map(s => ({
      sessionId: s.roomId,
      roomId: s.roomId,
      usernames: (s.participants || []).map(p => p.username || p.displayName || '?').filter(Boolean),
      startedAt: s.startTime,
      connectedAt: s.connectedAt,
      expiresAt: s.expiresAt,
      durationLimitSeconds: s.durationLimitSeconds,
      tags: s.tags || [],
      matchedTags: s.matchedTags || [],
      matchQuality: s.matchQuality || 'unknown'
    }));

    res.status(200).json({
      success: true,
      sessions: list,
      count: list.length
    });
  } catch (error) {
    log.error('Get active sessions error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to get active sessions',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const getEntitlementStatus = async (req) => {
  const userId = req.user._id;
  const entitlement = await resolveRandomConnectEntitlement({
    userId,
    requestSource: requestSource(req)
  });
  const genderCapability = entitlement.entitlements.randomConnect.genderFilter;
  const usage = genderCapability.enabled && !genderCapability.unlimited
    ? await getGenderFilterUsage({ userId })
    : { used: 0, legacyUsageConservativelyCharged: 0 };
  const used = usage.used;
  const limit = entitlement.genderFilterLimit;

  return {
    success: true,
    used,
    limit,
    remaining: genderCapability.unlimited ? null : Math.max(0, limit - used),
    unlimited: genderCapability.unlimited,
    legacyUsageConservativelyCharged: usage.legacyUsageConservativelyCharged,
    ...randomConnectEntitlementEnvelope(entitlement)
  };
};

// Canonical source for both initial feature gating and live daily quota state.
const getRandomConnectEntitlements = async (req, res) => {
  setEntitlementNoStore(res);
  try {
    return res.status(200).json(await getEntitlementStatus(req));
  } catch (error) {
    log.error('Get Random Connect entitlement error:', { error: String(error) });
    return res.status(error?.status || 500).json({
      success: false,
      message: 'Failed to get Random Connect entitlement',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Backward-compatible endpoint name; response now includes the same versioned,
// server-authoritative contract as /entitlements.
const getDailyGenderMatchesRemaining = getRandomConnectEntitlements;

module.exports = {
  joinQueue,
  leaveQueue,
  getCurrentConnection,
  getActiveSessions,
  getRandomConnectEntitlements,
  getDailyGenderMatchesRemaining,
  disconnectConnection,
  nextConnection,
  sendMessage,
  cleanupCurrentConnection,
  matchUsersFromQueue,
  markSessionReady,
  getSessionTimerState,
  syncExpiredSessions,
  _private: {
    normalizeTags,
    sanitizePreferredGender,
    normalizeMatchmakingGender,
    evaluateGenderCompatibility,
    buildGenderCandidateQuery,
    buildCompatiblePreferenceQuery,
    isPremiumUser,
    buildSessionPolicy,
    buildConnectionPayload,
    scoreCandidate,
    buildSessionPolicyPayload,
    buildGenderFilterUserIds,
    canPrivacyMatchUsers,
    cleanupCommittedPairQueue,
    getEntitlementStatus
  }
};
