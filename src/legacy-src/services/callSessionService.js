const { randomUUID } = require('crypto');
const CallSession = require('../models/CallSession');
const Notification = require('../models/Notification');
const log = require('../utils/logger');

const CALL_RING_TTL_SECONDS = Math.max(15, Math.min(120, Number(process.env.CALL_RING_TTL_SECONDS || 30)));
const MAX_CALL_DURATION_SECONDS = Math.max(300, Math.min(86400, Number(process.env.MAX_CALL_DURATION_SECONDS || 14400)));
const CALL_STATE_PUSH_MAX_ATTEMPTS = Math.max(1, Math.min(50, Number(process.env.CALL_STATE_PUSH_MAX_ATTEMPTS || 12)));
const CALL_STATE_PUSH_LEASE_MS = 2 * 60 * 1000;
const CALL_ID_PATTERN = /^[A-Za-z0-9:_-]{8,160}$/;
const TERMINAL_STATUSES = new Set(['declined', 'missed', 'cancelled', 'ended']);

const bounded = (value, max = 160) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const toId = (value) => String(value?._id || value || '');

const serviceError = (message, statusCode = 400, code = 'INVALID_CALL_SESSION') => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

const callStatePushMarker = (excludeInstallationId = '') => ({
  statePushStatus: 'pending',
  statePushRevision: randomUUID(),
  statePushExcludeInstallationId: bounded(excludeInstallationId, 200),
  statePushAttempts: 0,
  statePushNextAttemptAt: new Date(),
  statePushLeaseAt: null,
  statePushLeaseKey: '',
  statePushLastError: '',
  statePushCompletedAt: null
});

const serializeCallSession = (session) => session ? {
  id: toId(session._id),
  callId: session.callId,
  nativeCallId: session.nativeCallId,
  callerId: toId(session.caller),
  calleeId: toId(session.callee),
  callType: session.callType,
  source: session.source,
  randomRoomId: session.randomRoomId || undefined,
  caller: {
    username: session.callerSnapshot?.username || '',
    displayName: session.callerSnapshot?.displayName || '',
    avatar: session.callerSnapshot?.avatar || ''
  },
  status: session.status,
  expiresAt: session.expiresAt,
  acceptedAt: session.acceptedAt,
  acceptedInstallationId: session.acceptedInstallationId || '',
  activeUntil: session.activeUntil,
  declinedAt: session.declinedAt,
  missedAt: session.missedAt,
  endedAt: session.endedAt,
  endReason: session.endReason || '',
  createdAt: session.createdAt,
  updatedAt: session.updatedAt
} : null;

