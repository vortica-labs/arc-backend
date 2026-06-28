import { createServer } from "http";
import { createApp } from "./app";
import { env } from "./config/env";
import { logger } from "./config/logger";
import { loadSecretsManagerEnv } from "./config/secrets";
import { connectMongo } from "./infrastructure/database/mongodb";
import { connectRedis, redisCacheClient } from "./infrastructure/cache/redis";
import { createSocketServer } from "./infrastructure/websocket/socket";
import { enqueueEmail, enqueueBulkNotifications } from "./infrastructure/jobs/queue";
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
  // Load secrets from AWS Secrets Manager into process.env before anything else
  await loadSecretsManagerEnv();

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
  jobQueue?.setQueueFunctions?.({ enqueueEmail, enqueueBulkNotifications });

  const app = createApp();
  const httpServer = createServer(app);
  const io = createSocketServer(httpServer);
  app.set("io", io);

  const notificationEmitter = safeRequire<{ setIoInstance?: (ioServer: unknown) => void }>(
    path.join(backendRootPath, "utils", "notificationEmitter.js")
  );
  notificationEmitter?.setIoInstance?.(io);

  const messageController = safeRequire<{ setIoInstance?: (ioServer: unknown) => void }>(
    path.join(backendControllerPath, "messageController.js")
  );
  messageController?.setIoInstance?.(io);

  startLegacyBackgroundJobs(io);

  const payoutCron = safeRequire<{ startPayoutCrons?: () => void }>(path.join(backendRootPath, "jobs", "payoutCron.js"));
  payoutCron?.startPayoutCrons?.();

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
      const { emailWorker, notificationWorker } = await import("./infrastructure/jobs/queue");
      await Promise.allSettled([emailWorker.close(), notificationWorker.close()]);
    } catch { /* queue may not be initialized */ }

    // 4. Disconnect Redis + Mongo
    try {
      const mongoose = await import("mongoose");
      await mongoose.default.disconnect();
      await redisCacheClient?.quit?.();
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
