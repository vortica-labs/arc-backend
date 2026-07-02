import type { Server, Socket } from "socket.io";
import path from "path";
import { logger } from "../../config/logger";
import { backendModelPath, backendRootPath } from "../legacy/legacy.paths";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const User = require(path.join(backendModelPath, "User.js"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { normalizePrivacySettings, resolvePrivacyAccess } = require(path.join(backendRootPath, "utils", "privacyPolicy.js"));

const MAX_PRESENCE_TARGETS = 100;
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const userRoom = (userId: string) => `user-${userId}`;
const presenceRoom = (userId: string) => `presence-${userId}`;

type PresenceTarget = {
  _id: unknown;
  userType?: string;
  privacySettings?: unknown;
  blockedUsers?: unknown[];
  isActive?: boolean;
  lastSeen?: Date | string | null;
};

const normalizeIds = (payload: unknown): string[] => {
  const source = Array.isArray(payload)
    ? payload
    : (payload && typeof payload === "object" && Array.isArray((payload as { userIds?: unknown[] }).userIds))
      ? (payload as { userIds: unknown[] }).userIds
      : [];
  return [...new Set(source.map(String).map((id) => id.trim()).filter(Boolean))]
    .filter((id) => id.length <= 64)
    .slice(0, MAX_PRESENCE_TARGETS);
};

const onlineSnapshot = async (io: Server, userId: string) => {
  const sockets = await io.in(userRoom(userId)).fetchSockets();
  return sockets.length > 0;
};

export const registerPresenceSocketHandlers = (io: Server, socket: Socket): void => {
  socket.on("presence:subscribe", async (payload: unknown, acknowledge?: (result: unknown) => void) => {
    const viewerId = socket.authUser?.userId;
    if (!viewerId) return;
    try {
      const targetIds = normalizeIds(payload);
      const validTargetIds = targetIds.filter((targetId) => OBJECT_ID_PATTERN.test(targetId));
      const viewer = await User.findOne({ _id: viewerId, isActive: true })
        .select("_id userType blockedUsers")
        .lean();
      if (!viewer) throw new Error("Authenticated user is not active");

      const targets: PresenceTarget[] = await User.find({ _id: { $in: validTargetIds }, isActive: true })
        .select("_id userType privacySettings blockedUsers isActive lastSeen")
        .lean();
      const targetsById = new Map<string, PresenceTarget>(
        targets.map((target): [string, PresenceTarget] => [String(target._id), target])
      );
      const snapshots = [];

      for (const targetId of targetIds) {
        const target = targetsById.get(targetId);
        if (!target) {
          await socket.leave(presenceRoom(targetId));
          // Return the same fail-closed shape for malformed, missing, inactive,
          // and privacy-hidden targets so presence cannot be used as an account
          // existence oracle.
          snapshots.push({ userId: targetId, isOnline: false, lastSeen: null, hidden: true });
          continue;
        }
        const relationship = await resolvePrivacyAccess({ viewer, targetUser: target });
        if (!relationship.access.canSeeOnlineStatus) {
          await socket.leave(presenceRoom(targetId));
          snapshots.push({ userId: targetId, isOnline: false, lastSeen: null, hidden: true });
          continue;
        }

        await socket.join(presenceRoom(targetId));
        const isOnline = await onlineSnapshot(io, targetId);
        snapshots.push({
          userId: targetId,
          isOnline,
          lastSeen: isOnline ? null : (target.lastSeen || null),
          hidden: false
        });
      }

      const result = { success: true, data: snapshots };
      socket.emit("presence:snapshot", result);
      acknowledge?.(result);
    } catch (error) {
      logger.error("Presence subscription failed", { socketId: socket.id, viewerId, error: String(error) });
      const result = { success: false, code: "PRESENCE_UNAVAILABLE", data: [] };
      acknowledge?.(result);
    }
  });

  socket.on("presence:unsubscribe", async (payload: unknown) => {
    for (const targetId of normalizeIds(payload)) {
      await socket.leave(presenceRoom(targetId));
    }
  });
};

export const announcePresenceConnected = async (io: Server, userId: string): Promise<void> => {
  const user = await User.findOne({ _id: userId, isActive: true })
    .select("privacySettings")
    .lean();
  if (!user) return;
  if (!normalizePrivacySettings(user.privacySettings).showOnlineStatus) return;
  io.to(presenceRoom(userId)).emit("presence:updated", {
    userId,
    isOnline: true,
    lastSeen: null,
    updatedAt: new Date().toISOString()
  });
};

export const announcePresenceDisconnected = async (io: Server, userId: string): Promise<void> => {
  // The disconnect event fires after this socket has left its rooms. If another
  // installation is connected, the user remains online.
  if (await onlineSnapshot(io, userId)) return;
  const lastSeen = new Date();
  const user = await User.findOneAndUpdate(
    { _id: userId, isActive: true },
    { $set: { lastSeen } },
    { new: true }
  ).select("privacySettings").lean();
  if (!user) return;
  if (!normalizePrivacySettings(user.privacySettings).showOnlineStatus) return;
  io.to(presenceRoom(userId)).emit("presence:updated", {
    userId,
    isOnline: false,
    lastSeen,
    updatedAt: lastSeen.toISOString()
  });
};
