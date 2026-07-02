import type { Server, Socket } from "socket.io";
import path from "path";
import { logger } from "../../config/logger";
import { backendControllerPath, backendModelPath, backendRootPath } from "./legacy.paths";

const CALL_RING_TTL_SECONDS = 30;
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

type ActiveCallSession = {
  callId: string;
  callType: "voice" | "video";
  isGroup: true;
  chatRoomId: string;
  initiatorId: string;
  participants: Set<string>;
  startTime: Date;
  roomName: string;
};

type LeanRandomSession = {
  roomId: string;
  status: string;
  participants: Array<{ userId: unknown }>;
};

type RandomConnectionModel = {
  findOne: (filter: Record<string, unknown>) => {
    select: (fields: string) => {
      lean: () => Promise<LeanRandomSession | null>;
    };
  };
};

type RandomConnectController = {
  markSessionReady?: (roomId: string, userId: string, server: Server) => Promise<unknown>;
  getSessionTimerState?: (roomId: string, userId: string) => Promise<unknown>;
};

type DurableCallSession = {
  _id?: unknown;
  callId: string;
  nativeCallId: string;
  caller: unknown;
  callee: unknown;
  callType: "voice" | "video";
  expiresAt: Date | string;
  status: string;
  randomRoomId?: string;
  callerSnapshot?: Record<string, unknown>;
};

type CallSessionService = {
  createCallSession: (input: Record<string, unknown>) => Promise<DurableCallSession>;
  getCallSessionForParticipant: (callId: string, userId: string) => Promise<DurableCallSession>;
  transitionCallSession: (input: Record<string, unknown>) => Promise<DurableCallSession>;
  serializeCallSession: (session: DurableCallSession) => Record<string, unknown>;
};

type ApnsVoipPushService = {
  dispatchInitialVoipPush: (session: DurableCallSession) => Promise<Record<string, unknown>>;
  markVoipFallbackSent: (requestKey: string) => Promise<void>;
  getVoipFallbackExpoTokenHashes: (recipientId: string) => Promise<string[]>;
  sendExpoFallbackForVoipFailure: (
    recipientId: string,
    notification: Record<string, unknown>,
    outcome: Record<string, unknown> | null
  ) => Promise<Record<string, unknown>>;
};

const activeCalls = new Map<string, ActiveCallSession>();
const callRequestWindows = new Map<string, number[]>();
const CALL_REQUEST_WINDOW_MS = 60_000;
const CALL_REQUEST_MAX_PER_WINDOW = 8;
let randomMatchLoopStarted = false;

const consumeCallRequestQuota = (userId: string, now = Date.now()) => {
  const recent = (callRequestWindows.get(userId) || []).filter((timestamp) => now - timestamp < CALL_REQUEST_WINDOW_MS);
  if (recent.length >= CALL_REQUEST_MAX_PER_WINDOW) {
    callRequestWindows.set(userId, recent);
    return false;
  }
  recent.push(now);
  callRequestWindows.set(userId, recent);
  if (callRequestWindows.size > 10_000) {
    for (const [key, timestamps] of callRequestWindows) {
      if (!timestamps.some((timestamp) => now - timestamp < CALL_REQUEST_WINDOW_MS)) callRequestWindows.delete(key);
    }
  }
  return true;
};

const safeRequire = <T>(modulePath: string): T | null => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(modulePath) as T;
  } catch (_error) {
    return null;
  }
};

const getObjectIdString = (value: unknown): string => {
  if (!value) return "";
  if (typeof value === "object" && "_id" in value && (value as { _id?: unknown })._id) {
    return String((value as { _id: unknown })._id);
  }
  return String(value);
};

const boundedString = (value: unknown, maxLength: number): string =>
  typeof value === "string" ? value.trim().slice(0, maxLength) : "";

const getCallSessionService = (): CallSessionService | null =>
  safeRequire<CallSessionService>(path.join(backendRootPath, "services", "callSessionService.js"));

const getApnsVoipPushService = (): ApnsVoipPushService | null =>
  safeRequire<ApnsVoipPushService>(path.join(backendRootPath, "services", "apnsVoipPushService.js"));

