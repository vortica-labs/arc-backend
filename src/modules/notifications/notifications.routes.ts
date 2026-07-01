import { Router } from "express";
import path from "path";
import { Notification, User, protect } from "./notifications.legacy-adapters";
import { backendRootPath } from "../legacy/legacy.paths";

const router = Router();

const EXPO_PUSH_TOKEN_PATTERN = /^ExponentPushToken\[[\w-]+\]$|^ExpoPushToken\[[\w-]+\]$/;
const EXPO_PUSH_TOKEN_MAX_LENGTH = 512;
const MAX_PUSH_TOKENS_PER_USER = 10;
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
  token.length <= 24 ? token : `${token.slice(0, 12)}...${token.slice(-8)}`;
const isObjectId = (value: unknown) => typeof value === "string" && OBJECT_ID_PATTERN.test(value);
const trackingPlatform = (value: unknown) => {
  const platform = safeString(value, 40).toLowerCase();
  return VALID_TRACKING_PLATFORMS.has(platform) ? platform : "unknown";
};
const latestPushDiagnostics = new Map<string, Record<string, unknown>>();

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
const { trackDelivery, trackEvent } = require(path.join(backendRootPath, "services", "broadcastService.js"));

const serializePushToken = (entry: Record<string, unknown>) => {
  const token = typeof entry.token === "string" ? entry.token : "";
  const nativeToken = entry.nativeToken && typeof entry.nativeToken === "object"
    ? entry.nativeToken as Record<string, unknown>
    : undefined;

  return {
    tokenPreview: maskToken(token),
    isValidExpoToken: EXPO_PUSH_TOKEN_PATTERN.test(token),
    platform: safeString(entry.platform, 40) || "unknown",
    deviceName: safeString(entry.deviceName, 120),
    projectId: safeString(entry.projectId, 120),
    appVersion: safeString(entry.appVersion, 40),
    nativeTokenType: safeString(nativeToken?.type, 40),
    lastUsedAt: entry.lastUsedAt,
    createdAt: entry.createdAt
  };
};

const countRegisteredPushTokens = async (userId: string) => {
  const user = await User.findById(userId).select("pushTokens").lean();
  const pushTokens = Array.isArray(user?.pushTokens) ? user.pushTokens : [];
  return {
    pushTokenCount: pushTokens.length,
    validExpoPushTokenCount: pushTokens.filter((entry: Record<string, unknown>) =>
      typeof entry?.token === "string" && EXPO_PUSH_TOKEN_PATTERN.test(entry.token)
    ).length
  };
};

const sendDiagnosticPush = async (userId: string) => {
  const notification = await Notification.createNotification({
    recipient: userId,
    type: "system",
    title: "SquadHunt test notification",
    message: "Native push delivery is working on this device.",
    data: {
      customData: {
        url: "/notifications",
        diagnostic: true
      }
    },
    sendPush: false
  });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { sendPushNotification } = require(path.join(backendRootPath, "utils", "pushNotificationService.js"));
  const result = await sendPushNotification(userId, notification);
  const diagnostics = {
    notificationId: String(notification?._id || ""),
    sentAt: new Date().toISOString(),
    ...result
  };
  latestPushDiagnostics.set(userId, diagnostics);
  return diagnostics;
};

