import { randomUUID } from "crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import path from "path";
import { auditLog, requireAdminPermission } from "./admin.legacy-adapters";
import { backendRootPath } from "../legacy/legacy.paths";
import { logger } from "../../config/logger";

const router = Router();
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9:._-]{8,200}$/;
const PLATFORMS = new Set(["ios", "android", "web", "unknown"]);
const SOURCES = new Set(["generic", "diagnostic", "admin_test", "bulk", "call"]);
const STATUSES = new Set([
  "queued", "sending", "accepted", "failed", "skipped", "pending", "delivered",
  "provider_accepted", "provider_delivered", "client_delivered"
]);
const REQUEST_STATUSES = new Set([
  "created", "submitting", "retrying", "provider_accepted", "provider_delivered",
  "client_delivered", "skipped", "failed"
]);
const safeString = (value: unknown, max = 200) => typeof value === "string" ? value.trim().slice(0, max) : "";
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pagination = (req: { query: Record<string, unknown> }) => ({
  page: Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1),
  limit: Math.max(1, Math.min(100, Number.parseInt(String(req.query.limit || "25"), 10) || 25))
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const User = require(path.join(backendRootPath, "models", "User.js"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PushDevice = require(path.join(backendRootPath, "models", "PushDevice.js"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PushDeliveryAttempt = require(path.join(backendRootPath, "models", "PushDeliveryAttempt.js"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PushDeliveryRequest = require(path.join(backendRootPath, "models", "PushDeliveryRequest.js"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const CallVoipPushAttempt = require(path.join(backendRootPath, "models", "CallVoipPushAttempt.js"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sendPushNotification } = require(path.join(backendRootPath, "utils", "pushNotificationService.js"));

const readLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many push diagnostics requests. Try again shortly." }
});
const testLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many administrative test pushes. Try again shortly." }
});

const serializeAttempt = (attempt: Record<string, unknown>) => ({
  id: String(attempt._id || ""),
  requestKey: safeString(attempt.requestKey, 64),
  recipient: String(attempt.recipient || ""),
  notification: attempt.notification ? String(attempt.notification) : null,
  source: safeString(attempt.source, 40),
  notificationType: safeString(attempt.notificationType, 80),
  provider: safeString(attempt.provider, 40),
  tokenPreview: safeString(attempt.tokenPreview, 80),
  installationId: safeString(attempt.installationId, 200),
  platform: safeString(attempt.platform, 40),
  appVersion: safeString(attempt.appVersion, 40),
  ticketStatus: safeString(attempt.ticketStatus, 40),
  receiptStatus: safeString(attempt.receiptStatus, 40),
  deliveryStatus: safeString(attempt.deliveryStatus, 40),
  providerErrorCode: safeString(attempt.providerErrorCode, 200),
  providerErrorMessage: safeString(attempt.providerErrorMessage, 1000),
  payload: attempt.payload || {},
  providerResponse: attempt.providerResponse || {},
  sendAttempts: Number(attempt.sendAttempts || 0),
  receiptAttempts: Number(attempt.receiptAttempts || 0),
  sentAt: attempt.sentAt || null,
  providerDeliveredAt: attempt.providerDeliveredAt || null,
  clientDeliveredAt: attempt.clientDeliveredAt || null,
  openedAt: attempt.openedAt || null,
  clickedAt: attempt.clickedAt || null,
  createdAt: attempt.createdAt
});

const serializeVoipAttempt = (attempt: Record<string, unknown>) => ({
  id: String(attempt._id || ""),
  requestKey: safeString(attempt.requestKey, 64),
  recipient: String(attempt.recipient || ""),
  callSession: attempt.callSession ? String(attempt.callSession) : null,
  callId: safeString(attempt.callId, 160),
  nativeCallId: safeString(attempt.nativeCallId, 64),
  providerRequestId: safeString(attempt.providerRequestId, 64),
  providerMessageId: safeString(attempt.apnsId, 64),
  source: "incoming_call",
  notificationType: "call",
  provider: "apns_voip",
  tokenPreview: safeString(attempt.tokenPreview, 80),
  installationId: safeString(attempt.installationId, 200),
  platform: "ios",
  ticketStatus: safeString(attempt.status, 40),
  receiptStatus: "not_available",
  deliveryStatus: attempt.status === "accepted" ? "provider_accepted" : safeString(attempt.status, 40),
  providerErrorCode: safeString(attempt.errorCode, 200),
  providerErrorMessage: safeString(attempt.errorMessage, 1000),
  payload: attempt.payload || {},
  providerResponse: attempt.providerResponse || {},
  sendAttempts: Number(attempt.attempts || 0),
  retryable: attempt.retryable === true,
  nextAttemptAt: attempt.nextAttemptAt || null,
  fallbackSentAt: attempt.fallbackSentAt || null,
  fallbackProvider: safeString(attempt.fallbackProvider, 40),
  sentAt: attempt.acceptedAt || null,
  clientDeliveredAt: attempt.clientDeliveredAt || null,
  openedAt: attempt.openedAt || null,
  clickedAt: attempt.clickedAt || null,
  createdAt: attempt.createdAt,
  updatedAt: attempt.updatedAt
});

const serializeRequest = (request: Record<string, unknown>) => ({
  id: String(request._id || ""),
  requestKey: safeString(request.requestKey, 64),
  recipient: String(request.recipient || ""),
  notification: request.notification ? String(request.notification) : null,
  source: safeString(request.source, 40),
  notificationType: safeString(request.notificationType, 80),
  provider: safeString(request.provider, 40),
  status: safeString(request.status, 40),
  targetedInstallations: Number(request.targetedInstallations || 0),
  submitted: Number(request.submitted || 0),
  accepted: Number(request.accepted || 0),
  failed: Number(request.failed || 0),
  skipped: Number(request.skipped || 0),
  pendingReceipts: Number(request.pendingReceipts || 0),
  retryCount: Number(request.retryCount || 0),
  reasonCode: safeString(request.reasonCode, 200),
  reasonMessage: safeString(request.reasonMessage, 1000),
  payload: request.payload || {},
  firstAttemptAt: request.firstAttemptAt || null,
  lastAttemptAt: request.lastAttemptAt || null,
  completedAt: request.completedAt || null,
  createdAt: request.createdAt,
  updatedAt: request.updatedAt
});

router.get(
  "/requests",
  readLimiter,
  auditLog("VIEW_PUSH_REQUESTS"),
  requireAdminPermission("users:manage"),
  async (req, res) => {
    try {
      const { page, limit } = pagination(req as unknown as { query: Record<string, unknown> });
      const filter: Record<string, unknown> = {};
      const recipient = safeString(req.query.recipient || req.query.userId, 24);
      if (recipient) {
        if (!OBJECT_ID_PATTERN.test(recipient)) return res.status(400).json({ success: false, message: "Invalid recipient" });
        filter.recipient = recipient;
      }
      const status = safeString(req.query.status, 40).toLowerCase();
      if (status) {
        if (!REQUEST_STATUSES.has(status)) return res.status(400).json({ success: false, message: "Invalid status" });
        filter.status = status;
      }
      const source = safeString(req.query.source, 40).toLowerCase();
      if (source) {
        if (!SOURCES.has(source)) return res.status(400).json({ success: false, message: "Invalid source" });
        filter.source = source;
      }
      const requestKey = safeString(req.query.requestKey, 64).toLowerCase();
      if (requestKey) {
        if (!/^[a-f\d]{64}$/.test(requestKey)) return res.status(400).json({ success: false, message: "Invalid requestKey" });
        filter.requestKey = requestKey;
      }
      const [items, total] = await Promise.all([
        PushDeliveryRequest.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        PushDeliveryRequest.countDocuments(filter)
      ]);
      return res.json({
        success: true,
        data: { items: items.map(serializeRequest), pagination: { page, limit, total, pages: Math.ceil(total / limit) } }
      });
    } catch (error) {
      logger.error("Administrative push request lookup failed", { error: String(error) });
      return res.status(500).json({ success: false, message: "Failed to fetch push requests" });
    }
  }
);

router.get(
  "/devices",
  readLimiter,
  auditLog("VIEW_PUSH_DEVICES"),
  requireAdminPermission("users:manage"),
  async (req, res) => {
    try {
      const { page, limit } = pagination(req as unknown as { query: Record<string, unknown> });
      const filter: Record<string, unknown> = {};
      const platform = safeString(req.query.platform, 40).toLowerCase();
      const status = safeString(req.query.status, 40).toLowerCase();
      const projectId = safeString(req.query.projectId, 120);
      if (projectId) filter.projectId = projectId;
      if (platform) {
        if (!PLATFORMS.has(platform)) return res.status(400).json({ success: false, message: "Invalid platform" });
        filter.platform = platform;
      }
      if (status) {
        if (!["active", "invalid", "disabled"].includes(status)) {
          return res.status(400).json({ success: false, message: "Invalid device status" });
        }
        filter.status = status;
      }
      const search = safeString(req.query.search, 100);
      if (search) {
        const regex = new RegExp(escapeRegex(search), "i");
        const userIds = await User.find({ $or: [{ username: regex }, { email: regex }] }).distinct("_id");
        filter.$or = [
          { user: { $in: userIds } },
          ...(OBJECT_ID_PATTERN.test(search) ? [{ user: search }] : []),
          { installationId: regex },
          { deviceName: regex },
          { deviceModel: regex }
        ];
      }
      const [items, total] = await Promise.all([
        PushDevice.find(filter)
          .select("-token -nativeToken -fcmToken -apnsToken -voipToken -tokenHash -nativeTokenHash -fcmTokenHash -apnsTokenHash -voipTokenHash")
          .populate("user", "username email profile.displayName")
          .sort({ lastSeenAt: -1, _id: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        PushDevice.countDocuments(filter)
      ]);
      return res.json({
        success: true,
        data: {
          items: items.map((device: Record<string, any>) => ({
            id: String(device._id),
            userId: String(device.user?._id || device.user || ""),
            username: safeString(device.user?.username, 100),
            email: safeString(device.user?.email, 200),
            displayName: safeString(device.user?.profile?.displayName, 120),
            installationId: safeString(device.installationId, 200),
            provider: safeString(device.provider, 40),
            platform: safeString(device.platform, 40),
            deviceName: safeString(device.deviceName, 120),
            deviceModel: safeString(device.deviceModel, 120),
            deviceBrand: safeString(device.deviceBrand, 120),
            manufacturer: safeString(device.manufacturer, 120),
            deviceType: safeString(device.deviceType, 40),
            osName: safeString(device.osName, 40),
            osVersion: safeString(device.osVersion, 40),
            projectId: safeString(device.projectId, 120),
            appVersion: safeString(device.appVersion, 40),
            buildVersion: safeString(device.buildVersion, 40),
            nativeTokenType: safeString(device.nativeTokenType, 40),
            tokenPreview: safeString(device.tokenPreview, 80),
            nativeTokenPreview: safeString(device.nativeTokenPreview, 80),
            hasFcmToken: Boolean(device.fcmTokenPreview),
            fcmTokenPreview: safeString(device.fcmTokenPreview, 80),
            fcmTokenUpdatedAt: device.fcmTokenUpdatedAt,
            hasApnsToken: Boolean(device.apnsTokenPreview),
            apnsTokenPreview: safeString(device.apnsTokenPreview, 80),
            apnsTokenUpdatedAt: device.apnsTokenUpdatedAt,
            hasVoipToken: Boolean(device.voipTokenPreview),
            voipTokenPreview: safeString(device.voipTokenPreview, 80),
            voipTokenUpdatedAt: device.voipTokenUpdatedAt,
            status: safeString(device.status, 40),
            failureCount: Number(device.failureCount || 0),
            lastSeenAt: device.lastSeenAt,
            lastDeliveredAt: device.lastDeliveredAt,
            lastFailedAt: device.lastFailedAt,
            updatedAt: device.updatedAt,
            createdAt: device.createdAt
          })),
          pagination: { page, limit, total, pages: Math.ceil(total / limit) }
        }
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch push devices" });
    }
  }
);

router.get(
  "/deliveries",
  readLimiter,
  auditLog("VIEW_PUSH_DELIVERIES"),
  requireAdminPermission("users:manage"),
  async (req, res) => {
    try {
      const { page, limit } = pagination(req as unknown as { query: Record<string, unknown> });
      const filter: Record<string, unknown> = {};
      const recipient = safeString(req.query.recipient || req.query.userId, 24);
      if (recipient) {
        if (!OBJECT_ID_PATTERN.test(recipient)) return res.status(400).json({ success: false, message: "Invalid recipient" });
        filter.recipient = recipient;
      }
      const source = safeString(req.query.source, 40).toLowerCase();
      if (source) {
        if (!SOURCES.has(source)) return res.status(400).json({ success: false, message: "Invalid source" });
        filter.source = source;
      }
      const platform = safeString(req.query.platform, 40).toLowerCase();
      if (platform) {
        if (!PLATFORMS.has(platform)) return res.status(400).json({ success: false, message: "Invalid platform" });
        filter.platform = platform;
      }
      const requestKey = safeString(req.query.requestKey, 64).toLowerCase();
      if (requestKey) {
        if (!/^[a-f\d]{64}$/.test(requestKey)) return res.status(400).json({ success: false, message: "Invalid requestKey" });
        filter.requestKey = requestKey;
      }
      const status = safeString(req.query.status, 40).toLowerCase();
      if (status) {
        if (!STATUSES.has(status)) return res.status(400).json({ success: false, message: "Invalid status" });
        filter.$or = [{ ticketStatus: status }, { receiptStatus: status }, { deliveryStatus: status }];
      }
      const [items, total] = await Promise.all([
        PushDeliveryAttempt.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        PushDeliveryAttempt.countDocuments(filter)
      ]);
      return res.json({
        success: true,
        data: { items: items.map(serializeAttempt), pagination: { page, limit, total, pages: Math.ceil(total / limit) } }
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: "Failed to fetch push delivery attempts" });
    }
  }
);

router.get(
  "/voip-deliveries",
  readLimiter,
  auditLog("VIEW_VOIP_PUSH_DELIVERIES"),
  requireAdminPermission("users:manage"),
  async (req, res) => {
    try {
      const { page, limit } = pagination(req as unknown as { query: Record<string, unknown> });
      const filter: Record<string, unknown> = {};
      const recipient = safeString(req.query.recipient || req.query.userId, 24);
      if (recipient) {
        if (!OBJECT_ID_PATTERN.test(recipient)) return res.status(400).json({ success: false, message: "Invalid recipient" });
        filter.recipient = recipient;
      }
      const status = safeString(req.query.status, 40).toLowerCase();
      if (status) {
        if (!["queued", "sending", "accepted", "failed"].includes(status)) {
          return res.status(400).json({ success: false, message: "Invalid status" });
        }
        filter.status = status;
      }
      const callId = safeString(req.query.callId, 160);
      if (callId) filter.callId = callId;
      const requestKey = safeString(req.query.requestKey, 64).toLowerCase();
      if (requestKey) {
        if (!/^[a-f\d]{64}$/.test(requestKey)) return res.status(400).json({ success: false, message: "Invalid requestKey" });
        filter.requestKey = requestKey;
      }
      const [items, total] = await Promise.all([
        CallVoipPushAttempt.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        CallVoipPushAttempt.countDocuments(filter)
      ]);
      return res.json({
        success: true,
        data: { items: items.map(serializeVoipAttempt), pagination: { page, limit, total, pages: Math.ceil(total / limit) } }
      });
    } catch (error) {
      logger.error("Administrative APNs VoIP delivery lookup failed", { error: String(error) });
      return res.status(500).json({ success: false, message: "Failed to fetch APNs VoIP delivery attempts" });
    }
  }
);

router.post(
  "/test",
  testLimiter,
  auditLog("SEND_ADMIN_TEST_PUSH"),
  requireAdminPermission("users:manage"),
  async (req, res) => {
    try {
      const userId = safeString(req.body?.userId, 24);
      const username = safeString(req.body?.username, 100).toLowerCase();
      if (!userId && !username) return res.status(400).json({ success: false, message: "userId or username is required" });
      if (userId && !OBJECT_ID_PATTERN.test(userId)) return res.status(400).json({ success: false, message: "Invalid userId" });
      const user = await User.findOne(userId ? { _id: userId } : { username }).select("_id username isActive").lean();
      if (!user || user.isActive === false) return res.status(404).json({ success: false, message: "Active user not found" });

      const installationId = safeString(req.body?.installationId, 200);
      if (installationId && !INSTALLATION_ID_PATTERN.test(installationId)) {
        return res.status(400).json({ success: false, message: "Invalid installationId" });
      }
      const platform = safeString(req.body?.platform, 40).toLowerCase();
      if (platform && !PLATFORMS.has(platform)) return res.status(400).json({ success: false, message: "Invalid platform" });
      const projectId = safeString(req.body?.projectId, 120);
      const title = safeString(req.body?.title, 100) || "SquadHunt admin test";
      const body = safeString(req.body?.body, 1000) || "Administrative push delivery test.";
      const requestedData = req.body?.data && typeof req.body.data === "object" && !Array.isArray(req.body.data)
        ? req.body.data
        : {};
      if (Buffer.byteLength(JSON.stringify(requestedData), "utf8") > 8192) {
        return res.status(400).json({ success: false, message: "data exceeds 8 KB" });
      }
      const idempotencyKey = safeString(
        req.header("Idempotency-Key") || req.body?.idempotencyKey,
        200
      ) || randomUUID();
      const customData = requestedData.customData && typeof requestedData.customData === "object"
        ? requestedData.customData
        : {};
      const result = await sendPushNotification(String(user._id), {
        title,
        message: body,
        type: "system",
        data: {
          ...requestedData,
          customData: {
            ...customData,
            pushSource: "admin_test",
            pushRequestId: idempotencyKey,
            ...(installationId ? { pushTargetInstallationId: installationId } : {}),
            ...(platform ? { pushTargetPlatform: platform } : {}),
            ...(projectId ? { pushTargetProjectId: projectId } : {})
          }
        }
      });
      const accepted = Number(result.accepted || 0);
      logger.info("Administrative test push completed", {
        userId: String(user._id),
        installation: installationId.length < 12 ? "[redacted]" : `${installationId.slice(0, 8)}...${installationId.slice(-4)}`,
        platform: platform || "all",
        accepted,
        failed: Number(result.failed || 0),
        requestKey: safeString(result.requestKey, 64).slice(0, 16)
      });
      const statusCode = accepted > 0 ? 202 : (Number(result.sent || 0) === 0 ? 409 : 502);
      return res.status(statusCode).json({
        success: accepted > 0,
        message: accepted > 0 ? "Test push accepted by provider" : "No matching installation accepted the test push",
        data: result
      });
    } catch (error) {
      logger.error("Administrative test push failed", {
        userId: safeString(req.body?.userId, 24),
        username: safeString(req.body?.username, 100),
        installation: safeString(req.body?.installationId, 200).length < 12
          ? "[redacted]"
          : `${safeString(req.body?.installationId, 200).slice(0, 8)}...${safeString(req.body?.installationId, 200).slice(-4)}`,
        error: String(error)
      });
      const statusCode = Number((error as { statusCode?: number })?.statusCode) || 500;
      return res.status(statusCode).json({
        success: false,
        message: statusCode === 500 ? "Failed to send administrative test push" : (error as Error).message
      });
    }
  }
);

export default router;
