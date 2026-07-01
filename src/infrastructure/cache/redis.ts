import { createClient } from "redis";
import { env } from "../../config/env";
import { logger } from "../../config/logger";

const reconnectStrategy = (retries: number): number | Error => {
  // Stop retrying after 10 attempts; otherwise exponential backoff capped at 5 s
  if (retries > 10) return new Error("Redis max retries reached");
  return Math.min(retries * 200, 5000);
};

const redisConfig = {
  ...(env.REDIS_USERNAME ? { username: env.REDIS_USERNAME } : {}),
  ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
  socket: {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    // ElastiCache requires TLS; toggle via REDIS_TLS=true
    tls: env.REDIS_TLS ?? false,
    reconnectStrategy,
    connectTimeout: 10000,
  },
};

export const redisPubClient = createClient(redisConfig);
export const redisSubClient = redisPubClient.duplicate();
export const redisCacheClient = redisPubClient.duplicate();
// Socket.IO requires dedicated pub/sub connections. They cannot share the
// subscriber used by application cache invalidation because Redis subscriber
// mode has isolated channel ownership and lifecycle.
export const socketRedisPubClient = redisPubClient.duplicate();
export const socketRedisSubClient = redisPubClient.duplicate();

// Deduplicate noisy startup errors — only log once per client until it connects
const registerRedisLogging = (name: string, client: ReturnType<typeof createClient>) => {
  let connected = false;
  let errorCount = 0;
  client.on("error", (error) => {
    if (connected) {
      // Post-connect errors are always worth logging
      logger.error(`${name} redis error`, { error: String(error) });
    } else if (errorCount === 0) {
      // Log the first startup failure only
      logger.error(`${name} redis error`, { error: String(error) });
    }
    errorCount++;
  });
  client.on("connect", () => {
    connected = true;
    errorCount = 0;
    logger.info(`${name} redis connected`);
  });
};

registerRedisLogging("pub", redisPubClient);
registerRedisLogging("sub", redisSubClient);
registerRedisLogging("cache", redisCacheClient);
registerRedisLogging("socket-pub", socketRedisPubClient);
registerRedisLogging("socket-sub", socketRedisSubClient);

export const connectRedis = async (): Promise<void> => {
  await Promise.all([
    redisPubClient.connect(),
    redisSubClient.connect(),
    redisCacheClient.connect(),
    socketRedisPubClient.connect(),
    socketRedisSubClient.connect()
  ]);
};

export const disconnectRedis = async (): Promise<void> => {
  const clients = [
    socketRedisSubClient,
    socketRedisPubClient,
    redisSubClient,
    redisPubClient,
    redisCacheClient
  ];
  await Promise.allSettled(clients.map(async (client) => {
    if (client.isOpen) await client.quit();
  }));
};