const sendFailedVoipFallback = async (
  targetUserId: string,
  notification: any,
  voipResult: PromiseSettledResult<Record<string, unknown>>
) => {
  const apns = getApnsVoipPushService();
  if (!apns || !notification) return;
  const fulfilled = voipResult.status === "fulfilled" ? voipResult.value : null;
  await apns.sendExpoFallbackForVoipFailure(targetUserId, notification, fulfilled);
};

export const buildIncomingCallNotification = ({
  callId,
  callType,
  callerId,
  callerName,
  nativeCallId,
  randomRoomId,
  expiresAt: requestedExpiresAt,
  now = new Date()
}: {
  callId: string;
  callType: "voice" | "video";
  callerId: string;
  callerName: string;
  nativeCallId?: string;
  randomRoomId?: string;
  expiresAt?: Date | string;
  now?: Date;
}) => {
  const parsedExpiry = requestedExpiresAt ? new Date(requestedExpiresAt) : null;
  const expiresAt = parsedExpiry && !Number.isNaN(parsedExpiry.getTime())
    ? parsedExpiry
    : new Date(now.getTime() + CALL_RING_TTL_SECONDS * 1000);
  return {
    type: "call" as const,
    title: `${callerName || "Someone"} is calling`,
    message: `Incoming ${callType} call`,
    data: {
      deepLink: `/conversation/direct_${callerId}`,
      customData: {
        eventType: "incoming_call",
        callId,
        ...(nativeCallId ? { nativeCallId } : {}),
        notificationDedupeKey: `incoming-call:${callId}`,
        pushRequestId: `incoming-call:${callId}`,
        roomId: callId,
        callType,
        callerId,
        callerName,
        deadlineAt: expiresAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        ...(randomRoomId ? { randomRoomId } : {}),
        url: `/conversation/direct_${callerId}`,
        pushOptions: {
          ttl: CALL_RING_TTL_SECONDS,
          priority: "high",
          collapseKey: `incoming-call-${callId}`
        }
      }
    }
  };
};

const dispatchIncomingCallNotification = async ({
  targetUserId,
  callerId,
  callerName,
  callId,
  nativeCallId,
  callType,
  randomRoomId,
  expiresAt
}: {
  targetUserId: string;
  callerId: string;
  callerName: string;
  callId: string;
  nativeCallId?: string;
  callType: "voice" | "video";
  randomRoomId?: string;
  expiresAt?: Date | string;
}) => {
  const emitter = safeRequire<{ createAndEmitNotification?: (payload: Record<string, unknown>) => Promise<unknown> }>(
    path.join(backendRootPath, "utils", "notificationEmitter.js")
  );
  if (!emitter?.createAndEmitNotification) return;
  return emitter.createAndEmitNotification({
    recipient: targetUserId,
    sender: callerId,
    ...buildIncomingCallNotification({ callId, callType, callerId, callerName, nativeCallId, randomRoomId, expiresAt })
  });
};

const getRandomConnectionModel = (): RandomConnectionModel | null =>
  safeRequire<RandomConnectionModel>(path.join(backendModelPath, "RandomConnection.js"));

const getRandomConnectController = (): RandomConnectController | null =>
  safeRequire<RandomConnectController>(path.join(backendControllerPath, "randomConnectController.js"));

const findAuthorizedRandomSession = async (
  roomId: string,
  userId: string,
  targetUserId?: string
): Promise<LeanRandomSession | null> => {
  const RandomConnection = getRandomConnectionModel();
  if (!RandomConnection || !roomId || !userId) return null;

  const session = await RandomConnection.findOne({
    roomId,
    status: "active",
    "participants.userId": userId
  }).select("roomId status participants.userId").lean();

  if (!session) return null;
  const participantIds = new Set((session.participants || []).map((participant) => getObjectIdString(participant.userId)));
  if (!participantIds.has(userId)) return null;
  if (targetUserId && !participantIds.has(targetUserId)) return null;
  return session;
};

