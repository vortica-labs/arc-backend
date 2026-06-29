import { Queue, Worker, type Job } from "bullmq";
import { env } from "../../config/env";
import { logger } from "../../config/logger";

// ── Queue names ────────────────────────────────────────────────────────────
export const QUEUE_NAMES = {
  EMAIL: "email",
  NOTIFICATION: "notification"
} as const;

// ── Connection config — BullMQ uses ioredis format (flat host/port, not node-redis socket object) ──
const connection = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  username: env.REDIS_USERNAME,
  password: env.REDIS_PASSWORD,
  maxRetriesPerRequest: null // required by BullMQ for blocking commands
};

// ── Queues ─────────────────────────────────────────────────────────────────
export const emailQueue = new Queue(QUEUE_NAMES.EMAIL, { connection });
export const notificationQueue = new Queue(QUEUE_NAMES.NOTIFICATION, { connection });

// ── Email Worker ───────────────────────────────────────────────────────────
export const emailWorker = new Worker(
  QUEUE_NAMES.EMAIL,
  async (job: Job) => {
    const { to, subject, text, html, link } = job.data;
    try {
      // Dynamic import to avoid loading nodemailer at module scope
      const path = require("path");
      const legacyRoot = path.resolve(__dirname, "..", "..", "legacy-src");
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const emailUtil = require(path.join(legacyRoot, "utils", "email.js"));

      if (emailUtil?.sendNotificationEmail) {
        await emailUtil.sendNotificationEmail(to, subject, text, link);
      } else if (emailUtil?.sendEmail) {
        await emailUtil.sendEmail({ to, subject, text, html });
      }

      logger.info("Email sent via worker", { to, subject });
    } catch (error) {
      logger.error("Email worker failed", { error: String(error), to, subject });
      throw error; // let BullMQ retry
    }
  },
  {
    connection,
    concurrency: 3,
    limiter: { max: 10, duration: 1000 } // max 10 emails/sec
  }
);

// ── Notification Worker ────────────────────────────────────────────────────
export const notificationWorker = new Worker(
  QUEUE_NAMES.NOTIFICATION,
  async (job: Job) => {
    const { recipientIds, title, message, type, data } = job.data;
    try {
      const path = require("path");
      const legacyRoot = path.resolve(__dirname, "..", "..", "legacy-src");
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Notification = require(path.join(legacyRoot, "models", "Notification.js"));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { sendBulkPushNotification } = require(path.join(legacyRoot, "utils", "pushNotificationService.js"));

      // Batch insert
      const docs = (recipientIds as string[]).map((recipientId: string) => ({
        insertOne: {
          document: {
            recipient: recipientId,
            type: type || "system",
            title,
            message,
            data: data || {},
            isRead: false,
            createdAt: new Date(),
            updatedAt: new Date()
          }
        }
      }));

      if (docs.length > 0) {
        await Notification.bulkWrite(docs, { ordered: false });
        await sendBulkPushNotification(recipientIds, {
          type: type || "system",
          title,
          message,
          data: data || {}
        });
      }

      logger.info("Bulk notifications created", { count: recipientIds.length, type });
    } catch (error) {
      logger.error("Notification worker failed", { error: String(error) });
      throw error;
    }
  },
  {
    connection,
    concurrency: 2
  }
);

// ── Convenience helpers for legacy JS ──────────────────────────────────────
/**
 * Enqueue an email to be sent in the background.
 */
export const enqueueEmail = async (
  to: string,
  subject: string,
  text: string,
  link?: string
): Promise<void> => {
  await emailQueue.add("send", { to, subject, text, link }, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 500
  });
};

/**
 * Enqueue bulk notifications to be created in the background.
 */
export const enqueueBulkNotifications = async (
  recipientIds: string[],
  title: string,
  message: string,
  type?: string,
  data?: Record<string, unknown>
): Promise<void> => {
  // Split into batches of 500
  const BATCH = 500;
  for (let i = 0; i < recipientIds.length; i += BATCH) {
    const slice = recipientIds.slice(i, i + BATCH);
    await notificationQueue.add("bulk", {
      recipientIds: slice,
      title,
      message,
      type,
      data
    }, {
      attempts: 3,
      backoff: { type: "exponential", delay: 3000 },
      removeOnComplete: 50,
      removeOnFail: 200
    });
  }
};

// ── Graceful error handling ───────────────────────────────────────────────
emailWorker.on("failed", (job, err) => {
  logger.error("Email job failed", { jobId: job?.id, error: String(err) });
});

notificationWorker.on("failed", (job, err) => {
  logger.error("Notification job failed", { jobId: job?.id, error: String(err) });
});
