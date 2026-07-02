import { Queue, Worker, type Job } from "bullmq";
import { createHash, randomUUID } from "crypto";
import path from "path";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { backendRootPath } from "../../modules/legacy/legacy.paths";

// ── Queue names ────────────────────────────────────────────────────────────
export const QUEUE_NAMES = {
  EMAIL: "email",
  NOTIFICATION: "notification",
  BROADCAST: "broadcast"
} as const;

// ── Connection config — BullMQ uses ioredis format (flat host/port, not node-redis socket object) ──
const connection = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  username: env.REDIS_USERNAME,
  password: env.REDIS_PASSWORD,
  maxRetriesPerRequest: null, // required by BullMQ for blocking commands
  ...(env.REDIS_TLS ? { tls: {} } : {})
};
const BROADCAST_SEND_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.EXPO_BROADCAST_SEND_MAX_ATTEMPTS || 12)
);

// ── Queues ─────────────────────────────────────────────────────────────────
export const emailQueue = new Queue(QUEUE_NAMES.EMAIL, { connection });
export const notificationQueue = new Queue(QUEUE_NAMES.NOTIFICATION, { connection });
export const broadcastQueue = new Queue(QUEUE_NAMES.BROADCAST, { connection });

export type EmailDeliveryContext = {
  intent: string;
  eventType: string;
  notificationType?: string;
  templateKey?: string;
  triggerSource?: string;
  producerStack?: string;
};

type EmailPolicyResult = {
  allowed: boolean;
  intent?: string;
  eventType?: string;
  routineEventType?: string | null;
  reason: string;
};

type EmailPolicyModule = {
  evaluateEmailPolicy: (context?: Partial<EmailDeliveryContext>) => EmailPolicyResult;
};

type EmailAuditModule = {
  captureEmailCallStack: () => string;
  inferEmailTriggerSource: (stack?: string) => string;
  buildEmailAuditContext: (input: Record<string, unknown>) => Record<string, unknown>;
  sanitizeEmailAuditError: (error: unknown) => string;
};

// Load every legacy dependency from the canonical source tree. The compiled
// worker previously resolved dist/legacy-src while HTTP routes resolved
// src/legacy-src, allowing stale build artifacts to enforce a different email
// policy from the request process.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const emailPolicy = require(path.join(backendRootPath, "utils", "notificationChannelPolicy.js")) as EmailPolicyModule;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const emailAudit = require(path.join(backendRootPath, "utils", "emailAudit.js")) as EmailAuditModule;

