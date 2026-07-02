import { createServer } from "http";
import { createApp } from "./app";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { connectMongo } from "./infrastructure/database/mongodb";
import { connectRedis, disconnectRedis, redisCacheClient } from "./infrastructure/cache/redis";
import { attachSocketRedisAdapter, createSocketServer } from "./infrastructure/websocket/socket";
import {
  enqueueEmail,
  enqueueBulkNotifications,
  enqueuePushReceipts,
  enqueuePushSend,
  enqueueBroadcast,
  enqueueBroadcastReceipts,
  removeBroadcastJobs,
  startBroadcastScheduler,
  stopBroadcastScheduler
} from "./infrastructure/jobs/queue";
import path from "path";
import { backendControllerPath, backendRootPath } from "./modules/legacy/legacy.paths";
import { startLegacyBackgroundJobs } from "./modules/legacy/legacy.socket";

const safeRequire = <T>(modulePath: string): T | null => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(modulePath) as T;
  } catch (_error) {
    return null;
  }
};

const bootstrap = async () => {
  if (env.NODE_ENV === "production") {
    const apnsPreflight = safeRequire<{ assertConfigured?: () => unknown }>(
      path.join(backendRootPath, "services", "apnsVoipPushService.js")
    );
    if (!apnsPreflight?.assertConfigured) {
      throw new Error("APNs VoIP provider preflight is unavailable");
    }
    apnsPreflight.assertConfigured();
    logger.info("Push provider startup preflight passed", { standard: "expo", incomingCalls: "apns_voip" });
  }

  await connectMongo();
  try {
    await connectRedis();
  } catch (redisErr) {
    logger.warn("Redis unavailable — caching disabled for this session", { error: String(redisErr) });
  }

  // Inject shared Redis client into legacy JS bridge
  const redisCache = safeRequire<{ setRedisClient?: (client: unknown) => void }>(
    path.join(backendRootPath, "utils", "redisCache.js")
  );
  redisCache?.setRedisClient?.(redisCacheClient);

  // Inject BullMQ job queue functions into legacy JS bridge
  const jobQueue = safeRequire<{ setQueueFunctions?: (fns: unknown) => void }>(
    path.join(backendRootPath, "utils", "jobQueue.js")
  );
  jobQueue?.setQueueFunctions?.({
    enqueueEmail,
    enqueueBulkNotifications,
    enqueuePushReceipts,
    enqueuePushSend,
    enqueueBroadcast,
    enqueueBroadcastReceipts,
    removeBroadcastJobs
  });
  startBroadcastScheduler();

  const app = createApp();
  const httpServer = createServer(app);
  const io = createSocketServer(httpServer);
  attachSocketRedisAdapter(io);
  app.set("io", io);

  const notificationEmitter = safeRequire<{ setIoInstance?: (ioServer: unknown) => void }>(
    path.join(backendRootPath, "utils", "notificationEmitter.js")
  );
  notificationEmitter?.setIoInstance?.(io);

  const messageController = safeRequire<{ setIoInstance?: (ioServer: unknown) => void }>(
    path.join(backendControllerPath, "messageController.js")
  );
  messageController?.setIoInstance?.(io);

  const callSessionService = safeRequire<{
    startCallSessionSweeper?: () => void;
    stopCallSessionSweeper?: () => void;
  }>(path.join(backendRootPath, "services", "callSessionService.js"));
  callSessionService?.startCallSessionSweeper?.();
  const apnsVoipPushService = safeRequire<{
    startApnsVoipPushSweeper?: () => void;
    stopApnsVoipPushSweeper?: () => void;
  }>(path.join(backendRootPath, "services", "apnsVoipPushService.js"));
  apnsVoipPushService?.startApnsVoipPushSweeper?.();

  startLegacyBackgroundJobs(io);

  const payoutCron = safeRequire<{ startPayoutCrons?: () => void }>(path.join(backendRootPath, "jobs", "payoutCron.js"));
  payoutCron?.startPayoutCrons?.();

  const boostDeliveryCron = safeRequire<{ startBoostDeliveryCron?: () => void }>(
    path.join(backendRootPath, "jobs", "boostDeliveryCron.js")
  );
  boostDeliveryCron?.startBoostDeliveryCron?.();

  const premiumMembershipCron = safeRequire<{
    startPremiumMembershipCron?: () => void;
    stopPremiumMembershipCron?: () => void;
  }>(path.join(backendRootPath, "jobs", "premiumMembershipCron.js"));
  premiumMembershipCron?.startPremiumMembershipCron?.();

  httpServer.listen(env.PORT, () => {
    logger.info("Server started", {
      port: env.PORT,
      environment: env.NODE_ENV
    });
  });

  // ── Graceful shutdown (critical for ECS Fargate rolling deploys) ──
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — starting graceful shutdown`);

    // 1. Stop accepting new connections
    httpServer.close(() => {
      logger.info("HTTP server closed");
    });

    // 2. Close Socket.IO connections
    io.close();

    // 3. Close BullMQ workers
    try {
      stopBroadcastScheduler();
      callSessionService?.stopCallSessionSweeper?.();
      apnsVoipPushService?.stopApnsVoipPushSweeper?.();
      premiumMembershipCron?.stopPremiumMembershipCron?.();
      const { emailWorker, notificationWorker, broadcastWorker } = await import("./infrastructure/jobs/queue");
      await Promise.allSettled([emailWorker.close(), notificationWorker.close(), broadcastWorker.close()]);
    } catch { /* queue may not be initialized */ }

    // 4. Disconnect Redis + Mongo
    try {
      const mongoose = await import("mongoose");
      await mongoose.default.disconnect();
      await disconnectRedis();
    } catch { /* best effort */ }

    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

bootstrap().catch((error) => {
  logger.error("Fatal bootstrap failure", { error: String(error) });
  process.exit(1);
});
