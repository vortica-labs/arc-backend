import { Router } from "express";
import { body } from "express-validator";
import { messageController, protect, uploadFields, uploadMultiple } from "./messages.legacy-adapters";

const router = Router();

const sendDirectMessageValidation = [
  body("recipientId").optional().trim(),
  body("recipientUsername").optional().trim(),
  body("text").optional().isLength({ max: 1000 }).withMessage("Message cannot exceed 1000 characters")
];

const createChatRoomValidation = [
  body("name").isLength({ min: 1, max: 50 }).withMessage("Chat room name must be between 1 and 50 characters"),
  body("description").optional().isLength({ max: 200 }).withMessage("Description cannot exceed 200 characters"),
  body("memberIds").optional().isArray().withMessage("Member IDs must be an array")
];

const updateChatRoomValidation = [
  body("name").isLength({ min: 1, max: 50 }).withMessage("Chat room name must be between 1 and 50 characters"),
  body("description").optional().isLength({ max: 200 }).withMessage("Description cannot exceed 200 characters")
];

const addMemberValidation = [body("memberId").notEmpty().withMessage("Member ID is required")];
const updateMemberRoleValidation = [body("role").isIn(["admin", "member"]).withMessage("Role must be either admin or member")];
const sendGroupMessageValidation = [
  body("chatRoomId").notEmpty().withMessage("Chat room ID is required"),
  body("text").optional().isLength({ max: 1000 }).withMessage("Message cannot exceed 1000 characters")
];
const addReactionValidation = [
  body("emoji").notEmpty().withMessage("Emoji is required").isLength({ min: 1, max: 10 }).withMessage("Invalid emoji")
];

router.post("/direct", protect, uploadMultiple("media", 3), sendDirectMessageValidation, messageController.sendDirectMessage);
router.get("/direct/:userId", protect, messageController.getDirectMessages);
router.get("/recent", protect, messageController.getRecentConversations);
router.post("/rooms", protect, createChatRoomValidation, messageController.createChatRoom);
router.get("/rooms", protect, messageController.getChatRooms);
router.post("/rooms/:chatRoomId/leave", protect, messageController.leaveGroup);
router.get("/rooms/:chatRoomId/invite-link", protect, messageController.getGroupInviteLink);
router.post("/rooms/:chatRoomId/reset-invite-link", protect, messageController.resetGroupInviteLink);
router.post("/rooms/:chatRoomId/invite-dm", protect, messageController.sendGroupInviteDM);
router.put("/rooms/:chatRoomId/permissions", protect, messageController.updateGroupPermissions);
router.get("/join/:inviteToken/preview", messageController.getGroupInvitePreview);
router.post("/join/:inviteToken", protect, messageController.joinGroupViaInvite);
router.put(
  "/rooms/:chatRoomId",
  protect,
  uploadFields([{ name: "avatar", maxCount: 1 }]),
  updateChatRoomValidation,
  messageController.updateChatRoom
);
router.post("/rooms/:chatRoomId/members", protect, addMemberValidation, messageController.addMemberToChatRoom);
router.put("/rooms/:chatRoomId/members/:memberId/role", protect, updateMemberRoleValidation, messageController.updateMemberRole);
router.delete("/rooms/:chatRoomId/members/:memberId", protect, messageController.removeMemberFromChatRoom);
router.post("/group", protect, uploadMultiple("media", 3), sendGroupMessageValidation, messageController.sendGroupMessage);
router.get("/rooms/:chatRoomId", protect, messageController.getGroupMessages);
router.post("/mark-read", protect, messageController.markMessagesAsRead);
router.post("/call-summary", protect, messageController.createCallSummary);
router.delete("/direct/:userId", protect, messageController.deleteDirectMessage);
router.delete("/rooms/:chatRoomId", protect, messageController.deleteGroupMessage);
router.post("/:messageId/reaction", protect, addReactionValidation, messageController.addReaction);
router.post("/:messageId/invite-response", protect, messageController.handleInviteResponse);
router.get("/preferences", protect, messageController.getChatPreferences);
router.post("/chat/:userId/mute", protect, messageController.toggleMuteChat);
// Mobile-compatible mute endpoints
router.post("/direct/:userId/mute", protect, messageController.toggleMuteChat);
router.post("/rooms/:chatRoomId/mute", protect, messageController.toggleMuteGroup);
router.post("/chat/:userId/pin", protect, messageController.togglePinChat);
router.post("/group/:chatRoomId/pin", protect, messageController.togglePinGroup);
// Report a message
router.post("/report", protect, messageController.reportMessage);
// Pin a message (message-level bookmark — stored per-user client-side; backend acknowledges)
router.post("/pin", protect, (_req, res) => {
  // Message pinning is persisted client-side (pinnedMessages Set in React state).
  // The backend endpoint exists purely to acknowledge the request gracefully.
  res.json({ success: true, message: "Message pinned" });
});


export default router;
