const express = require('express');
const { body } = require('express-validator');
const { protect } = require('../middleware/auth');
const { uploadMultiple, uploadFields } = require('../middleware/upload');
const {
  sendDirectMessage,
  getDirectMessages,
  createChatRoom,
  getChatRooms,
  getRecentConversations,
  sendGroupMessage,
  getGroupMessages,
  addReaction,
  updateChatRoom,
  addMemberToChatRoom,
  removeMemberFromChatRoom,
  updateMemberRole,
  handleInviteResponse,
  markMessagesAsRead,
  deleteDirectMessage,
  deleteGroupMessage,
  leaveGroup,
  createCallSummary,
  toggleMuteChat,
  toggleMuteGroup,
  togglePinChat,
  togglePinGroup,
  getChatPreferences,
  getGroupInviteLink,
  resetGroupInviteLink,
  joinGroupViaInvite,
  getGroupInvitePreview,
  updateGroupPermissions,
  sendGroupInviteDM,
  reportMessage
} = require('../controllers/messageController');

const router = express.Router();

// Validation middleware
const sendDirectMessageValidation = [
  body('recipientId')
    .optional()
    .trim(),
  body('recipientUsername')
    .optional()
    .trim(),
  body('text')
    .optional()
    .isLength({ max: 1000 })
    .withMessage('Message cannot exceed 1000 characters')
];

const createChatRoomValidation = [
  body('name')
    .isLength({ min: 1, max: 50 })
    .withMessage('Chat room name must be between 1 and 50 characters'),
  body('description')
    .optional()
    .isLength({ max: 200 })
    .withMessage('Description cannot exceed 200 characters'),
  body('memberIds')
    .optional()
    .isArray()
    .withMessage('Member IDs must be an array')
];

const updateChatRoomValidation = [
  body('name')
    .isLength({ min: 1, max: 50 })
    .withMessage('Chat room name must be between 1 and 50 characters'),
  body('description')
    .optional()
    .isLength({ max: 200 })
    .withMessage('Description cannot exceed 200 characters')
];

const addMemberValidation = [
  body('memberId')
    .notEmpty()
    .withMessage('Member ID is required')
];

const updateMemberRoleValidation = [
  body('role')
    .isIn(['admin', 'member'])
    .withMessage('Role must be either admin or member')
];

const sendGroupMessageValidation = [
  body('chatRoomId')
    .notEmpty()
    .withMessage('Chat room ID is required'),
  body('text')
    .optional()
    .isLength({ max: 1000 })
    .withMessage('Message cannot exceed 1000 characters')
];

const addReactionValidation = [
  body('emoji')
    .notEmpty()
    .withMessage('Emoji is required')
    .isLength({ min: 1, max: 10 })
    .withMessage('Invalid emoji')
];

// Routes
router.post('/direct', protect, uploadMultiple('media', 3), sendDirectMessageValidation, sendDirectMessage);
router.get('/direct/:userId', protect, getDirectMessages);
router.get('/recent', protect, getRecentConversations);
router.post('/rooms', protect, createChatRoomValidation, createChatRoom);
router.get('/rooms', protect, getChatRooms);
router.post('/rooms/:chatRoomId/leave', protect, leaveGroup);
router.get('/rooms/:chatRoomId/invite-link', protect, getGroupInviteLink);
router.post('/rooms/:chatRoomId/reset-invite-link', protect, resetGroupInviteLink);
router.post('/rooms/:chatRoomId/invite-dm', protect, sendGroupInviteDM);
router.put('/rooms/:chatRoomId/permissions', protect, updateGroupPermissions);
router.get('/join/:inviteToken/preview', getGroupInvitePreview);
router.post('/join/:inviteToken', protect, joinGroupViaInvite);
router.put('/rooms/:chatRoomId', protect, uploadFields([{ name: 'avatar', maxCount: 1 }]), updateChatRoomValidation, updateChatRoom);
router.post('/rooms/:chatRoomId/members', protect, addMemberValidation, addMemberToChatRoom);
router.put('/rooms/:chatRoomId/members/:memberId/role', protect, updateMemberRoleValidation, updateMemberRole);
router.delete('/rooms/:chatRoomId/members/:memberId', protect, removeMemberFromChatRoom);
router.post('/group', protect, uploadMultiple('media', 3), sendGroupMessageValidation, sendGroupMessage);
router.get('/rooms/:chatRoomId', protect, getGroupMessages);
router.post('/mark-read', protect, markMessagesAsRead);
router.post('/call-summary', protect, createCallSummary);
router.delete('/direct/:userId', protect, deleteDirectMessage);
router.delete('/rooms/:chatRoomId', protect, deleteGroupMessage);
router.post('/:messageId/reaction', protect, addReactionValidation, addReaction);
router.post('/:messageId/invite-response', protect, handleInviteResponse);

// Chat preferences (mute/pin)
router.get('/preferences', protect, getChatPreferences);
router.post('/chat/:userId/mute', protect, toggleMuteChat);
router.post('/rooms/:chatRoomId/mute', protect, toggleMuteGroup);
router.post('/chat/:userId/pin', protect, togglePinChat);
router.post('/group/:chatRoomId/pin', protect, togglePinGroup);
// Report a message
router.post('/report', protect, reportMessage);
// Pin a message — client-side bookmark; backend acknowledges only
router.post('/pin', protect, (_req, res) => res.json({ success: true, message: 'Message pinned' }));

module.exports = router;