// ── Email Worker ───────────────────────────────────────────────────────────
export const emailWorker = new Worker(
  QUEUE_NAMES.EMAIL,
  async (job: Job) => {
    const { to, subject, text, link, context } = job.data;
    const policy = emailPolicy.evaluateEmailPolicy(context || {});
    const audit = emailAudit.buildEmailAuditContext({
      to,
      intent: policy.intent || context?.intent,
      eventType: policy.eventType || context?.eventType,
      notificationType: context?.notificationType,
      templateKey: context?.templateKey,
      triggerSource: context?.triggerSource || "bullmq.email_worker",
      producerStack: context?.producerStack
    });
    if (!policy.allowed) {
      logger.info("Email job suppressed by channel policy", {
        jobId: String(job.id || ""),
        ...audit,
        reason: policy.reason,
        routineEventType: policy.routineEventType || ""
      });
      return { suppressed: true, reason: policy.reason };
    }
    const workerContext = {
      ...(context || {}),
      intent: policy.intent,
      eventType: policy.eventType,
      triggerSource: context?.triggerSource || "bullmq.email_worker"
    };
    try {
      // Dynamic import to avoid loading nodemailer at module scope
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const emailUtil = require(path.join(backendRootPath, "utils", "email.js"));

      if (!emailUtil?.sendNotificationEmail) {
        throw new Error("Policy-aware email dispatcher is unavailable");
      }
      const result = await emailUtil.sendNotificationEmail(to, subject, text, link, workerContext);
      if (result?.blocked) {
        logger.info("Email job suppressed by channel policy", {
          jobId: String(job.id || ""),
          ...audit,
          reason: result.reason || "policy_blocked"
        });
        return { suppressed: true, reason: result.reason || "policy_blocked" };
      }
      if (!result?.sent) throw new Error(result?.error || "Email transport did not confirm delivery");

      logger.info("Email sent via worker", { jobId: String(job.id || ""), ...audit });
      return { sent: true, messageId: result.messageId };
    } catch (error) {
      logger.error("Email worker failed", {
        jobId: String(job.id || ""),
        ...audit,
        error: emailAudit.sanitizeEmailAuditError(error)
      });
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
    try {
      if (job.name === "push-send") {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pushService = require(path.join(backendRootPath, "utils", "pushNotificationService.js"));
        return pushService.retryPushDeliveryAttempts(job.data.attemptIds);
      }
      if (job.name === "push-receipts") {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pushService = require(path.join(backendRootPath, "utils", "pushNotificationService.js"));
        const result = await pushService.reconcilePushDeliveryReceipts(
          job.data.attemptIds,
          String(job.id || "")
        );
        if (result?.pendingRecordIds?.length) {
          await enqueuePushReceipts(
            result.pendingRecordIds,
            result.nextRunAt || new Date(Date.now() + 60000),
            `retry-${Math.floor(new Date(result.nextRunAt || Date.now() + 60000).getTime() / 1000)}`
          );
        }
        if (result?.retryRecordIds?.length) {
          await enqueuePushSend(
            result.retryRecordIds,
            result.nextSendAt || new Date(Date.now() + 10000),
            `receipt-resend-${Math.floor(new Date(result.nextSendAt || Date.now() + 10000).getTime() / 1000)}`
          );
        }
        return result;
      }
      if (job.name !== "bulk") throw new Error(`Unknown notification job: ${job.name}`);
      const { recipientIds, title, message, type, data, deliveryKey } = job.data;
      const effectiveDeliveryKey = String(deliveryKey || job.id || randomUUID()).trim().slice(0, 250);
      // Route bulk fan-out through the same preference-aware producer used by
      // individual events. The stable delivery key makes BullMQ retries safe:
      // in-app rows are deduplicated and push attempts reuse one request key.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createAndEmitNotification } = require(path.join(backendRootPath, "utils", "notificationEmitter.js"));
      const failures: Array<{ recipientId: string; reason: string }> = [];
      let delivered = 0;
      const ids = Array.from(new Set((recipientIds as string[]).map(String).filter(Boolean)));
      const customData = data?.customData && typeof data.customData === "object" && !Array.isArray(data.customData)
        ? data.customData
        : {};

      for (let index = 0; index < ids.length; index += 50) {
        const slice = ids.slice(index, index + 50);
        const results = await Promise.allSettled(slice.map((recipientId: string) =>
          createAndEmitNotification({
            recipient: recipientId,
            type: type || "system",
            title,
            message,
            data: {
              ...(data || {}),
              customData: {
                ...customData,
                notificationDedupeKey: effectiveDeliveryKey,
                pushRequestId: effectiveDeliveryKey,
                pushSource: "bulk"
              }
            }
          })
        ));
        results.forEach((result, resultIndex) => {
          if (result.status === "rejected") {
            failures.push({ recipientId: slice[resultIndex], reason: String(result.reason) });
          } else if (result.value) {
            delivered += 1;
          }
        });
      }

      if (failures.length > 0) {
        logger.error("Bulk notification delivery had producer failures", {
          failures: failures.length,
          count: ids.length,
          type,
          recipients: failures.slice(0, 20).map((entry) => entry.recipientId)
        });
        throw new AggregateError(
          failures.map((entry) => new Error(`${entry.recipientId}: ${entry.reason}`)),
          `${failures.length} bulk notification deliveries failed`
        );
      }

      logger.info("Bulk notifications processed", { count: ids.length, delivered, type, deliveryKey: effectiveDeliveryKey });
    } catch (error) {
      logger.error("Notification worker failed", { error: String(error) });
      throw error;
    }
  },
  {
    connection,
    concurrency: env.PUSH_WORKER_CONCURRENCY
  }
);

type BroadcastService = {
  processBroadcastDispatch: (
    data: { broadcastId: string; occurrenceKey: string; runAt: string; workerJobId?: string },
    enqueueChunk: (broadcastId: string, occurrenceKey: string, chunkIndex: number, recipientIds: string[]) => Promise<void>
  ) => Promise<unknown>;
  processBroadcastChunk: (data: {
    broadcastId: string;
    occurrenceKey: string;
    chunkIndex: number;
    recipientIds: string[];
    workerJobId?: string;
  }) => Promise<unknown>;
  processBroadcastPushReceipts: (data: {
    receiptRecordIds: string[];
    workerJobId?: string;
  }) => Promise<unknown>;
  reconcileTerminalPushReceipts: (recipientLogIds: string[]) => Promise<unknown>;
  expireUnacknowledgedWebPushes: (limit?: number) => Promise<unknown>;
  reconcileDirtyBroadcastMetrics: (limit?: number) => Promise<unknown>;
  reconcileAcknowledgedNotificationFailures: (limit?: number) => Promise<unknown>;
  markBroadcastWorkerFailure: (
    data: { broadcastId: string; occurrenceKey: string; chunkIndex?: number; jobName?: string },
    error: Error
  ) => Promise<void>;
};

const loadBroadcastService = (): BroadcastService => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(path.join(backendRootPath, "services", "broadcastService.js")) as BroadcastService;
};