const dispatchCallStatePushes = async (session, excludeInstallationId = '') => {
  if (!session?._id) return null;
  const expectedRevision = String(session.statePushRevision || '');
  if (!expectedRevision) return null;
  const staleLease = new Date(Date.now() - CALL_STATE_PUSH_LEASE_MS);
  const leaseKey = `call-state-${randomUUID()}`;
  const claimed = await CallSession.findOneAndUpdate(
    {
      _id: session._id,
      statePushRevision: expectedRevision,
      statePushAttempts: { $lt: CALL_STATE_PUSH_MAX_ATTEMPTS },
      $or: [
        {
          statePushStatus: 'pending',
          $or: [{ statePushNextAttemptAt: null }, { statePushNextAttemptAt: { $lte: new Date() } }]
        },
        { statePushStatus: 'processing', statePushLeaseAt: { $lte: staleLease } }
      ]
    },
    {
      $set: {
        statePushStatus: 'processing',
        statePushLeaseAt: new Date(),
        statePushLeaseKey: leaseKey,
        statePushNextAttemptAt: null
      },
      $inc: { statePushAttempts: 1 }
    },
    { new: true }
  );
  if (!claimed || !['accepted', 'declined', 'missed', 'cancelled', 'ended'].includes(claimed.status)) return null;
  const revision = claimed.statePushRevision;
  const excludedInstallation = bounded(
    claimed.statePushExcludeInstallationId || excludeInstallationId,
    200
  );
  const pushRequestId = `call-state:${claimed.callId}:${claimed.status}:${revision}`;
  const notification = {
    recipient: claimed.callee,
    type: 'call',
    title: 'Call updated',
    message: `Call ${claimed.status}`,
    data: {
      customData: {
        eventType: 'call_state_update',
        callStateReconciliation: true,
        pushRequestId,
        callId: claimed.callId,
        nativeCallId: claimed.nativeCallId,
        status: claimed.status,
        callStatus: claimed.status,
        stateRevision: revision,
        reason: claimed.endReason || '',
        pushTargetPlatforms: ['android', 'ios'],
        ...(excludedInstallation ? { pushExcludeInstallationId: excludedInstallation } : {}),
        pushOptions: {
          ttl: 60,
          priority: 'high',
          collapseKey: `call-state-${claimed.callId}`
        }
      }
    }
  };
  const { sendPushNotification } = require('../utils/pushNotificationService');
  const results = await Promise.allSettled([
    sendPushNotification(claimed.callee, notification)
  ]);
  const failures = results.filter((result) => result.status === 'rejected');
  results.forEach((result) => {
    if (result.status === 'rejected') {
      log.error('Call-state background push failed', {
        callId: claimed.callId,
        status: claimed.status,
        error: String(result.reason)
      });
    }
  });
  if (failures.length) {
    const exhausted = Number(claimed.statePushAttempts || 0) >= CALL_STATE_PUSH_MAX_ATTEMPTS;
    const delayMs = Math.min(5 * 60 * 1000, 5000 * (2 ** Math.max(0, Number(claimed.statePushAttempts || 1) - 1)));
    await CallSession.updateOne(
      { _id: claimed._id, statePushRevision: revision, statePushLeaseKey: leaseKey },
      {
        $set: {
          statePushStatus: exhausted ? 'failed' : 'pending',
          statePushLastError: failures.map((result) => String(result.reason)).join('; ').slice(0, 1000),
          statePushNextAttemptAt: exhausted ? null : new Date(Date.now() + delayMs),
          statePushLeaseAt: null,
          statePushLeaseKey: ''
        }
      }
    );
    return { completed: false, retryable: !exhausted };
  }
  await CallSession.updateOne(
    { _id: claimed._id, statePushRevision: revision, statePushLeaseKey: leaseKey },
    {
      $set: {
        statePushStatus: 'completed',
        statePushCompletedAt: new Date(),
        statePushLastError: '',
        statePushNextAttemptAt: null,
        statePushLeaseAt: null,
        statePushLeaseKey: ''
      }
    }
  );
  return { completed: true };
};

const createCallSession = async ({
  callId,
  callerId,
  calleeId,
  callType,
  source = 'socket',
  randomRoomId = '',
  caller = {},
  expiresAt
}) => {
  const normalizedCallId = bounded(callId);
  if (!CALL_ID_PATTERN.test(normalizedCallId)) throw serviceError('Invalid callId');
  if (!['voice', 'video'].includes(callType)) throw serviceError('Invalid callType');
  if (!callerId || !calleeId || toId(callerId) === toId(calleeId)) throw serviceError('Invalid call participants');
  const normalizedSource = ['socket', 'rest', 'random_connect'].includes(source) ? source : 'socket';
  const deadline = expiresAt ? new Date(expiresAt) : new Date(Date.now() + CALL_RING_TTL_SECONDS * 1000);
  if (Number.isNaN(deadline.getTime()) || deadline <= new Date()) throw serviceError('Invalid call expiry');

  await expireDueCallSessions(100);

  const busySession = await CallSession.findOne({
    callId: { $ne: normalizedCallId },
    participantLeaseActive: true,
    $and: [
      { $or: [
        { status: 'ringing', expiresAt: { $gt: new Date() } },
        { status: 'accepted', activeUntil: { $gt: new Date() } }
      ] },
      { $or: [
        { caller: callerId }, { callee: callerId },
        { caller: calleeId }, { callee: calleeId }
      ] }
    ]
  }).select('callId').lean();
  if (busySession) {
    throw serviceError('A call participant is already ringing', 409, 'CALL_PARTICIPANT_BUSY');
  }

  let session;
  try {
    session = await CallSession.findOneAndUpdate(
      { callId: normalizedCallId },
      {
        $setOnInsert: {
        callId: normalizedCallId,
        nativeCallId: randomUUID(),
        caller: callerId,
        callee: calleeId,
        participantLeaseKeys: [callerId, calleeId],
        participantLeaseActive: true,
        callType,
        source: normalizedSource,
        randomRoomId: bounded(randomRoomId),
        callerSnapshot: {
          username: bounded(caller.username, 100),
          displayName: bounded(caller.displayName, 120),
          avatar: bounded(caller.avatar, 2048)
        },
        status: 'ringing',
        expiresAt: deadline,
        initialVoipPushStatus: 'pending',
        initialVoipPushAttempts: 0,
        initialVoipPushNextAttemptAt: new Date(),
        initialVoipPushLeaseAt: null,
        initialVoipPushLeaseKey: '',
        initialVoipPushLastError: '',
        initialVoipPushCompletedAt: null,
        initialVoipFallbackSentAt: null
        }
      },
      { upsert: true, new: true, runValidators: true }
    );
  } catch (error) {
    if (error?.code === 11000 && /participantLeaseKeys/.test(String(error?.message || ''))) {
      throw serviceError('A call participant is already active', 409, 'CALL_PARTICIPANT_BUSY');
    }
    throw error;
  }

  if (toId(session.caller) !== toId(callerId) || toId(session.callee) !== toId(calleeId)) {
    throw serviceError('callId already belongs to another session', 409, 'CALL_ID_CONFLICT');
  }
  if (session.callType !== callType) {
    throw serviceError('callId already belongs to a different call type', 409, 'CALL_ID_CONFLICT');
  }
  if (session.source !== normalizedSource) {
    throw serviceError('callId already belongs to a different call source', 409, 'CALL_ID_CONFLICT');
  }
  if (session.status !== 'ringing' || new Date(session.expiresAt) <= new Date()) {
    await expireCallSession(normalizedCallId);
    throw serviceError('callId is no longer ringable', 409, 'CALL_SESSION_TERMINAL');
  }
  return session;
};

