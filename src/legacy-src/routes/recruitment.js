const express = require('express');
const router = express.Router();
const {
  createTeamRecruitment,
  getTeamRecruitments,
  getTeamRecruitment,
  updateTeamRecruitment,
  closeTeamRecruitment,
  reopenTeamRecruitment,
  deleteTeamRecruitment,
  createPlayerProfile,
  getPlayerCardLimit,
  getPlayerProfiles,
  getPlayerProfile,
  updatePlayerProfile,
  deletePlayerProfile,
  applyToRecruitment,
  withdrawApplication,
  showInterestInProfile,
  getUserApplications,
  getTeamApplications,
  updateApplicationStatus
} = require('../controllers/recruitmentController');
const { protect: auth, publicOptionalAuth } = require('../middleware/auth');
const { markSocialPreviewRequest } = require('../utils/socialPreviewRequest');
const {
  validateRecruitment,
  validateRecruitmentUpdate,
  validatePlayerProfile,
  validatePlayerProfileUpdate,
  validateApplication,
  validateApplicationStatus,
  validateProfileInterest
} = require('../middleware/validation');

// Team Recruitment Routes
router.post('/team-recruitments', auth, ...validateRecruitment, createTeamRecruitment);
router.get('/team-recruitments', auth, getTeamRecruitments);
router.get('/recruitment/:code/preview', markSocialPreviewRequest, publicOptionalAuth, getTeamRecruitment);
router.get('/recruitment/:code', publicOptionalAuth, getTeamRecruitment); // Shareable link route (public) - must come before /team-recruitments/:id
router.get('/team-recruitments/:id', publicOptionalAuth, getTeamRecruitment); // Supports both ID and recruitmentCode (public for viewing)
router.put('/team-recruitments/:id', auth, ...validateRecruitmentUpdate, updateTeamRecruitment);
router.post('/team-recruitments/:id/close', auth, closeTeamRecruitment);
router.post('/team-recruitments/:id/reopen', auth, reopenTeamRecruitment);
router.delete('/team-recruitments/:id', auth, deleteTeamRecruitment);

// Player Profile Routes
router.post('/player-profiles', auth, ...validatePlayerProfile, createPlayerProfile);
router.get('/player-profiles/daily-limit', auth, getPlayerCardLimit);
router.get('/player-profiles', auth, getPlayerProfiles);
router.get('/profile/:code/preview', markSocialPreviewRequest, publicOptionalAuth, getPlayerProfile);
router.get('/player-profiles/:id', publicOptionalAuth, getPlayerProfile); // Supports both ID and profileCode (public for viewing)
router.get('/profile/:code', publicOptionalAuth, getPlayerProfile); // Shareable link route (public)
router.put('/player-profiles/:id', auth, ...validatePlayerProfileUpdate, updatePlayerProfile);
router.delete('/player-profiles/:id', auth, deletePlayerProfile);

// Application Routes
router.post('/team-recruitments/:recruitmentId/apply', auth, ...validateApplication, applyToRecruitment); // Supports ID or code
router.delete('/team-recruitments/:recruitmentId/apply', auth, withdrawApplication); // Withdraw active application
router.post('/team-recruitments/:recruitmentId/withdraw', auth, withdrawApplication); // Mobile-friendly withdraw action
router.post('/recruitment/:recruitmentId/apply', auth, ...validateApplication, applyToRecruitment); // Shareable link route
router.post('/recruitment/:recruitmentId/withdraw', auth, withdrawApplication); // Shareable link route
router.post('/player-profiles/:profileId/interest', auth, ...validateProfileInterest, showInterestInProfile); // Supports ID or code
router.post('/profile/:profileId/interest', auth, ...validateProfileInterest, showInterestInProfile); // Shareable link route
router.get('/applications/my', auth, getUserApplications);
router.get('/applications/team', auth, getTeamApplications);
router.get('/team-applications', auth, getTeamApplications);
router.put('/applications/:applicationId/status', auth, ...validateApplicationStatus, updateApplicationStatus);

module.exports = router;
