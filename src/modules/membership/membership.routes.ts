import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { membershipController, paymentController, protect } from "./membership.legacy-adapters";

const router = Router();
const paymentMutationLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).user?._id ? String((req as any).user._id) : ipKeyGenerator(req.ip || "127.0.0.1"),
  message: { success: false, message: "Too many payment requests. Try again later." }
});
const paymentCreateLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).user?._id ? String((req as any).user._id) : ipKeyGenerator(req.ip || "127.0.0.1"),
  message: { success: false, message: "Too many payment creation requests. Try again later." }
});

router.get("/plans", membershipController.getPlans);       // public – list all plans
router.get("/", protect, membershipController.getMembership);
router.post("/payment/create-order", protect, paymentCreateLimiter, paymentController.createOrder);
router.post("/payment/verify", protect, paymentMutationLimiter, paymentController.verifyPayment);
router.post("/subscription/create", protect, paymentCreateLimiter, paymentController.createRecurringPremiumSubscription);
router.post("/subscription/verify", protect, paymentMutationLimiter, paymentController.verifyRecurringPremiumSubscription);
router.post("/cancel", protect, paymentMutationLimiter, paymentController.cancelSubscription);

export default router;