const broadcastJobId = (...parts: Array<string | number>): string =>
  parts.join("-").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 220);

const enqueueBroadcastChunk = async (
  broadcastId: string,
  occurrenceKey: string,
  chunkIndex: number,
  recipientIds: string[]
): Promise<void> => {
  await broadcastQueue.add(
    "deliver-chunk",
    { broadcastId, occurrenceKey, chunkIndex, recipientIds },
    {
      jobId: broadcastJobId("broadcast-chunk", broadcastId, occurrenceKey, chunkIndex),
      attempts: BROADCAST_SEND_MAX_ATTEMPTS,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 2000,
      removeOnFail: 5000
    }
  );
};

export const broadcastWorker = new Worker(
  QUEUE_NAMES.BROADCAST,
  async (job: Job) => {
    const service = loadBroadcastService();
    if (job.name === "dispatch") {
      return service.processBroadcastDispatch({ ...job.data, workerJobId: String(job.id || "") }, enqueueBroadcastChunk);
    }
    if (job.name === "deliver-chunk") {
      return service.processBroadcastChunk({ ...job.data, workerJobId: String(job.id || "") });
    }
    if (job.name === "reconcile-receipts") {
      return service.processBroadcastPushReceipts({ ...job.data, workerJobId: String(job.id || "") });
    }
    throw new Error(`Unknown broadcast job: ${job.name}`);
  },
  {
    connection,
    concurrency: Math.max(1, Math.min(20, Number(process.env.BROADCAST_WORKER_CONCURRENCY || 5))),
    limiter: {
      // 100-recipient chunks can expand to multiple device tokens. Three jobs
      // per second leaves headroom below Expo's project send-rate ceiling for
      // the common one-to-two-device case; deployments may tune this explicitly.
      max: Math.max(1, Number(process.env.BROADCAST_JOBS_PER_SECOND || 3)),
      duration: 1000
    },
    lockDuration: 120000
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
  link?: string,
  context?: EmailDeliveryContext
): Promise<{ queued: boolean; blocked: boolean; reason?: string }> => {
  const producerStack = context?.producerStack || emailAudit.captureEmailCallStack();
  const typedContext = {
    ...(context || {}),
    producerStack,
    triggerSource: context?.triggerSource || emailAudit.inferEmailTriggerSource(producerStack)
  };
  const policy = emailPolicy.evaluateEmailPolicy(typedContext);
  const audit = emailAudit.buildEmailAuditContext({
    to,
    intent: policy.intent || typedContext.intent,
    eventType: policy.eventType || typedContext.eventType,
    notificationType: typedContext.notificationType,
    templateKey: typedContext.templateKey,
    triggerSource: typedContext.triggerSource,
    producerStack
  });
  if (!policy.allowed) {
    logger.info("Email queue submission suppressed by channel policy", {
      ...audit,
      reason: policy.reason,
      routineEventType: policy.routineEventType || ""
    });
    return { queued: false, blocked: true, reason: policy.reason };
  }
  await emailQueue.add("send", { to, subject, text, link, context: typedContext }, {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 500
  });
  logger.info("Email queued", audit);
  return { queued: true, blocked: false };
};

/**
 * Enqueue bulk notifications to be created in the background.
 */
export const enqueueBulkNotifications = async (
  recipientIds: string[],
  title: string,
  message: string,
  type?: string,
  data?: Record<string, unknown>,
  deliveryKey?: string
): Promise<void> => {
  const stableDeliveryKey = String(deliveryKey || randomUUID()).trim().slice(0, 250);
  // Split into batches of 500
  const BATCH = 500;
  for (let i = 0; i < recipientIds.length; i += BATCH) {
    const slice = recipientIds.slice(i, i + BATCH);
    const recipientDigest = createHash("sha256")
      .update(slice.map(String).sort().join(","))
      .digest("hex")
      .slice(0, 20);
    await notificationQueue.add("bulk", {
      recipientIds: slice,
      title,
      message,
      type,
      data,
      deliveryKey: stableDeliveryKey
    }, {
      jobId: broadcastJobId("bulk", createHash("sha256").update(stableDeliveryKey).digest("hex").slice(0, 20), recipientDigest),
      attempts: 3,
      backoff: { type: "exponential", delay: 3000 },
      removeOnComplete: 50,
      removeOnFail: 200
    });
  }
};

export const enqueuePushReceipts = async (
  attemptIds: string[],
  runAt: Date | string,
  reconciliationKey = "primary"
): Promise<void> => {
  const ids = Array.from(new Set((attemptIds || []).map(String).filter(Boolean))).sort();
  if (!ids.length) return;
  const scheduledAt = new Date(runAt);
  if (Number.isNaN(scheduledAt.getTime())) throw new Error("Invalid push receipt run time");
  const digest = createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 24);
  await notificationQueue.add(
    "push-receipts",
    { attemptIds: ids },
    {
      jobId: broadcastJobId("push-receipts", digest, reconciliationKey),
      delay: Math.max(0, scheduledAt.getTime() - Date.now()),
      attempts: Math.max(1, Number(process.env.EXPO_GENERIC_PUSH_RECEIPT_JOB_ATTEMPTS || 6)),
      backoff: { type: "exponential", delay: 60000 },
      removeOnComplete: 5000,
      removeOnFail: 10000
    }
  );
};

