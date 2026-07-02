import { Router } from "express";
import rateLimit from "express-rate-limit";
import { adminController, auditLog, durableMutationAudit, requireAdminPermission, requireSuperAdmin } from "./admin.legacy-adapters";
import { requireHardcodedAdminAuth } from "./admin-auth.middleware";
import broadcastRoutes from "./broadcast.routes";
import broadcastTemplateRoutes from "./broadcast-template.routes";
import premiumMembershipRoutes from "./premium-membership.routes";
import pushRoutes from "./push.routes";
import { premiumMembershipController } from "./premium-membership.legacy-adapters";

const router = Router();
const legacyPremiumMutationLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many premium membership mutations. Try again shortly." }
});

// All admin routes are protected by the hardcoded-admin JWT check
router.use(requireHardcodedAdminAuth);
router.use((_, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
});

router.use("/broadcasts", broadcastRoutes);
router.use("/broadcast-templates", broadcastTemplateRoutes);
router.use("/premium-memberships", premiumMembershipRoutes);
router.use("/push", pushRoutes);

router.get("/dashboard", auditLog("VIEW_DASHBOARD"), requireAdminPermission("dashboard:read"), adminController.getDashboardStats);
router.get("/search", auditLog("GLOBAL_SEARCH"), requireAdminPermission("dashboard:read"), adminController.globalSearch);
router.get("/analytics/users", auditLog("VIEW_USER_ANALYTICS"), adminController.getUserAnalytics);
router.get("/health", auditLog("VIEW_SYSTEM_HEALTH"), adminController.getSystemHealth);
router.get("/activities", auditLog("VIEW_RECENT_ACTIVITIES"), adminController.getRecentActivities);
router.get("/audit-logs", auditLog("VIEW_AUDIT_LOGS"), requireAdminPermission("audit:read"), adminController.getAuditLogs);
router.get("/users", auditLog("VIEW_USERS"), requireAdminPermission("users:read"), adminController.getUsers);
router.get("/users/:userId/inspection", auditLog("INSPECT_USER_PROFILE"), requireAdminPermission("users:read"), adminController.getUserInspection);
router.put("/users/:userId/status", auditLog("UPDATE_USER_STATUS"), requireAdminPermission("users:manage"), adminController.updateUserStatus);
router.put("/users/:userId/controls", auditLog("UPDATE_USER_CONTROLS"), requireAdminPermission("users:manage"), adminController.updateUserControls);
router.post("/users/:userId/premium/grant", auditLog("GRANT_PREMIUM"), legacyPremiumMutationLimiter, requireAdminPermission("premium:manage"), durableMutationAudit("GRANT_PREMIUM"), premiumMembershipController.legacyGrant);
router.post("/users/:userId/premium/remove", auditLog("REMOVE_PREMIUM"), legacyPremiumMutationLimiter, requireAdminPermission("premium:manage"), durableMutationAudit("REMOVE_PREMIUM"), premiumMembershipController.legacyRemove);
router.put("/users/:userId/reset-password", auditLog("RESET_USER_PASSWORD"), requireAdminPermission("users:manage"), adminController.resetUserPassword);
router.delete("/users/:userId", auditLog("DELETE_USER"), requireSuperAdmin, adminController.deleteUser);
router.get("/posts", auditLog("VIEW_POSTS"), requireAdminPermission("content:manage"), adminController.getPosts);
router.delete("/posts/:postId", auditLog("DELETE_POST"), requireAdminPermission("content:manage"), adminController.deletePost);
router.get("/tournaments", auditLog("VIEW_TOURNAMENTS"), requireAdminPermission("tournaments:manage"), adminController.getTournaments);
router.delete("/tournaments/:tournamentId", auditLog("DELETE_TOURNAMENT"), requireAdminPermission("tournaments:manage"), adminController.deleteTournament);
router.get("/reports", auditLog("VIEW_REPORTS"), requireAdminPermission("reports:manage"), adminController.getReports);
router.put("/reports/:reportId", auditLog("UPDATE_REPORT"), requireAdminPermission("reports:manage"), adminController.updateReport);
router.get("/boost-campaigns", auditLog("VIEW_BOOST_CAMPAIGNS"), requireAdminPermission("boost_delivery:read"), adminController.getBoostCampaigns);
router.get("/boost-delivery", auditLog("VIEW_BOOST_DELIVERY"), requireAdminPermission("boost_delivery:read"), adminController.getBoostCampaigns);
router.post("/boost-campaigns/:campaignId/manual-delivery", auditLog("CONFIGURE_BOOST_DELIVERY"), requireAdminPermission("boost_delivery:manage"), adminController.configureBoostDelivery);
router.post("/boost-campaigns/:campaignId/delivery/configure", auditLog("CONFIGURE_BOOST_DELIVERY"), requireAdminPermission("boost_delivery:manage"), adminController.configureBoostDelivery);
router.post("/boost-campaigns/:campaignId/delivery/control", auditLog("CONTROL_BOOST_DELIVERY"), requireAdminPermission("boost_delivery:manage"), adminController.controlBoostDelivery);
router.patch("/boost-campaigns/:campaignId/delivery/adjust", auditLog("ADJUST_BOOST_DELIVERY"), requireAdminPermission("boost_delivery:manage"), adminController.adjustBoostDelivery);
router.put("/boost-campaigns/:campaignId/status", auditLog("UPDATE_BOOST_STATUS"), requireAdminPermission("boost_delivery:manage"), adminController.updateBoostCampaignStatus);
router.get("/monetization/summary", auditLog("VIEW_MONETIZATION_SUMMARY"), requireAdminPermission("monetization:manage"), adminController.getMonetizationSummary);
router.get("/monetization/applications", auditLog("VIEW_MONETIZATION_APPLICATIONS"), requireAdminPermission("monetization:manage"), adminController.getMonetizationApplications);
router.post("/monetization/applications/:applicationId/approve", auditLog("APPROVE_MONETIZATION"), requireSuperAdmin, adminController.approveMonetizationApplication);
router.post("/monetization/applications/:applicationId/reject", auditLog("REJECT_MONETIZATION"), requireSuperAdmin, adminController.rejectMonetizationApplication);
router.post("/monetization/payout-hold/:userId", auditLog("HOLD_CREATOR_PAYOUT"), requireSuperAdmin, adminController.holdCreatorPayout);
router.get("/monetization/creators/export.csv", auditLog("EXPORT_CREATORS"), requireAdminPermission("monetization:manage"), adminController.exportCreatorsCsv);
router.get("/monetization/creators/:userId/bank-details", auditLog("VIEW_CREATOR_BANK_DETAILS"), requireSuperAdmin, adminController.getCreatorBankDetailsForAdmin);
router.get("/monetization/creators/:userId/analytics", auditLog("VIEW_CREATOR_ANALYTICS"), requireAdminPermission("monetization:manage"), adminController.getCreatorAnalytics);
router.get("/monetization/creators", auditLog("VIEW_CREATORS"), requireAdminPermission("monetization:manage"), adminController.getApprovedCreators);
router.post("/monetization/revoke/:userId", auditLog("REVOKE_MONETIZATION"), requireSuperAdmin, adminController.revokeMonetization);
router.post("/monetization/grant/:userId", auditLog("GRANT_MONETIZATION"), requireSuperAdmin, adminController.grantMonetization);
router.post("/monetization/suspend/:userId", auditLog("SUSPEND_MONETIZATION"), requireSuperAdmin, adminController.suspendMonetization);
router.post("/monetization/resume/:userId", auditLog("RESUME_MONETIZATION"), requireSuperAdmin, adminController.resumeMonetization);
router.post("/monetization/disable/:userId", auditLog("DISABLE_MONETIZATION"), requireSuperAdmin, adminController.disableMonetization);
router.put("/monetization/cpm/:userId", auditLog("SET_CREATOR_CPM"), requireSuperAdmin, adminController.setCreatorCpm);
router.get("/monetization/cpm/:userId", auditLog("VIEW_CREATOR_CPM"), requireAdminPermission("monetization:manage"), adminController.getCreatorCpm);
router.get("/monetization/withdrawal-requests", auditLog("VIEW_WITHDRAWALS"), requireAdminPermission("monetization:manage"), adminController.listWithdrawalRequests);
router.post("/monetization/withdrawal-requests/:id/approve", auditLog("APPROVE_WITHDRAWAL"), requireSuperAdmin, adminController.approveWithdrawalRequest);
router.post("/monetization/withdrawal-requests/:id/reject", auditLog("REJECT_WITHDRAWAL"), requireSuperAdmin, adminController.rejectWithdrawalRequest);
router.get("/monetization/payouts/export.csv", auditLog("EXPORT_CREATOR_PAYOUTS"), requireAdminPermission("monetization:manage"), adminController.exportCreatorPayoutsCsv);
router.get("/monetization/payouts", auditLog("VIEW_CREATOR_PAYOUTS"), requireAdminPermission("monetization:manage"), adminController.listCreatorPayouts);
router.post("/monetization/payouts/:id/approve", auditLog("APPROVE_CREATOR_PAYOUT"), requireSuperAdmin, adminController.approveCreatorPayout);
router.post("/monetization/payouts/:id/processing", auditLog("PROCESS_CREATOR_PAYOUT"), requireSuperAdmin, adminController.markCreatorPayoutProcessing);
router.post("/monetization/payouts/:id/paid", auditLog("MARK_CREATOR_PAYOUT_PAID"), requireSuperAdmin, adminController.markCreatorPayoutPaid);
router.post("/monetization/payouts/:id/reject", auditLog("REJECT_CREATOR_PAYOUT"), requireSuperAdmin, adminController.rejectCreatorPayout);
router.post("/monetization/payouts/:id/cancel", auditLog("CANCEL_CREATOR_PAYOUT"), requireSuperAdmin, adminController.cancelCreatorPayout);
router.get("/host-verification/applications", auditLog("VIEW_HOST_VERIFICATION_APPLICATIONS"), requireAdminPermission("hosts:manage"), adminController.getHostVerificationApplications);
router.post(
  "/host-verification/applications/:id/approve",
  auditLog("APPROVE_HOST_VERIFICATION_APPLICATION"),
  requireAdminPermission("hosts:manage"),
  adminController.approveHostVerificationApplication
);
router.post(
  "/host-verification/applications/:id/reject",
  auditLog("REJECT_HOST_VERIFICATION_APPLICATION"),
  requireAdminPermission("hosts:manage"),
  adminController.rejectHostVerificationApplication
);
router.get("/host-verification/verified-hosts", auditLog("VIEW_VERIFIED_HOSTS"), requireAdminPermission("hosts:read"), adminController.getVerifiedHosts);
router.post("/host-verification/revoke/:userId", auditLog("REVOKE_HOST_VERIFICATION"), requireAdminPermission("hosts:manage"), adminController.revokeHostVerification);

export default router;
