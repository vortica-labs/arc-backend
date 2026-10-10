import { Router } from "express";
import { body, param } from "express-validator";
import rateLimit from "express-rate-limit";
import { handleValidationErrors, optionalAuth, publicOptionalAuth, protect, userController } from "./users.legacy-adapters";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  ROSTER_GAMES,
  STAFF_GAMES,
  TEAM_ROLE_MAX_LENGTH,
  isValidTeamRole,
  normalizeTeamRole
} = require("../../legacy-src/utils/teamInvitationPolicy.js");

const router = Router();
const avatarProxyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many avatar requests. Try again later." }
});
const profileAvailabilityLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many profile lookup requests. Try again later." }
});
const profileAvailabilityValidation = [
  param("identifier")
    .isString()
    .matches(/^[A-Za-z0-9_]{3,20}$/)
    .withMessage("Invalid username")
];

const teamIdentifierValidation = [
  param("teamId").custom((value) => {
    const identifier = typeof value === "string" ? value.trim() : "";
    if (/^[a-f0-9]{24}$/i.test(identifier) || /^[A-Za-z0-9_]{3,20}$/.test(identifier)) return true;
    throw new Error("Invalid team ID or username");
  })
];
const inviteIdValidation = [param("inviteId").isMongoId().withMessage("Invalid invite ID")];
const roleValidation = body("role")
  .isString()
  .withMessage("Role is required")
  .custom((value) => isValidTeamRole(value))
  .withMessage(`Role must be between 1 and ${TEAM_ROLE_MAX_LENGTH} characters`)
  .customSanitizer(normalizeTeamRole);
const optionalInviteFieldsValidation = [
  body("message").optional().isString().trim().isLength({ max: 500 }).withMessage("Message cannot exceed 500 characters"),
  body("inGameName").optional().isString().trim().isLength({ max: 80 }).withMessage("In-game name cannot exceed 80 characters")
];
const rosterInviteValidation = [
  body("playerId").isString().isMongoId().withMessage("Invalid player ID"),
  body("game").isIn(ROSTER_GAMES).withMessage("Invalid roster game"),
  roleValidation,
  ...optionalInviteFieldsValidation
];
const staffInviteValidation = [
  body("memberId").isString().isMongoId().withMessage("Invalid member ID"),
  body("game").optional().isIn(STAFF_GAMES).withMessage("Invalid staff game"),
  roleValidation,
  body("message").optional().isString().trim().isLength({ max: 500 }).withMessage("Message cannot exceed 500 characters")
];
const staffInviteByUsernameValidation = [
  body("username")
    .isString()
    .trim()
    .matches(/^[A-Za-z0-9_]{3,20}$/)
    .withMessage("Invalid username"),
  body("game").optional().isIn(STAFF_GAMES).withMessage("Invalid staff game"),
  roleValidation,
  body("message").optional().isString().trim().isLength({ max: 500 }).withMessage("Message cannot exceed 500 characters")
];
const cancelByUsernameValidation = [
  body("username")
    .isString()
    .trim()
    .matches(/^[A-Za-z0-9_]{3,20}$/)
    .withMessage("Invalid username")
];

