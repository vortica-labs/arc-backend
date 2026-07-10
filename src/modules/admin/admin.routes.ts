import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { adminController, auditLog, durableMutationAudit, requireAdminPermission, requireSuperAdmin } from "./admin.legacy-adapters";
import { requireHardcodedAdminAuth } from "./admin-auth.middleware";
import broadcastRoutes from "./broadcast.routes";
import broadcastTemplateRoutes from "./broadcast-template.routes";
import premiumMembershipRoutes from "./premium-membership.routes";
import pushRoutes from "./push.routes";
import { premiumMembershipController } from "./premium-membership.legacy-adapters";
import { adminBankDetailsController } from "./admin-bank-details.legacy-adapters";
import { adminMonetizationController } from "./admin-monetization.legacy-adapters";

const router = Router();
export const rejectStructuredAdminQuery = (req: Request, res: Response, next: NextFunction) => {
  const invalidField = Object.entries(req.query || {}).find(([, value]) => typeof value !== "string");
  if (invalidField) {
    return res.status(400).json({
      success: false,
      code: "INVALID_QUERY_FILTER",
      message: `Query filter ${invalidField[0]} must be a single string value`
    });
  }
  return next();
};
const mongoObjectIdPattern = /^[a-f\d]{24}$/i;
for (const parameterName of ["userId", "postId", "tournamentId", "scrimId", "reportId", "campaignId", "applicationId", "id"]) {
  router.param(parameterName, (_req, res, next, value) => {
    if (!mongoObjectIdPattern.test(String(value || ""))) {
      return res.status(400).json({
        success: false,
        code: "INVALID_RESOURCE_ID",
        message: `Valid ${parameterName} is required`
      });
    }
    return next();
  });
}
const legacyPremiumMutationLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many premium membership mutations. Try again shortly." }
});
const sensitiveBankRevealLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many sensitive bank-detail requests. Try again later." }
});
const financialMutationLimiter = rateLimit({
  windowMs: 5 * 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many financial administration actions. Try again shortly." }
});

