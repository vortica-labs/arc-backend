const User = require('../models/User');
const RandomConnection = require('../models/RandomConnection');
const ConnectionQueue = require('../models/ConnectionQueue');
const { v4: uuidv4 } = require('uuid');
const log = require('../utils/logger');

// Free users: daily match limit. Premium: unlimited matches.
const FREE_DAILY_MATCH_LIMIT = 5;
const FREE_TO_FREE_SESSION_SECONDS = Number(process.env.RANDOM_CONNECT_FREE_SESSION_SECONDS || 180);
const SESSION_WARNING_SECONDS = 30;
const TAG_FALLBACK_MS = Number(process.env.RANDOM_CONNECT_TAG_FALLBACK_MS || 20000);
const RECENT_PARTNER_AVOID_MS = Number(process.env.RANDOM_CONNECT_RECENT_PARTNER_AVOID_MS || 10 * 60 * 1000);
const MATCH_BATCH_LIMIT = Number(process.env.RANDOM_CONNECT_MATCH_BATCH_LIMIT || 100);
const ACTIVE_SESSION_STATUSES = ['waiting', 'active'];
const PREMIUM_TIERS = ['player_pro', 'player_pro_plus', 'team_pro', 'team_org'];
const sessionTimerHandles = new Map();

const isPremiumUser = (user) => {
  if (!user) return false;
  const tier = user.membership?.tier || 'free';
  const isPremiumTier = PREMIUM_TIERS.includes(tier);
  const validUntil = user.membership?.validUntil;
  const isExpired = validUntil ? new Date(validUntil).getTime() < Date.now() : false;
  return (user.isPremium === true || isPremiumTier) && !isExpired;
};

const getIo = (req) => req?.app?.get?.('io') || global._arcSocketIO || null;

const normalizeTags = (tags = []) => {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags
    .map(tag => String(tag || '').trim().toLowerCase())
    .filter(tag => tag.length > 0 && tag.length <= 30))]
    .slice(0, 10);
};

const sanitizePreferredGender = (preferredGender) =>
  (preferredGender === 'male' || preferredGender === 'female') ? preferredGender : '';

const getUserIdString = (value) => {
  if (!value) return '';
  if (value._id) return value._id.toString();
  return value.toString();
};

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
      isPremium: Boolean(p.isPremium),
      membershipTier: p.membershipTier || 'free',
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

