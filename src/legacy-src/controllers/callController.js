/**
 * Call Controller
 * ---------------
 * Handles video/voice call infrastructure using ZegoCloud.
 *
 * Responsibilities:
 *   1. Generate ZegoCloud tokens for authenticated users
 *   2. Manage call signaling (offer/answer/reject/end) via Socket.IO
 *   3. Track call history with call summary messages
 *
 * Flow:
 *   Caller → POST /api/calls/token → gets ZegoCloud token
 *   Caller → Socket 'call:offer' → server relays to callee
 *   Callee → Socket 'call:answer' or 'call:reject' → server relays back
 *   Either → Socket 'call:end' → server records call summary
 */

const { generateToken04 } = require('../utils/zegoTokenGenerator');
const User = require('../models/User');
const { Message } = require('../models/Message');
const { createAndEmitNotification } = require('../utils/notificationEmitter');
const {
  createCallSession,
  getCallSessionForParticipant,
  transitionCallSession,
  serializeCallSession
} = require('../services/callSessionService');
const log = require('../utils/logger');

// ── Config ──
const ZEGO_APP_ID = parseInt(process.env.ZEGOCLOUD_APP_ID || '0', 10);
const ZEGO_SERVER_SECRET = process.env.ZEGOCLOUD_SERVER_SECRET || '';
const TOKEN_EXPIRY_SECONDS = 3600; // 1 hour

/**
 * POST /api/calls/token
 * Generate a ZegoCloud access token for the authenticated user.
 *
 * Body: { roomId: string }
 * Tokens are issued only to a participant in a durable 1:1 call session.
 */