const expireCallSession = async (callId, now = new Date()) => {
  const session = await CallSession.findOneAndUpdate(
    { callId, status: 'ringing', expiresAt: { $lte: now } },
    {
      $set: {
        status: 'missed', missedAt: now, endedAt: now, endReason: 'timeout', participantLeaseActive: false,
        ...callStatePushMarker()
      }
    },
    { new: true }
  );
  if (!session) return null;

  await Notification.findOneAndUpdate(
    { recipient: session.callee, type: 'call', 'data.customData.callId': session.callId },
    {
      $set: {
        title: `Missed ${session.callType} call`,
        message: `You missed a call from ${session.callerSnapshot?.displayName || session.callerSnapshot?.username || 'Someone'}`,
        'data.customData.eventType': 'missed_call',
        'data.customData.callStatus': 'missed'
      }
    },
    { new: true }
  ).catch((error) => log.warn('Missed-call inbox reconciliation failed', { callId, error: String(error) }));

  const io = global._arcSocketIO;
  io?.to?.(`user-${toId(session.caller)}`).emit('call-missed', {
    callId: session.callId,
    nativeCallId: session.nativeCallId,
    targetUserId: toId(session.callee),
    reason: 'timeout'
  });
  io?.to?.(`user-${toId(session.callee)}`).emit('call-session-updated', serializeCallSession(session));
  void dispatchCallStatePushes(session).catch((error) => {
    log.error('Missed call-state reconciliation push failed', { callId: session.callId, error: String(error) });
  });
  return session;
};

const expireActiveCallSession = async (callId, now = new Date()) => {
  const session = await CallSession.findOneAndUpdate(
    { callId, status: 'accepted', activeUntil: { $lte: now } },
    {
      $set: {
        status: 'ended',
        endedAt: now,
        endReason: 'max_duration',
        participantLeaseActive: false,
        ...callStatePushMarker()
      }
    },
    { new: true }
  );
  if (!session) return null;
  const io = global._arcSocketIO;
  io?.to?.(`user-${toId(session.caller)}`).emit('call-session-updated', serializeCallSession(session));
  io?.to?.(`user-${toId(session.callee)}`).emit('call-session-updated', serializeCallSession(session));
  void dispatchCallStatePushes(session).catch((error) => {
    log.error('Expired active call-state push failed', { callId: session.callId, error: String(error) });
  });
  return session;
};

const expireDueCallSessions = async (limit = 500) => {
  const due = await CallSession.find({
    $or: [
      { status: 'ringing', expiresAt: { $lte: new Date() } },
      { status: 'accepted', activeUntil: { $lte: new Date() } }
    ]
  })
    .select('callId status')
    .sort({ expiresAt: 1, activeUntil: 1 })
    .limit(Math.max(1, Math.min(2000, limit)))
    .lean();
  let expired = 0;
  for (const entry of due) {
    const result = entry.status === 'accepted'
      ? await expireActiveCallSession(entry.callId)
      : await expireCallSession(entry.callId);
    if (result) expired += 1;
  }
  return expired;
};

