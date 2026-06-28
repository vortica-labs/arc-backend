import type { Server, Socket } from "socket.io";
import path from "path";
import { backendControllerPath, backendModelPath } from "./legacy.paths";

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

const activeCalls = new Map<string, ActiveCallSession>();
let randomMatchLoopStarted = false;

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

  socket.on("call-request", (data: { callId?: string; targetUserId?: string; callType?: "voice" | "video"; fromUsername?: string; fromDisplayName?: string; fromAvatar?: string; randomRoomId?: string }) => {
    if (!data?.callId || !data?.targetUserId || !data?.callType) {
      return;
    }
    io.to(`user-${String(data.targetUserId)}`).emit("call-request", {
      callId: data.callId,
      fromUserId: userIdStr,
      callType: data.callType,
      fromUsername: data.fromUsername,
      fromDisplayName: data.fromDisplayName,
      fromAvatar: data.fromAvatar,
      randomRoomId: data.randomRoomId,
    });
  });

  for (const eventName of ["call-accept", "call-reject", "call-end"] as const) {
    socket.on(eventName, (data: { callId?: string; targetUserId?: string }) => {
      if (!data?.callId || !data?.targetUserId) {
        return;
      }
      io.to(`user-${String(data.targetUserId)}`).emit(eventName, {
        callId: data.callId,
        fromUserId: userIdStr
      });
    });
  }

  socket.on("call-signal", (data: { callId?: string; targetUserId?: string; signal?: unknown }) => {
    if (!data?.callId || !data?.targetUserId || !data?.signal) {
      return;
    }
    io.to(`user-${String(data.targetUserId)}`).emit("call-signal", {
      callId: data.callId,
      fromUserId: userIdStr,
      signal: data.signal
    });
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
