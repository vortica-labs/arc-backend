import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import path from "path";
import { randomUUID } from "crypto";
import { Notification, User, protect } from "./notifications.legacy-adapters";
import { backendRootPath } from "../legacy/legacy.paths";
import { logger } from "../../config/logger";

const router = Router();

const EXPO_PUSH_TOKEN_PATTERN = /^ExponentPushToken\[[\w-]+\]$|^ExpoPushToken\[[\w-]+\]$/;
const EXPO_PUSH_TOKEN_MAX_LENGTH = 512;
const APNS_VOIP_TOKEN_PATTERN = /^[a-f\d]{64,512}$/i;
const MAX_PUSH_TOKENS_PER_USER = 10;
const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9:._-]{8,200}$/;
const VALID_PLATFORMS = new Set(["ios", "android", "web", "unknown"]);
const VALID_TRACKING_PLATFORMS = new Set(["ios", "android", "web"]);
const VALID_BROADCAST_CATEGORIES = new Set([
  "announcement", "update", "maintenance", "feature_release", "tournament",
  "recruitment", "promotion", "creator", "premium", "system", "custom"
]);
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

const getUserId = (req: { user?: { _id?: string } }) => req.user?._id;
const safeString = (value: unknown, maxLength = 200) =>
  typeof value === "string" ? value.trim().slice(0, maxLength) : "";
const maskToken = (token: string) =>
  token.length <= 24 ? "[redacted]" : `${token.slice(0, 12)}...${token.slice(-8)}`;
const previewInstallation = (value: unknown) => {
  const id = safeString(value, 200);
  return id.length < 12 ? "[redacted]" : `${id.slice(0, 8)}...${id.slice(-4)}`;
};
const isObjectId = (value: unknown) => typeof value === "string" && OBJECT_ID_PATTERN.test(value);
const trackingPlatform = (value: unknown) => {
  const platform = safeString(value, 40).toLowerCase();
  return VALID_TRACKING_PLATFORMS.has(platform) ? platform : "unknown";
};
const userRateKey = (req: { user?: { _id?: unknown }; ip?: string }) =>
  String(req.user?._id || ipKeyGenerator(req.ip || "unknown"));
const pushMutationLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userRateKey,
  message: { success: false, message: "Too many push registration changes. Try again shortly." }
});
const pushTestLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userRateKey,
  message: { success: false, message: "Too many test push requests. Try again later." }
});

const buildClientVisibilityFilter = (platform: string, appVersion: string) => {
  const hasKnownPlatform = Boolean(platform && VALID_PLATFORMS.has(platform) && platform !== "unknown");
  return [
    {
      $or: [
        { "data.targetPlatforms": { $exists: false } },
        { "data.targetPlatforms": { $size: 0 } },
        ...(hasKnownPlatform ? [{ "data.targetPlatforms": platform }] : [])
      ]
    },
    {
      $or: [
        { "data.targetAppVersions": { $exists: false } },
        { "data.targetAppVersions": { $size: 0 } },
        ...(appVersion ? [{ "data.targetAppVersions": appVersion }] : [])
      ]
    }
  ];
};

