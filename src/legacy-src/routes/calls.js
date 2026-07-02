const express = require('express');
const rateLimit = require('express-rate-limit').default || require('express-rate-limit');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  generateCallToken,
  initiateCall,
  acceptCall,
  rejectCall,
  endCall,
  generateGroupCallToken
} = require('../controllers/callController');
const {
  getPendingCall,
  getCallSession,
  acceptCallSession,
  declineCallSession,
  endCallSession
} = require('../controllers/callSessionController');

const callInitiationLimiter = rateLimit({
  windowMs: 60_000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?._id || 'authenticated'),
  message: { success: false, message: 'Too many call attempts. Try again shortly.' }
});

// Generate a general ZegoCloud token (for manual room joining)
router.post('/token', protect, generateCallToken);

// 1:1 Call flow
router.post('/initiate', protect, callInitiationLimiter, initiateCall);
router.post('/accept', protect, acceptCall);
router.post('/reject', protect, rejectCall);
router.post('/end', protect, endCall);

// Durable call state used by killed-app notification actions and multi-device
// reconciliation. These routes do not expose media credentials.
router.get('/sessions/pending', protect, getPendingCall);
router.get('/sessions/:callId', protect, getCallSession);
router.post('/sessions/:callId/accept', protect, acceptCallSession);
router.post('/sessions/:callId/decline', protect, declineCallSession);
router.post('/sessions/:callId/end', protect, endCallSession);

// Group call token
router.post('/group-token', protect, generateGroupCallToken);

module.exports = router;
