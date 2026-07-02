const {
  serializeCallSession,
  getPendingCallSession,
  getCallSessionForParticipant,
  transitionCallSession
} = require('../services/callSessionService');
const log = require('../utils/logger');
const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9:._-]{8,200}$/;

const userId = (req) => String(req.user?._id || '');
const sendError = (res, error, operation) => {
  const status = Number(error?.statusCode || 500);
  if (status >= 500) log.error(`Call session ${operation} failed`, { error: String(error) });
  return res.status(status).json({
    success: false,
    message: status >= 500 ? `Failed to ${operation} call session` : error.message,
    code: error?.code || 'CALL_SESSION_ERROR'
  });
};

const getPendingCall = async (req, res) => {
  try {
    const session = await getPendingCallSession(userId(req));
    return res.json({ success: true, data: { session: serializeCallSession(session) } });
  } catch (error) {
    return sendError(res, error, 'load pending');
  }
};

const getCallSession = async (req, res) => {
  try {
    const session = await getCallSessionForParticipant(req.params.callId, userId(req));
    return res.json({ success: true, data: { session: serializeCallSession(session) } });
  } catch (error) {
    return sendError(res, error, 'load');
  }
};

const performAction = (action) => async (req, res) => {
  try {
    const actorId = userId(req);
    const requestedInstallationId = typeof req.body?.installationId === 'string'
      ? req.body.installationId.trim()
      : '';
    const installationId = INSTALLATION_ID_PATTERN.test(requestedInstallationId)
      ? requestedInstallationId
      : '';
    const session = await transitionCallSession({
      callId: req.params.callId,
      actorId,
      action,
      reason: req.body?.reason,
      installationId
    });
    const io = req.app?.get?.('io') || global._arcSocketIO;
    const callerId = String(session.caller);
    const calleeId = String(session.callee);
    const otherUserId = actorId === callerId ? calleeId : callerId;
    if (action === 'accept') {
      io?.to?.(`user-${callerId}`).emit('call-accept', {
        callId: session.callId,
        nativeCallId: session.nativeCallId,
        fromUserId: calleeId,
        acceptedAt: session.acceptedAt
      });
    } else if (action === 'decline') {
      io?.to?.(`user-${callerId}`).emit('call-reject', {
        callId: session.callId,
        nativeCallId: session.nativeCallId,
        fromUserId: calleeId,
        reason: session.endReason || 'declined'
      });
    } else {
      io?.to?.(`user-${otherUserId}`).emit('call-end', {
        callId: session.callId,
        nativeCallId: session.nativeCallId,
        fromUserId: actorId,
        reason: session.endReason || 'ended'
      });
    }
    io?.to?.(`user-${calleeId}`).emit('call-session-updated', serializeCallSession(session));
    io?.to?.(`user-${callerId}`).emit('call-session-updated', serializeCallSession(session));
    return res.json({ success: true, data: { session: serializeCallSession(session) } });
  } catch (error) {
    return sendError(res, error, action);
  }
};

module.exports = {
  getPendingCall,
  getCallSession,
  acceptCallSession: performAction('accept'),
  declineCallSession: performAction('decline'),
  endCallSession: performAction('end')
};
