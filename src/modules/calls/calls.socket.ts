import type { Server, Socket } from "socket.io";
import { logger } from "../../config/logger";

/**
 * Compatibility export only.
 *
 * Direct client-supplied `call:*` relays used to live here and trusted a
 * targetUserId/callerId from the payload. That allowed an authenticated socket
 * to signal arbitrary users without a durable CallSession or privacy check.
 * Production signaling is registered exclusively by legacy.socket.ts, which
 * proves both participants and revalidates block/account privacy for every
 * accept and signal operation.
 */
export const registerCallSocketHandlers = (_io: Server, socket: Socket): void => {
  logger.warn("Deprecated call socket bridge was not registered", {
    socketId: socket.id,
    userId: socket.authUser?.userId || ""
  });
};
