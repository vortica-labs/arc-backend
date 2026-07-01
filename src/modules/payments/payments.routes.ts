import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { paymentController, premiumWebhookController, protect } from "./payments.legacy-adapters";

const router = Router();
const webhookLimiter = rateLimit({
  windowMs: 60_000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Webhook rate limit exceeded" }
});
const customerPaymentLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).user?._id ? String((req as any).user._id) : ipKeyGenerator(req.ip || "127.0.0.1"),
  message: { success: false, message: "Too many payment requests. Try again later." }
});
const customerCreateLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).user?._id ? String((req as any).user._id) : ipKeyGenerator(req.ip || "127.0.0.1"),
  message: { success: false, message: "Too many payment creation requests. Try again later." }
});

router.post("/razorpay/webhook", webhookLimiter, premiumWebhookController.handleRazorpayWebhook);

router.get("/history", protect, paymentController.getPaymentHistory);

// Subscription payment routes
router.post("/subscription/create-order", protect, customerCreateLimiter, paymentController.createOrder);
router.post("/subscription/verify", protect, customerPaymentLimiter, paymentController.verifyPayment);
router.post("/subscription/create", protect, customerCreateLimiter, paymentController.createRecurringPremiumSubscription);
router.post("/subscription/verify-recurring", protect, customerPaymentLimiter, paymentController.verifyRecurringPremiumSubscription);

// Tournament payment routes
router.post("/tournament/create-order", protect, paymentController.createTournamentOrder);
router.post("/tournament/verify", protect, paymentController.verifyTournamentPayment);

// Boost payment routes
router.get("/boost/campaigns", protect, paymentController.getBoostCampaigns);
router.post("/boost/create-order", protect, paymentController.createBoostOrder);
router.post("/boost/verify", protect, paymentController.verifyBoostPayment);

export default router;
