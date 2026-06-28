import { Router, Request, Response } from "express";
import { body } from "express-validator";
import {
  randomConnectController,
  randomConnectionControllerNew,
  protect,
  authorize,
  ConnectionQueue,
  RandomConnection
} from "./random-connections.legacy-adapters";

const router = Router();

// Test endpoint to check queue status (no auth required for testing)
router.get("/queue-status", protect, async (_req: Request, res: Response) => {
  try {
    const queueCount = await ConnectionQueue.countDocuments({ status: "waiting" });
    const activeConnections = await RandomConnection.countDocuments({ status: "active" });

    res.status(200).json({
      success: true,
      queueCount,
      activeConnections,
      timestamp: new Date()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to get queue status",
      error: String((error as Error).message)
    });
  }
});

// All routes require authentication except test endpoints
router.use(protect);
// Random Connect is for players only
router.use(authorize("player"));

// Validation middleware
const joinQueueValidation = [
  body("selectedGame")
    .optional()
    .isString()
    .withMessage("Game selection must be a string"),
  body("tags")
    .optional()
    .isArray()
    .withMessage("Tags must be an array"),
  body("tags.*")
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1, max: 30 })
    .withMessage("Each tag must be between 1 and 30 characters"),
  body("videoEnabled")
    .optional()
    .isBoolean()
    .withMessage("Video enabled must be a boolean"),
  body("preferredGender")
    .optional()
    .isIn(["male", "female"])
    .withMessage("Preferred gender must be male or female (use Any for no filter)")
];

const sendMessageValidation = [
  body("roomId")
    .notEmpty()
    .withMessage("Room ID is required"),
  body("message")
    .notEmpty()
    .trim()
    .isLength({ min: 1, max: 500 })
    .withMessage("Message must be between 1 and 500 characters")
];

const disconnectValidation = [
  body("roomId")
    .notEmpty()
    .withMessage("Room ID is required")
];

// Routes (original random connections)
router.post("/join-queue", protect, joinQueueValidation, randomConnectController.joinQueue);
router.delete("/leave-queue", protect, randomConnectController.leaveQueue);
router.get("/current-connection", protect, randomConnectController.getCurrentConnection);
router.get("/active-sessions", protect, randomConnectController.getActiveSessions);
router.get("/daily-gender-matches-remaining", protect, randomConnectController.getDailyGenderMatchesRemaining);
router.post("/disconnect", protect, disconnectValidation, randomConnectController.disconnectConnection);
router.post("/send-message", protect, sendMessageValidation, randomConnectController.sendMessage);
router.post("/cleanup-current", protect, randomConnectController.cleanupCurrentConnection);

// New random connections (v2)
router.post("/v2/join-queue", randomConnectionControllerNew.joinQueue);
router.delete("/v2/leave-queue", randomConnectionControllerNew.leaveQueue);
router.get("/v2/current-connection", randomConnectionControllerNew.getCurrentConnection);
router.post("/v2/disconnect", randomConnectionControllerNew.disconnectConnection);
router.post("/v2/cleanup-current", randomConnectionControllerNew.cleanupCurrentConnection);

export default router;