const getCallSessionForParticipant = async (callId, userId) => {
  const normalizedCallId = bounded(callId);
  if (!CALL_ID_PATTERN.test(normalizedCallId)) throw serviceError('Invalid callId');
  await expireCallSession(normalizedCallId);
  await expireActiveCallSession(normalizedCallId);
  const session = await CallSession.findOne({
    callId: normalizedCallId,
    $or: [{ caller: userId }, { callee: userId }]
  }).lean();
  if (!session) throw serviceError('Call session not found', 404, 'CALL_SESSION_NOT_FOUND');
  return session;
};

const getPendingCallSession = async (calleeId) => {
  await expireDueCallSessions(100);
  return CallSession.findOne({ callee: calleeId, status: 'ringing', expiresAt: { $gt: new Date() } })
    .sort({ createdAt: -1 })
    .lean();
};

const transitionCallSession = async ({ callId, actorId, action, reason = '', installationId = '' }) => {
  const normalizedCallId = bounded(callId);
  if (!CALL_ID_PATTERN.test(normalizedCallId)) throw serviceError('Invalid callId');
  const now = new Date();
  await expireCallSession(normalizedCallId, now);
  await expireActiveCallSession(normalizedCallId, now);
  const current = await CallSession.findOne({ callId: normalizedCallId }).lean();
  if (!current) throw serviceError('Call session not found', 404, 'CALL_SESSION_NOT_FOUND');
  const actor = toId(actorId);
  const callerId = toId(current.caller);
  const calleeId = toId(current.callee);
  if (actor !== callerId && actor !== calleeId) throw serviceError('Not a call participant', 403, 'CALL_SESSION_FORBIDDEN');

  // Native notification actions can be replayed when the JS bridge restores
  // cached CallKit/ConnectionService events. Treat an identical completed
  // action as success while still rejecting contradictory transitions.
  if (action === 'accept' && actor === calleeId && current.status === 'accepted') {
    if (current.acceptedInstallationId && installationId && current.acceptedInstallationId !== installationId) {
      throw serviceError('Call was answered on another installation', 409, 'CALL_ALREADY_ANSWERED');
    }
    void dispatchCallStatePushes(current).catch((error) => {
      log.error('Accepted call-state replay recovery failed', { callId: current.callId, error: String(error) });
    });
    return current;
  }
  if (action === 'decline' && actor === calleeId && current.status === 'declined') {
    void dispatchCallStatePushes(current).catch((error) => {
      log.error('Declined call-state replay recovery failed', { callId: current.callId, error: String(error) });
    });
    return current;
  }
  if (action === 'end' && TERMINAL_STATUSES.has(current.status)) {
    void dispatchCallStatePushes(current).catch((error) => {
      log.error('Ended call-state replay recovery failed', { callId: current.callId, error: String(error) });
    });
    return current;
  }

  let filter;
  let update;
  if (action === 'accept') {
    if (actor !== calleeId) throw serviceError('Only the callee can accept', 403, 'CALL_SESSION_FORBIDDEN');
    filter = { callId: normalizedCallId, callee: actorId, status: 'ringing', expiresAt: { $gt: now } };
    update = { $set: {
      status: 'accepted',
      acceptedAt: now,
      acceptedInstallationId: bounded(installationId, 200),
      activeUntil: new Date(now.getTime() + MAX_CALL_DURATION_SECONDS * 1000),
      participantLeaseActive: true,
      ...callStatePushMarker(installationId)
    } };
  } else if (action === 'decline') {
    if (actor !== calleeId) throw serviceError('Only the callee can decline', 403, 'CALL_SESSION_FORBIDDEN');
    filter = { callId: normalizedCallId, callee: actorId, status: 'ringing' };
    update = {
      $set: {
        status: 'declined', declinedAt: now, endedAt: now, endedBy: actorId,
        endReason: bounded(reason, 80) || 'declined', participantLeaseActive: false,
        ...callStatePushMarker()
      }
    };
  } else if (action === 'end') {
    filter = { callId: normalizedCallId, $or: [{ caller: actorId }, { callee: actorId }], status: { $in: ['ringing', 'accepted'] } };
    update = [{
      $set: {
        status: { $cond: [{ $eq: ['$status', 'ringing'] }, 'cancelled', 'ended'] },
        endedAt: now,
        endedBy: actorId,
        endReason: bounded(reason, 80) || 'ended',
        participantLeaseActive: false,
        ...callStatePushMarker()
      }
    }];
  } else {
    throw serviceError('Unsupported call action');
  }

  const updated = await CallSession.findOneAndUpdate(filter, update, {
    new: true,
    ...(Array.isArray(update) ? {} : { runValidators: true })
  });
  if (!updated) {
    const latest = await CallSession.findOne({ callId: normalizedCallId }).lean();
    if (latest && TERMINAL_STATUSES.has(latest.status)) {
      throw serviceError(`Call is already ${latest.status}`, 409, 'CALL_SESSION_TERMINAL');
    }
    throw serviceError('Call state changed; refresh and try again', 409, 'CALL_SESSION_CONFLICT');
  }
  void dispatchCallStatePushes(
    updated,
    action === 'accept' ? bounded(installationId, 200) : ''
  ).catch((error) => {
    log.error('Call-state reconciliation push failed', { callId: updated.callId, status: updated.status, error: String(error) });
  });
  return updated;
};

