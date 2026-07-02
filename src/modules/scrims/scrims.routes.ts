import { Router } from "express";
import { protect, publicOptionalAuth, scrimController } from "./scrims.legacy-adapters";

const router = Router();

router.route("/")
  .get(publicOptionalAuth, scrimController.getScrims)
  .post(protect, scrimController.createScrim);

router.get("/code/:code", publicOptionalAuth, scrimController.getScrim);

router.route("/:id")
  .get(publicOptionalAuth, scrimController.getScrim)
  .put(protect, scrimController.updateScrim)
  .delete(protect, scrimController.deleteScrim);

router.post("/:id/join", protect, scrimController.joinScrim);
router.post("/:id/leave", protect, scrimController.leaveScrim);
router.post("/:id/matches/:matchNumber/results", protect, scrimController.submitMatchResults);
router.put("/:id/cancel", protect, scrimController.cancelScrim);
router.post("/:id/prize-distribution", protect, scrimController.updateScrimPrizeDistribution);
router.post("/:id/generate-final-result", protect, scrimController.generateScrimFinalResult);
router.post("/:id/assign-special-prize", protect, scrimController.assignScrimSpecialPrize);
router.post("/:id/broadcast", protect, scrimController.broadcastScrimMessage);

export default router;