router.get("/", optionalAuth, userController.getUsers);
router.get("/search", optionalAuth, userController.getUsers);
router.get("/resolve-mention/:username", protect, [param("username").matches(/^[A-Za-z0-9_]{3,20}$/)], handleValidationErrors, userController.getMentionUser);
router.post("/create-team", protect, userController.createTeam);
router.get("/avatar/:userId", avatarProxyLimiter, userController.getAvatar);
router.get("/blocked", protect, userController.getBlockedUsers);
router.post("/block/:username", protect, userController.blockUser);
router.delete("/block/:username", protect, userController.unblockUser);
router.delete("/roster-invite/:inviteId", protect, inviteIdValidation, handleValidationErrors, userController.cancelRosterInvite);
// Player-facing roster invite endpoints (list / accept / decline)
router.get("/roster-invites", protect, userController.getRosterInvites);
router.post("/roster-invites/:inviteId/accept", protect, inviteIdValidation, handleValidationErrors, userController.acceptRosterInvite);
router.post("/roster-invites/:inviteId/decline", protect, inviteIdValidation, handleValidationErrors, userController.declineRosterInvite);
router.delete("/staff-invite/:inviteId", protect, inviteIdValidation, handleValidationErrors, userController.cancelStaffInvite);
router.get("/gaming-stats", protect, userController.getGamingStats);
router.post("/gaming-stats", protect, userController.addGamingStat);
router.put("/gaming-stats/:statId", protect, userController.updateGamingStat);
router.delete("/gaming-stats/:statId", protect, userController.deleteGamingStat);
router.post("/gaming-stats/sync-coc", protect, userController.syncClashOfClansData);
router.post("/gaming-stats/sync-cr", protect, userController.syncClashRoyaleData);
router.get("/:identifier/tournaments", publicOptionalAuth, userController.getLiveTournamentHistory);
router.get("/:username/tournament-history", publicOptionalAuth, userController.getUserTournamentHistory);
router.get("/privacy-settings", protect, userController.getPrivacySettings);
router.put("/privacy-settings", protect, userController.updatePrivacySettings);
router.get("/notification-settings", protect, userController.getNotificationSettings);
router.put("/notification-settings", protect, userController.updateNotificationSettings);
router.get("/:userId/dm-privacy", protect, userController.getDmPrivacy);
router.get("/follow-requests/incoming", protect, userController.getFollowRequests);
router.post("/follow-requests/:requestId/accept", protect, userController.acceptFollowRequest);
router.post("/follow-requests/:requestId/reject", protect, userController.rejectFollowRequest);
// Existence-only direct-link probe. No profile fields or privacy state leave
// this route; authenticated profile reads continue through /:identifier.
router.get("/:identifier/availability", profileAvailabilityLimiter, profileAvailabilityValidation, handleValidationErrors, userController.getUserAvailability);
router.get("/:identifier", publicOptionalAuth, userController.getUser);
router.post("/:id/follow", protect, userController.toggleFollow);
router.delete("/:id/follow", protect, userController.toggleFollow);
router.get("/:id/followers", publicOptionalAuth, userController.getFollowers);
router.get("/:id/following", publicOptionalAuth, userController.getFollowing);
router.get("/:id/posts", publicOptionalAuth, userController.getUserPosts);
router.get("/:id/clips", publicOptionalAuth, userController.getUserClips);
router.post("/:teamId/roster/add", protect, teamIdentifierValidation, rosterInviteValidation, handleValidationErrors, userController.addPlayerToRoster);
router.delete("/:teamId/roster/:game/leave", protect, userController.leaveTeam);
router.delete("/:teamId/roster/:game/:playerId", protect, userController.removePlayerFromRoster);
router.post("/:teamId/staff/add", protect, teamIdentifierValidation, staffInviteValidation, handleValidationErrors, userController.addStaffMember);
router.post("/:teamId/staff/add-by-username", protect, teamIdentifierValidation, staffInviteByUsernameValidation, handleValidationErrors, userController.addStaffMemberByUsername);
router.delete("/:teamId/staff/cancel-by-username", protect, teamIdentifierValidation, cancelByUsernameValidation, handleValidationErrors, userController.cancelStaffInviteByUsername);
router.delete("/:teamId/staff/:playerId", protect, userController.removeStaffMember);
router.get("/:teamId/pending-invites", protect, teamIdentifierValidation, handleValidationErrors, userController.getTeamPendingInvites);
router.post("/:teamId/leave-request", protect, userController.sendLeaveRequest);
router.get("/:teamId/leave-requests", protect, userController.getTeamLeaveRequests);
router.post("/leave-requests/:requestId/approve", protect, userController.approveLeaveRequest);
router.post("/leave-requests/:requestId/reject", protect, userController.rejectLeaveRequest);

export default router;
