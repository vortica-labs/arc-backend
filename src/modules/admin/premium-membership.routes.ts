import { Router } from "express";
import rateLimit from "express-rate-limit";
import { auditLog, durableMutationAudit, requireAdminPermission } from "./admin.legacy-adapters";
import { premiumMembershipController } from "./premium-membership.legacy-adapters";

const router = Router();
const mutationLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many premium membership mutations. Try again shortly." }
});

router.get("/dashboard", auditLog("VIEW_PREMIUM_DASHBOARD"), requireAdminPermission("premium:read"), premiumMembershipController.getDashboard);
router.get("/eligible-users", auditLog("SEARCH_PREMIUM_ELIGIBLE_USERS"), requireAdminPermission("premium:manage"), premiumMembershipController.eligibleUsers);
router.get("/", auditLog("VIEW_PREMIUM_MEMBERSHIPS"), requireAdminPermission("premium:read"), premiumMembershipController.listMemberships);
router.post("/grant", auditLog("GRANT_PREMIUM_MEMBERSHIP"), mutationLimiter, requireAdminPermission("premium:manage"), durableMutationAudit("GRANT_PREMIUM_MEMBERSHIP"), premiumMembershipController.grant);
router.get("/:id/payments", auditLog("VIEW_PREMIUM_PAYMENTS"), requireAdminPermission("premium:read"), premiumMembershipController.getPayments);
router.get("/:id/timeline", auditLog("VIEW_PREMIUM_TIMELINE"), requireAdminPermission("premium:read"), premiumMembershipController.getTimeline);
router.get("/:id/login-history", auditLog("VIEW_PREMIUM_LOGIN_HISTORY"), requireAdminPermission("premium:read"), premiumMembershipController.getLoginHistory);
router.get("/:id", auditLog("VIEW_PREMIUM_MEMBERSHIP"), requireAdminPermission("premium:read"), premiumMembershipController.getMembership);
router.post("/:id/extend", auditLog("EXTEND_PREMIUM_MEMBERSHIP"), mutationLimiter, requireAdminPermission("premium:manage"), durableMutationAudit("EXTEND_PREMIUM_MEMBERSHIP"), premiumMembershipController.extend);
router.post("/:id/change-plan", auditLog("CHANGE_PREMIUM_PLAN"), mutationLimiter, requireAdminPermission("premium:manage"), durableMutationAudit("CHANGE_PREMIUM_PLAN"), premiumMembershipController.changePlan);
router.post("/:id/cancel", auditLog("CANCEL_PREMIUM_MEMBERSHIP"), mutationLimiter, requireAdminPermission("premium:cancel"), durableMutationAudit("CANCEL_PREMIUM_MEMBERSHIP"), premiumMembershipController.cancel);
router.post("/:id/remove", auditLog("REMOVE_PREMIUM_MEMBERSHIP"), mutationLimiter, requireAdminPermission("premium:manage"), durableMutationAudit("REMOVE_PREMIUM_MEMBERSHIP"), premiumMembershipController.remove);
router.post("/:id/resume", auditLog("RESUME_PREMIUM_MEMBERSHIP"), mutationLimiter, requireAdminPermission("premium:cancel"), durableMutationAudit("RESUME_PREMIUM_MEMBERSHIP"), premiumMembershipController.resume);
router.post("/:id/auto-renew", auditLog("SET_PREMIUM_AUTO_RENEW"), mutationLimiter, requireAdminPermission("premium:cancel"), durableMutationAudit("SET_PREMIUM_AUTO_RENEW"), premiumMembershipController.autoRenew);
router.post("/:id/refund", auditLog("REFUND_PREMIUM_PAYMENT"), mutationLimiter, requireAdminPermission("premium:refund"), durableMutationAudit("REFUND_PREMIUM_PAYMENT"), premiumMembershipController.refund);
router.post("/:id/reconcile", auditLog("RECONCILE_PREMIUM_MEMBERSHIP"), mutationLimiter, requireAdminPermission("premium:manage"), durableMutationAudit("RECONCILE_PREMIUM_MEMBERSHIP"), premiumMembershipController.reconcile);

export default router;
