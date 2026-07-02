import { Router } from "express";
import { protect, publicOptionalAuth, tournamentController } from "./tournaments.legacy-adapters";

const router = Router();

router.get("/hosting-limits", protect, tournamentController.getHostingLimits);

router.route("/")
  .get(publicOptionalAuth, tournamentController.getTournaments)
  .post(protect, tournamentController.createTournament);

router.get("/code/:code", publicOptionalAuth, tournamentController.getTournament);
router.get("/by-name/:tournamentName/:hostUsername", publicOptionalAuth, tournamentController.getTournamentByName);

router.route("/:id")
  .get(publicOptionalAuth, tournamentController.getTournament)
  .put(protect, tournamentController.updateTournament)
  .delete(protect, tournamentController.deleteTournament);

router.post("/:id/join", protect, tournamentController.joinTournament);
router.post("/:id/leave", protect, tournamentController.leaveTournament);
router.post("/:id/leave-team", protect, tournamentController.leaveTournamentAsTeam);
router.post("/:id/assign-groups", protect, tournamentController.autoAssignGroups);
router.post("/:id/start", protect, tournamentController.startTournament);
router.post("/:id/schedule-matches", protect, tournamentController.scheduleMatches);
router.put("/:id/cancel", protect, tournamentController.cancelTournament);
router.post("/:id/tournament-message", protect, tournamentController.sendTournamentMessage);
router.post("/:id/group-message", protect, tournamentController.sendGroupMessage);
router.get("/:id/tournament-messages", protect, tournamentController.getTournamentMessages);
router.get("/:id/group-messages", protect, tournamentController.getGroupMessages);
router.delete("/:id/tournament-message/:messageIndex", protect, tournamentController.deleteTournamentMessage);
router.delete("/:id/group-message/:groupId/:round/:messageIndex", protect, tournamentController.deleteGroupMessage);
router.post("/:id/start-match", protect, tournamentController.startMatch);
router.post("/:id/update-match-result", protect, tournamentController.updateMatchResult);
router.get("/:id/participants", protect, tournamentController.getTournamentParticipants);
router.post("/:id/remove-participant", protect, tournamentController.removeParticipant);
router.post("/:id/assign-participant", protect, tournamentController.assignParticipantToGroup);
router.put("/:id/round-settings", protect, tournamentController.updateRoundSettings);
router.post("/:id/recreate-groups", protect, tournamentController.recreateGroups);
router.post("/:id/schedule", protect, tournamentController.createMatchSchedule);
router.get("/:id/schedule", protect, tournamentController.getTournamentSchedule);
router.put("/:id/schedule/:matchId", protect, tournamentController.updateMatchSchedule);
router.delete("/:id/schedule/:matchId", protect, tournamentController.deleteMatchFromSchedule);
router.delete("/:id/schedule/round/:round", protect, tournamentController.deleteRoundSchedule);
router.put("/:id/schedule-config", protect, tournamentController.configureScheduleSettings);
router.post("/:id/broadcast-schedule", protect, tournamentController.broadcastSchedule);
router.post("/:id/results", protect, tournamentController.submitGroupResults);
router.get("/:id/results/:round", protect, tournamentController.getRoundResults);
router.post("/:id/qualify", protect, tournamentController.qualifyTeams);
router.post("/:id/next-round", protect, tournamentController.createNextRoundGroups);
router.get("/:id/qualification-status", protect, tournamentController.getQualificationStatus);
router.post("/:id/qualification-settings", protect, tournamentController.saveQualificationSettings);
router.get("/:id/qualification-settings", protect, tournamentController.getQualificationSettings);
router.post("/:id/create-round-2", protect, tournamentController.createRound2);
router.post("/:id/auto-assign-round-2", protect, tournamentController.autoAssignRound2);
router.post("/:id/prize-distribution", protect, tournamentController.updatePrizeDistribution);
router.post("/:id/generate-final-result", protect, tournamentController.generateFinalResult);
router.post("/:id/assign-special-prize", protect, tournamentController.assignSpecialPrize);
router.post("/:id/open-registration", protect, tournamentController.openRegistration);

export default router;
