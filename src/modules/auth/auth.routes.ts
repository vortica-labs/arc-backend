import { Router } from "express";
import { body } from "express-validator";
import rateLimit from "express-rate-limit";
import {
  legacyAuthController,
  passport,
  progressiveLoginLimiter,
  progressiveOtpLoginLimiter,
  protect,
  uploadSingle
} from "./auth.legacy-adapters";

const router = Router();

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    message: "Too many OTP requests, please try again after 15 minutes"
  }
});

const registerValidation = [
  body("username")
    .isLength({ min: 3, max: 20 })
    .withMessage("Username must be between 3 and 20 characters")
    .custom((value) => {
      if (value && value.includes(" ")) {
        throw new Error("Username cannot contain spaces");
      }
      return true;
    })
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage("Username can only contain letters, numbers and underscores (no spaces)"),
  body("email").isEmail().withMessage("Please provide a valid email"),
  body("password").isLength({ min: 6 }).withMessage("Password must be at least 6 characters long"),
  body("userType").isIn(["player", "team"]).withMessage("User type must be either player or team"),
  body("displayName")
    .isLength({ min: 1, max: 50 })
    .withMessage("Display name is required and must be less than 50 characters"),
  body("gender")
    .optional()
    .isIn(["male", "female", "other", "prefer_not_to_say"])
    .withMessage("Gender must be male, female, other, or prefer_not_to_say")
];

const loginValidation = [
  body("email").optional().isEmail().withMessage("Please provide a valid email"),
  body("username").optional().isLength({ min: 3, max: 20 }).withMessage("Username must be between 3 and 20 characters"),
  body("password").notEmpty().withMessage("Password is required"),
  body().custom((value) => {
    if (!value.email && !value.username) {
      throw new Error("Either email or username must be provided");
    }
    return true;
  })
];

const changePasswordValidation = [
  body("currentPassword").notEmpty().withMessage("Current password is required"),
  body("newPassword").isLength({ min: 6 }).withMessage("New password must be at least 6 characters long")
];

const deleteAccountValidation = [body("password").notEmpty().withMessage("Password is required to delete account")];

const profileUpdateValidation = [
  body("username")
    .optional()
    .isLength({ min: 3, max: 20 })
    .withMessage("Username must be between 3 and 20 characters")
    .custom((value) => {
      if (value && value.includes(" ")) {
        throw new Error("Username cannot contain spaces");
      }
      return true;
    })
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage("Username can only contain letters, numbers and underscores (no spaces)"),
  body("displayName").optional().isLength({ min: 1, max: 50 }).withMessage("Display name must be less than 50 characters"),
  body("gender")
    .optional()
    .isIn(["", "male", "female", "other", "prefer_not_to_say"])
    .withMessage("Gender must be male, female, other, or prefer_not_to_say")
];

router.get("/check-username", legacyAuthController.checkUsernameAvailability);
router.get("/check-email", legacyAuthController.checkEmailAvailability);
router.post("/send-otp", otpLimiter, legacyAuthController.sendOtp);
router.post("/verify-otp-register", otpLimiter, legacyAuthController.verifyOtpForRegister);
router.post("/verify-otp-login", progressiveOtpLoginLimiter, legacyAuthController.verifyOtpAndLogin);
router.post("/reset-password-otp", otpLimiter, legacyAuthController.resetPasswordWithOtp);
router.post("/check-password-same", legacyAuthController.checkPasswordSame);
router.post("/register", uploadSingle("avatar"), registerValidation, legacyAuthController.register);
router.post("/login", progressiveLoginLimiter, loginValidation, legacyAuthController.login);
router.post("/guest-token", legacyAuthController.generateGuestToken);
router.get("/me", protect, legacyAuthController.getMe);
router.put("/profile", protect, uploadSingle("avatar"), profileUpdateValidation, legacyAuthController.updateProfile);
router.post("/upload-profile-picture", protect, uploadSingle("image"), legacyAuthController.uploadProfilePicture);
router.post("/upload-banner", protect, uploadSingle("image"), legacyAuthController.uploadBanner);
router.put("/change-password", protect, changePasswordValidation, legacyAuthController.changePassword);
router.delete("/account", protect, deleteAccountValidation, legacyAuthController.deleteAccount);
router.post("/logout", legacyAuthController.logout);
router.post("/complete-google-profile", protect, legacyAuthController.completeGoogleProfile);

router.post("/google/token", legacyAuthController.googleTokenLogin);
router.post("/apple/mobile", legacyAuthController.appleMobileLogin);

router.get("/google", passport.authenticate("google", { scope: ["profile", "email"] }));
// Mobile entry point — passes state=mobile so callback can redirect to deep link
router.get("/google/mobile", passport.authenticate("google", { scope: ["profile", "email"], state: "mobile" } as object));
router.get(
  "/google/callback",
  passport.authenticate("google", { session: false, failureRedirect: `${process.env.CLIENT_URL}/login?error=google_auth_failed` }),
  async (req, res) => {
    try {
      const authReq = req as unknown as { user?: { token?: string } };
      const token = authReq.user?.token ?? "";
      const isMobile = req.query.state === "mobile";
      if (isMobile) {
        return res.redirect(`arcmobile://google-auth?token=${encodeURIComponent(token)}`);
      }
      return res.redirect(`${process.env.CLIENT_URL}/login#token=${encodeURIComponent(token)}`);
    } catch (err) {
      console.error("Google OAuth callback error:", err);
      return res.redirect(`${process.env.CLIENT_URL}/login?error=google_auth_failed`);
    }
  }
);

export default router;
