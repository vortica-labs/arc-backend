const express = require('express');
const router = express.Router();
const {
  createScrim,
  getScrims,
  getScrim,
  joinScrim,
  leaveScrim,
  submitMatchResults,
  updateScrim,
  deleteScrim,
  cancelScrim
} = require('../controllers/scrimController');
const { protect, publicOptionalAuth } = require('../middleware/auth');

// Scrim CRUD operations
router.route('/')
  .get(publicOptionalAuth, getScrims)
  .post(protect, createScrim);

// Public shareable link route (must come before /:id route)
router.get('/code/:code', publicOptionalAuth, getScrim);

router.route('/:id')
  .get(publicOptionalAuth, getScrim)
  .put(protect, updateScrim)
  .delete(protect, deleteScrim);

// Scrim participation
router.post('/:id/join', protect, joinScrim);
router.post('/:id/leave', protect, leaveScrim);

// Match results
router.post('/:id/matches/:matchNumber/results', protect, submitMatchResults);

// Scrim management
router.put('/:id/cancel', protect, cancelScrim);

// Prize & Final Result management
const { updateScrimPrizeDistribution, generateScrimFinalResult, assignScrimSpecialPrize, broadcastScrimMessage } = require('../controllers/scrimController');
router.post('/:id/prize-distribution', protect, updateScrimPrizeDistribution);
router.post('/:id/generate-final-result', protect, generateScrimFinalResult);
router.post('/:id/assign-special-prize', protect, assignScrimSpecialPrize);
router.post('/:id/broadcast', protect, broadcastScrimMessage);

module.exports = router;
