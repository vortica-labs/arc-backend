const User = require('../models/User');
const RandomConnection = require('../models/RandomConnection');
const { resolvePrivacyAccess } = require('./privacyPolicy');

const idString = (value) => String(value?._id || value || '');

const privacyError = (message, code = 'CALL_PRIVACY_RESTRICTED') => {
  const error = new Error(message);
  error.statusCode = 403;
  error.code = code;
  return error;
};

/**
 * Revalidate a durable call immediately before accepting, issuing media
 * credentials, or forwarding signaling. This closes the gap where a caller is
 * blocked or an account is suspended after the call session was created.
 */
const assertCallSessionPrivacy = async (session) => {
  if (!session) throw privacyError('Call session is unavailable', 'CALL_SESSION_UNAVAILABLE');
  const callerId = idString(session.caller);
  const calleeId = idString(session.callee);
  if (!callerId || !calleeId) throw privacyError('Call participants are unavailable');

  if (session.source === 'random_connect' || session.randomRoomId) {
    const randomSession = await RandomConnection.exists({
      roomId: session.randomRoomId,
      status: 'active',
      'participants.userId': { $all: [callerId, calleeId] }
    });
    if (!randomSession) {
      throw privacyError('Random Connect session is no longer active', 'RANDOM_SESSION_INACTIVE');
    }
    return { callerId, calleeId };
  }

  const [caller, callee] = await Promise.all([
    User.findOne({ _id: callerId, isActive: true })
      .select('_id userType privacySettings blockedUsers isActive')
      .lean(),
    User.findOne({ _id: calleeId, isActive: true })
      .select('_id userType privacySettings blockedUsers isActive')
      .lean()
  ]);
  if (!caller || !callee) {
    throw privacyError('Call participant is inactive', 'CALL_PARTICIPANT_INACTIVE');
  }

  const relationship = await resolvePrivacyAccess({
    viewer: caller,
    targetUser: callee,
    existingConversation: true
  });
  if (relationship.blocked) {
    throw privacyError('Call is no longer permitted');
  }
  return { callerId, calleeId };
};

module.exports = { assertCallSessionPrivacy };
