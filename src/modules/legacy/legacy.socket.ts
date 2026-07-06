import type { Server, Socket } from "socket.io";
import path from "path";
import { logger } from "../../config/logger";
import { backendControllerPath, backendModelPath, backendRootPath } from "./legacy.paths";

const CALL_RING_TTL_SECONDS = Math.max(
  15,
  Math.min(120, Number(process.env.CALL_RING_TTL_SECONDS || 30))
);
const CALL_DISCONNECT_GRACE_MS = Math.max(
  1000,
  Math.min(30_000, Number(process.env.CALL_DISCONNECT_GRACE_MS || 30_000))
);
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const CALL_ID_PATTERN = /^[A-Za-z0-9:_-]{8,160}$/;
const MAX_ACTIVE_GROUP_CALLS = 10_000;

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

type PrivacyPolicy = {
  resolvePrivacyAccess: (input: Record<string, unknown>) => Promise<{
    settings: { allowMessageFrom: string };
    access: { canMessage: boolean };
  }>;
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
  source?: "socket" | "rest" | "random_connect";
  randomRoomId?: string;
  callerSnapshot?: Record<string, unknown>;
};

type CallSessionService = {
  createCallSession: (input: Record<string, unknown>) => Promise<DurableCallSession>;
  getCallSessionForParticipant: (callId: string, userId: string) => Promise<DurableCallSession>;
  transitionCallSession: (input: Record<string, unknown>) => Promise<DurableCallSession>;
  serializeCallSession: (session: DurableCallSession) => Record<string, unknown>;
  endAcceptedCallSessionsForUser?: (userId: string, reason?: string) => Promise<DurableCallSession[]>;
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

type CallPrivacy = {
  assertCallSessionPrivacy: (session: DurableCallSession) => Promise<unknown>;
};

const activeCalls = new Map<string, ActiveCallSession>();
const callRequestWindows = new Map<string, number[]>();
const CALL_REQUEST_WINDOW_MS = 60_000;
const CALL_REQUEST_MAX_PER_WINDOW = 8;
let randomMatchLoopStarted = false;
let randomMatchTickRunning = false;
let randomMatchTimer: NodeJS.Timeout | null = null;
const callSignalDebugEnabled = process.env.CALL_SIGNAL_DEBUG === "true";
const traceCallSignal = (stage: string, meta: Record<string, unknown>) => {
  if (!callSignalDebugEnabled) return;
  logger.info("Call signaling trace", {
    timestamp: new Date().toISOString(),
    stage,
    ...meta
  });
};

const getSignalType = (signal: unknown): string => (
  signal && typeof signal === "object" && "type" in signal
    ? boundedString((signal as { type?: unknown }).type, 40) || "unknown"
    : "unknown"
);

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

export const releaseDisconnectedUserCallSessions = async (
  io: Server,
  userId: string,
  callSessionService: CallSessionService
): Promise<DurableCallSession[]> => {
  // Socket.IO removes the disconnecting socket from its rooms before the
  // `disconnect` event. A non-empty user room therefore means another tab or
  // installation is still connected and owns the same durable call session.
  const remainingSockets = await io.in(`user-${userId}`).fetchSockets();
  if (remainingSockets.length > 0 || !callSessionService.endAcceptedCallSessionsForUser) {
    return [];
  }

  const ended = await callSessionService.endAcceptedCallSessionsForUser(userId, "peer_disconnected");
  for (const session of ended) {
    const callerId = getObjectIdString(session.caller);
    const calleeId = getObjectIdString(session.callee);
    const otherUserId = userId === callerId ? calleeId : callerId;
    io.to(`user-${otherUserId}`).emit("call-end", {
      callId: session.callId,
      nativeCallId: session.nativeCallId,
      fromUserId: userId,
      reason: "peer_disconnected"
    });
  }
  return ended;
};

const getApnsVoipPushService = (): ApnsVoipPushService | null =>
  safeRequire<ApnsVoipPushService>(path.join(backendRootPath, "services", "apnsVoipPushService.js"));

const getCallPrivacy = (): CallPrivacy | null =>
  safeRequire<CallPrivacy>(path.join(backendRootPath, "utils", "callPrivacy.js"));

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

const getPrivacyPolicy = (): PrivacyPolicy | null =>
  safeRequire<PrivacyPolicy>(path.join(backendRootPath, "utils", "privacyPolicy.js"));

const isAuthorizedLegacyChatMember = async (chatRoomId: string, userId: string): Promise<boolean> => {
  const messageModels = safeRequire<any>(path.join(backendModelPath, "Message.js"));
  if (!messageModels?.ChatRoom || !chatRoomId || !userId) return false;
  return Boolean(await messageModels.ChatRoom.exists({
    _id: chatRoomId,
    isActive: true,
    $or: [
      { creator: userId },
      { "members.user": userId }
    ]
  }));
};

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
    if (socket.data?.groupCallChats && typeof socket.data.groupCallChats === "object") {
      delete socket.data.groupCallChats[callId];
    }
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
    const selectedGame = boundedString(data?.selectedGame, 64);
    if (!selectedGame || !/^[A-Za-z0-9 _.-]{1,64}$/.test(selectedGame)) return;
    for (const room of socket.rooms) {
      if (room.startsWith("random-queue-")) socket.leave(room);
    }
    socket.join(`random-queue-${selectedGame}`);
  });

  socket.on("leave-random-queue", (data: { selectedGame?: string }) => {
    const selectedGame = boundedString(data?.selectedGame, 64);
    if (selectedGame && /^[A-Za-z0-9 _.-]{1,64}$/.test(selectedGame)) {
      socket.leave(`random-queue-${selectedGame}`);
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
    const message = boundedString(data?.message, 2000);
    if (!data?.roomId || !message) {
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
      message,
      timestamp: new Date()
    });
  });

  socket.on("webrtc-signal", async (data: { roomId?: string; signal?: unknown; targetUserId?: string }) => {
    if (!data?.roomId || !data?.signal || typeof data.signal !== "object" || !data?.targetUserId) {
      return;
    }
    let serializedSignal = "";
    try { serializedSignal = JSON.stringify(data.signal); } catch { return; }
    if (Buffer.byteLength(serializedSignal, "utf8") > 64 * 1024) return;
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
    traceCallSignal("call_request_received", {
      callId,
      callType: data.callType,
      callerId: userIdStr,
      calleeId: targetUserId,
      socketId: socket.id
    });
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
      User.findById(userIdStr).select("username userType profile privacySettings blockedUsers isActive").lean(),
      User.findById(targetUserId).select("username userType profile privacySettings blockedUsers isActive").lean()
    ]);
    if (!caller?.isActive || !target?.isActive) {
      socket.emit("call-error", { callId, code: "CALL_UNAVAILABLE" });
      return;
    }
    const callerBlockedTarget = (caller.blockedUsers || []).some((id: unknown) => getObjectIdString(id) === targetUserId);
    const targetBlockedCaller = (target.blockedUsers || []).some((id: unknown) => getObjectIdString(id) === userIdStr);
    if (callerBlockedTarget || targetBlockedCaller) {
      socket.emit("call-error", { callId, code: "CALL_PRIVACY_RESTRICTED", reason: "blocked" });
      return;
    }

    if (!data.randomRoomId) {
      const Message = safeRequire<any>(path.join(backendModelPath, "Message.js"));
      const privacyPolicy = getPrivacyPolicy();
      if (!Message?.Message || !privacyPolicy) {
        socket.emit("call-error", { callId, code: "CALL_PRIVACY_UNAVAILABLE" });
        return;
      }
      const existingConversation = Boolean(await Message.Message.exists({
        messageType: "direct",
        isDeleted: false,
        $or: [
          { sender: targetUserId, recipient: userIdStr },
          { sender: userIdStr, recipient: targetUserId }
        ]
      }));
      const targetAccess = await privacyPolicy.resolvePrivacyAccess({
        viewer: caller,
        targetUser: target,
        existingConversation
      });
      if (!targetAccess.access.canMessage) {
        socket.emit("call-error", {
          callId,
          code: "CALL_PRIVACY_RESTRICTED",
          reason: targetAccess.settings.allowMessageFrom === "followers" ? "not_follower" : "messages_disabled"
        });
        return;
      }
    }

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
      socket.emit("call-error", {
        callId,
        code: boundedString((error as { code?: unknown })?.code, 80) || "CALL_SESSION_REJECTED"
      });
      return;
    }
    try {
      const callPrivacy = getCallPrivacy();
      if (!callPrivacy) throw new Error("CALL_PRIVACY_UNAVAILABLE");
      await callPrivacy.assertCallSessionPrivacy(durableSession);
    } catch (error) {
      await callSessionService.transitionCallSession({
        callId,
        actorId: userIdStr,
        action: "end",
        reason: "privacy_changed"
      }).catch(() => undefined);
      socket.emit("call-error", {
        callId,
        code: boundedString((error as { code?: unknown })?.code, 80) || "CALL_PRIVACY_RESTRICTED"
      });
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
        if (eventName === "call-accept") {
          const pendingSession = await callSessionService.getCallSessionForParticipant(
            boundedString(data.callId, 160),
            userIdStr
          );
          const callPrivacy = getCallPrivacy();
          if (!callPrivacy) throw new Error("CALL_PRIVACY_UNAVAILABLE");
          await callPrivacy.assertCallSessionPrivacy(pendingSession);
        }
        const session = await callSessionService.transitionCallSession({
          callId: boundedString(data.callId, 160),
          actorId: userIdStr,
          action,
          reason: boundedString(data.reason, 80)
        });
        const callerId = getObjectIdString(session.caller);
        const calleeId = getObjectIdString(session.callee);
        const otherUserId = userIdStr === callerId ? calleeId : callerId;
        traceCallSignal("call_state_forwarded", {
          callId: session.callId,
          eventName,
          actorId: userIdStr,
          targetUserId: otherUserId,
          socketId: socket.id,
          status: session.status
        });
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
        socket.emit("call-error", {
          callId: data.callId,
          code: boundedString((error as { code?: unknown })?.code, 80) || "CALL_STATE_CONFLICT"
        });
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
      const callPrivacy = getCallPrivacy();
      if (!callPrivacy) return;
      await callPrivacy.assertCallSessionPrivacy(session);
      const signalType = getSignalType(data.signal);
      if (session.status !== "accepted") {
        traceCallSignal("signal_rejected_session_not_accepted", {
          callId,
          actorId: userIdStr,
          requestedTarget,
          signalType,
          status: session.status,
          socketId: socket.id
        });
        return;
      }
      const callerId = getObjectIdString(session.caller);
      const calleeId = getObjectIdString(session.callee);
      const authorizedTarget = userIdStr === callerId ? calleeId : callerId;
      if (requestedTarget !== authorizedTarget) {
        traceCallSignal("signal_rejected_wrong_target", {
          callId,
          actorId: userIdStr,
          requestedTarget,
          authorizedTarget,
          signalType,
          socketId: socket.id
        });
        return;
      }
      io.to(`user-${authorizedTarget}`).emit("call-signal", {
        callId: session.callId,
        nativeCallId: session.nativeCallId,
        fromUserId: userIdStr,
        signal: data.signal
      });
      traceCallSignal("signal_forwarded", {
        callId,
        fromUserId: userIdStr,
        targetUserId: authorizedTarget,
        signalType,
        socketId: socket.id
      });
    } catch (error) {
      logger.warn("Unauthorized call signal rejected", { callId, actorId: userIdStr, error: String(error) });
      socket.emit("call-error", {
        callId,
        code: boundedString((error as { code?: unknown })?.code, 80) || "CALL_SIGNAL_REJECTED"
      });
    }
  });

  socket.on("group-call-request", async (data: { callId?: string; chatRoomId?: string; callType?: "voice" | "video" }) => {
    const callId = boundedString(data?.callId, 160);
    const chatRoomId = boundedString(data?.chatRoomId, 64);
    if (!CALL_ID_PATTERN.test(callId)
      || !OBJECT_ID_PATTERN.test(chatRoomId)
      || !data?.callType
      || !["voice", "video"].includes(data.callType)) {
      socket.emit("call-error", { callId, code: "INVALID_GROUP_CALL" });
      return;
    }
    if (!consumeCallRequestQuota(userIdStr)) {
      socket.emit("call-error", { callId, code: "CALL_RATE_LIMITED" });
      return;
    }
    if (!await isAuthorizedLegacyChatMember(chatRoomId, userIdStr)) {
      socket.emit("call-error", { callId, code: "GROUP_CALL_ACCESS_DENIED" });
      return;
    }
    const existingCall = activeCalls.get(callId);
    if (existingCall || activeCalls.size >= MAX_ACTIVE_GROUP_CALLS) {
      socket.emit("call-error", {
        callId,
        code: existingCall ? "CALL_ID_CONFLICT" : "GROUP_CALL_CAPACITY_REACHED"
      });
      return;
    }
    activeCalls.set(callId, {
      callId,
      callType: data.callType,
      isGroup: true,
      chatRoomId,
      initiatorId: userIdStr,
      participants: new Set([userIdStr]),
      startTime: new Date(),
      roomName: `call-${callId}`
    });
    socket.data.groupCallChats = {
      ...(socket.data.groupCallChats || {}),
      [callId]: chatRoomId
    };
    await socket.join(`call-${callId}`);
    // The Web initiator acquires local media from this acknowledgement. Without
    // it, only later joiners initialize media and no offer can be created.
    socket.emit("group-call-joined", {
      callId,
      callType: data.callType,
      chatRoomId,
      participants: []
    });
    io.to(`chat-${chatRoomId}`).emit("group-call-incoming", {
      callId,
      callType: data.callType,
      initiatorId: userIdStr,
      chatRoomId
    });
  });

  socket.on("group-call-join", async (data: { callId?: string }) => {
    if (!data?.callId) {
      return;
    }
    const session = activeCalls.get(data.callId);
    if (!session) {
      socket.emit("group-call-not-found", { callId: data.callId });
      return;
    }
    if (!await isAuthorizedLegacyChatMember(session.chatRoomId, userIdStr)) {
      socket.emit("call-error", { callId: data.callId, code: "GROUP_CALL_ACCESS_DENIED" });
      return;
    }
    const participantAuthorization = await Promise.all(
      [...session.participants].map(async (participantId) => ({
        participantId,
        allowed: await isAuthorizedLegacyChatMember(session.chatRoomId, participantId)
      }))
    );
    participantAuthorization.forEach(({ participantId, allowed }) => {
      if (!allowed) session.participants.delete(participantId);
    });
    session.participants.add(userIdStr);
    socket.data.groupCallChats = {
      ...(socket.data.groupCallChats || {}),
      [data.callId]: session.chatRoomId
    };
    await socket.join(`call-${data.callId}`);
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

  socket.on("group-call-signal", async (data: { callId?: string; targetUserId?: string; signal?: unknown }) => {
    if (!data?.callId || !data?.targetUserId || !data?.signal || typeof data.signal !== "object") {
      return;
    }
    let serializedSignal = "";
    try { serializedSignal = JSON.stringify(data.signal); } catch { return; }
    if (Buffer.byteLength(serializedSignal, "utf8") > 64 * 1024) return;
    const session = activeCalls.get(data.callId);
    const targetUserId = String(data.targetUserId);
    if (!session
      || !session.participants.has(userIdStr)
      || !session.participants.has(targetUserId)
      || !await isAuthorizedLegacyChatMember(session.chatRoomId, userIdStr)
      || !await isAuthorizedLegacyChatMember(session.chatRoomId, targetUserId)) {
      socket.emit("call-error", { callId: data.callId, code: "GROUP_CALL_ACCESS_DENIED" });
      return;
    }
    io.to(`user-${targetUserId}`).emit("group-call-signal", {
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
    // Release accepted durable 1:1 call-session leases held by this user. A
    // refresh, tab close, or network drop during an accepted call otherwise
    // leaves the session leased (participantLeaseActive) until activeUntil — up to
    // MAX_CALL_DURATION_SECONDS (default 4h) — which blocks this account's next
    // call with CALL_PARTICIPANT_BUSY → "A previous call is still active."
    const callSessionService = getCallSessionService();
    if (callSessionService?.endAcceptedCallSessionsForUser) {
      // Let short network changes and app foreground transitions reconnect.
      // Ringing calls are never released here: native push/CallKit acceptance
      // legitimately happens while the callee has no active Socket.IO client.
      const releaseTimer = setTimeout(() => {
        void releaseDisconnectedUserCallSessions(io, userIdStr, callSessionService)
          .catch((error: unknown) => {
            logger.warn("Failed to release call sessions on disconnect", {
              userId: userIdStr,
              error: String(error)
            });
          });
      }, CALL_DISCONNECT_GRACE_MS);
      releaseTimer.unref?.();
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
    randomMatchTimer = setInterval(async () => {
      if (randomMatchTickRunning) return;
      randomMatchTickRunning = true;
      try {
        await randomConnectController.matchUsersFromQueue?.(io);
      } catch {
        // Swallow transient DB/network errors — the next tick will retry
      } finally {
        randomMatchTickRunning = false;
      }
    }, 3000);
  }
};

export const stopLegacyBackgroundJobs = (): void => {
  if (randomMatchTimer) clearInterval(randomMatchTimer);
  randomMatchTimer = null;
  randomMatchTickRunning = false;
  randomMatchLoopStarted = false;
};
