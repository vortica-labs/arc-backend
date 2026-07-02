const express = require('express');
const { protect, optionalAuth } = require('../middleware/auth');
const {
  getUsers,
  getUser,
  getAvatar,
  blockUser,
  unblockUser,
  getBlockedUsers,
  getLiveTournamentHistory,
  getUserTournamentHistory,
  toggleFollow,
  getFollowers,
  getFollowing,
  getUserPosts,
  getUserClips,
  addPlayerToRoster,
  addStaffMember,
  addStaffMemberByUsername,
  removePlayerFromRoster,
  removeStaffMember,
  getTeamPendingInvites,
  cancelRosterInvite,
  getRosterInvites,
  acceptRosterInvite,
  declineRosterInvite,
  cancelStaffInvite,
  cancelStaffInviteByUsername,
  leaveTeam,
  addGamingStat,
  updateGamingStat,
  deleteGamingStat,
  getGamingStats,
  syncClashOfClansData,
  syncClashRoyaleData,
  createTeam,
  sendLeaveRequest,
  getTeamLeaveRequests,
  approveLeaveRequest,
  rejectLeaveRequest,
  getPrivacySettings,
  updatePrivacySettings,
  getFollowRequests,
  acceptFollowRequest,
  rejectFollowRequest,
  getDmPrivacy
} = require('../controllers/userController');

const router = express.Router();

// Routes
router.get('/', optionalAuth, getUsers);
router.get('/search', optionalAuth, getUsers); // Add search route
router.post('/create-team', protect, createTeam); // Create team route

// Avatar proxy for external URLs (e.g. Gmail) - must be before /:identifier
router.get('/avatar/:userId', getAvatar);

// Blocked users & block/unblock (fixed paths so they don't match /:identifier)
router.get('/blocked', protect, getBlockedUsers);
router.post('/block/:username', protect, blockUser);
router.delete('/block/:username', protect, unblockUser);

// Tournament history (must be before /:identifier)
router.get('/:identifier/tournaments', optionalAuth, getLiveTournamentHistory);
router.get('/:username/tournament-history', optionalAuth, getUserTournamentHistory);

// Privacy settings (must be before /:identifier)
router.get('/privacy-settings', protect, getPrivacySettings);
router.put('/privacy-settings', protect, updatePrivacySettings);
router.get('/:userId/dm-privacy', protect, getDmPrivacy);
router.get('/follow-requests/incoming', protect, getFollowRequests);
router.post('/follow-requests/:requestId/accept', protect, acceptFollowRequest);
router.post('/follow-requests/:requestId/reject', protect, rejectFollowRequest);

router.get('/:identifier', optionalAuth, getUser);
router.post('/:id/follow', protect, toggleFollow);
router.delete('/:id/follow', protect, toggleFollow);
router.get('/:id/followers', optionalAuth, getFollowers);
router.get('/:id/following', optionalAuth, getFollowing);
router.get('/:id/posts', optionalAuth, getUserPosts);
router.get('/:id/clips', optionalAuth, getUserClips);

// Team management routes
router.post('/:teamId/roster/add', protect, addPlayerToRoster);
router.delete('/:teamId/roster/:game/leave', protect, leaveTeam);
router.delete('/:teamId/roster/:game/:playerId', protect, removePlayerFromRoster);
router.post('/:teamId/staff/add', protect, addStaffMember);
router.post('/:teamId/staff/add-by-username', protect, addStaffMemberByUsername);
router.delete('/:teamId/staff/:playerId', protect, removeStaffMember);
router.get('/:teamId/pending-invites', protect, getTeamPendingInvites);
router.delete('/roster-invite/:inviteId', protect, cancelRosterInvite);
// Player-facing roster invite endpoints
router.get('/roster-invites', protect, getRosterInvites);
router.post('/roster-invites/:inviteId/accept', protect, acceptRosterInvite);
router.post('/roster-invites/:inviteId/decline', protect, declineRosterInvite);
router.delete('/staff-invite/:inviteId', protect, cancelStaffInvite);
router.delete('/:teamId/staff/cancel-by-username', protect, cancelStaffInviteByUsername);

// Gaming Stats routes
router.get('/gaming-stats', protect, getGamingStats);
router.post('/gaming-stats', protect, addGamingStat);
router.put('/gaming-stats/:statId', protect, updateGamingStat);
router.delete('/gaming-stats/:statId', protect, deleteGamingStat);
router.post('/gaming-stats/sync-coc', protect, syncClashOfClansData);
router.post('/gaming-stats/sync-cr', protect, syncClashRoyaleData);

// Leave request routes
router.post('/:teamId/leave-request', protect, sendLeaveRequest);
router.get('/:teamId/leave-requests', protect, getTeamLeaveRequests);
router.post('/leave-requests/:requestId/approve', protect, approveLeaveRequest);
router.post('/leave-requests/:requestId/reject', protect, rejectLeaveRequest);

module.exports = router;
