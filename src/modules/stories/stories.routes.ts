import { Router } from "express";
import { param } from "express-validator";
import { handleValidationErrors, storyController, protect, publicOptionalAuth, uploadFields } from "./stories.legacy-adapters";

const router = Router();
const userIdValidation = [param("userId").isMongoId().withMessage("Invalid user ID")];
const storyIdValidation = [param("storyId").isMongoId().withMessage("Invalid story ID")];

router.get("/feed", protect, storyController.getStoriesFeed);
router.get("/user/:userId", publicOptionalAuth, userIdValidation, handleValidationErrors, storyController.getUserStories);
router.post("/", protect, uploadFields([{ name: "media", maxCount: 1 }, { name: "music", maxCount: 1 }]), storyController.createStory);
router.get("/:storyId", publicOptionalAuth, storyIdValidation, handleValidationErrors, storyController.getStory);
router.post("/:storyId/view", protect, storyIdValidation, handleValidationErrors, storyController.viewStory);
router.get("/:storyId/views", protect, storyIdValidation, handleValidationErrors, storyController.getStoryViewers);
router.delete("/:storyId", protect, storyIdValidation, handleValidationErrors, storyController.deleteStory);

export default router;