const handleGroupCallLeave = (io: Server, callId: string, userId: string, socket?: Socket) => {
  const session = activeCalls.get(callId);
  if (!session) {
    return;
  }

  session.participants.delete(userId);
  if (socket) {
    socket.to(`call-${callId}`).emit("group-call-participant-left", { callId, userId });
    socket.leave(`call-${callId}`);
  } else {
    io.to(`call-${callId}`).emit("group-call-participant-left", { callId, userId });
  }

  if (session.participants.size === 0) {
    io.to(`chat-${session.chatRoomId}`).emit("group-call-ended", { callId });
    activeCalls.delete(callId);
  }
};

export const registerLegacySocketHandlers = (io: Server, socket: Socket): void => {
  const userIdStr = String(socket.authUser?.userId ?? "");
  if (!userIdStr) {
    return;
  }

  socket.on("join-random-queue", (data: { selectedGame?: string }) => {
    if (data?.selectedGame) {
      socket.join(`random-queue-${data.selectedGame}`);
    }
  });

  socket.on("leave-random-queue", (data: { selectedGame?: string }) => {
    if (data?.selectedGame) {
      socket.leave(`random-queue-${data.selectedGame}`);
    }
  });

  socket.on("join-random-room", async (roomId: string) => {
    if (!roomId) {
      return;
    }
    const roomIdStr = String(roomId);
    const session = await findAuthorizedRandomSession(roomIdStr, userIdStr);
    if (!session) {
      socket.emit("random-session-error", { roomId: roomIdStr, message: "Random Connect session not found or not authorized" });
      return;
    }
    const room = `random-room-${String(roomId)}`;
    socket.join(room);
    socket.emit("room-joined", { roomId: String(roomId) });
    socket.to(room).emit("user-joined-room", { roomId: String(roomId), userId: userIdStr });
    const controller = getRandomConnectController();
    await controller?.markSessionReady?.(roomIdStr, userIdStr, io);
    const timerState = await controller?.getSessionTimerState?.(roomIdStr, userIdStr);
    if (timerState) socket.emit("random-session-timer-sync", timerState);
  });

  socket.on("leave-random-room", (roomId: string) => {
    if (roomId) {
      socket.leave(`random-room-${String(roomId)}`);
    }
  });

  socket.on("random-session-ready", async (data: { roomId?: string }) => {
    if (!data?.roomId) return;
    const roomId = String(data.roomId);
    const session = await findAuthorizedRandomSession(roomId, userIdStr);
    if (!session) {
      socket.emit("random-session-error", { roomId, message: "Random Connect session not authorized" });
      return;
    }
    const controller = getRandomConnectController();
    await controller?.markSessionReady?.(roomId, userIdStr, io);
  });

  socket.on("random-connection-message", async (data: { roomId?: string; message?: string }) => {
    if (!data?.roomId || !data?.message) {
      return;
    }
    const session = await findAuthorizedRandomSession(String(data.roomId), userIdStr);
    if (!session) {
      socket.emit("random-session-error", { roomId: data.roomId, message: "Random Connect session not authorized" });
      return;
    }
    socket.to(`random-room-${data.roomId}`).emit("random-connection-message", {
      roomId: data.roomId,
      sender: userIdStr,
      message: data.message,
      timestamp: new Date()
    });
  });

  socket.on("webrtc-signal", async (data: { roomId?: string; signal?: unknown; targetUserId?: string }) => {
    if (!data?.roomId || !data?.signal || !data?.targetUserId) {
      return;
    }
    const targetUserId = String(data.targetUserId);
    const session = await findAuthorizedRandomSession(String(data.roomId), userIdStr, targetUserId);
    if (!session) {
      socket.emit("random-session-error", { roomId: data.roomId, message: "Random Connect signal rejected" });
      return;
    }
    io.to(`user-${String(data.targetUserId)}`).emit("webrtc-signal", {
      signal: data.signal,
      fromUserId: userIdStr,
      roomId: data.roomId
    });
  });

  socket.on("webrtc-request-offer", async (data: { roomId?: string; targetUserId?: string }) => {
    if (!data?.roomId || !data?.targetUserId) {
      return;
    }
    const targetUserId = String(data.targetUserId);
    const session = await findAuthorizedRandomSession(String(data.roomId), userIdStr, targetUserId);
    if (!session) {
      socket.emit("random-session-error", { roomId: data.roomId, message: "Random Connect offer request rejected" });
      return;
    }
    io.to(`user-${String(data.targetUserId)}`).emit("webrtc-request-offer", {
      roomId: data.roomId,
      fromUserId: userIdStr
    });
  });

  socket.on("video-state-change", async (data: { roomId?: string; videoEnabled?: boolean; targetUserId?: string }) => {
    if (!data?.roomId || !data?.targetUserId) {
      return;
    }
    const targetUserId = String(data.targetUserId);
    const session = await findAuthorizedRandomSession(String(data.roomId), userIdStr, targetUserId);
    if (!session) return;
    io.to(`user-${String(data.targetUserId)}`).emit("video-state-change", {
      fromUserId: userIdStr,
      videoEnabled: data.videoEnabled
    });
  });

  socket.on("media-state", async (data: { roomId?: string; targetUserId?: string; video?: boolean; audio?: boolean }) => {
    if (!data?.roomId || !data?.targetUserId) {
      return;
    }
    const targetUserId = String(data.targetUserId);
    const session = await findAuthorizedRandomSession(String(data.roomId), userIdStr, targetUserId);
    if (!session) return;
    io.to(`user-${String(data.targetUserId)}`).emit("media-state", {
      fromUserId: userIdStr,
      video: data.video,
      audio: data.audio
    });
  });

  socket.on("call-request", async (data: { callId?: string; targetUserId?: string; callType?: "voice" | "video"; fromUsername?: string; fromDisplayName?: string; fromAvatar?: string; randomRoomId?: string }) => {
    const callId = boundedString(data?.callId, 160);
    const targetUserId = boundedString(data?.targetUserId, 64);
    if (!callId || !OBJECT_ID_PATTERN.test(targetUserId) || !data?.callType || !["voice", "video"].includes(data.callType) || targetUserId === userIdStr) {
      return;
    }
    if (!consumeCallRequestQuota(userIdStr)) {
      socket.emit("call-error", { callId, code: "CALL_RATE_LIMITED" });
      return;
    }
    if (data.randomRoomId) {
      const session = await findAuthorizedRandomSession(boundedString(data.randomRoomId, 160), userIdStr, targetUserId);
      if (!session) return;
    }

    const User = safeRequire<any>(path.join(backendModelPath, "User.js"));
    if (!User) return;
    const [caller, target] = await Promise.all([
      User.findById(userIdStr).select("username profile.displayName profile.avatar blockedUsers isActive").lean(),
      User.findById(targetUserId).select("username blockedUsers isActive").lean()
    ]);
    if (!caller?.isActive || !target?.isActive) return;
    const callerBlockedTarget = (caller.blockedUsers || []).some((id: unknown) => getObjectIdString(id) === targetUserId);
    const targetBlockedCaller = (target.blockedUsers || []).some((id: unknown) => getObjectIdString(id) === userIdStr);
    if (callerBlockedTarget || targetBlockedCaller) return;

    const callerName = boundedString(caller.profile?.displayName || caller.username, 100) || "Someone";
    const callSessionService = getCallSessionService();
    if (!callSessionService) {
      logger.error("Call session service unavailable", { callId, callerId: userIdStr, targetUserId });
      socket.emit("call-error", { callId, code: "CALL_SESSION_UNAVAILABLE" });
      return;
    }
    let durableSession: DurableCallSession;
    try {
      durableSession = await callSessionService.createCallSession({
        callId,
        callerId: userIdStr,
        calleeId: targetUserId,
        callType: data.callType,
        source: data.randomRoomId ? "random_connect" : "socket",
        randomRoomId: boundedString(data.randomRoomId, 160),
        caller: {
          username: caller.username,
          displayName: caller.profile?.displayName || caller.username,
          avatar: caller.profile?.avatar
        },
        expiresAt: new Date(Date.now() + CALL_RING_TTL_SECONDS * 1000)
      });
    } catch (error) {
      logger.warn("Call session creation rejected", { callId, callerId: userIdStr, targetUserId, error: String(error) });
      socket.emit("call-error", { callId, code: "CALL_SESSION_REJECTED" });
      return;
    }
    const deadlineAt = new Date(durableSession.expiresAt).toISOString();
    io.to(`user-${targetUserId}`).emit("call-request", {
      callId,
      nativeCallId: durableSession.nativeCallId,
      fromUserId: userIdStr,
      callType: data.callType,
      fromUsername: caller.username,
      fromDisplayName: caller.profile?.displayName || caller.username,
      fromAvatar: caller.profile?.avatar,
      randomRoomId: boundedString(data.randomRoomId, 160) || undefined,
      deadlineAt
    });
    const incomingCallNotification = {
      recipient: targetUserId,
      sender: userIdStr,
      ...buildIncomingCallNotification({
        callId,
        nativeCallId: durableSession.nativeCallId,
        callType: data.callType,
        callerId: userIdStr,
        callerName,
        randomRoomId: boundedString(data.randomRoomId, 160) || undefined,
        expiresAt: durableSession.expiresAt
      })
    };
    const standardPush = dispatchIncomingCallNotification({
      targetUserId,
      callerId: userIdStr,
      callerName,
      callId,
      nativeCallId: durableSession.nativeCallId,
      callType: data.callType,
      randomRoomId: boundedString(data.randomRoomId, 160) || undefined,
      expiresAt: durableSession.expiresAt
    });
    const apnsService = getApnsVoipPushService();
    const apnsVoipPush = apnsService
      ? apnsService.dispatchInitialVoipPush(durableSession)
      : Promise.reject(new Error("APNs VoIP service unavailable"));
    void Promise.allSettled([standardPush, apnsVoipPush]).then(async (results) => {
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          logger.error(index === 0 ? "Incoming call notification failed" : "APNs VoIP call push failed", {
            callId,
            callerId: userIdStr,
            targetUserId,
            error: String(result.reason)
          });
        }
      });
      // If the inbox/outbox write itself failed, the provider fallback can
      // still use the already-normalized payload. sendPushNotification repeats
      // the recipient preference check before touching the provider.
      const fallbackNotification = results[0].status === "fulfilled"
        ? results[0].value
        : incomingCallNotification;
      await sendFailedVoipFallback(targetUserId, fallbackNotification, results[1]).catch((error) => {
        logger.error("Incoming call Expo fallback failed", { callId, targetUserId, error: String(error) });
      });
    });
  });

  for (const eventName of ["call-accept", "call-reject", "call-end"] as const) {
    socket.on(eventName, async (data: { callId?: string; targetUserId?: string; reason?: string }) => {
      if (!data?.callId || !data?.targetUserId) {
        return;
      }
      const callSessionService = getCallSessionService();
      if (!callSessionService) return;
      try {
        const action = eventName === "call-accept" ? "accept" : eventName === "call-reject" ? "decline" : "end";
        const session = await callSessionService.transitionCallSession({
          callId: boundedString(data.callId, 160),
          actorId: userIdStr,
          action,
          reason: boundedString(data.reason, 80)
        });
        const callerId = getObjectIdString(session.caller);
        const calleeId = getObjectIdString(session.callee);
        const otherUserId = userIdStr === callerId ? calleeId : callerId;
        io.to(`user-${otherUserId}`).emit(eventName, {
          callId: session.callId,
          nativeCallId: session.nativeCallId,
          fromUserId: userIdStr,
          reason: boundedString(data.reason, 80) || undefined
        });
        const serialized = callSessionService.serializeCallSession(session);
        io.to(`user-${callerId}`).emit("call-session-updated", serialized);
        io.to(`user-${calleeId}`).emit("call-session-updated", serialized);
      } catch (error) {
        logger.warn("Call state transition rejected", {
          eventName,
          callId: boundedString(data.callId, 160),
          actorId: userIdStr,
          error: String(error)
        });
        socket.emit("call-error", { callId: data.callId, code: "CALL_STATE_CONFLICT" });
      }
    });
  }

  socket.on("call-signal", async (data: { callId?: string; targetUserId?: string; signal?: unknown }) => {
    const callId = boundedString(data?.callId, 160);
    const requestedTarget = boundedString(data?.targetUserId, 64);
    if (!callId || !OBJECT_ID_PATTERN.test(requestedTarget) || !data?.signal || typeof data.signal !== "object") {
      return;
    }
    let serializedSignal = "";
    try { serializedSignal = JSON.stringify(data.signal); } catch { return; }
    if (Buffer.byteLength(serializedSignal, "utf8") > 64 * 1024) return;
    const service = getCallSessionService();
    if (!service) return;
    try {
      const session = await service.getCallSessionForParticipant(callId, userIdStr);
      if (session.status !== "accepted") return;
      const callerId = getObjectIdString(session.caller);
      const calleeId = getObjectIdString(session.callee);
      const authorizedTarget = userIdStr === callerId ? calleeId : callerId;
      if (requestedTarget !== authorizedTarget) return;
      io.to(`user-${authorizedTarget}`).emit("call-signal", {
        callId: session.callId,
        nativeCallId: session.nativeCallId,
        fromUserId: userIdStr,
        signal: data.signal
      });
    } catch (error) {
      logger.warn("Unauthorized call signal rejected", { callId, actorId: userIdStr, error: String(error) });
    }
  });

  socket.on("group-call-request", (data: { callId?: string; chatRoomId?: string; callType?: "voice" | "video" }) => {
    if (!data?.callId || !data?.chatRoomId || !data?.callType) {
      return;
    }
    activeCalls.set(data.callId, {
      callId: data.callId,
      callType: data.callType,
      isGroup: true,
      chatRoomId: data.chatRoomId,
      initiatorId: userIdStr,
      participants: new Set([userIdStr]),
      startTime: new Date(),
      roomName: `call-${data.callId}`
    });
    socket.join(`call-${data.callId}`);
    io.to(`chat-${data.chatRoomId}`).emit("group-call-incoming", {
      callId: data.callId,
      callType: data.callType,
      initiatorId: userIdStr,
      chatRoomId: data.chatRoomId
    });
  });

  socket.on("group-call-join", (data: { callId?: string }) => {
    if (!data?.callId) {
      return;
    }
    const session = activeCalls.get(data.callId);
    if (!session) {
      socket.emit("group-call-not-found", { callId: data.callId });
      return;
    }
    session.participants.add(userIdStr);
    socket.join(`call-${data.callId}`);
    const existingParticipants = Array.from(session.participants)
      .filter((id) => id !== userIdStr)
      .map((id) => ({ userId: id, username: id }));
    socket.emit("group-call-joined", {
      callId: data.callId,
      callType: session.callType,
      chatRoomId: session.chatRoomId,
      participants: existingParticipants,
    });
    socket.to(`call-${data.callId}`).emit("group-call-participant-joined", { callId: data.callId, userId: userIdStr });
  });

  socket.on("group-call-signal", (data: { callId?: string; targetUserId?: string; signal?: unknown }) => {
    if (!data?.callId || !data?.targetUserId || !data?.signal) {
      return;
    }
    io.to(`user-${String(data.targetUserId)}`).emit("group-call-signal", {
      callId: data.callId,
      fromUserId: userIdStr,
      signal: data.signal
    });
  });

  socket.on("group-call-leave", (data: { callId?: string }) => {
    if (data?.callId) {
      handleGroupCallLeave(io, data.callId, userIdStr, socket);
    }
  });

  socket.on("disconnect", () => {
    for (const [callId, session] of activeCalls.entries()) {
      if (session.participants.has(userIdStr)) {
        handleGroupCallLeave(io, callId, userIdStr);
      }
    }
  });
};

export const startLegacyBackgroundJobs = (io: Server): void => {
  if (randomMatchLoopStarted) {
    return;
  }
  randomMatchLoopStarted = true;

  const randomConnectController = safeRequire<{ matchUsersFromQueue?: (server: Server) => Promise<void> }>(
    path.join(backendControllerPath, "randomConnectController.js")
  );

  if (randomConnectController?.matchUsersFromQueue) {
    setInterval(async () => {
      try {
        await randomConnectController.matchUsersFromQueue?.(io);
      } catch {
        // Swallow transient DB/network errors — the next tick will retry
      }
    }, 3000);
  }
};