export const enqueuePushSend = async (
  attemptIds: string[],
  runAt: Date | string,
  retryKey = "primary"
): Promise<void> => {
  const ids = Array.from(new Set((attemptIds || []).map(String).filter(Boolean))).sort();
  if (!ids.length) return;
  const scheduledAt = new Date(runAt);
  if (Number.isNaN(scheduledAt.getTime())) throw new Error("Invalid push retry run time");
  const digest = createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 24);
  await notificationQueue.add(
    "push-send",
    { attemptIds: ids },
    {
      jobId: broadcastJobId("push-send", digest, retryKey),
      delay: Math.max(0, scheduledAt.getTime() - Date.now()),
      attempts: 3,
      backoff: { type: "exponential", delay: 3000 },
      removeOnComplete: 5000,
      removeOnFail: 10000
    }
  );
};

export const enqueueBroadcast = async (
  broadcastId: string,
  runAt: Date | string,
  occurrenceKey: string,
  recoveryKey?: string
): Promise<void> => {
  const scheduledAt = new Date(runAt);
  if (Number.isNaN(scheduledAt.getTime())) throw new Error("Invalid broadcast run time");
  const delay = Math.max(0, scheduledAt.getTime() - Date.now());
  await broadcastQueue.add(
    "dispatch",
    { broadcastId, occurrenceKey, runAt: scheduledAt.toISOString() },
    {
      jobId: broadcastJobId("broadcast-dispatch", broadcastId, occurrenceKey, recoveryKey || "primary"),
      delay,
      attempts: 5,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 2000,
      removeOnFail: 5000
    }
  );
};

