import { Router } from "express";
import rateLimit from "express-rate-limit";
import path from "path";
import { backendControllerPath } from "../legacy/legacy.paths";
import { auditLog, durableMutationAudit, requireAdminPermission } from "./admin.legacy-adapters";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const controller = require(path.join(backendControllerPath, "broadcastController.js"));

const router = Router();

const mutationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many broadcast changes. Try again later." }
});

const sendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Broadcast send limit reached. Try again later." }
});

router.get("/dashboard", auditLog("VIEW_BROADCAST_DASHBOARD"), requireAdminPermission("broadcasts:read"), controller.getDashboard);
router.get("/delivery-logs", auditLog("VIEW_BROADCAST_DELIVERY_LOGS"), requireAdminPermission("broadcasts:read"), controller.getDeliveryLogs);
router.post("/preview", auditLog("PREVIEW_BROADCAST_PAYLOAD"), requireAdminPermission("broadcasts:read"), controller.previewPayload);
router.get("/", auditLog("VIEW_BROADCASTS"), requireAdminPermission("broadcasts:read"), controller.listBroadcasts);
router.post("/", auditLog("CREATE_BROADCAST"), mutationLimiter, requireAdminPermission("broadcasts:manage"), durableMutationAudit("CREATE_BROADCAST"), controller.createBroadcast);
router.get("/:id", auditLog("VIEW_BROADCAST"), requireAdminPermission("broadcasts:read"), controller.getBroadcast);
router.patch("/:id", auditLog("UPDATE_BROADCAST"), mutationLimiter, requireAdminPermission("broadcasts:manage"), durableMutationAudit("UPDATE_BROADCAST"), controller.updateBroadcast);
router.delete("/:id", auditLog("DELETE_BROADCAST"), mutationLimiter, requireAdminPermission("broadcasts:manage"), durableMutationAudit("DELETE_BROADCAST"), controller.deleteBroadcast);
router.post("/:id/duplicate", auditLog("DUPLICATE_BROADCAST"), mutationLimiter, requireAdminPermission("broadcasts:manage"), durableMutationAudit("DUPLICATE_BROADCAST"), controller.duplicateBroadcast);
router.post("/:id/preview", auditLog("PREVIEW_BROADCAST"), requireAdminPermission("broadcasts:read"), controller.previewBroadcast);
router.post("/:id/send", auditLog("SEND_BROADCAST"), sendLimiter, requireAdminPermission("broadcasts:send"), durableMutationAudit("SEND_BROADCAST"), controller.sendBroadcast);
router.post("/:id/retry-failed", auditLog("RETRY_FAILED_BROADCAST_NOTIFICATIONS"), sendLimiter, requireAdminPermission("broadcasts:send"), durableMutationAudit("RETRY_FAILED_BROADCAST_NOTIFICATIONS"), controller.retryFailedNotifications);
router.post("/:id/cancel", auditLog("CANCEL_BROADCAST"), mutationLimiter, requireAdminPermission("broadcasts:manage"), durableMutationAudit("CANCEL_BROADCAST"), controller.cancelBroadcast);
router.get("/:id/analytics", auditLog("VIEW_BROADCAST_ANALYTICS"), requireAdminPermission("broadcasts:read"), controller.getAnalytics);
router.get("/:id/recipients", auditLog("VIEW_BROADCAST_RECIPIENTS"), requireAdminPermission("broadcasts:read"), controller.getRecipients);

export default router;
