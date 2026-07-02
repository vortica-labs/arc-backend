import { Router } from "express";
import {
  protect,
  publicOptionalAuth,
  recruitmentController,
  validateApplication,
  validateApplicationStatus,
  validatePlayerProfile,
  validatePlayerProfileUpdate,
  validateProfileInterest,
  validateRecruitment,
  validateRecruitmentUpdate
} from "./recruitment.legacy-adapters";

const router = Router();

router.post("/team-recruitments", protect, ...validateRecruitment, recruitmentController.createTeamRecruitment);
router.get("/team-recruitments", protect, recruitmentController.getTeamRecruitments);
router.get("/recruitment/:code", publicOptionalAuth, recruitmentController.getTeamRecruitment);
router.get("/team-recruitments/:id", publicOptionalAuth, recruitmentController.getTeamRecruitment);
router.put("/team-recruitments/:id", protect, ...validateRecruitmentUpdate, recruitmentController.updateTeamRecruitment);
router.post("/team-recruitments/:id/close", protect, recruitmentController.closeTeamRecruitment);
router.post("/team-recruitments/:id/reopen", protect, recruitmentController.reopenTeamRecruitment);
router.delete("/team-recruitments/:id", protect, recruitmentController.deleteTeamRecruitment);

router.post("/player-profiles", protect, ...validatePlayerProfile, recruitmentController.createPlayerProfile);
router.get("/player-profiles", protect, recruitmentController.getPlayerProfiles);
router.get("/player-profiles/:id", publicOptionalAuth, recruitmentController.getPlayerProfile);
router.get("/profile/:code", publicOptionalAuth, recruitmentController.getPlayerProfile);
router.put("/player-profiles/:id", protect, ...validatePlayerProfileUpdate, recruitmentController.updatePlayerProfile);
router.delete("/player-profiles/:id", protect, recruitmentController.deletePlayerProfile);

router.post("/team-recruitments/:recruitmentId/apply", protect, ...validateApplication, recruitmentController.applyToRecruitment);
router.delete("/team-recruitments/:recruitmentId/apply", protect, recruitmentController.withdrawApplication);
router.post("/team-recruitments/:recruitmentId/withdraw", protect, recruitmentController.withdrawApplication);
router.post("/recruitment/:recruitmentId/apply", protect, ...validateApplication, recruitmentController.applyToRecruitment);
router.post("/recruitment/:recruitmentId/withdraw", protect, recruitmentController.withdrawApplication);
router.post("/player-profiles/:profileId/interest", protect, ...validateProfileInterest, recruitmentController.showInterestInProfile);
router.post("/profile/:profileId/interest", protect, ...validateProfileInterest, recruitmentController.showInterestInProfile);
router.get("/applications/my", protect, recruitmentController.getUserApplications);
router.get("/applications/team", protect, recruitmentController.getTeamApplications);
router.get("/team-applications", protect, recruitmentController.getTeamApplications);
router.put("/applications/:applicationId/status", protect, ...validateApplicationStatus, recruitmentController.updateApplicationStatus);

export default router;