export const enqueueBroadcastReceipts = async (
  receiptRecordIds: string[],
  runAt: Date | string,
  reconciliationKey = "primary"
): Promise<void> => {
  const ids = Array.from(new Set((receiptRecordIds || []).map(String).filter(Boolean))).sort();
  if (ids.length === 0) return;
  const scheduledAt = new Date(runAt);
  if (Number.isNaN(scheduledAt.getTime())) throw new Error("Invalid broadcast receipt run time");
  const digest = createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 24);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const BroadcastPushReceipt = require(path.join(backendRootPath, "models", "BroadcastPushReceipt.js"));
  const broadcastIds = (await BroadcastPushReceipt.distinct("broadcast", { _id: { $in: ids } })).map(String);
  await broadcastQueue.add(
    "reconcile-receipts",
    { receiptRecordIds: ids, broadcastIds },
    {
      jobId: broadcastJobId("broadcast-receipts", digest, reconciliationKey),
      delay: Math.max(0, scheduledAt.getTime() - Date.now()),
      attempts: 6,
      backoff: { type: "exponential", delay: 60000 },
      removeOnComplete: 5000,
      removeOnFail: 10000
    }
  );
};

export const removeBroadcastJobs = async (broadcastId: string): Promise<void> => {
  const jobs = await broadcastQueue.getJobs([
    "delayed", "waiting", "prioritized", "paused", "completed", "failed"
  ], 0, 4999, true);
  await Promise.allSettled(
    jobs
      .filter((job) =>
        String(job.data?.broadcastId || "") === String(broadcastId) ||
        (Array.isArray(job.data?.broadcastIds) && job.data.broadcastIds.map(String).includes(String(broadcastId)))
      )
      .map((job) => job.remove())
  );
};

let broadcastRecoveryTimer: NodeJS.Timeout | null = null;

