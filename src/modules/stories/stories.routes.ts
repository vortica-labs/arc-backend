import { Router } from "express";
import { storyController, protect, uploadFields } from "./stories.legacy-adapters";

const router = Router();

router.get("/feed", protect, storyController.getStoriesFeed);
router.get("/user/:userId", protect, storyController.getUserStories);
router.post("/", protect, uploadFields([{ name: "media", maxCount: 1 }, { name: "music", maxCount: 1 }]), storyController.createStory);
router.post("/:storyId/view", protect, storyController.viewStory);
router.get("/:storyId/views", protect, storyController.getStoryViewers);
router.delete("/:storyId", protect, storyController.deleteStory);

export default router;
