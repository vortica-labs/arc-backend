import type { Server as HttpServer } from "http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import jwt from "jsonwebtoken";
import path from "path";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { registerChatSocketHandlers } from "../../modules/chat/chat.socket";
import { registerLegacySocketHandlers } from "../../modules/legacy/legacy.socket";
import { backendMiddlewarePath } from "../../modules/legacy/legacy.paths";
import { socketRedisPubClient, socketRedisSubClient } from "../cache/redis";
import {
  announcePresenceConnected,
  announcePresenceDisconnected,
  registerPresenceSocketHandlers
} from "../../modules/presence/presence.socket";

type SocketAuthUser = {
  isActive?: boolean;
  needsProfileCompletion?: boolean;
};

type LegacyAuthMiddleware = {
  getCachedUser: (userId: string) => Promise<SocketAuthUser | null>;
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getCachedUser } = require(path.join(backendMiddlewarePath, "auth.js")) as LegacyAuthMiddleware;

export type AuthSocketUser = {
  userId: string;
};

declare module "socket.io" {
  interface Socket {
    authUser?: AuthSocketUser;
  }
}

export const createSocketServer = (httpServer: HttpServer): Server => {
  const allowedOrigins = env.CORS_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean);
  const io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
      methods: ["GET", "POST"]
    },
    transports: ["polling", "websocket"],
    allowUpgrades: true,
    pingTimeout: 60000,
    pingInterval: 25000,
    upgradeTimeout: 30000,
    maxHttpBufferSize: 1e6
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token as string | undefined;
      if (!token) {
        return next(new Error("Authentication token is required"));
      }

      const decoded = jwt.verify(token, env.JWT_SECRET) as { id?: string; userId?: string };
      const userId = decoded.id ?? decoded.userId;
      if (!userId) {
        return next(new Error("Invalid token payload"));
      }

      const user = await getCachedUser(String(userId));
      if (!user || !user.isActive) {
        return next(new Error("User account is deactivated or not found"));
      }
      if (user.needsProfileCompletion === true) {
        return next(new Error("PROFILE_COMPLETION_REQUIRED"));
      }

      socket.authUser = { userId: String(userId) };
      // socket.data is serialized by Socket.IO adapters/fetchSockets. Keep the
      // authenticated identity there as well so cross-node room revocation can
      // never depend on a client-supplied identifier.
      socket.data.userId = String(userId);
      return next();
    } catch (error) {
      return next(new Error(`Authentication failed: ${String(error)}`));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.authUser?.userId;
    if (!userId) {
      socket.disconnect();
      return;
    }

    socket.join(`user-${userId}`);
    socket.on("join-user-room", (incomingUserId: string) => {
      if (String(incomingUserId) !== String(userId)) {
        logger.warn("Rejected socket user-room join for another user", {
          socketId: socket.id,
          authenticatedUserId: userId,
          requestedUserId: String(incomingUserId)
        });
        return;
      }
      socket.join(`user-${userId}`);
    });

    socket.on("ping", () => socket.emit("pong"));
    registerChatSocketHandlers(io, socket);
    registerPresenceSocketHandlers(io, socket);
    // Calls are registered only by the durable legacy bridge below. The old
    // colon-event relay accepted client-supplied target IDs without proving
    // CallSession participation and must never be mounted in parallel.
    registerLegacySocketHandlers(io, socket);

    void announcePresenceConnected(io, userId).catch((error) => {
      logger.error("Failed to publish online presence", { userId, socketId: socket.id, error: String(error) });
    });
    socket.on("disconnect", () => {
      void announcePresenceDisconnected(io, userId).catch((error) => {
        logger.error("Failed to publish offline presence", { userId, socketId: socket.id, error: String(error) });
      });
    });

    logger.info("Socket connected", { socketId: socket.id, userId });
  });

  // Store IO instance globally for call controller access
  (globalThis as Record<string, unknown>)._arcSocketIO = io;

  return io;
};

export const attachSocketRedisAdapter = (io: Server): boolean => {
  if (!socketRedisPubClient.isReady || !socketRedisSubClient.isReady) {
    logger.warn("Socket.IO Redis adapter unavailable; realtime delivery is limited to this instance");
    return false;
  }
  io.adapter(createAdapter(socketRedisPubClient, socketRedisSubClient));
  logger.info("Socket.IO Redis adapter attached");
  return true;
};
