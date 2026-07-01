import { Router } from "express";
import rateLimit from "express-rate-limit";
import path from "path";
import { backendControllerPath } from "../legacy/legacy.paths";
import { auditLog, durableMutationAudit, requireAdminPermission } from "./admin.legacy-adapters";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const controller = require(path.join(backendControllerPath, "broadcastController.js"));
const router = Router();

const templateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many template changes. Try again later." }
});

router.get("/", auditLog("VIEW_BROADCAST_TEMPLATES"), requireAdminPermission("broadcasts:read"), controller.listTemplates);
router.post("/", auditLog("CREATE_BROADCAST_TEMPLATE"), templateLimiter, requireAdminPermission("broadcasts:manage"), durableMutationAudit("CREATE_BROADCAST_TEMPLATE"), controller.createTemplate);
router.patch("/:id", auditLog("UPDATE_BROADCAST_TEMPLATE"), templateLimiter, requireAdminPermission("broadcasts:manage"), durableMutationAudit("UPDATE_BROADCAST_TEMPLATE"), controller.updateTemplate);
router.delete("/:id", auditLog("DELETE_BROADCAST_TEMPLATE"), templateLimiter, requireAdminPermission("broadcasts:manage"), durableMutationAudit("DELETE_BROADCAST_TEMPLATE"), controller.deleteTemplate);

export default router;
