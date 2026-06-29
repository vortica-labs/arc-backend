import { Router } from "express";
import { Notification, User, protect } from "./notifications.legacy-adapters";

const router = Router();

const EXPO_PUSH_TOKEN_PATTERN = /^ExponentPushToken\[[\w-]+\]$|^ExpoPushToken\[[\w-]+\]$/;
const VALID_PLATFORMS = new Set(["ios", "android", "web", "unknown"]);

const getUserId = (req: { user?: { _id?: string } }) => req.user?._id;
const safeString = (value: unknown, maxLength = 200) =>
  typeof value === "string" ? value.trim().slice(0, maxLength) : "";

router.post("/push-token", protect, async (req, res) => {
  try {
    const userId = getUserId(req as { user?: { _id?: string } });
    const {
      token,
      platform = "unknown",
      deviceName = "",
      projectId = "",
      nativeToken
    } = req.body ?? {};

    if (!userId) {
      return res.status(401).json({ success: false, message: "Authenticated user is required" });
    }

    if (typeof token !== "string" || !EXPO_PUSH_TOKEN_PATTERN.test(token)) {
      return res.status(400).json({ success: false, message: "Valid Expo push token is required" });
    }

    const normalizedPlatform = typeof platform === "string" && VALID_PLATFORMS.has(platform) ? platform : "unknown";
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
            token,
            platform: normalizedPlatform,
            deviceName: safeString(deviceName, 120),
            projectId: safeString(projectId, 120),
            ...(normalizedNativeToken ? { nativeToken: normalizedNativeToken } : {}),
            lastUsedAt: new Date(),
            createdAt: new Date()
          }
        }
      }
    );

    return res.status(200).json({
      success: true,
      message: "Push token registered",
      data: {
        platform: normalizedPlatform,
        registeredAt: new Date().toISOString()
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to register push token",
      error: error instanceof Error ? error.message : String(error)
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

    if (typeof token !== "string") {
      return res.status(400).json({ success: false, message: "Push token is required" });
    }

    await User.updateOne({ _id: userId }, { $pull: { pushTokens: { token } } });
    return res.status(200).json({ success: true, message: "Push token removed" });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to remove push token",
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

router.get("/", protect, async (req, res) => {
  try {
    const userId = getUserId(req as { user?: { _id?: string } });
    const page = Number.parseInt(String(req.query.page ?? "1"), 10) || 1;
    const limit = Number.parseInt(String(req.query.limit ?? "20"), 10) || 20;
    const skip = (page - 1) * limit;
    const isRead = req.query.isRead;

    const filter: Record<string, unknown> = { recipient: userId };
    if (isRead !== undefined) {
      filter.isRead = String(isRead) === "true";
    }

    const notifications = await Notification.find(filter)
      .populate("sender", "username profile.displayName profile.avatar")
      .populate("data.postId", "content.text")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .exec();

    const total = await Notification.countDocuments(filter);
    const unreadCount = await Notification.countDocuments({ recipient: userId, isRead: false });

    return res.status(200).json({
      success: true,
      data: {
        notifications,
        unreadCount,
        pagination: {
          current: page,
          total: Math.ceil(total / limit),
          count: notifications.length,
          totalNotifications: total
        }
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch notifications",
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

router.put("/:id/read", protect, async (req, res) => {
  try {
    const userId = (req as { user?: { _id?: string } }).user?._id;
    const { id } = req.params;
    const notification = await Notification.findOne({ _id: id, recipient: userId });
    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }
    await notification.markAsRead();
    return res.status(200).json({ success: true, message: "Notification marked as read" });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to mark notification as read",
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

router.put("/read-all", protect, async (req, res) => {
  try {
    const userId = (req as { user?: { _id?: string } }).user?._id;
    await Notification.updateMany({ recipient: userId, isRead: false }, { isRead: true, readAt: new Date() });
    return res.status(200).json({ success: true, message: "All notifications marked as read" });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to mark all notifications as read",
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

router.delete("/:id", protect, async (req, res) => {
  try {
    const userId = (req as { user?: { _id?: string } }).user?._id;
    const { id } = req.params;
    const notification = await Notification.findOne({ _id: id, recipient: userId });
    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }
    await notification.deleteOne();
    return res.status(200).json({ success: true, message: "Notification deleted" });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to delete notification",
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

export default router;