// All admin routes are protected by the hardcoded-admin JWT check
router.use(requireHardcodedAdminAuth);
router.use(rejectStructuredAdminQuery);
router.use((_, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
});
router.use("/monetization", (req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    return financialMutationLimiter(req, res, next);
  }
  return next();
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
router.get("/scrims", auditLog("VIEW_SCRIMS"), requireAdminPermission("tournaments:manage"), adminController.getScrims);
router.delete("/scrims/:scrimId", auditLog("DELETE_SCRIM"), requireAdminPermission("tournaments:manage"), adminController.deleteScrim);
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
router.get("/monetization/dashboard", auditLog("VIEW_MONETIZATION_DASHBOARD"), requireAdminPermission("monetization:read"), adminMonetizationController.getDashboard);
router.get("/monetization/charts", auditLog("VIEW_MONETIZATION_CHARTS"), requireAdminPermission("monetization:read"), adminMonetizationController.getCharts);
router.get("/monetization/leaderboards", auditLog("VIEW_MONETIZATION_LEADERBOARDS"), requireAdminPermission("monetization:read"), adminMonetizationController.getLeaderboards);
router.get("/monetization/reports/export", auditLog("EXPORT_MONETIZATION_REPORT"), requireAdminPermission("financial_reports:export"), adminMonetizationController.exportReports);
router.post("/monetization/reports/export", auditLog("EXPORT_MONETIZATION_REPORT"), requireAdminPermission("financial_reports:export"), adminMonetizationController.exportReports);
router.get("/monetization/reports", auditLog("VIEW_MONETIZATION_REPORTS"), requireAdminPermission("monetization:read"), adminMonetizationController.getReports);
router.get("/monetization/audit-logs", auditLog("VIEW_MONETIZATION_AUDIT_LOGS"), requireAdminPermission("audit:read"), adminMonetizationController.getAuditLogs);
router.get("/monetization/bank-details/export.csv", auditLog("EXPORT_CREATOR_BANK_DETAILS"), requireAdminPermission("bank_details:read"), requireAdminPermission("financial_reports:export"), adminBankDetailsController.exportCsv);
router.get("/monetization/bank-details/export.xls", auditLog("EXPORT_CREATOR_BANK_DETAILS_EXCEL"), requireAdminPermission("bank_details:read"), requireAdminPermission("financial_reports:export"), adminBankDetailsController.exportExcel);
router.get("/monetization/bank-details", auditLog("VIEW_CREATOR_BANK_DETAILS_LIST"), requireAdminPermission("bank_details:read"), adminBankDetailsController.listBankDetails);
router.get("/monetization/bank-details/:id/history", auditLog("VIEW_CREATOR_BANK_DETAILS_HISTORY"), requireAdminPermission("bank_details:read"), adminBankDetailsController.getHistory);
router.get("/monetization/bank-details/:id", auditLog("VIEW_CREATOR_BANK_DETAILS_MASKED"), requireAdminPermission("bank_details:read"), adminBankDetailsController.getBankDetails);
router.patch("/monetization/bank-details/:id/verification", auditLog("UPDATE_CREATOR_BANK_VERIFICATION"), requireSuperAdmin, durableMutationAudit("UPDATE_CREATOR_BANK_VERIFICATION"), adminBankDetailsController.updateVerification);
router.post("/monetization/bank-details/:id/request-update", auditLog("REQUEST_CREATOR_BANK_DETAILS_UPDATE"), requireSuperAdmin, durableMutationAudit("REQUEST_CREATOR_BANK_DETAILS_UPDATE"), adminBankDetailsController.requestUpdate);
router.patch("/monetization/bank-details/:id/notes", auditLog("UPDATE_CREATOR_BANK_NOTES"), requireSuperAdmin, durableMutationAudit("UPDATE_CREATOR_BANK_NOTES"), adminBankDetailsController.updateNotes);
router.post("/monetization/bank-details/:id/reveal", auditLog("REVEAL_CREATOR_BANK_DETAILS_ATTEMPT"), sensitiveBankRevealLimiter, requireSuperAdmin, adminBankDetailsController.revealBankDetails);
router.get("/monetization/applications", auditLog("VIEW_MONETIZATION_APPLICATIONS"), requireAdminPermission("monetization:manage"), adminController.getMonetizationApplications);
router.post("/monetization/applications/:applicationId/approve", auditLog("APPROVE_MONETIZATION"), requireAdminPermission("monetization:manage"), durableMutationAudit("APPROVE_MONETIZATION"), adminController.approveMonetizationApplication);
router.post("/monetization/applications/:applicationId/reject", auditLog("REJECT_MONETIZATION"), requireAdminPermission("monetization:manage"), durableMutationAudit("REJECT_MONETIZATION"), adminController.rejectMonetizationApplication);
router.post("/monetization/payout-hold/:userId", auditLog("HOLD_CREATOR_PAYOUT"), requireSuperAdmin, durableMutationAudit("HOLD_CREATOR_PAYOUT"), adminController.holdCreatorPayout);
router.post("/monetization/payout-hold/:userId/release", auditLog("RELEASE_CREATOR_PAYOUT_HOLD"), requireSuperAdmin, durableMutationAudit("RELEASE_CREATOR_PAYOUT_HOLD"), adminController.releaseCreatorPayoutHold);
router.get("/monetization/creators/export.csv", auditLog("EXPORT_CREATORS"), requireAdminPermission("financial_reports:export"), adminMonetizationController.exportCreators);
router.get("/monetization/creators/:userId/bank-details", auditLog("VIEW_CREATOR_BANK_DETAILS"), requireSuperAdmin, adminController.getCreatorBankDetailsForAdmin);
router.get("/monetization/creators/:userId/analytics", auditLog("VIEW_CREATOR_ANALYTICS"), requireAdminPermission("monetization:manage"), adminController.getCreatorAnalytics);
router.get("/monetization/creators/:userId/overview", auditLog("VIEW_CREATOR_MONETIZATION_PROFILE"), requireAdminPermission("earnings:read"), adminMonetizationController.getCreatorOverview);
router.get("/monetization/creators", auditLog("VIEW_CREATORS"), requireAdminPermission("monetization:read"), adminMonetizationController.listCreators);
router.post("/monetization/revoke/:userId", auditLog("REVOKE_MONETIZATION"), requireAdminPermission("monetization:manage"), durableMutationAudit("REVOKE_MONETIZATION"), adminController.revokeMonetization);
router.post("/monetization/grant/:userId", auditLog("GRANT_MONETIZATION"), requireAdminPermission("monetization:manage"), durableMutationAudit("GRANT_MONETIZATION"), adminController.grantMonetization);
router.post("/monetization/suspend/:userId", auditLog("SUSPEND_MONETIZATION"), requireSuperAdmin, durableMutationAudit("SUSPEND_MONETIZATION"), adminController.suspendMonetization);
router.post("/monetization/resume/:userId", auditLog("RESUME_MONETIZATION"), requireAdminPermission("monetization:manage"), durableMutationAudit("RESUME_MONETIZATION"), adminController.resumeMonetization);
router.post("/monetization/disable/:userId", auditLog("DISABLE_MONETIZATION"), requireAdminPermission("monetization:manage"), durableMutationAudit("DISABLE_MONETIZATION"), adminController.disableMonetization);
router.put("/monetization/cpm/:userId", auditLog("SET_CREATOR_CPM"), requireAdminPermission("monetization:manage"), durableMutationAudit("SET_CREATOR_CPM"), adminController.setCreatorCpm);
router.get("/monetization/cpm/:userId", auditLog("VIEW_CREATOR_CPM"), requireAdminPermission("monetization:manage"), adminController.getCreatorCpm);
router.get("/monetization/withdrawal-requests", auditLog("VIEW_WITHDRAWALS"), requireAdminPermission("monetization:manage"), adminController.listWithdrawalRequests);
router.post("/monetization/withdrawal-requests/:id/approve", auditLog("APPROVE_WITHDRAWAL"), requireSuperAdmin, durableMutationAudit("APPROVE_WITHDRAWAL"), adminController.approveWithdrawalRequest);
router.post("/monetization/withdrawal-requests/:id/reject", auditLog("REJECT_WITHDRAWAL"), requireSuperAdmin, durableMutationAudit("REJECT_WITHDRAWAL"), adminController.rejectWithdrawalRequest);
router.post("/monetization/withdrawal-requests/:id/paid", auditLog("MARK_WITHDRAWAL_PAID"), requireSuperAdmin, durableMutationAudit("MARK_WITHDRAWAL_PAID"), adminController.markWithdrawalPaid);
router.post("/monetization/withdrawal-requests/:id/failed", auditLog("MARK_WITHDRAWAL_FAILED"), requireSuperAdmin, durableMutationAudit("MARK_WITHDRAWAL_FAILED"), adminController.markWithdrawalFailed);
router.post("/monetization/withdrawal-requests/:id/cancel", auditLog("CANCEL_WITHDRAWAL"), requireSuperAdmin, durableMutationAudit("CANCEL_WITHDRAWAL"), adminController.cancelWithdrawalRequest);
router.get("/monetization/payouts/export.csv", auditLog("EXPORT_CREATOR_PAYOUTS"), requireAdminPermission("financial_reports:export"), adminController.exportCreatorPayoutsCsv);
router.post("/monetization/payouts/generate", auditLog("GENERATE_CREATOR_PAYOUTS"), requireAdminPermission("payouts:manage"), durableMutationAudit("GENERATE_CREATOR_PAYOUTS"), adminMonetizationController.generate);
router.post("/monetization/payouts/bulk/:action", auditLog("BULK_CREATOR_PAYOUT_ACTION"), requireAdminPermission("payouts:manage"), durableMutationAudit("BULK_CREATOR_PAYOUT_ACTION"), adminMonetizationController.bulkAction);
router.get("/monetization/payouts/:id/history", auditLog("VIEW_CREATOR_PAYOUT_HISTORY"), requireAdminPermission("transactions:read"), adminMonetizationController.getPayoutHistory);
router.post("/monetization/payouts/:id/statement", auditLog("GENERATE_CREATOR_PAYOUT_STATEMENT"), requireAdminPermission("financial_reports:export"), durableMutationAudit("GENERATE_CREATOR_PAYOUT_STATEMENT"), adminMonetizationController.statement);
router.get("/monetization/payouts/:id/statement", auditLog("DOWNLOAD_CREATOR_PAYOUT_STATEMENT"), requireAdminPermission("financial_reports:export"), adminMonetizationController.downloadStatement);
router.get("/monetization/payouts/:id", auditLog("VIEW_CREATOR_PAYOUT"), requireAdminPermission("transactions:read"), adminMonetizationController.getPayoutDetail);
router.get("/monetization/payouts", auditLog("VIEW_CREATOR_PAYOUTS"), requireAdminPermission("earnings:read"), adminMonetizationController.listPayouts);
router.post("/monetization/payouts/:id/approve", auditLog("APPROVE_CREATOR_PAYOUT"), requireAdminPermission("payouts:manage"), durableMutationAudit("APPROVE_CREATOR_PAYOUT"), adminMonetizationController.approvePayout);
router.post("/monetization/payouts/:id/processing", auditLog("PROCESS_CREATOR_PAYOUT"), requireAdminPermission("payouts:manage"), durableMutationAudit("PROCESS_CREATOR_PAYOUT"), adminMonetizationController.processPayout);
router.post("/monetization/payouts/:id/paid", auditLog("MARK_CREATOR_PAYOUT_PAID"), requireAdminPermission("payouts:manage"), durableMutationAudit("MARK_CREATOR_PAYOUT_PAID"), adminMonetizationController.markPayoutPaid);
router.post("/monetization/payouts/:id/failed", auditLog("MARK_CREATOR_PAYOUT_FAILED"), requireAdminPermission("payouts:manage"), durableMutationAudit("MARK_CREATOR_PAYOUT_FAILED"), adminMonetizationController.failPayout);
router.post("/monetization/payouts/:id/hold", auditLog("HOLD_CREATOR_PAYOUT"), requireAdminPermission("payouts:manage"), durableMutationAudit("HOLD_CREATOR_PAYOUT"), adminMonetizationController.holdPayout);
router.post("/monetization/payouts/:id/resume", auditLog("RESUME_CREATOR_PAYOUT"), requireAdminPermission("payouts:manage"), durableMutationAudit("RESUME_CREATOR_PAYOUT"), adminMonetizationController.resumePayout);
router.post("/monetization/payouts/:id/reject", auditLog("REJECT_CREATOR_PAYOUT"), requireAdminPermission("payouts:manage"), durableMutationAudit("REJECT_CREATOR_PAYOUT"), adminMonetizationController.rejectPayout);
router.post("/monetization/payouts/:id/cancel", auditLog("CANCEL_CREATOR_PAYOUT"), requireAdminPermission("payouts:manage"), durableMutationAudit("CANCEL_CREATOR_PAYOUT"), adminMonetizationController.cancelPayout);
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
