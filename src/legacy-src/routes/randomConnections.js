const express = require('express');
const { body } = require('express-validator');
const { protect, authorize } = require('../middleware/auth');
const {
  joinQueue,
  leaveQueue,
  getCurrentConnection,
  getActiveSessions,
  getDailyGenderMatchesRemaining,
  disconnectConnection,
  sendMessage,
  cleanupCurrentConnection
} = require('../controllers/randomConnectController');

const ConnectionQueue = require('../models/ConnectionQueue');
const RandomConnection = require('../models/RandomConnection');
const { normalizePreferredGender } = require('../utils/randomConnectGender');

const router = express.Router();

// Test endpoint to check queue status (no auth required for testing)
router.get('/queue-status', async (req, res) => {
  try {
    const queueCount = await ConnectionQueue.countDocuments({ status: 'waiting' });
    const activeConnections = await RandomConnection.countDocuments({ status: 'active' });
    
    res.status(200).json({
      success: true,
      queueCount,
      activeConnections,
      timestamp: new Date()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get queue status',
      error: error.message
    });
  }
});

// Debug endpoint removed for security purposes (prevented PII and Room ID leaks)

// All routes require authentication except test endpoints
router.use(protect);
// Random Connect is for players only - match 2 players by same tag for video call
router.use(authorize('player'));

// Validation middleware
const joinQueueValidation = [
  body('selectedGame')
    .optional()
    .isString()
    .withMessage('Game selection must be a string'),
  body('tags')
    .optional()
    .isArray()
    .withMessage('Tags must be an array'),
  body('tags.*')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1, max: 30 })
    .withMessage('Each tag must be between 1 and 30 characters'),
  body('videoEnabled')
    .optional()
    .isBoolean()
    .withMessage('Video enabled must be a boolean'),
  body('preferredGender')
    .optional()
    .customSanitizer(normalizePreferredGender)
    .isIn(['', 'male', 'female'])
    .withMessage('Preferred gender must be male or female (use Any for no filter)')
];

const sendMessageValidation = [
  body('roomId')
    .notEmpty()
    .withMessage('Room ID is required'),
  body('message')
    .notEmpty()
    .trim()
    .isLength({ min: 1, max: 500 })
    .withMessage('Message must be between 1 and 500 characters')
];

const disconnectValidation = [
  body('roomId')
    .notEmpty()
    .withMessage('Room ID is required')
];

// Routes
router.post('/join-queue', protect, joinQueueValidation, joinQueue);
router.delete('/leave-queue', protect, leaveQueue);
router.get('/current-connection', protect, getCurrentConnection);
router.get('/active-sessions', protect, getActiveSessions);
router.get('/daily-gender-matches-remaining', protect, getDailyGenderMatchesRemaining);
router.post('/disconnect', protect, disconnectValidation, disconnectConnection);
router.post('/send-message', protect, sendMessageValidation, sendMessage);
router.post('/cleanup-current', protect, cleanupCurrentConnection);

module.exports = router;