// Random Connect: for PLAYERS only. Matches 2 players who share at least one tag → video call.
// Join the random connection queue with tags support
const joinQueue = async (req, res) => {
  try {
    const { selectedGame, tags = [], videoEnabled = true, preferredGender } = req.body;
    const userId = req.user._id;
    const isPremium = isPremiumUser(req.user);
    const userGender = req.user.profile?.gender || '';
    const io = getIo(req);

    // Only players can use Random Connect (teams cannot)
    if (req.user.userType !== 'player') {
      console.warn(`[RandomConnect] join-queue forbidden (not player): user=${req.user.username} id=${userId} type=${req.user.userType}`);
      return res.status(403).json({
        success: false,
        message: 'Random Connect is only for players. Teams cannot use this feature.'
      });
    }

    // Free users: daily limit (5) only when using gender filter (Male/Female). Default "Any" = unlimited.
    const usingGenderFilter = sanitizePreferredGender(preferredGender) !== '';
    if (!isPremium && usingGenderFilter) {
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const todayGenderFilterMatchCount = await RandomConnection.countDocuments({
        'participants.userId': userId,
        status: { $in: ['active', 'disconnected', 'ended'] },
        startTime: { $gte: startOfToday },
        usedGenderFilter: true
      });
      if (todayGenderFilterMatchCount >= FREE_DAILY_MATCH_LIMIT) {
        console.warn(`[RandomConnect] join-queue daily limit (gender filter): user=${req.user.username} count=${todayGenderFilterMatchCount}/${FREE_DAILY_MATCH_LIMIT}`);
        return res.status(403).json({
          success: false,
          message: `Daily limit reached (${FREE_DAILY_MATCH_LIMIT} matches per day when using Male/Female filter). Use "Any" for unlimited or upgrade to Premium.`,
          dailyLimitReached: true,
          limit: FREE_DAILY_MATCH_LIMIT
        });
      }
    }

    // Allow join with or without tags – without tags = random match with any waiting player
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }

    // Normalize tags - remove duplicates, trim, lowercase
    const normalizedTags = normalizeTags(tags);

    if (process.env.NODE_ENV === 'development') { console.log(`User ${userId} attempting to join queue - Game: ${selectedGame || 'none'}, Tags: ${normalizedTags.join(', ')}`);
}
    // Clean up any existing connections first
    await cleanupExistingConnections(userId, io);

    // Check if user is already in queue
    const existingInQueue = await ConnectionQueue.findOne({
      userId,
      status: 'waiting'
    });

    const queuePreferredGender = sanitizePreferredGender(preferredGender);
    if (existingInQueue) {
      if (process.env.NODE_ENV === 'development') { console.log(`User ${userId} already in queue, updating preferences`);}
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
          username: req.user.username,
          displayName: req.user.profile?.displayName,
          avatar: req.user.profile?.avatar,
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
              username: req.user.username,
              displayName: req.user.profile?.displayName,
              avatar: req.user.profile?.avatar,
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
      if (process.env.NODE_ENV === 'development') { console.log(`User ${userId} added to queue`);}
    }

    // Gender filter: Male/Female only (free: 5/day when used; Any = unlimited)
    const currentEntry = await ConnectionQueue.findOne({ userId, status: 'waiting' }).lean();
    const matchOptions = {
      preferredGender: queuePreferredGender || null,
      currentGender: userGender,
      currentEntry
    };

    // Try to find a match immediately
    const match = await findMatch(userId, selectedGame, normalizedTags, matchOptions);
    
    if (match) {
      if (process.env.NODE_ENV === 'development') { console.log(`✅ Instant match found for ${userId} with ${match.userId}`);
      }
      const claimed = await claimWaitingPair(userId, match.userId);
      if (!claimed) {
        return res.status(200).json({
          success: true,
          message: 'Added to queue. Waiting for match...',
          matched: false
        });
      }

      const usedGenderFilter = queuePreferredGender !== '';
      const connection = await createConnectionForPair({
        user1: {
          userId,
          username: req.user.username,
          displayName: req.user.profile?.displayName,
          avatar: req.user.profile?.avatar,
          videoEnabled
        },
        user2: match,
        selectedGame: selectedGame || match.selectedGame || null,
        tags: normalizedTags,
        usedGenderFilter,
        matchedTags: match.commonTags || [],
        matchQuality: match.matchQuality || 'unknown'
      });

      const userIdStr = userId.toString();
      const matchUserIdStr = match.userId.toString();
      const connectionData = buildConnectionPayload(connection);

      // CRITICAL: Emit socket events for BOTH users
      if (io) {
        if (process.env.NODE_ENV === 'development') { console.log(`📤 Emitting connection-matched events to both users...`);}
        await emitConnectionMatched(io, userIdStr, matchUserIdStr, connectionData, connection.roomId);
      } else {
        console.warn('⚠️ Socket.io not available, cannot emit events');
      }

      // Return connection data in API response - BOTH users can use this
      // Use connectionData which has properly formatted participants
      return res.status(200).json({
        success: true,
        message: 'Connection established!',
        connection: {
          ...connectionData
        },
        matched: true,
        roomId: connection.roomId
      });
    }

    // No immediate match found, user is in queue
    res.status(200).json({
      success: true,
      message: 'Added to queue. Waiting for match...',
      matched: false
    });

  } catch (error) {
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

const scoreCandidate = ({ currentEntry, candidate, tags, selectedGame, currentGender, allowFallback, recentPartnerIds }) => {
  const candidateId = getUserIdString(candidate.userId);
  if (!candidateId || candidateId === getUserIdString(currentEntry.userId)) return null;
  if (!allowFallback && recentPartnerIds.has(candidateId)) return null;

  if (candidate.preferredGender && candidate.preferredGender !== currentGender) return null;

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
      return null;
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
    return null;
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
    const { preferredGender, currentGender = '', currentEntry: providedCurrentEntry } = options;
    const currentEntry = providedCurrentEntry || await ConnectionQueue.findOne({ userId, status: 'waiting' }).lean();
    if (!currentEntry) return null;

    const joinedAt = new Date(currentEntry.joinedAt || currentEntry.createdAt || Date.now()).getTime();
    const allowFallback = Date.now() - joinedAt >= TAG_FALLBACK_MS;
    const recentPartnerIds = await getRecentPartnerIds(userId);

    const query = {
      userId: { $ne: userId },
      status: 'waiting'
    };

    if (preferredGender) {
      query.gender = preferredGender;
      if (process.env.NODE_ENV === 'development') { console.log(`🔍 Random Connect (Premium): filter by gender ${preferredGender}`);}
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

    const scored = potentialMatches
      .map(candidate => scoreCandidate({
        currentEntry,
        candidate,
        tags,
        selectedGame,
        currentGender,
        allowFallback,
        recentPartnerIds
      }))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || new Date(a.candidate.joinedAt || a.candidate.createdAt).getTime() - new Date(b.candidate.joinedAt || b.candidate.createdAt).getTime());

    if (scored.length > 0) {
      const best = scored[0];
      const match = best.candidate;
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

const buildParticipant = (queueLikeUser, dbUser, videoEnabled) => {
  const premium = getPremiumSnapshot(dbUser);
  return {
    userId: dbUser._id,
    username: queueLikeUser.username || dbUser.username,
    displayName: queueLikeUser.displayName || dbUser.profile?.displayName,
    avatar: queueLikeUser.avatar || dbUser.profile?.avatar,
    videoEnabled: videoEnabled !== undefined ? videoEnabled : queueLikeUser.videoEnabled,
    isPremium: premium.isPremium,
    membershipTier: premium.membershipTier
  };
};

const createConnectionForPair = async ({ user1, user2, selectedGame, tags, usedGenderFilter, matchedTags = [], matchQuality = 'unknown' }) => {
  const [dbUser1, dbUser2] = await Promise.all([
    User.findById(user1.userId || user1._id).select('username profile.displayName profile.avatar isPremium membership'),
    User.findById(user2.userId || user2._id).select('username profile.displayName profile.avatar isPremium membership')
  ]);

  if (!dbUser1 || !dbUser2) {
    throw new Error('Matched user profile not found');
  }

  const policy = buildSessionPolicy(dbUser1, dbUser2);
  const roomId = uuidv4();
  const connection = await RandomConnection.create({
    roomId,
    participants: [
      buildParticipant(user1, dbUser1, user1.videoEnabled),
      buildParticipant(user2, dbUser2, user2.videoEnabled)
    ],
    selectedGame: selectedGame || null,
    tags: tags || [],
    matchedTags,
    matchQuality,
    status: 'active',
    createdBy: dbUser1._id,
    usedGenderFilter: Boolean(usedGenderFilter),
    durationLimitSeconds: policy.durationLimitSeconds,
    endReason: null
  });

  await ConnectionQueue.deleteMany({
    userId: { $in: [dbUser1._id, dbUser2._id] }
  });

  return connection;
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
        const claimed = await claimWaitingPair(user1.userId, match.userId);
        if (!claimed) {
          continue;
        }

        const usedGenderFilter = (user1.preferredGender === 'male' || user1.preferredGender === 'female' ||
          match.preferredGender === 'male' || match.preferredGender === 'female');
        const connection = await createConnectionForPair({
          user1,
          user2: match,
          selectedGame: user1.selectedGame || match.selectedGame || null,
          tags: user1.tags || [],
          usedGenderFilter,
          matchedTags: match.commonTags || [],
          matchQuality: match.matchQuality || 'unknown'
        });

        if (process.env.NODE_ENV === 'development') {
          console.log(`✅ Periodic match: Created connection ${connection.roomId} for users ${user1.userId} <-> ${match.userId}`);
        }
        const userId1Str = user1.userId.toString();
        const userId2Str = match.userId.toString();
        const connectionData = buildConnectionPayload(connection);

        if (io) {
          await emitConnectionMatched(io, userId1Str, userId2Str, connectionData, connection.roomId);
        }

        processedUserIds.add(userId1Str);
        processedUserIds.add(userId2Str);
      }
    }

    if (processedUserIds.size > 0) {
      if (process.env.NODE_ENV === 'development') { console.log(`✅ Periodic matching: Successfully matched ${processedUserIds.size / 2} pairs`);}
    }
  } catch (error) {
    log.error('❌ Periodic matching error:', { error: String(error) });
  }
};

