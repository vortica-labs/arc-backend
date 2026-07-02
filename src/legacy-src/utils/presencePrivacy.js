const presenceRoom = (userId) => `presence-${String(userId)}`;
const userRoom = (userId) => `user-${String(userId)}`;

const publishPrivacySettingsUpdate = (io, userId) => {
  if (!io || !userId) return null;
  const payload = {
    userId: String(userId),
    updatedAt: new Date().toISOString()
  };
  // The owner must refresh every signed-in device. Existing presence-room
  // subscribers were authorized before this update and may invalidate a
  // rendered profile, but unrelated sockets must learn nothing about it.
  io.to?.(userRoom(userId)).emit('privacy-settings-updated', payload);
  io.to?.(presenceRoom(userId)).emit('privacy-settings-updated', payload);
  return payload;
};

const evictPresenceAudience = (io, userId) => {
  if (!io || !userId) return;
  const room = presenceRoom(userId);
  io.to?.(room).emit('presence:updated', {
    userId: String(userId),
    isOnline: false,
    lastSeen: null,
    hidden: true,
    updatedAt: new Date().toISOString()
  });
  io.in?.(room).socketsLeave?.(room);
};

const removePresenceSubscription = (io, viewerId, targetId) => {
  if (!io || !viewerId || !targetId) return;
  const viewerRoom = userRoom(viewerId);
  // Revoke the rendered value before removing room membership. Otherwise a
  // client that had already rendered "online" could retain that stale state
  // after an unfollow or block because it no longer receives target updates.
  io.to?.(viewerRoom).emit('presence:updated', {
    userId: String(targetId),
    isOnline: false,
    lastSeen: null,
    hidden: true,
    updatedAt: new Date().toISOString()
  });
  io.in?.(viewerRoom).socketsLeave?.(presenceRoom(targetId));
};

module.exports = {
  publishPrivacySettingsUpdate,
  evictPresenceAudience,
  removePresenceSubscription
};
