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

  socket.on("join-random-room", (roomId: string) => {
    if (!roomId) {
      return;
    }
    const room = `random-room-${String(roomId)}`;
    socket.join(room);
    socket.emit("room-joined", { roomId: String(roomId) });
    socket.to(room).emit("user-joined-room", { roomId: String(roomId), userId: userIdStr });
  });

  socket.on("leave-random-room", (roomId: string) => {
    if (roomId) {
      socket.leave(`random-room-${String(roomId)}`);
    }
  });

  socket.on("random-connection-message", (data: { roomId?: string; message?: string }) => {
    if (!data?.roomId || !data?.message) {
      return;
    }
    socket.to(`random-room-${data.roomId}`).emit("random-connection-message", {
      roomId: data.roomId,
      sender: userIdStr,
      message: data.message,
      timestamp: new Date()
    });
  });

  socket.on("webrtc-signal", (data: { roomId?: string; signal?: unknown; targetUserId?: string }) => {
    if (!data?.roomId || !data?.signal || !data?.targetUserId) {
      return;
    }
    io.to(`user-${String(data.targetUserId)}`).emit("webrtc-signal", {
      signal: data.signal,
      fromUserId: userIdStr,
      roomId: data.roomId
    });
  });

  socket.on("webrtc-request-offer", (data: { roomId?: string; targetUserId?: string }) => {
    if (!data?.roomId || !data?.targetUserId) {
      return;
    }
    io.to(`user-${String(data.targetUserId)}`).emit("webrtc-request-offer", {
      roomId: data.roomId,
      fromUserId: userIdStr
    });
  });

  socket.on("video-state-change", (data: { roomId?: string; videoEnabled?: boolean; targetUserId?: string }) => {
    if (!data?.roomId || !data?.targetUserId) {
      return;
    }
    io.to(`user-${String(data.targetUserId)}`).emit("video-state-change", {
      fromUserId: userIdStr,
      videoEnabled: data.videoEnabled
    });
  });

  socket.on("media-state", (data: { roomId?: string; targetUserId?: string; video?: boolean; audio?: boolean }) => {
    if (!data?.roomId || !data?.targetUserId) {
      return;
    }
    io.to(`user-${String(data.targetUserId)}`).emit("media-state", {
      fromUserId: userIdStr,
      video: data.video,
      audio: data.audio
    });
  });

  socket.on("call-request", (data: { callId?: string; targetUserId?: string; callType?: "voice" | "video" }) => {
    if (!data?.callId || !data?.targetUserId || !data?.callType) {
      return;
    }
    io.to(`user-${String(data.targetUserId)}`).emit("call-request", {
      callId: data.callId,
      fromUserId: userIdStr,
      callType: data.callType
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
      await randomConnectController.matchUsersFromQueue?.(io);
    }, 3000);
  }
};
