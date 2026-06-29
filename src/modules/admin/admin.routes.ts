import { Router } from "express";
import { adminController, auditLog, requireAdminPermission, requireSuperAdmin } from "./admin.legacy-adapters";
import { requireHardcodedAdminAuth } from "./admin-auth.middleware";

const router = Router();

// All admin routes are protected by the hardcoded-admin JWT check
router.use(requireHardcodedAdminAuth);
router.use((_, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
});

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
router.post("/users/:userId/premium/grant", auditLog("GRANT_PREMIUM"), requireAdminPermission("users:manage"), adminController.grantPremium);
router.post("/users/:userId/premium/remove", auditLog("REMOVE_PREMIUM"), requireAdminPermission("users:manage"), adminController.removePremium);
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
router.get("/monetization/applications", auditLog("VIEW_MONETIZATION_APPLICATIONS"), requireAdminPermission("monetization:manage"), adminController.getMonetizationApplications);
router.post("/monetization/applications/:applicationId/approve", auditLog("APPROVE_MONETIZATION"), requireAdminPermission("monetization:manage"), adminController.approveMonetizationApplication);
router.post("/monetization/applications/:applicationId/reject", auditLog("REJECT_MONETIZATION"), requireAdminPermission("monetization:manage"), adminController.rejectMonetizationApplication);
router.post("/monetization/payout-hold/:userId", auditLog("HOLD_CREATOR_PAYOUT"), requireAdminPermission("monetization:manage"), adminController.holdCreatorPayout);
router.get("/monetization/creators", auditLog("VIEW_CREATORS"), requireAdminPermission("monetization:manage"), adminController.getApprovedCreators);
router.post("/monetization/revoke/:userId", auditLog("REVOKE_MONETIZATION"), requireAdminPermission("monetization:manage"), adminController.revokeMonetization);
router.post("/monetization/grant/:userId", auditLog("GRANT_MONETIZATION"), requireAdminPermission("monetization:manage"), adminController.grantMonetization);
router.put("/monetization/cpm/:userId", auditLog("SET_CREATOR_CPM"), requireAdminPermission("monetization:manage"), adminController.setCreatorCpm);
router.get("/monetization/cpm/:userId", auditLog("VIEW_CREATOR_CPM"), requireAdminPermission("monetization:manage"), adminController.getCreatorCpm);
router.get("/monetization/withdrawal-requests", auditLog("VIEW_WITHDRAWALS"), requireAdminPermission("monetization:manage"), adminController.listWithdrawalRequests);
router.post("/monetization/withdrawal-requests/:id/approve", auditLog("APPROVE_WITHDRAWAL"), requireAdminPermission("monetization:manage"), adminController.approveWithdrawalRequest);
router.post("/monetization/withdrawal-requests/:id/reject", auditLog("REJECT_WITHDRAWAL"), requireAdminPermission("monetization:manage"), adminController.rejectWithdrawalRequest);
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