// Improved socket event emission with retry and verification
const emitConnectionMatched = async (io, userId1Str, userId2Str, connectionData, roomId) => {
  try {
    // Find sockets for both users - improved detection
    const allSockets = Array.from(io.sockets.sockets.values());
    
    // Normalize userId strings for comparison
    const userId1Normalized = String(userId1Str).trim();
    const userId2Normalized = String(userId2Str).trim();
    
    // Try multiple ways to match userId
    const userSockets1 = allSockets.filter(s => {
      const socketUserId = String(s.authUser?.userId ?? '').trim();
      return socketUserId !== '' && socketUserId === userId1Normalized;
    });

    const userSockets2 = allSockets.filter(s => {
      const socketUserId = String(s.authUser?.userId ?? '').trim();
      return socketUserId !== '' && socketUserId === userId2Normalized;
    });
    
    // Also check user rooms for sockets
    const room1 = io.sockets.adapter.rooms.get(`user-${userId1Str}`);
    const room2 = io.sockets.adapter.rooms.get(`user-${userId2Str}`);
    
    if (process.env.NODE_ENV === 'development') { console.log(`📤 Emitting connection-matched:`);}
    if (process.env.NODE_ENV === 'development') { console.log(`   User1 (${userId1Str}): ${userSockets1.length} direct socket(s), ${room1?.size || 0} socket(s) in room`);}
    if (process.env.NODE_ENV === 'development') { console.log(`   User2 (${userId2Str}): ${userSockets2.length} direct socket(s), ${room2?.size || 0} socket(s) in room`);
    }
    // Debug: Log all socket userIds for troubleshooting
    if (userSockets1.length === 0 || userSockets2.length === 0) {
      log.debug('🔍 Debug: All connected socket userIds:', 
        allSockets.map(s => ({ 
          socketId: s.id, 
          userId: s.userId?.toString(),
          connected: s.connected,
          rooms: Array.from(s.rooms || [])
        })).slice(0, 10)
      );
      if (process.env.NODE_ENV === 'development') { console.log(`🔍 Looking for userIds: "${userId1Normalized}" and "${userId2Normalized}"`);}
    }
    
    // Join sockets to random room first
    userSockets1.forEach(socket => {
      socket.join(`random-room-${roomId}`);
      if (process.env.NODE_ENV === 'development') { console.log(`✓ Socket ${socket.id} (user ${userId1Str}) joined random-room-${roomId}`);}
    });
    userSockets2.forEach(socket => {
      socket.join(`random-room-${roomId}`);
      if (process.env.NODE_ENV === 'development') { console.log(`✓ Socket ${socket.id} (user ${userId2Str}) joined random-room-${roomId}`);}
    });
    
    // Small delay to ensure room joins are processed
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Emit to user rooms (primary method) - multiple times to ensure delivery
    const emitToRooms = () => {
      io.to(`user-${userId1Str}`).emit('connection-matched', connectionData);
      io.to(`user-${userId2Str}`).emit('connection-matched', connectionData);
    };
    
    // Immediate emit
    emitToRooms();
    
    // Emit directly to sockets as backup
    userSockets1.forEach(socket => {
      socket.emit('connection-matched', connectionData);
      if (process.env.NODE_ENV === 'development') { console.log(`  ✓ Direct emit to socket ${socket.id} (user ${userId1Str})`);}
    });
    userSockets2.forEach(socket => {
      socket.emit('connection-matched', connectionData);
      if (process.env.NODE_ENV === 'development') { console.log(`  ✓ Direct emit to socket ${socket.id} (user ${userId2Str})`);}
    });
    
    // CRITICAL: Multiple retry emits to ensure BOTH users receive the event
    // This is essential because one user might receive it but the other might miss it
    setTimeout(() => {
      if (process.env.NODE_ENV === 'development') { console.log(`📤 Retry emit #1 (500ms delay) - ensuring both users receive`);}
      emitToRooms();
      userSockets1.forEach(socket => socket.emit('connection-matched', connectionData));
      userSockets2.forEach(socket => socket.emit('connection-matched', connectionData));
    }, 500);
    
    setTimeout(() => {
      if (process.env.NODE_ENV === 'development') { console.log(`📤 Retry emit #2 (1000ms delay) - ensuring both users receive`);}
      emitToRooms();
      userSockets1.forEach(socket => socket.emit('connection-matched', connectionData));
      userSockets2.forEach(socket => socket.emit('connection-matched', connectionData));
    }, 1000);
    
    setTimeout(() => {
      if (process.env.NODE_ENV === 'development') { console.log(`📤 Retry emit #3 (2000ms delay) - ensuring both users receive`);}
      emitToRooms();
      userSockets1.forEach(socket => socket.emit('connection-matched', connectionData));
      userSockets2.forEach(socket => socket.emit('connection-matched', connectionData));
    }, 2000);
    
    setTimeout(() => {
      if (process.env.NODE_ENV === 'development') { console.log(`📤 Retry emit #4 (3000ms delay) - ensuring both users receive`);}
      emitToRooms();
      userSockets1.forEach(socket => socket.emit('connection-matched', connectionData));
      userSockets2.forEach(socket => socket.emit('connection-matched', connectionData));
    }, 3000);
    
    // Final retry after 5 seconds
    setTimeout(() => {
      if (process.env.NODE_ENV === 'development') { console.log(`📤 Final retry emit #5 (5000ms delay) - ensuring both users receive`);}
      emitToRooms();
      userSockets1.forEach(socket => socket.emit('connection-matched', connectionData));
      userSockets2.forEach(socket => socket.emit('connection-matched', connectionData));
    }, 5000);
    
    // Also emit to random room as backup (users will join this room when they get the event)
    io.to(`random-room-${roomId}`).emit('connection-matched', connectionData);
    if (process.env.NODE_ENV === 'development') { console.log(`📤 Also emitted to random-room-${roomId}`);
    }
    // CRITICAL: Also join sockets from rooms to random room (in case they're in room but not found directly)
    if (room1 && room1.size > 0) {
      room1.forEach(socketId => {
        const socket = io.sockets.sockets.get(socketId);
        if (socket && socket.connected) {
          socket.join(`random-room-${roomId}`);
          socket.emit('connection-matched', connectionData);
          if (process.env.NODE_ENV === 'development') { console.log(`  ✓ Emitted to socket ${socketId} from room (user ${userId1Str})`);}
        }
      });
    }
    
    if (room2 && room2.size > 0) {
      room2.forEach(socketId => {
        const socket = io.sockets.sockets.get(socketId);
        if (socket && socket.connected) {
          socket.join(`random-room-${roomId}`);
          socket.emit('connection-matched', connectionData);
          if (process.env.NODE_ENV === 'development') { console.log(`  ✓ Emitted to socket ${socketId} from room (user ${userId2Str})`);}
        }
      });
    }
    
    // Log warnings if no sockets found
    if (userSockets1.length === 0 && (!room1 || room1.size === 0)) {
      console.warn(`⚠️ No sockets found for user ${userId1Str} - event sent to room only`);
      console.warn(`   User will receive event via fallback check or when socket connects`);
    }
    if (userSockets2.length === 0 && (!room2 || room2.size === 0)) {
      console.warn(`⚠️ No sockets found for user ${userId2Str} - event sent to room only`);
      console.warn(`   User will receive event via fallback check or when socket connects`);
    }
    
    // Important: Even if no sockets found, the event is sent to user rooms
    // Frontend fallback check will pick it up via current-connection API
    if (process.env.NODE_ENV === 'development') { console.log(`✅ Connection-matched event emitted via multiple channels for BOTH users`);}
  } catch (error) {
    log.error('❌ Error emitting connection-matched event:', { error: String(error) });
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
  }
};