const recoverDueBroadcasts = async (): Promise<void> => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Broadcast = require(path.join(backendRootPath, "models", "Broadcast.js"));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const BroadcastPushReceipt = require(path.join(backendRootPath, "models", "BroadcastPushReceipt.js"));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const PushDeliveryAttempt = require(path.join(backendRootPath, "models", "PushDeliveryAttempt.js"));
    const horizon = new Date(Date.now() + 5 * 60 * 1000);
    const staleLease = new Date(Date.now() - 15 * 60 * 1000);

    // Generic push tickets use MongoDB as the durable source of truth too.
    // Recover delayed receipt work after Redis/job loss and terminalize an
    // ambiguous provider submission instead of risking a duplicate resend.
    const expiredGenericSendLeases = await PushDeliveryAttempt.find(
      { ticketStatus: "sending", sendLeaseAt: { $lte: staleLease } }
    ).select("_id requestKey").limit(3000).lean();
    await PushDeliveryAttempt.updateMany(
      {
        _id: { $in: expiredGenericSendLeases.map((attempt: { _id: unknown }) => attempt._id) },
        ticketStatus: "sending",
        sendLeaseAt: { $lte: staleLease }
      },
      {
        $set: {
          ticketStatus: "failed",
          receiptStatus: "failed",
          retryable: false,
          receiptCheckedAt: new Date(),
          providerErrorCode: "SendLeaseExpired",
          providerErrorMessage: "Provider submission outcome was ambiguous after worker interruption"
        },
        $unset: { sendLeaseAt: 1, sendLeaseKey: 1, nextReceiptAt: 1 }
      }
    );
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const genericPushService = require(path.join(backendRootPath, "utils", "pushNotificationService.js"));
    if (expiredGenericSendLeases.length) {
      await genericPushService.refreshPushDeliveryRequests(
        Array.from(new Set(expiredGenericSendLeases.map((attempt: { requestKey: string }) => attempt.requestKey)))
      );
    }
    await genericPushService.recoverPendingNotificationPushes(200);
    await genericPushService.recoverInterruptedPushRequests(200);
    const dueGenericReceipts = await PushDeliveryAttempt.find({
      ticketStatus: "accepted",
      receiptStatus: "pending",
      nextReceiptAt: { $ne: null, $lte: horizon },
      $or: [{ receiptLeaseAt: null }, { receiptLeaseAt: { $lte: staleLease } }]
    }).select("_id nextReceiptAt").sort({ nextReceiptAt: 1, _id: 1 }).limit(3000).lean();
    const retryableGenericSends = await PushDeliveryAttempt.find({
      ticketStatus: { $in: ["queued", "failed"] },
      retryable: true,
      sendAttempts: { $lt: Math.max(1, Number(process.env.EXPO_GENERIC_PUSH_SEND_MAX_ATTEMPTS || 5)) },
      $and: [
        { $or: [{ nextSendAt: null }, { nextSendAt: { $lte: horizon } }] },
        { $or: [{ sendLeaseAt: null }, { sendLeaseAt: { $lte: staleLease } }] }
      ]
    }).select("_id nextSendAt").sort({ nextSendAt: 1, _id: 1 }).limit(3000).lean();
    for (let index = 0; index < retryableGenericSends.length; index += 300) {
      const retryBatch = retryableGenericSends.slice(index, index + 300);
      const runAt = retryBatch.reduce((latest: Date, attempt: { nextSendAt?: Date }) => {
        const date = attempt.nextSendAt ? new Date(attempt.nextSendAt) : new Date();
        return date > latest ? date : latest;
      }, new Date());
      await enqueuePushSend(
        retryBatch.map((attempt: { _id: unknown }) => String(attempt._id)),
        runAt,
        `recovery-${Math.floor(Date.now() / 60000)}-${index / 300}`
      );
    }
    for (let index = 0; index < dueGenericReceipts.length; index += 300) {
      const receiptBatch = dueGenericReceipts.slice(index, index + 300);
      const runAt = receiptBatch.reduce((latest: Date, receipt: { nextReceiptAt?: Date }) => {
        const date = receipt.nextReceiptAt ? new Date(receipt.nextReceiptAt) : new Date();
        return date > latest ? date : latest;
      }, new Date());
      await enqueuePushReceipts(
        receiptBatch.map((receipt: { _id: unknown }) => String(receipt._id)),
        runAt,
        `recovery-${Math.floor(Date.now() / 60000)}-${index / 300}`
      );
    }
    const scheduled = await Broadcast.find({
      $or: [
        { status: "queued" },
        { status: "scheduled", "schedule.nextRunAt": { $ne: null, $lte: horizon } },
        {
          status: "processing",
          $or: [
            { "execution.lockedAt": null },
            { "execution.lockedAt": { $lte: staleLease } }
          ]
        }
      ]
    }).select("_id status schedule.nextRunAt execution.occurrenceKey").lean();
    for (const broadcast of scheduled) {
      const isProcessing = broadcast.status === "processing";
      const isQueued = broadcast.status === "queued" || !broadcast.schedule?.nextRunAt;
      const runAt = isQueued ? new Date() : new Date(broadcast.schedule.nextRunAt);
      const occurrenceKey = (isProcessing || isQueued) && broadcast.execution?.occurrenceKey
        ? String(broadcast.execution.occurrenceKey)
        : (isQueued
        ? `queued-${String(broadcast._id)}`
        : runAt.toISOString().replace(/[:.]/g, "-"));
      const recoveryKey = isProcessing ? `recovery-${Math.floor(Date.now() / 60000)}` : undefined;
      await enqueueBroadcast(String(broadcast._id), runAt, occurrenceKey, recoveryKey);
    }

    // MongoDB is the source of truth for provider tickets. This scan repairs a
    // crash between ticket persistence and delayed BullMQ job creation, and it
    // also resumes tickets whose prior receipt job exhausted Redis retries.
    const receiptLeaseCutoff = new Date(Date.now() - 5 * 60 * 1000);
    await BroadcastPushReceipt.updateMany(
      { ticketStatus: "sending", sendLeaseAt: { $lte: receiptLeaseCutoff } },
      {
        $set: {
          ticketStatus: "queued",
          providerErrorMessage: "Recovered an expired Expo send lease"
        },
        $unset: { sendLeaseAt: 1, sendLeaseKey: 1 }
      }
    );
    const maxSendAttempts = BROADCAST_SEND_MAX_ATTEMPTS;
    const exhaustedSendRecords = await BroadcastPushReceipt.find({
      ticketStatus: "queued",
      receiptStatus: "pending",
      sendAttempts: { $gte: maxSendAttempts }
    }).select("_id broadcastRecipient").limit(3000).lean();
    await BroadcastPushReceipt.updateMany(
      { _id: { $in: exhaustedSendRecords.map((record: { _id: unknown }) => record._id) }, ticketStatus: "queued", receiptStatus: "pending" },
      {
        $set: {
          ticketStatus: "failed",
          receiptStatus: "failed",
          receiptCheckedAt: new Date(),
          providerErrorCode: "SendRetryExhausted",
          providerErrorMessage: "Expo ticket submission exhausted its retry budget"
        },
        $unset: { sendLeaseAt: 1, sendLeaseKey: 1, nextReceiptAt: 1 }
      }
    );
    if (exhaustedSendRecords.length) {
      await loadBroadcastService().reconcileTerminalPushReceipts(
        exhaustedSendRecords.map((record: { broadcastRecipient: unknown }) => String(record.broadcastRecipient))
      );
    }
    await loadBroadcastService().expireUnacknowledgedWebPushes(1000);
    await loadBroadcastService().reconcileDirtyBroadcastMetrics(100);
    await loadBroadcastService().reconcileAcknowledgedNotificationFailures(1000);
    const dueReceipts = await BroadcastPushReceipt.find({
      ticketStatus: "accepted",
      receiptStatus: "pending",
      nextReceiptAt: { $ne: null, $lte: horizon },
      $or: [
        { receiptLeaseAt: null },
        { receiptLeaseAt: { $lte: receiptLeaseCutoff } }
      ]
    }).select("_id nextReceiptAt").sort({ nextReceiptAt: 1, _id: 1 }).limit(3000).lean();
    const queuedPushRetryCandidates = await BroadcastPushReceipt.find({
      ticketStatus: "queued",
      receiptStatus: "pending",
      $and: [
        { $or: [{ sendAttempts: { $exists: false } }, { sendAttempts: { $lt: maxSendAttempts } }] },
        { $or: [
          { sendLeaseAt: null },
          { sendLeaseAt: { $lte: receiptLeaseCutoff } }
        ] }
      ]
    }).select("_id broadcast broadcastRecipient nextReceiptAt").sort({ updatedAt: 1, _id: 1 }).limit(3000).lean();
    const retryBroadcastIds = Array.from(new Set(queuedPushRetryCandidates.map(
      (record: { broadcast: unknown }) => String(record.broadcast)
    )));
    const activeRetryBroadcastIds = new Set<string>((await Broadcast.distinct("_id", {
      _id: { $in: retryBroadcastIds },
      status: { $ne: "cancelled" },
      cancelledAt: null
    })).map(String));
    const cancelledRetryRecords = queuedPushRetryCandidates.filter(
      (record: { broadcast: unknown }) => !activeRetryBroadcastIds.has(String(record.broadcast))
    );
    if (cancelledRetryRecords.length) {
      await BroadcastPushReceipt.updateMany(
        { _id: { $in: cancelledRetryRecords.map((record: { _id: unknown }) => record._id) }, ticketStatus: "queued" },
        {
          $set: {
            ticketStatus: "cancelled",
            receiptStatus: "cancelled",
            receiptCheckedAt: new Date(),
            providerErrorCode: "BroadcastCancelled",
            providerErrorMessage: "Broadcast is cancelled or unavailable; retry suppressed"
          },
          $unset: { sendLeaseAt: 1, sendLeaseKey: 1, nextReceiptAt: 1 }
        }
      );
      await loadBroadcastService().reconcileTerminalPushReceipts(
        cancelledRetryRecords.map((record: { broadcastRecipient: unknown }) => String(record.broadcastRecipient))
      );
    }
    const queuedPushRetries = queuedPushRetryCandidates.filter(
      (record: { broadcast: unknown }) => activeRetryBroadcastIds.has(String(record.broadcast))
    );
    const dueReceiptRecords = Array.from(new Map<string, { _id: unknown; nextReceiptAt?: Date }>(
      [...dueReceipts, ...queuedPushRetries].map((receipt: { _id: unknown }) => [String(receipt._id), receipt])
    ).values());
    for (let index = 0; index < dueReceiptRecords.length; index += 300) {
      const receiptBatch = dueReceiptRecords.slice(index, index + 300);
      const runAt = receiptBatch.reduce<Date>((latest, receipt: { nextReceiptAt?: Date }) => {
        const date = receipt.nextReceiptAt ? new Date(receipt.nextReceiptAt) : new Date();
        return date > latest ? date : latest;
      }, new Date());
      await enqueueBroadcastReceipts(
        receiptBatch.map((receipt: { _id: unknown }) => String(receipt._id)),
        runAt,
        `recovery-${Math.floor(Date.now() / 60000)}-${index / 300}`
      );
    }
  } catch (error) {
    logger.error("Broadcast schedule recovery failed", { error: String(error) });
  }
};

