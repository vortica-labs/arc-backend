const express = require('express');
const router = express.Router();
const { 
  createTournament, 
  getTournaments, 
  getTournament, 
  getTournamentByName,
  updateTournament, 
  joinTournament, 
  leaveTournament,
  leaveTournamentAsTeam, 
  autoAssignGroups, 
  sendTournamentMessage, 
  sendGroupMessage, 
  getTournamentMessages, 
  getGroupMessages, 
  deleteTournamentMessage,
  deleteGroupMessage,
  startTournament, 
  deleteTournament, 
  cancelTournament, 
  scheduleMatches,
  createMatchSchedule,
  updateMatchSchedule,
  getTournamentSchedule,
  configureScheduleSettings,
  deleteMatchFromSchedule,
  deleteRoundSchedule,
  broadcastSchedule,
  updateMatchResult, 
  startMatch, 
  getTournamentParticipants, 
  removeParticipant, 
  assignParticipantToGroup, 
  updateRoundSettings, 
  recreateGroups,
  submitGroupResults,
  getRoundResults,
  qualifyTeams,
  createNextRoundGroups,
  getQualificationStatus,
  saveQualificationSettings,
  getQualificationSettings,
  createRound2,
  autoAssignRound2,
  openRegistration,
  getHostingLimits
} = require('../controllers/tournamentController');
const { protect, publicOptionalAuth } = require('../middleware/auth');

// Most routes require authentication, but GET tournaments should be public
// router.use(protect); // Commented out to allow public access to some routes

// Hosting limits check (must be before /:id routes)
router.get('/hosting-limits', protect, getHostingLimits);

// Tournament CRUD operations
router.route('/')
  .get(publicOptionalAuth, getTournaments) // Public access; validate and attach a supplied token
  .post(protect, createTournament); // Requires authentication

// Public shareable link route (must come before /:id route)
router.get('/code/:code', publicOptionalAuth, getTournament); // Public access - shareable link

// Get tournament by name and host username
router.get('/by-name/:tournamentName/:hostUsername', publicOptionalAuth, getTournamentByName); // Public access for guest users

router.route('/:id')
  .get(publicOptionalAuth, getTournament) // Public access for guest users
  .put(protect, updateTournament)
  .delete(protect, deleteTournament);

// Tournament participation
router.post('/:id/join', protect, joinTournament);
router.post('/:id/leave', protect, leaveTournament);
router.post('/:id/leave-team', protect, leaveTournamentAsTeam);

// Tournament management (host only)
router.post('/:id/assign-groups', protect, autoAssignGroups);
router.post('/:id/start', protect, startTournament);
router.post('/:id/schedule-matches', protect, scheduleMatches);
router.put('/:id/cancel', protect, cancelTournament);

// Messaging system
router.post('/:id/tournament-message', protect, sendTournamentMessage);
router.post('/:id/group-message', protect, sendGroupMessage);
router.get('/:id/tournament-messages', protect, getTournamentMessages);
router.get('/:id/group-messages', protect, getGroupMessages);
router.delete('/:id/tournament-message/:messageIndex', protect, deleteTournamentMessage);
router.delete('/:id/group-message/:groupId/:round/:messageIndex', protect, deleteGroupMessage);

// Match management (host only)
router.post('/:id/start-match', protect, startMatch);
router.post('/:id/update-match-result', protect, updateMatchResult);

// Participant management
router.get('/:id/participants', protect, getTournamentParticipants);
router.post('/:id/remove-participant', protect, removeParticipant);
router.post('/:id/assign-participant', protect, assignParticipantToGroup);

// Round settings management
router.put('/:id/round-settings', protect, updateRoundSettings);
router.post('/:id/recreate-groups', protect, recreateGroups);

// Schedule management (host only)
router.post('/:id/schedule', protect, createMatchSchedule);
router.get('/:id/schedule', protect, getTournamentSchedule);
router.put('/:id/schedule/:matchId', protect, updateMatchSchedule);
router.delete('/:id/schedule/:matchId', protect, deleteMatchFromSchedule);
router.delete('/:id/schedule/round/:round', protect, deleteRoundSchedule);
router.put('/:id/schedule-config', protect, configureScheduleSettings);
router.post('/:id/broadcast-schedule', protect, broadcastSchedule);

// Results and Qualification management (host only)
router.post('/:id/results', protect, submitGroupResults);
router.get('/:id/results/:round', protect, getRoundResults);
router.post('/:id/qualify', protect, qualifyTeams);
router.post('/:id/next-round', protect, createNextRoundGroups);
router.get('/:id/qualification-status', protect, getQualificationStatus);
router.post('/:id/qualification-settings', protect, saveQualificationSettings);
router.get('/:id/qualification-settings', protect, getQualificationSettings);
router.post('/:id/create-round-2', protect, createRound2);
router.post('/:id/auto-assign-round-2', protect, autoAssignRound2);

// Prize & Final Result management
const { updatePrizeDistribution, generateFinalResult, assignSpecialPrize } = require('../controllers/tournamentController');
router.post('/:id/prize-distribution', protect, updatePrizeDistribution);
router.post('/:id/generate-final-result', protect, generateFinalResult);
router.post('/:id/assign-special-prize', protect, assignSpecialPrize);

// Registration and tournament control routes
router.post('/:id/open-registration', protect, openRegistration);
router.post('/:id/start', protect, startTournament);

module.exports = router;