router.post("/push-token", protect, async (req, res) => {
  try {
    const userId = getUserId(req as { user?: { _id?: string } });
    const {
      token,
      platform = "unknown",
      deviceName = "",
      projectId = "",
      appVersion = "",
      nativeToken
    } = req.body ?? {};

    if (!userId) {
      return res.status(401).json({ success: false, message: "Authenticated user is required" });
    }

    if (typeof token !== "string" || token.length > EXPO_PUSH_TOKEN_MAX_LENGTH || !EXPO_PUSH_TOKEN_PATTERN.test(token)) {
      return res.status(400).json({ success: false, message: "Valid Expo push token is required" });
    }

    const requestedPlatform = safeString(platform, 40).toLowerCase();
    const normalizedPlatform = VALID_PLATFORMS.has(requestedPlatform) ? requestedPlatform : "unknown";
    const normalizedNativeToken = nativeToken && typeof nativeToken === "object"
      ? {
          type: safeString((nativeToken as Record<string, unknown>).type, 40),
          data: safeString((nativeToken as Record<string, unknown>).data, 2048)
        }
      : undefined;

    // A physical device token should belong to exactly one authenticated account.
    // Remove it everywhere first so stale sessions do not receive future pushes.
    await User.updateMany(
      { "pushTokens.token": token },
      {
        $pull: { pushTokens: { token } }
      }
    );

    await User.updateOne(
      { _id: userId },
      {
        $push: {
          pushTokens: {
            $each: [{
            token,
            platform: normalizedPlatform,
            deviceName: safeString(deviceName, 120),
            projectId: safeString(projectId, 120),
            appVersion: safeString(appVersion, 40),
            ...(normalizedNativeToken ? { nativeToken: normalizedNativeToken } : {}),
            lastUsedAt: new Date(),
            createdAt: new Date()
            }],
            $slice: -MAX_PUSH_TOKENS_PER_USER
          }
        }
      }
    );
    const tokenCounts = await countRegisteredPushTokens(userId);

    return res.status(200).json({
      success: true,
      message: "Push token registered",
      data: {
        platform: normalizedPlatform,
        appVersion: safeString(appVersion, 40),
        registeredAt: new Date().toISOString(),
        ...tokenCounts
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to register push token"
    });
  }
});

router.post("/client-context", protect, async (req, res) => {
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

router.delete("/push-token", protect, async (req, res) => {
  try {
    const userId = getUserId(req as { user?: { _id?: string } });
    const { token } = req.body ?? {};

    if (!userId) {
      return res.status(401).json({ success: false, message: "Authenticated user is required" });
    }

    if (typeof token !== "string" || token.length > EXPO_PUSH_TOKEN_MAX_LENGTH || !EXPO_PUSH_TOKEN_PATTERN.test(token)) {
      return res.status(400).json({ success: false, message: "Valid Expo push token is required" });
    }

    await User.updateOne({ _id: userId }, { $pull: { pushTokens: { token } } });
    return res.status(200).json({ success: true, message: "Push token removed" });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to remove push token"
    });
  }
});

router.get("/push-status", protect, async (req, res) => {
  try {
    const userId = getUserId(req as { user?: { _id?: string } });

    if (!userId) {
      return res.status(401).json({ success: false, message: "Authenticated user is required" });
    }

    const user = await User.findById(userId).select("pushTokens notificationClients notificationSettings").lean();
    const pushTokens = Array.isArray(user?.pushTokens) ? user.pushTokens : [];
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
        lastTestPush: latestPushDiagnostics.get(userId) ?? null,
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
    return res.status(500).json({
      success: false,
      message: "Failed to fetch push notification status"
    });
  }
});

router.post("/push-test", protect, async (req, res) => {
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

    const diagnostics = await sendDiagnosticPush(userId);
    return res.status(200).json({
      success: true,
      message: "Test push notification sent",
      data: {
        ...tokenCounts,
        testPush: diagnostics
      }
    });
  } catch (error) {
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
  if (!deliveryLog) return null;
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
};

router.post("/:id/delivered", protect, async (req, res) => {
  try {
    const userId = getUserId(req as { user?: { _id?: string } });
    if (!userId) return res.status(401).json({ success: false, message: "Authenticated user is required" });
    const owned = await resolveOwnedBroadcastDelivery(req.params.id, userId);
    if (!owned) return res.status(404).json({ success: false, message: "Notification not found" });
    const result = await trackDelivery({
      notification: owned.notification,
      userId,
      platform: trackingPlatform(req.body?.platform),
      metadata: { source: safeString(req.body?.source, 80) }
    });
    return res.json({ success: true, data: result });
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
    const result = await trackEvent({
      notification: owned.notification,
      userId,
      eventType: "open",
      platform: trackingPlatform(req.body?.platform),
      metadata: { source: safeString(req.body?.source, 80) }
    });
    return res.json({ success: true, data: result });
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
    await trackEvent({
      notification: owned.notification,
      userId,
      eventType: "open",
      platform: trackingPlatform(req.body?.platform),
      metadata: { source: "click" }
    });
    const result = await trackEvent({
      notification: owned.notification,
      userId,
      eventType: "click",
      url: safeString(req.body?.url, 2048),
      platform: trackingPlatform(req.body?.platform),
      metadata: { source: safeString(req.body?.source, 80) }
    });
    return res.json({ success: true, data: result });
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

    const notifications = await Notification.find(filter)
      .populate("sender", "username profile.displayName profile.avatar")
      .populate("data.postId", "content.text")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .exec();

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
