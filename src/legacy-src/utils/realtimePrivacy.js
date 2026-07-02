const idString = (value) => String(value?._id || value || '').trim();

const userRoom = (userId) => `user-${idString(userId)}`;
const chatRoom = (chatRoomId) => `chat-${idString(chatRoomId)}`;

/**
 * Revoke an authenticated user's live access to a group chat on every Socket.IO
 * node. Room membership is an optimization, never an authorization grant, so a
 * database membership removal must also remove already-connected sockets.
 */
const revokeChatRoomAccess = async (io, chatRoomId, userId, reason = 'membership_revoked') => {
  const normalizedChatRoomId = idString(chatRoomId);
  const normalizedUserId = idString(userId);
  if (!io || !normalizedChatRoomId || !normalizedUserId) return;

  const targetUserRoom = userRoom(normalizedUserId);
  const targetChatRoom = chatRoom(normalizedChatRoomId);

  io.to?.(targetUserRoom).emit?.('chat-access-revoked', {
    chatRoomId: normalizedChatRoomId,
    reason
  });

  // The adapter propagates socketsLeave across all application instances.
  io.in?.(targetUserRoom).socketsLeave?.(targetChatRoom);

  // Group-call rooms are dynamic. socket.data records which chat authorized a
  // call-room join so only calls belonging to the revoked chat are removed.
  if (typeof io.in?.(targetUserRoom)?.fetchSockets !== 'function') return;
  const sockets = await io.in(targetUserRoom).fetchSockets();
  await Promise.all((sockets || []).map(async (socket) => {
    const groupCallChats = socket.data?.groupCallChats;
    if (!groupCallChats || typeof groupCallChats !== 'object') return;
    for (const [callId, authorizedChatRoomId] of Object.entries(groupCallChats)) {
      if (idString(authorizedChatRoomId) !== normalizedChatRoomId) continue;
      await socket.leave?.(`call-${callId}`);
    }
  }));
};

/**
 * Immediately revoke all live transports for an account that is suspended,
 * deleted, or otherwise made inactive. JWT expiry alone is not sufficient:
 * existing Socket.IO connections would otherwise remain in their user room.
 */
const disconnectUserSockets = async (io, userId, reason = 'account_unavailable') => {
  const normalizedUserId = idString(userId);
  if (!io || !normalizedUserId) return;
  const room = userRoom(normalizedUserId);
  io.to?.(room).emit?.('session-revoked', { reason });
  await io.in?.(room).disconnectSockets?.(true);
};

module.exports = {
  revokeChatRoomAccess,
  disconnectUserSockets
};