export const startBroadcastScheduler = (): void => {
  if (broadcastRecoveryTimer) return;
  void recoverDueBroadcasts();
  broadcastRecoveryTimer = setInterval(() => void recoverDueBroadcasts(), 60000);
  broadcastRecoveryTimer.unref();
};

export const stopBroadcastScheduler = (): void => {
  if (broadcastRecoveryTimer) clearInterval(broadcastRecoveryTimer);
  broadcastRecoveryTimer = null;
};

// ── Graceful error handling ───────────────────────────────────────────────
emailWorker.on("failed", (job, err) => {
  logger.error("Email job failed", { jobId: job?.id, error: String(err) });
});

notificationWorker.on("failed", (job, err) => {
  logger.error("Notification job failed", { jobId: job?.id, error: String(err) });
});

broadcastWorker.on("failed", (job, err) => {
  logger.error("Broadcast job failed", { jobId: job?.id, error: String(err) });
  const maxAttempts = Number(job?.opts.attempts || 1);
  if (job?.name === "reconcile-receipts") return;
  if (job && job.attemptsMade >= maxAttempts) {
    void loadBroadcastService()
      .markBroadcastWorkerFailure({ ...job.data, jobName: job.name }, err)
      .catch((error) => logger.error("Failed to persist terminal broadcast failure", { error: String(error) }));
  }
});
