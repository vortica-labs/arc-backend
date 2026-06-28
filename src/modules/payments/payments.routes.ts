import { Router } from "express";
import { paymentController, protect } from "./payments.legacy-adapters";

const router = Router();

router.get("/history", protect, paymentController.getPaymentHistory);

// Subscription payment routes
router.post("/subscription/create-order", protect, paymentController.createOrder);
router.post("/subscription/verify", protect, paymentController.verifyPayment);

// Tournament payment routes
router.post("/tournament/create-order", protect, paymentController.createTournamentOrder);
router.post("/tournament/verify", protect, paymentController.verifyTournamentPayment);

// Boost payment routes
router.post("/boost/create-order", protect, paymentController.createBoostOrder);
router.post("/boost/verify", protect, paymentController.verifyBoostPayment);

export default router;