// Leave the queue
const leaveQueue = async (req, res) => {
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
const disconnectConnection = async (req, res) => {
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
const cleanupCurrentConnection = async (req, res) => {
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

// List active sessions for monitoring (each session has unique sessionId = roomId)
const getActiveSessions = async (req, res) => {
  try {
    const sessions = await RandomConnection.find({ status: 'active' })
      .select('roomId startTime connectedAt expiresAt durationLimitSeconds participants.username participants.displayName participants.isPremium tags matchQuality matchedTags')
      .lean();

    const list = sessions.map(s => ({
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

// Get remaining daily gender-filter matches (for free users: Male/Female filter = 5/day)
const getDailyGenderMatchesRemaining = async (req, res) => {
  try {
    const userId = req.user._id;
    const isPremium = isPremiumUser(req.user);
    const limit = FREE_DAILY_MATCH_LIMIT;

    if (isPremium) {
      return res.status(200).json({
        success: true,
        used: 0,
        limit,
        remaining: limit,
        isPremium: true
      });
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const used = await RandomConnection.countDocuments({
      'participants.userId': userId,
      status: { $in: ['active', 'disconnected', 'ended'] },
      startTime: { $gte: startOfToday },
      usedGenderFilter: true
    });
    const remaining = Math.max(0, limit - used);

    res.status(200).json({
      success: true,
      used,
      limit,
      remaining,
      isPremium: false
    });
  } catch (error) {
    log.error('Get daily gender matches remaining error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to get remaining matches',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

module.exports = {
  joinQueue,
  leaveQueue,
  getCurrentConnection,
  getActiveSessions,
  getDailyGenderMatchesRemaining,
  disconnectConnection,
  sendMessage,
  cleanupCurrentConnection,
  matchUsersFromQueue,
  markSessionReady,
  getSessionTimerState,
  syncExpiredSessions,
  _private: {
    normalizeTags,
    sanitizePreferredGender,
    isPremiumUser,
    buildSessionPolicy,
    scoreCandidate,
    buildSessionPolicyPayload
  }
};