const generateCallToken = async (req, res) => {
  try {
    const userId = req.user._id.toString();
    const { roomId } = req.body;

    if (!roomId) {
      return res.status(400).json({ success: false, message: 'roomId is required' });
    }

    if (!ZEGO_APP_ID || !ZEGO_SERVER_SECRET) {
      return res.status(503).json({
        success: false,
        message: 'Video calling service is not configured. Set ZEGOCLOUD_APP_ID and ZEGOCLOUD_SERVER_SECRET.'
      });
    }

    const callSession = await getCallSessionForParticipant(roomId, userId);
    if (!['ringing', 'accepted'].includes(callSession.status)) {
      const error = new Error(`Call is already ${callSession.status}`);
      error.statusCode = 409;
      throw error;
    }
    const payload = JSON.stringify({
      room_id: callSession.callId,
      privilege: {
        1: 1, // loginRoom: allow
        2: 1  // publishStream: allow
      },
      stream_id_list: null
    });

    const result = generateToken04(
      ZEGO_APP_ID,
      userId,
      ZEGO_SERVER_SECRET,
      TOKEN_EXPIRY_SECONDS,
      payload
    );

    if (result.errorCode !== 0) {
      log.error('ZegoCloud token generation failed', { errorCode: result.errorCode, errorMessage: result.errorMessage });
      return res.status(500).json({
        success: false,
        message: 'Failed to generate call token'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        token: result.token,
        appID: ZEGO_APP_ID,
        userID: userId,
        roomId: callSession.callId,
        expiresIn: TOKEN_EXPIRY_SECONDS
      }
    });

  } catch (error) {
    log.error('generateCallToken error', { error: String(error) });
    res.status(Number(error?.statusCode || 500)).json({
      success: false,
      message: Number(error?.statusCode || 500) >= 500 ? 'Failed to generate call token' : error.message,
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * POST /api/calls/initiate
 * Initiate a call — creates a unique room ID, generates a token,
 * and sends a call offer to the target user via Socket.IO.
 *
 * Body: { targetUserId: string, callType: 'voice' | 'video' }
 */
const initiateCall = async (req, res) => {
  try {
    const callerId = req.user._id.toString();
    const { targetUserId, callType } = req.body;

    if (!targetUserId || !callType) {
      return res.status(400).json({
        success: false,
        message: 'targetUserId and callType are required'
      });
    }

    if (!/^[a-f\d]{24}$/i.test(String(targetUserId))) {
      return res.status(400).json({ success: false, message: 'Valid targetUserId is required' });
    }

    if (!['voice', 'video'].includes(callType)) {
      return res.status(400).json({
        success: false,
        message: 'callType must be "voice" or "video"'
      });
    }

    if (targetUserId === callerId) {
      return res.status(400).json({
        success: false,
        message: 'You cannot call yourself'
      });
    }

    if (!ZEGO_APP_ID || !ZEGO_SERVER_SECRET) {
      return res.status(503).json({
        success: false,
        message: 'Video calling service is not configured'
      });
    }

    // Check if target user exists and is active
    const targetUser = await User.findById(targetUserId)
      .select('isActive username profile.displayName profile.avatar blockedUsers')
      .lean();

    if (!targetUser || !targetUser.isActive) {
      return res.status(404).json({
        success: false,
        message: 'User not found or inactive'
      });
    }

    // Get caller info for the offer payload
    const callerUser = await User.findById(callerId)
      .select('username profile.displayName profile.avatar blockedUsers')
      .lean();

    const callerBlockedTarget = (callerUser?.blockedUsers || []).some((id) => String(id) === String(targetUserId));
    const targetBlockedCaller = (targetUser.blockedUsers || []).some((id) => String(id) === callerId);
    if (callerBlockedTarget || targetBlockedCaller) {
      return res.status(403).json({ success: false, message: 'Call is not permitted' });
    }

    // Generate unique room ID for this call
    const roomId = `call_${callerId}_${targetUserId}_${Date.now()}`;

    // Generate token for the caller
    const callerPayload = JSON.stringify({
      room_id: roomId,
      privilege: { 1: 1, 2: 1 },
      stream_id_list: null
    });

    const callerToken = generateToken04(
      ZEGO_APP_ID,
      callerId,
      ZEGO_SERVER_SECRET,
      TOKEN_EXPIRY_SECONDS,
      callerPayload
    );

    if (callerToken.errorCode !== 0) {
      return res.status(500).json({
        success: false,
        message: 'Failed to generate call token'
      });
    }

    const callSession = await createCallSession({
      callId: roomId,
      callerId,
      calleeId: targetUserId,
      callType,
      source: 'rest',
      caller: {
        username: callerUser?.username,
        displayName: callerUser?.profile?.displayName || callerUser?.username,
        avatar: callerUser?.profile?.avatar
      },
      expiresAt: new Date(Date.now() + 30_000)
    });

    // Emit to target user's socket room
    const callData = {
      roomId,
      callId: roomId,
      nativeCallId: callSession.nativeCallId,
      callType,
      caller: {
        userId: callerId,
        username: callerUser?.username,
        displayName: callerUser?.profile?.displayName,
        avatar: callerUser?.profile?.avatar
      },
      appID: ZEGO_APP_ID,
      timestamp: Date.now()
    };

    // Use the io instance from notificationEmitter (it's injected at boot)
    if (global._arcSocketIO) {
      global._arcSocketIO.to(`user-${targetUserId}`).emit('call:offer', callData);
    }

    const expiresAt = new Date(callSession.expiresAt).toISOString();
    const incomingCallNotification = {
      recipient: targetUserId,
      sender: callerId,
      type: 'call',
      title: `${callerUser?.profile?.displayName || callerUser?.username || 'Someone'} is calling`,
      message: `Incoming ${callType === 'video' ? 'video' : 'voice'} call`,
      data: {
        customData: {
          eventType: 'incoming_call',
          callId: roomId,
          nativeCallId: callSession.nativeCallId,
          notificationDedupeKey: `incoming-call:${roomId}`,
          pushRequestId: `incoming-call:${roomId}`,
          roomId,
          callType,
          callerId,
          callerName: callerUser?.profile?.displayName || callerUser?.username || 'Someone',
          deadlineAt: expiresAt,
          expiresAt,
          url: `/conversation/direct_${callerId}`,
          pushOptions: {
            ttl: 30,
            priority: 'high',
            collapseKey: `incoming-call-${roomId}`
          }
        },
        deepLink: `/conversation/direct_${callerId}`
      }
    };
    const standardPush = createAndEmitNotification(incomingCallNotification);
    const { dispatchInitialVoipPush, sendExpoFallbackForVoipFailure } = require('../services/apnsVoipPushService');
    const voipPush = dispatchInitialVoipPush(callSession);
    // Call setup must not wait on provider network I/O. Both transports write
    // durable delivery attempts and continue independently with retries.
    void Promise.allSettled([standardPush, voipPush]).then(async ([standardResult, voipResult]) => {
      if (standardResult.status === 'rejected') {
        log.warn('Failed to create call push notification', { error: String(standardResult.reason), targetUserId, roomId });
      }
      if (voipResult.status === 'rejected') {
        log.warn('Failed to create APNs VoIP call push', { error: String(voipResult.reason), targetUserId, roomId });
      }
      await sendExpoFallbackForVoipFailure(
        targetUserId,
        standardResult.status === 'fulfilled' ? standardResult.value : incomingCallNotification,
        voipResult.status === 'fulfilled' ? voipResult.value : null
      ).catch((fallbackError) => {
        log.error('Failed to create incoming-call Expo fallback', { error: String(fallbackError), targetUserId, roomId });
      });
    });

    res.status(200).json({
      success: true,
      data: {
        roomId,
        nativeCallId: callSession.nativeCallId,
        token: callerToken.token,
        appID: ZEGO_APP_ID,
        userID: callerId,
        targetUser: {
          userId: targetUserId,
          username: targetUser.username,
          displayName: targetUser.profile?.displayName,
          avatar: targetUser.profile?.avatar
        },
        callType,
        expiresIn: TOKEN_EXPIRY_SECONDS
      }
    });

  } catch (error) {
    log.error('initiateCall error', { error: String(error) });
    res.status(Number(error?.statusCode || 500)).json({
      success: false,
      message: 'Failed to initiate call',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * POST /api/calls/accept
 * Accept an incoming call — generates a token for the callee to join the room.
 *
 * Body: { roomId: string, callerId: string }
 */
const acceptCall = async (req, res) => {
  try {
    const calleeId = req.user._id.toString();
    const { roomId, callerId } = req.body;

    if (!roomId || !callerId) {
      return res.status(400).json({
        success: false,
        message: 'roomId and callerId are required'
      });
    }

    if (!ZEGO_APP_ID || !ZEGO_SERVER_SECRET) {
      return res.status(503).json({
        success: false,
        message: 'Video calling service is not configured'
      });
    }

    let durableSession = await getCallSessionForParticipant(roomId, calleeId);
    if (String(durableSession.caller) !== String(callerId) || String(durableSession.callee) !== calleeId) {
      const error = new Error('Call participants do not match the pending session');
      error.statusCode = 403;
      throw error;
    }
    if (durableSession.status === 'ringing') {
      durableSession = await transitionCallSession({ callId: roomId, actorId: calleeId, action: 'accept' });
    } else if (durableSession.status !== 'accepted') {
      const error = new Error(`Call is already ${durableSession.status}`);
      error.statusCode = 409;
      throw error;
    }

    // Generate token for callee
    const calleePayload = JSON.stringify({
      room_id: roomId,
      privilege: { 1: 1, 2: 1 },
      stream_id_list: null
    });

    const calleeToken = generateToken04(
      ZEGO_APP_ID,
      calleeId,
      ZEGO_SERVER_SECRET,
      TOKEN_EXPIRY_SECONDS,
      calleePayload
    );

    if (calleeToken.errorCode !== 0) {
      return res.status(500).json({
        success: false,
        message: 'Failed to generate call token'
      });
    }

    // Notify caller that call was accepted
    if (global._arcSocketIO) {
      global._arcSocketIO.to(`user-${callerId}`).emit('call:answer', {
        roomId,
        callId: roomId,
        nativeCallId: durableSession.nativeCallId,
        calleeId,
        accepted: true,
        timestamp: Date.now()
      });
    }

    res.status(200).json({
      success: true,
      data: {
        roomId,
        nativeCallId: durableSession.nativeCallId,
        token: calleeToken.token,
        appID: ZEGO_APP_ID,
        userID: calleeId,
        expiresIn: TOKEN_EXPIRY_SECONDS
      }
    });

  } catch (error) {
    log.error('acceptCall error', { error: String(error) });
    res.status(Number(error?.statusCode || 500)).json({
      success: false,
      message: 'Failed to accept call',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * POST /api/calls/reject
 * Reject an incoming call — notifies the caller.
 *
 * Body: { roomId: string, callerId: string }
 */
const rejectCall = async (req, res) => {
  try {
    const calleeId = req.user._id.toString();
    const { roomId, callerId } = req.body;

    if (!roomId || !callerId) {
      return res.status(400).json({
        success: false,
        message: 'roomId and callerId are required'
      });
    }

    const currentSession = await getCallSessionForParticipant(roomId, calleeId);
    if (String(currentSession.caller) !== String(callerId) || String(currentSession.callee) !== calleeId) {
      const error = new Error('Call participants do not match the pending session');
      error.statusCode = 403;
      throw error;
    }
    if (!['ringing', 'declined'].includes(currentSession.status)) {
      const error = new Error(`Call is already ${currentSession.status}`);
      error.statusCode = 409;
      throw error;
    }
    const durableSession = await transitionCallSession({
      callId: roomId,
      actorId: calleeId,
      action: 'decline',
      reason: 'declined'
    });

    // Notify caller that call was rejected
    if (global._arcSocketIO) {
      global._arcSocketIO.to(`user-${callerId}`).emit('call:rejected', {
        roomId,
        callId: roomId,
        nativeCallId: durableSession.nativeCallId,
        calleeId,
        timestamp: Date.now()
      });
    }

    res.status(200).json({
      success: true,
      message: 'Call rejected'
    });

  } catch (error) {
    log.error('rejectCall error', { error: String(error) });
    res.status(Number(error?.statusCode || 500)).json({
      success: false,
      message: 'Failed to reject call'
    });
  }
};

/**
 * POST /api/calls/end
 * End an active call — records call summary and notifies all participants.
 *
 * Body: {
 *   roomId: string,
 *   callType: 'voice' | 'video',
 *   outcome: 'answered' | 'missed' | 'declined',
 *   durationSeconds: number,
 *   participantId: string  // the other user
 * }
 */
const endCall = async (req, res) => {
  try {
    const userId = req.user._id.toString();
    const { roomId, callType, outcome, durationSeconds, participantId } = req.body;

    if (!roomId) {
      return res.status(400).json({
        success: false,
        message: 'roomId is required'
      });
    }

    let durableSession = await getCallSessionForParticipant(roomId, userId);
    const callerId = String(durableSession.caller);
    const calleeId = String(durableSession.callee);
    const resolvedParticipantId = userId === callerId ? calleeId : callerId;
    if (participantId && String(participantId) !== resolvedParticipantId) {
      const error = new Error('participantId does not match the durable call session');
      error.statusCode = 403;
      throw error;
    }
    if (callType && callType !== durableSession.callType) {
      const error = new Error('callType does not match the durable call session');
      error.statusCode = 409;
      throw error;
    }
    if (outcome && !['answered', 'missed', 'declined'].includes(outcome)) {
      const error = new Error('Invalid call outcome');
      error.statusCode = 400;
      throw error;
    }
    const previousStatus = durableSession.status;
    if (['ringing', 'accepted'].includes(previousStatus)) {
      durableSession = await transitionCallSession({
        callId: roomId,
        actorId: userId,
        action: 'end',
        reason: outcome || 'ended'
      });
    }
    const resolvedOutcome = ['accepted', 'ended'].includes(previousStatus) || durableSession.status === 'ended'
      ? 'answered'
      : durableSession.status === 'declined' ? 'declined' : 'missed';
    const normalizedDuration = resolvedOutcome === 'answered'
      ? Math.max(0, Math.min(86400, Number(durationSeconds) || 0))
      : 0;

    // Notify the other participant that the call ended
    if (global._arcSocketIO) {
      global._arcSocketIO.to(`user-${resolvedParticipantId}`).emit('call:ended', {
        roomId,
        callId: roomId,
        nativeCallId: durableSession.nativeCallId,
        endedBy: userId,
        timestamp: Date.now()
      });
    }

    // Record call summary as a message in the chat
    const messageData = {
      sender: userId,
      recipient: resolvedParticipantId,
      messageType: 'call',
      content: { text: '' },
      callSummary: {
        callId: durableSession.callId,
        callType: durableSession.callType,
        outcome: resolvedOutcome,
        durationSeconds: normalizedDuration,
        participantCount: 2
      }
    };

    const message = await Message.findOneAndUpdate(
      { messageType: 'call', 'callSummary.callId': durableSession.callId },
      { $setOnInsert: messageData },
      { upsert: true, new: true, runValidators: true }
    );
    await message.populate('sender', 'username profile.displayName profile.avatar');

    // Emit call summary to both participants' chat
    if (global._arcSocketIO) {
      global._arcSocketIO.to(`user-${resolvedParticipantId}`).emit('newMessage', {
        chatId: `direct_${userId}`,
        message
      });
    }

    res.status(200).json({
      success: true,
      data: { message }
    });

  } catch (error) {
    log.error('endCall error', { error: String(error) });
    res.status(Number(error?.statusCode || 500)).json({
      success: false,
      message: 'Failed to end call',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * POST /api/calls/group-token
 * Generate a token for group calls (in a chat room).
 *
 * Body: { chatRoomId: string }
 */
const generateGroupCallToken = async (req, res) => {
  try {
    const userId = req.user._id.toString();
    const { chatRoomId } = req.body;

    if (!chatRoomId) {
      return res.status(400).json({
        success: false,
        message: 'chatRoomId is required'
      });
    }

    if (!ZEGO_APP_ID || !ZEGO_SERVER_SECRET) {
      return res.status(503).json({
        success: false,
        message: 'Video calling service is not configured'
      });
    }

    // Verify user is a member of the chat room
    const ChatRoom = require('../models/ChatRoom');
    const chatRoom = await ChatRoom.findById(chatRoomId).lean();

    if (!chatRoom || !chatRoom.isActive) {
      return res.status(404).json({
        success: false,
        message: 'Chat room not found'
      });
    }

    const isMember = chatRoom.members.some(
      m => m.user.toString() === userId
    );

    if (!isMember) {
      return res.status(403).json({
        success: false,
        message: 'You are not a member of this chat room'
      });
    }

    // Use chatRoomId as the room ID for group calls
    const roomId = `group_${chatRoomId}`;
    const payload = JSON.stringify({
      room_id: roomId,
      privilege: { 1: 1, 2: 1 },
      stream_id_list: null
    });

    const result = generateToken04(
      ZEGO_APP_ID,
      userId,
      ZEGO_SERVER_SECRET,
      TOKEN_EXPIRY_SECONDS,
      payload
    );

    if (result.errorCode !== 0) {
      return res.status(500).json({
        success: false,
        message: 'Failed to generate call token'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        token: result.token,
        appID: ZEGO_APP_ID,
        userID: userId,
        roomId,
        expiresIn: TOKEN_EXPIRY_SECONDS
      }
    });

  } catch (error) {
    log.error('generateGroupCallToken error', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to generate group call token',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

module.exports = {
  generateCallToken,
  initiateCall,
  acceptCall,
  rejectCall,
  endCall,
  generateGroupCallToken
};