const withClientVisibility = (
  base: Record<string, unknown>,
  platform: string,
  appVersion: string
) => {
  const constraints = buildClientVisibilityFilter(platform, appVersion);
  return constraints.length ? { ...base, $and: constraints } : base;
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const BroadcastRecipient = require(path.join(backendRootPath, "models", "BroadcastRecipient.js"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PushDeliveryAttempt = require(path.join(backendRootPath, "models", "PushDeliveryAttempt.js"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const CallVoipPushAttempt = require(path.join(backendRootPath, "models", "CallVoipPushAttempt.js"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  getPushDevicesForUser,
  registerPushDevice,
  removePushDevices,
  registerVoipToken,
  removeVoipToken
} = require(path.join(backendRootPath, "services", "pushDeviceService.js"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { trackDelivery, trackEvent } = require(path.join(backendRootPath, "services", "broadcastService.js"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sanitizeNotificationsForViewer } = require(path.join(backendRootPath, "utils", "notificationPrivacy.js"));

const serializePushToken = (entry: Record<string, unknown>) => {
  const token = typeof entry.token === "string" ? entry.token : "";
  const nativeToken = entry.nativeToken && typeof entry.nativeToken === "object"
    ? entry.nativeToken as Record<string, unknown>
    : undefined;

  return {
    tokenPreview: safeString(entry.tokenPreview, 80) || maskToken(token),
    isValidExpoToken: EXPO_PUSH_TOKEN_PATTERN.test(token),
    platform: safeString(entry.platform, 40) || "unknown",
    installationId: safeString(entry.installationId, 200),
    deviceName: safeString(entry.deviceName, 120),
    projectId: safeString(entry.projectId, 120),
    appVersion: safeString(entry.appVersion, 40),
    buildVersion: safeString(entry.buildVersion, 40),
    nativeTokenType: safeString(entry.nativeTokenType || nativeToken?.type, 40),
    hasFcmToken: Boolean(entry.fcmTokenHash),
    fcmTokenPreview: safeString(entry.fcmTokenPreview, 80),
    fcmTokenUpdatedAt: entry.fcmTokenUpdatedAt,
    hasApnsToken: Boolean(entry.apnsTokenHash),
    apnsTokenPreview: safeString(entry.apnsTokenPreview, 80),
    apnsTokenUpdatedAt: entry.apnsTokenUpdatedAt,
    hasVoipToken: Boolean(entry.voipTokenHash),
    voipTokenPreview: safeString(entry.voipTokenPreview, 80),
    voipTokenUpdatedAt: entry.voipTokenUpdatedAt,
    lastUsedAt: entry.lastUsedAt,
    createdAt: entry.createdAt
  };
};

const serializePushAttempt = (entry: Record<string, unknown>) => ({
  id: String(entry._id || ""),
  requestKey: safeString(entry.requestKey, 64),
  source: safeString(entry.source, 40),
  notificationId: entry.notification ? String(entry.notification) : null,
  notificationType: safeString(entry.notificationType, 80),
  provider: safeString(entry.provider, 40) || "expo",
  tokenPreview: safeString(entry.tokenPreview, 80),
  installationId: safeString(entry.installationId, 200),
  platform: safeString(entry.platform, 40) || "unknown",
  appVersion: safeString(entry.appVersion, 40),
  ticketStatus: safeString(entry.ticketStatus, 40),
  receiptStatus: safeString(entry.receiptStatus, 40),
  deliveryStatus: safeString(entry.deliveryStatus, 40),
  providerErrorCode: safeString(entry.providerErrorCode, 200),
  providerErrorMessage: safeString(entry.providerErrorMessage, 1000),
  payload: entry.payload || {},
  providerResponse: entry.providerResponse || {},
  sendAttempts: Number(entry.sendAttempts || 0),
  receiptAttempts: Number(entry.receiptAttempts || 0),
  sentAt: entry.sentAt || null,
  providerDeliveredAt: entry.providerDeliveredAt || null,
  clientDeliveredAt: entry.clientDeliveredAt || null,
  openedAt: entry.openedAt || null,
  clickedAt: entry.clickedAt || null,
  receiptCheckedAt: entry.receiptCheckedAt || null,
  createdAt: entry.createdAt
});

const countRegisteredPushTokens = async (userId: string) => {
  const pushTokens = await getPushDevicesForUser(userId);
  return {
    pushTokenCount: pushTokens.length,
    validExpoPushTokenCount: pushTokens.filter((entry: Record<string, unknown>) =>
      typeof entry?.token === "string" && EXPO_PUSH_TOKEN_PATTERN.test(entry.token)
    ).length
  };
};

const sendDiagnosticPush = async (userId: string, source = "diagnostic", requestId = "") => {
  const notification = await Notification.createNotification({
    recipient: userId,
    type: "system",
    title: "SquadHunt test notification",
    message: "Native push delivery is working on this device.",
    data: {
      customData: {
        url: "/notifications",
        diagnostic: true,
        pushSource: source,
        pushRequestId: requestId
      }
    },
    sendPush: false,
    pushDeliveryState: "pending"
  });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { sendPushNotification } = require(path.join(backendRootPath, "utils", "pushNotificationService.js"));
  const leaseKey = `notification-outbox-${randomUUID()}`;
  const claimed = await Notification.claimPushDelivery(notification._id, leaseKey);
  if (!claimed) throw new Error("Diagnostic push outbox could not be claimed");
  let result;
  try {
    result = await sendPushNotification(userId, claimed);
    await Notification.completePushDelivery(notification._id, leaseKey);
  } catch (error) {
    await Notification.retryPushDelivery(notification._id, leaseKey, error).catch(() => undefined);
    throw error;
  }
  const diagnostics = {
    notificationId: String(notification?._id || ""),
    sentAt: new Date().toISOString(),
    ...result
  };
  return diagnostics;
};

router.post("/push-token", protect, pushMutationLimiter, async (req, res) => {
  try {
    const userId = getUserId(req as { user?: { _id?: string } });
    const {
      token,
      platform = "unknown",
      deviceName = "",
      deviceModel = "",
      deviceBrand = "",
      manufacturer = "",
      deviceType = "",
      osName = "",
      osVersion = "",
      projectId = "",
      appVersion = "",
      buildVersion = "",
      installationId: requestedInstallationId,
      deviceId,
      nativeToken
    } = req.body ?? {};

    if (!userId) {
      return res.status(401).json({ success: false, message: "Authenticated user is required" });
    }

    const normalizedToken = typeof token === "string" ? token.trim() : "";
    if (!normalizedToken || normalizedToken.length > EXPO_PUSH_TOKEN_MAX_LENGTH || !EXPO_PUSH_TOKEN_PATTERN.test(normalizedToken)) {
      return res.status(400).json({ success: false, message: "Valid Expo push token is required" });
    }

    const requestedPlatform = safeString(platform, 40).toLowerCase();
    if (!["ios", "android"].includes(requestedPlatform)) {
      return res.status(400).json({ success: false, message: "platform must be ios or android" });
    }
    const installationId = safeString(requestedInstallationId || deviceId, 200);
    if (!INSTALLATION_ID_PATTERN.test(installationId)) {
      return res.status(400).json({ success: false, message: "A stable installationId is required" });
    }
    const nativeTokenType = nativeToken && typeof nativeToken === "object"
      ? safeString((nativeToken as Record<string, unknown>).type, 40)
      : "";
    const nativeTokenData = nativeToken && typeof nativeToken === "object"
      ? safeString((nativeToken as Record<string, unknown>).data, 2048)
      : "";

    const devices = await registerPushDevice(userId, {
      token: normalizedToken,
      installationId,
      platform: requestedPlatform,
      deviceName: safeString(deviceName, 120),
      deviceModel: safeString(deviceModel, 120),
      deviceBrand: safeString(deviceBrand, 120),
      manufacturer: safeString(manufacturer, 120),
      deviceType: safeString(deviceType, 40),
      osName: safeString(osName, 40),
      osVersion: safeString(osVersion, 40),
      projectId: safeString(projectId, 120),
      appVersion: safeString(appVersion, 40),
      buildVersion: safeString(buildVersion, 40),
      nativeTokenType,
      nativeToken: nativeTokenData
    });
    if (devices.length > MAX_PUSH_TOKENS_PER_USER) {
      const stale = devices
        .sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
          new Date(String(a.lastSeenAt || 0)).getTime() - new Date(String(b.lastSeenAt || 0)).getTime())
        .slice(0, devices.length - MAX_PUSH_TOKENS_PER_USER);
      for (const entry of stale) {
        await removePushDevices(userId, { installationId: entry.installationId });
      }
    }
    const tokenCounts = await countRegisteredPushTokens(userId);

    logger.info("Push installation registered", {
      userId: String(userId),
      installation: previewInstallation(installationId),
      platform: requestedPlatform
    });

    return res.status(200).json({
      success: true,
      message: "Push token registered",
      data: {
        installationId,
        platform: requestedPlatform,
        deviceModel: safeString(deviceModel, 120),
        osName: safeString(osName, 40),
        osVersion: safeString(osVersion, 40),
        appVersion: safeString(appVersion, 40),
        buildVersion: safeString(buildVersion, 40),
        registeredAt: new Date().toISOString(),
        ...tokenCounts
      }
    });
  } catch (error) {
    logger.error("Push installation registration failed", {
      userId: String(getUserId(req as { user?: { _id?: string } }) || ""),
      installation: previewInstallation(req.body?.installationId || req.body?.deviceId),
      error: String(error)
    });
    return res.status(500).json({
      success: false,
      message: "Failed to register push token"
    });
  }
});

router.post("/voip-token", protect, pushMutationLimiter, async (req, res) => {
  try {
    const userId = getUserId(req as { user?: { _id?: string } });
    if (!userId) return res.status(401).json({ success: false, message: "Authenticated user is required" });
    const installationId = safeString(req.body?.installationId || req.body?.deviceId, 200);
    const token = safeString(req.body?.token, 512).replace(/[<>\s]/g, "").toLowerCase();
    if (!INSTALLATION_ID_PATTERN.test(installationId)) {
      return res.status(400).json({ success: false, message: "A stable installationId is required" });
    }
    if (!APNS_VOIP_TOKEN_PATTERN.test(token)) {
      return res.status(400).json({ success: false, message: "A valid APNs VoIP token is required" });
    }
    const device = await registerVoipToken(userId, installationId, token);
    logger.info("APNs VoIP installation registered", {
      userId: String(userId),
      installation: previewInstallation(installationId),
      tokenHash: safeString(device?.voipTokenHash, 64).slice(0, 12)
    });
    return res.json({
      success: true,
      data: {
        installationId,
        tokenPreview: safeString(device?.voipTokenPreview, 80),
        updatedAt: device?.voipTokenUpdatedAt || new Date().toISOString()
      }
    });
  } catch (error) {
    const status = Number((error as { statusCode?: number })?.statusCode || 500);
    logger.error("APNs VoIP installation registration failed", {
      userId: String(getUserId(req as { user?: { _id?: string } }) || ""),
      installation: previewInstallation(req.body?.installationId || req.body?.deviceId),
      error: String(error)
    });
    return res.status(status).json({
      success: false,
      message: status >= 500 ? "Failed to register APNs VoIP token" : (error as Error).message
    });
  }
});

router.delete("/voip-token", protect, pushMutationLimiter, async (req, res) => {
  try {
    const userId = getUserId(req as { user?: { _id?: string } });
    if (!userId) return res.status(401).json({ success: false, message: "Authenticated user is required" });
    const installationId = safeString(req.body?.installationId || req.body?.deviceId, 200);
    const token = safeString(req.body?.token, 512).replace(/[<>\s]/g, "").toLowerCase();
    if (!installationId && !token) {
      return res.status(400).json({ success: false, message: "installationId or token is required" });
    }
    if (installationId && !INSTALLATION_ID_PATTERN.test(installationId)) {
      return res.status(400).json({ success: false, message: "Invalid installationId" });
    }
    if (token && !APNS_VOIP_TOKEN_PATTERN.test(token)) {
      return res.status(400).json({ success: false, message: "Invalid APNs VoIP token" });
    }
    const result = await removeVoipToken(userId, { installationId, token });
    logger.info("APNs VoIP installation removed", {
      userId: String(userId),
      installation: previewInstallation(installationId),
      removed: result.removed
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    logger.error("APNs VoIP installation removal failed", {
      userId: String(getUserId(req as { user?: { _id?: string } }) || ""),
      installation: previewInstallation(req.body?.installationId || req.body?.deviceId),
      error: String(error)
    });
    return res.status(500).json({ success: false, message: "Failed to remove APNs VoIP token" });
  }
});

router.post("/client-context", protect, pushMutationLimiter, async (req, res) => {
  try {
    const userId = getUserId(req as { user?: { _id?: string } });
    if (!userId) return res.status(401).json({ success: false, message: "Authenticated user is required" });
    const platform = safeString(req.body?.platform, 40).toLowerCase();
    if (!VALID_PLATFORMS.has(platform) || platform === "unknown") {
      return res.status(400).json({ success: false, message: "platform must be ios, android, or web" });
    }
    const appVersion = safeString(req.body?.appVersion, 40);
    const clientId = safeString(req.body?.clientId, 200);
    const permissionInput = safeString(req.body?.notificationPermission, 20).toLowerCase();
    const notificationPermission = new Set(["granted", "denied", "default", "unsupported"])
      .has(permissionInput) ? permissionInput : "unknown";
    const browserNotificationsSupported = req.body?.browserNotificationsSupported === true;
    if (!clientId) {
      return res.status(400).json({ success: false, message: "A stable clientId is required" });
    }
    const now = new Date();

    // An installation belongs to one authenticated account at a time. Moving
    // it first prevents a signed-out account from remaining eligible for
    // platform/version broadcasts on the same browser or mobile installation.
    await User.updateMany(
      { _id: { $ne: userId }, "notificationClients.clientId": clientId },
      { $pull: { notificationClients: { clientId } } }
    );
    const result = await User.updateOne(
      { _id: userId, "notificationClients.clientId": clientId },
      {
        $set: {
          "notificationClients.$.platform": platform,
          "notificationClients.$.appVersion": appVersion,
          "notificationClients.$.notificationPermission": notificationPermission,
          "notificationClients.$.browserNotificationsSupported": browserNotificationsSupported,
          "notificationClients.$.lastSeenAt": now
        }
      }
    );
    if (!result?.matchedCount) {
      await User.updateOne(
        { _id: userId },
        {
          $push: {
            notificationClients: {
              $each: [{
                clientId, platform, appVersion, notificationPermission,
                browserNotificationsSupported, lastSeenAt: now, createdAt: now
              }],
              $slice: -10
            }
          }
        }
      );
    }
    return res.json({
      success: true,
      data: { clientId, platform, appVersion, notificationPermission, browserNotificationsSupported, registeredAt: now }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to register notification client context"
    });
  }
});

router.delete("/push-token", protect, pushMutationLimiter, async (req, res) => {
  try {
    const userId = getUserId(req as { user?: { _id?: string } });
    const { token, installationId: requestedInstallationId, deviceId } = req.body ?? {};

    if (!userId) {
      return res.status(401).json({ success: false, message: "Authenticated user is required" });
    }

    const normalizedToken = typeof token === "string" ? token.trim() : "";
    const installationId = safeString(requestedInstallationId || deviceId, 200);
    if (!normalizedToken && !installationId) {
      return res.status(400).json({ success: false, message: "token or installationId is required" });
    }
    if (normalizedToken && (normalizedToken.length > EXPO_PUSH_TOKEN_MAX_LENGTH || !EXPO_PUSH_TOKEN_PATTERN.test(normalizedToken))) {
      return res.status(400).json({ success: false, message: "Valid Expo push token is required" });
    }
    if (installationId && !INSTALLATION_ID_PATTERN.test(installationId)) {
      return res.status(400).json({ success: false, message: "Invalid installationId" });
    }

    const result = await removePushDevices(userId, {
      token: normalizedToken || undefined,
      installationId: installationId || undefined
    });
    logger.info("Push installation removed", {
      userId: String(userId),
      installation: previewInstallation(installationId),
      removed: result.removed
    });
    return res.status(200).json({ success: true, message: "Push installation removed", data: result });
  } catch (error) {
    logger.error("Push installation removal failed", {
      userId: String(getUserId(req as { user?: { _id?: string } }) || ""),
      installation: previewInstallation(req.body?.installationId || req.body?.deviceId),
      error: String(error)
    });
    return res.status(500).json({
      success: false,
      message: "Failed to remove push installation"
    });
  }
});

router.delete("/client-context", protect, pushMutationLimiter, async (req, res) => {
  try {
    const userId = getUserId(req as { user?: { _id?: string } });
    if (!userId) return res.status(401).json({ success: false, message: "Authenticated user is required" });
    const clientId = safeString(req.body?.clientId, 200);
    if (!clientId || !INSTALLATION_ID_PATTERN.test(clientId)) {
      return res.status(400).json({ success: false, message: "Valid clientId is required" });
    }

    await User.updateOne({ _id: userId }, { $pull: { notificationClients: { clientId } } });
    return res.status(200).json({ success: true, message: "Notification client context removed" });
  } catch (error) {
    logger.error("Notification client context removal failed", {
      userId: String(getUserId(req as { user?: { _id?: string } }) || ""),
      error: String(error)
    });
    return res.status(500).json({
      success: false,
      message: "Failed to remove notification client context"
    });
  }
});

router.get("/push-status", protect, async (req, res) => {
  try {
    const userId = getUserId(req as { user?: { _id?: string } });

    if (!userId) {
      return res.status(401).json({ success: false, message: "Authenticated user is required" });
    }

    const [user, pushTokens, latestAttempt] = await Promise.all([
      User.findById(userId).select("notificationClients notificationSettings").lean(),
      getPushDevicesForUser(userId),
      PushDeliveryAttempt.findOne({ recipient: userId }).sort({ createdAt: -1 }).lean()
    ]);
    const tokens = pushTokens.map((entry: Record<string, unknown>) => serializePushToken(entry));

    return res.status(200).json({
      success: true,
      data: {
        userId,
        serverTime: new Date().toISOString(),
        deliveryProvider: "expo",
        pushTokenCount: tokens.length,
        validExpoPushTokenCount: tokens.filter((entry: { isValidExpoToken: boolean }) => entry.isValidExpoToken).length,
        tokens,
        clients: Array.isArray(user?.notificationClients)
          ? user.notificationClients.map((client: Record<string, unknown>) => ({
              clientId: safeString(client.clientId, 200),
              platform: safeString(client.platform, 40) || "unknown",
              appVersion: safeString(client.appVersion, 40),
              notificationPermission: safeString(client.notificationPermission, 20) || "unknown",
              browserNotificationsSupported: client.browserNotificationsSupported === true,
              lastSeenAt: client.lastSeenAt
            }))
          : [],
        lastPushAttempt: latestAttempt ? serializePushAttempt(latestAttempt) : null,
        notificationSettings: {
          pushEnabled: true,
          inAppEnabled: true,
          ...(user?.notificationSettings ?? {})
        },
        requirements: {
          android: "Expo/EAS FCM credentials must be configured for the Android package used by the installed build.",
          ios: "Expo/EAS APNs credentials must be configured for the iOS bundle identifier and APNs environment."
        }
      }
    });
  } catch (error) {
    logger.error("Push status lookup failed", {
      userId: String(getUserId(req as { user?: { _id?: string } }) || ""),
      error: String(error)
    });
    return res.status(500).json({
      success: false,
      message: "Failed to fetch push notification status"
    });
  }
});

router.get("/push-deliveries", protect, async (req, res) => {
  try {
    const userId = getUserId(req as { user?: { _id?: string } });
    if (!userId) return res.status(401).json({ success: false, message: "Authenticated user is required" });
    const page = Math.max(1, Number.parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.max(1, Math.min(50, Number.parseInt(String(req.query.limit || "20"), 10) || 20));
    const filter: Record<string, unknown> = { recipient: userId };
    const status = safeString(req.query.status, 40);
    if (status && new Set(["queued", "sending", "accepted", "failed", "delivered", "pending", "skipped"]).has(status)) {
      filter.$or = [{ ticketStatus: status }, { receiptStatus: status }];
    }
    const [items, total] = await Promise.all([
      PushDeliveryAttempt.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      PushDeliveryAttempt.countDocuments(filter)
    ]);
    return res.json({
      success: true,
      data: { items: items.map(serializePushAttempt), pagination: { page, limit, total, pages: Math.ceil(total / limit) } }
    });
  } catch (error) {
    logger.error("Push delivery history lookup failed", {
      userId: String(getUserId(req as { user?: { _id?: string } }) || ""),
      error: String(error)
    });
    return res.status(500).json({ success: false, message: "Failed to fetch push delivery history" });
  }
});

router.post("/push-test", protect, pushTestLimiter, async (req, res) => {
  try {
    const userId = getUserId(req as { user?: { _id?: string } });

    if (!userId) {
      return res.status(401).json({ success: false, message: "Authenticated user is required" });
    }

    const tokenCounts = await countRegisteredPushTokens(userId);
    if (tokenCounts.validExpoPushTokenCount < 1) {
      return res.status(400).json({
        success: false,
        message: "No valid Expo push token is registered for this account",
        data: tokenCounts
      });
    }

    const requestId = safeString(req.header("Idempotency-Key"), 120);
    const diagnostics = await sendDiagnosticPush(userId, "diagnostic", requestId);
    const accepted = Number((diagnostics as Record<string, unknown>).accepted || 0);
    const statusCode = accepted > 0 ? 202 : 502;
    return res.status(statusCode).json({
      success: accepted > 0,
      message: accepted > 0 ? "Test push accepted by provider" : "Test push was not accepted by the provider",
      data: {
        ...tokenCounts,
        testPush: diagnostics
      }
    });
  } catch (error) {
    logger.error("Self-service test push failed", {
      userId: String(getUserId(req as { user?: { _id?: string } }) || ""),
      error: String(error)
    });
    return res.status(500).json({
      success: false,
      message: "Failed to send test push notification"
    });
  }
});

const resolveOwnedBroadcastDelivery = async (notificationId: string, userId: string) => {
  if (!/^[a-f\d]{24}$/i.test(notificationId)) return null;
  const notification = await Notification.findOne({ _id: notificationId, recipient: userId, deletedAt: null });
  if (notification) return { notification, persistentNotification: true };
  const deliveryLog = await BroadcastRecipient.findOne({ _id: notificationId, recipient: userId }).lean();
  if (deliveryLog) {
    return {
      persistentNotification: false,
      notification: {
        _id: deliveryLog._id,
        recipient: deliveryLog.recipient,
        broadcastRecipient: deliveryLog._id,
        data: {
          broadcastId: deliveryLog.broadcast,
          deliveryLogId: deliveryLog._id,
          customData: {
            broadcastId: String(deliveryLog.broadcast),
            deliveryLogId: String(deliveryLog._id)
          }
        }
      }
    };
  }
  const pushAttempt = await PushDeliveryAttempt.findOne({ _id: notificationId, recipient: userId }).lean();
  if (!pushAttempt) {
    const voipAttempt = await CallVoipPushAttempt.findOne({ _id: notificationId, recipient: userId }).lean();
    if (!voipAttempt) return null;
    return {
      persistentNotification: false,
      pushAttemptId: String(voipAttempt._id),
      voipAttempt: true,
      notification: {
        _id: voipAttempt._id,
        recipient: voipAttempt.recipient,
        data: { customData: voipAttempt.payload || {} }
      }
    };
  }
  const referencedNotification = pushAttempt.notification
    ? await Notification.findOne({ _id: pushAttempt.notification, recipient: userId, deletedAt: null })
    : null;
  return {
    persistentNotification: Boolean(referencedNotification),
    pushAttemptId: String(pushAttempt._id),
    notification: referencedNotification || {
      _id: pushAttempt._id,
      recipient: pushAttempt.recipient,
      data: pushAttempt.payload?.notificationData || pushAttempt.payload?.data || {}
    }
  };
};

const advanceGenericPushDelivery = async (
  notificationId: string,
  userId: string,
  eventType: "delivered" | "open" | "click",
  installationId = "",
  pushAttemptId = ""
) => {
  if (!isObjectId(notificationId)) return { matched: 0, eventType };
  const now = new Date();
  const fields: Record<string, unknown> = {
    clientDeliveredAt: { $ifNull: ["$clientDeliveredAt", now] },
    deliveryStatus: "client_delivered"
  };
  if (eventType === "open" || eventType === "click") {
    fields.openedAt = { $ifNull: ["$openedAt", now] };
  }
  if (eventType === "click") fields.clickedAt = { $ifNull: ["$clickedAt", now] };
  const filter = {
    recipient: userId,
    ...(isObjectId(pushAttemptId)
      ? { _id: pushAttemptId }
      : {
          notification: notificationId,
          ...(INSTALLATION_ID_PATTERN.test(installationId) ? { installationId } : {})
        })
  };
  const requestKeys = await PushDeliveryAttempt.distinct("requestKey", filter);
  const result = await PushDeliveryAttempt.updateMany(
    filter,
    [{ $set: fields }]
  );
  if (requestKeys.length) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { refreshPushDeliveryRequests } = require(path.join(backendRootPath, "utils", "pushNotificationService.js"));
    await refreshPushDeliveryRequests(requestKeys);
  }
  let voipMatched = 0;
  let voipModified = 0;
  if (Number(result.matchedCount || 0) === 0 && isObjectId(pushAttemptId)) {
    const voipFilter = {
      _id: pushAttemptId,
      recipient: userId,
      ...(INSTALLATION_ID_PATTERN.test(installationId) ? { installationId } : {})
    };
    const voipRequestKeys = await CallVoipPushAttempt.distinct("requestKey", voipFilter);
    const voipResult = await CallVoipPushAttempt.updateOne(
      voipFilter,
      [{ $set: {
        clientDeliveredAt: { $ifNull: ["$clientDeliveredAt", now] },
        ...(eventType === "open" || eventType === "click"
          ? { openedAt: { $ifNull: ["$openedAt", now] } }
          : {}),
        ...(eventType === "click" ? { clickedAt: { $ifNull: ["$clickedAt", now] } } : {})
      } }]
    );
    voipMatched = Number(voipResult.matchedCount || 0);
    voipModified = Number(voipResult.modifiedCount || 0);
    if (voipMatched && voipRequestKeys.length) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PushDeliveryRequest = require(path.join(backendRootPath, "models", "PushDeliveryRequest.js"));
      await PushDeliveryRequest.updateMany(
        { requestKey: { $in: voipRequestKeys } },
        { $set: { status: "client_delivered", completedAt: now } }
      );
    }
  }
  return {
    matched: Number(result.matchedCount || 0) + voipMatched,
    modified: Number(result.modifiedCount || 0) + voipModified,
    eventType
  };
};

router.post("/:id/delivered", protect, async (req, res) => {
  try {
    const userId = getUserId(req as { user?: { _id?: string } });
    if (!userId) return res.status(401).json({ success: false, message: "Authenticated user is required" });
    const owned = await resolveOwnedBroadcastDelivery(req.params.id, userId);
    if (!owned) return res.status(404).json({ success: false, message: "Notification not found" });
    const [genericPush, broadcast] = await Promise.all([
      advanceGenericPushDelivery(
        String(owned.notification._id), userId, "delivered",
        safeString(req.body?.installationId || req.body?.deviceId, 200),
        safeString(req.body?.pushDeliveryAttemptId || owned.pushAttemptId, 24)
      ),
      trackDelivery({
        notification: owned.notification,
        userId,
        platform: trackingPlatform(req.body?.platform),
        metadata: { source: safeString(req.body?.source, 80) }
      })
    ]);
    return res.json({ success: true, data: { ...broadcast, genericPush } });
  } catch (error) {
    const statusCode = Number((error as { statusCode?: number })?.statusCode) || 500;
    return res.status(statusCode).json({
      success: false,
      message: statusCode === 500 ? "Failed to acknowledge notification delivery" : (error as Error).message
    });
  }
});

router.post("/:id/open", protect, async (req, res) => {
  try {
    const userId = getUserId(req as { user?: { _id?: string } });
    if (!userId) return res.status(401).json({ success: false, message: "Authenticated user is required" });
    const owned = await resolveOwnedBroadcastDelivery(req.params.id, userId);
    if (!owned) return res.status(404).json({ success: false, message: "Notification not found" });
    if (owned.persistentNotification) {
      await Notification.updateMany(
        { _id: owned.notification._id, recipient: userId, isRead: false },
        { $set: { isRead: true, readAt: new Date() } }
      );
    }
    const [genericPush, broadcast] = await Promise.all([
      advanceGenericPushDelivery(
        String(owned.notification._id), userId, "open",
        safeString(req.body?.installationId || req.body?.deviceId, 200),
        safeString(req.body?.pushDeliveryAttemptId || owned.pushAttemptId, 24)
      ),
      trackEvent({
        notification: owned.notification,
        userId,
        eventType: "open",
        platform: trackingPlatform(req.body?.platform),
        metadata: { source: safeString(req.body?.source, 80) }
      })
    ]);
    return res.json({ success: true, data: { ...broadcast, genericPush } });
  } catch (error) {
    const statusCode = Number((error as { statusCode?: number })?.statusCode) || 500;
    return res.status(statusCode).json({
      success: false,
      message: statusCode === 500 ? "Failed to track notification open" : (error as Error).message
    });
  }
});

router.post("/:id/click", protect, async (req, res) => {
  try {
    const userId = getUserId(req as { user?: { _id?: string } });
    if (!userId) return res.status(401).json({ success: false, message: "Authenticated user is required" });
    const owned = await resolveOwnedBroadcastDelivery(req.params.id, userId);
    if (!owned) return res.status(404).json({ success: false, message: "Notification not found" });
    // A click implies an open. Both operations are idempotent at the recipient-log layer.
    if (owned.persistentNotification) {
      await Notification.updateMany(
        { _id: owned.notification._id, recipient: userId, isRead: false },
        { $set: { isRead: true, readAt: new Date() } }
      );
    }
    const [genericPush, , broadcast] = await Promise.all([
      advanceGenericPushDelivery(
        String(owned.notification._id), userId, "click",
        safeString(req.body?.installationId || req.body?.deviceId, 200),
        safeString(req.body?.pushDeliveryAttemptId || owned.pushAttemptId, 24)
      ),
      trackEvent({
        notification: owned.notification,
        userId,
        eventType: "open",
        platform: trackingPlatform(req.body?.platform),
        metadata: { source: "click" }
      }),
      trackEvent({
        notification: owned.notification,
        userId,
        eventType: "click",
        url: safeString(req.body?.url, 2048),
        platform: trackingPlatform(req.body?.platform),
        metadata: { source: safeString(req.body?.source, 80) }
      })
    ]);
    return res.json({ success: true, data: { ...broadcast, genericPush } });
  } catch (error) {
    const statusCode = Number((error as { statusCode?: number })?.statusCode) || 500;
    return res.status(statusCode).json({
      success: false,
      message: statusCode === 500 ? "Failed to track notification click" : (error as Error).message
    });
  }
});

router.get("/", protect, async (req, res) => {
  try {
    const userId = getUserId(req as { user?: { _id?: string } });
    if (!userId) return res.status(401).json({ success: false, message: "Authenticated user is required" });
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.max(1, Math.min(100, Number.parseInt(String(req.query.limit ?? "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const isRead = req.query.isRead;

    const platform = safeString(req.query.platform, 40).toLowerCase();
    if (platform && !VALID_PLATFORMS.has(platform)) {
      return res.status(400).json({ success: false, message: "platform filter is invalid" });
    }
    const appVersion = safeString(req.query.appVersion, 40);
    const archivedValue = String(req.query.archived ?? "false").toLowerCase();
    if (!["true", "false"].includes(archivedValue)) {
      return res.status(400).json({ success: false, message: "archived filter must be true or false" });
    }
    const archived = archivedValue === "true";
    let filter: Record<string, unknown> = withClientVisibility({
      recipient: userId,
      deletedAt: null,
      archivedAt: archived ? { $ne: null } : null
    }, platform, appVersion);
    if (isRead !== undefined) {
      const readValue = String(isRead).toLowerCase();
      if (!["true", "false"].includes(readValue)) {
        return res.status(400).json({ success: false, message: "isRead filter must be true or false" });
      }
      filter = { ...filter, isRead: readValue === "true" };
    }
    const category = safeString(req.query.category, 60).toLowerCase();
    if (category && category !== "all" && !VALID_BROADCAST_CATEGORIES.has(category)) {
      return res.status(400).json({ success: false, message: "category filter is invalid" });
    }
    if (category && category !== "all") filter = { ...filter, "data.customData.category": category };
    const search = safeString(req.query.search, 100);
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter = {
        ...filter,
        $or: [
          { title: { $regex: escaped, $options: "i" } },
          { message: { $regex: escaped, $options: "i" } }
        ]
      };
    }

    const notificationDocuments = await Notification.find(filter)
      .populate("sender", "username profile.displayName profile.avatar")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .exec();
    const notifications = await sanitizeNotificationsForViewer(notificationDocuments, req.user);

    const total = await Notification.countDocuments(filter);
    const unreadCount = await Notification.countDocuments(
      withClientVisibility({ recipient: userId, isRead: false, deletedAt: null, archivedAt: null }, platform, appVersion)
    );

    return res.status(200).json({
      success: true,
      data: {
        notifications,
        unreadCount,
        pagination: {
          current: page,
          total: Math.ceil(total / limit),
          count: notifications.length,
          totalNotifications: total,
          // Compatibility aliases for clients that use conventional names.
          page,
          pages: Math.ceil(total / limit),
          limit,
          totalItems: total
        }
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch notifications"
    });
  }
});

router.put("/:id/read", protect, async (req, res) => {
  try {
    const userId = (req as { user?: { _id?: string } }).user?._id;
    const { id } = req.params;
    if (!userId) return res.status(401).json({ success: false, message: "Authenticated user is required" });
    if (!isObjectId(id)) return res.status(404).json({ success: false, message: "Notification not found" });
    const platform = safeString(req.body?.platform ?? req.query.platform, 40).toLowerCase();
    const appVersion = safeString(req.body?.appVersion ?? req.query.appVersion, 40);
    const notification = await Notification.findOne(
      withClientVisibility({ _id: id, recipient: userId, deletedAt: null }, platform, appVersion)
    );
    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }
    const alreadyRead = notification.isRead === true;
    if (!alreadyRead) await notification.markAsRead();
    return res.status(200).json({ success: true, message: "Notification marked as read", data: { alreadyRead } });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to mark notification as read"
    });
  }
});

router.put("/read-all", protect, async (req, res) => {
  try {
    const userId = (req as { user?: { _id?: string } }).user?._id;
    if (!userId) return res.status(401).json({ success: false, message: "Authenticated user is required" });
    const platform = safeString(req.body?.platform ?? req.query.platform, 40).toLowerCase();
    const appVersion = safeString(req.body?.appVersion ?? req.query.appVersion, 40);
    await Notification.updateMany(
      withClientVisibility({ recipient: userId, isRead: false, deletedAt: null, archivedAt: null }, platform, appVersion),
      { isRead: true, readAt: new Date() }
    );
    return res.status(200).json({ success: true, message: "All notifications marked as read" });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to mark all notifications as read"
    });
  }
});

router.put("/:id/archive", protect, async (req, res) => {
  try {
    const userId = getUserId(req as { user?: { _id?: string } });
    if (!userId) return res.status(401).json({ success: false, message: "Authenticated user is required" });
    if (!isObjectId(req.params.id)) return res.status(404).json({ success: false, message: "Notification not found" });
    const notification = await Notification.findOne({ _id: req.params.id, recipient: userId, deletedAt: null });
    if (!notification) return res.status(404).json({ success: false, message: "Notification not found" });
    notification.archivedAt = new Date();
    await notification.save();
    return res.json({ success: true, message: "Notification archived" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to archive notification" });
  }
});

router.put("/:id/unarchive", protect, async (req, res) => {
  try {
    const userId = getUserId(req as { user?: { _id?: string } });
    if (!userId) return res.status(401).json({ success: false, message: "Authenticated user is required" });
    if (!isObjectId(req.params.id)) return res.status(404).json({ success: false, message: "Notification not found" });
    const notification = await Notification.findOne({ _id: req.params.id, recipient: userId, deletedAt: null });
    if (!notification) return res.status(404).json({ success: false, message: "Notification not found" });
    notification.archivedAt = null;
    await notification.save();
    return res.json({ success: true, message: "Notification restored" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to restore notification" });
  }
});

router.delete("/:id", protect, async (req, res) => {
  try {
    const userId = (req as { user?: { _id?: string } }).user?._id;
    const { id } = req.params;
    if (!userId) return res.status(401).json({ success: false, message: "Authenticated user is required" });
    if (!isObjectId(id)) return res.status(404).json({ success: false, message: "Notification not found" });
    const notification = await Notification.findOne({ _id: id, recipient: userId, deletedAt: null });
    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }
    notification.deletedAt = new Date();
    notification.archivedAt = null;
    notification.isRead = true;
    notification.readAt = notification.readAt || new Date();
    await notification.save();
    return res.status(200).json({ success: true, message: "Notification deleted" });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to delete notification"
    });
  }
});

export default router;