const recoverCallStatePushes = async (limit = 200) => {
  const staleLease = new Date(Date.now() - CALL_STATE_PUSH_LEASE_MS);
  const now = new Date();
  const exhausted = await CallSession.updateMany(
    {
      statePushAttempts: { $gte: CALL_STATE_PUSH_MAX_ATTEMPTS },
      $or: [
        {
          statePushStatus: 'pending',
          $or: [{ statePushNextAttemptAt: null }, { statePushNextAttemptAt: { $lte: now } }]
        },
        { statePushStatus: 'processing', statePushLeaseAt: { $lte: staleLease } }
      ]
    },
    {
      $set: {
        statePushStatus: 'failed',
        statePushLastError: 'Call-state reconciliation exhausted its retry budget',
        statePushNextAttemptAt: null,
        statePushLeaseAt: null,
        statePushLeaseKey: ''
      }
    }
  );
  if (Number(exhausted.modifiedCount || 0) > 0) {
    log.error('Call-state push outbox retry budget exhausted', {
      count: Number(exhausted.modifiedCount || 0)
    });
  }
  const candidates = await CallSession.find({
    statePushAttempts: { $lt: CALL_STATE_PUSH_MAX_ATTEMPTS },
    $or: [
      {
        statePushStatus: 'pending',
        $or: [{ statePushNextAttemptAt: null }, { statePushNextAttemptAt: { $lte: now } }]
      },
      { statePushStatus: 'processing', statePushLeaseAt: { $lte: staleLease } }
    ]
  })
    .select('_id statePushRevision')
    .sort({ statePushNextAttemptAt: 1, updatedAt: 1 })
    .limit(Math.max(1, Math.min(1000, limit)))
    .lean();
  let completed = 0;
  let retrying = 0;
  for (const candidate of candidates) {
    const result = await dispatchCallStatePushes(candidate);
    if (result?.completed) completed += 1;
    else if (result?.retryable) retrying += 1;
  }
  return {
    scanned: candidates.length,
    completed,
    retrying,
    failed: Number(exhausted.modifiedCount || 0)
  };
};

let sweepTimer = null;
const runCallSessionSweep = async () => {
  await expireDueCallSessions();
  await recoverCallStatePushes();
};
const startCallSessionSweeper = () => {
  if (sweepTimer) return;
  void runCallSessionSweep().catch((error) => log.error('Initial call-session sweep failed', { error: String(error) }));
  sweepTimer = setInterval(() => {
    void runCallSessionSweep().catch((error) => log.error('Call-session sweep failed', { error: String(error) }));
  }, 5000);
  sweepTimer.unref?.();
};

const stopCallSessionSweeper = () => {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
};

module.exports = {
  CALL_ID_PATTERN,
  CALL_RING_TTL_SECONDS,
  MAX_CALL_DURATION_SECONDS,
  serializeCallSession,
  createCallSession,
  expireCallSession,
  expireActiveCallSession,
  dispatchCallStatePushes,
  expireDueCallSessions,
  getCallSessionForParticipant,
  getPendingCallSession,
  transitionCallSession,
  recoverCallStatePushes,
  startCallSessionSweeper,
  stopCallSessionSweeper
};
