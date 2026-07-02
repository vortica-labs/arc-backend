const express = require('express');
const { body } = require('express-validator');
const { protect, protectAllowIncomplete } = require('../middleware/auth');
const { uploadSingle } = require('../middleware/upload');
const passport = require('passport');
const rateLimit = require('express-rate-limit');
const { recordSuccessfulLogin } = require('../utils/userLoginAudit');
const {
  progressiveLoginLimiter,
  progressiveOtpLoginLimiter
} = require('../middleware/progressiveAuthLimiter');

// Keep OTP request limiter as-is (spam protection for sending OTP emails)
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 OTP requests per IP
  message: {
    success: false,
    message: 'Too many OTP requests, please try again after 15 minutes'
  }
});
const {
  register,
  login,
  getMe,
  updateProfile,
  changePassword,
  deleteAccount,
  logout,
  uploadProfilePicture,
  uploadBanner,
  completeProfile,
  completeGoogleProfile,
  checkUsernameAvailability,
  checkEmailAvailability,
  sendOtp,
  verifyOtpForRegister,
  verifyOtpAndLogin,
  resetPasswordWithOtp,
  checkPasswordSame,
  generateGuestToken,
  googleTokenLogin,
  appleMobileLogin
} = require('../controllers/authController');

const router = express.Router();

// Validation middleware
const registerValidation = [
  body('username')
    .isLength({ min: 3, max: 20 })
    .withMessage('Username must be between 3 and 20 characters')
    .custom((value) => {
      if (value && value.includes(' ')) {
        throw new Error('Username cannot contain spaces');
      }
      return true;
    })
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Username can only contain letters, numbers and underscores (no spaces)'),
  body('email')
    .isEmail()
    .withMessage('Please provide a valid email'),
  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters long'),
  body('userType')
    .isIn(['player', 'team'])
    .withMessage('User type must be either player or team'),
  body('displayName')
    .isLength({ min: 1, max: 50 })
    .withMessage('Display name is required and must be less than 50 characters'),
  body('gender')
    .optional()
    .isIn(['male', 'female', 'other', 'prefer_not_to_say'])
    .withMessage('Gender must be male, female, other, or prefer_not_to_say')
];

const loginValidation = [
  body('email')
    .optional()
    .isEmail()
    .withMessage('Please provide a valid email'),
  body('username')
    .optional()
    .isLength({ min: 3, max: 20 })
    .withMessage('Username must be between 3 and 20 characters'),
  body('password')
    .notEmpty()
    .withMessage('Password is required'),
  body().custom((value, { req }) => {
    if (!value.email && !value.username) {
      throw new Error('Either email or username must be provided');
    }
    return true;
  })
];

const changePasswordValidation = [
  body('currentPassword')
    .notEmpty()
    .withMessage('Current password is required'),
  body('newPassword')
    .isLength({ min: 6 })
    .withMessage('New password must be at least 6 characters long')
];

const deleteAccountValidation = [
  body('password')
    .notEmpty()
    .withMessage('Password is required to delete account')
];

const profileUpdateValidation = [
  body('username')
    .optional()
    .isLength({ min: 3, max: 20 })
    .withMessage('Username must be between 3 and 20 characters')
    .custom((value) => {
      if (value && value.includes(' ')) {
        throw new Error('Username cannot contain spaces');
      }
      return true;
    })
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Username can only contain letters, numbers and underscores (no spaces)'),
  body('displayName')
    .optional()
    .isLength({ min: 1, max: 50 })
    .withMessage('Display name must be less than 50 characters'),
  body('gender')
    .optional()
    .isIn(['', 'male', 'female', 'other', 'prefer_not_to_say'])
    .withMessage('Gender must be male, female, other, or prefer_not_to_say')
];

// Routes
router.get('/check-username', checkUsernameAvailability);
router.get('/check-email', checkEmailAvailability);
router.post('/send-otp', otpLimiter, sendOtp);
router.post('/verify-otp-register', otpLimiter, verifyOtpForRegister);
router.post('/verify-otp-login', progressiveOtpLoginLimiter, verifyOtpAndLogin);
router.post('/reset-password-otp', otpLimiter, resetPasswordWithOtp);
router.post('/check-password-same', checkPasswordSame);
router.post('/register', uploadSingle('avatar'), registerValidation, register);
router.post('/login', progressiveLoginLimiter, loginValidation, login);
router.post('/guest-token', generateGuestToken);
router.get('/me', protectAllowIncomplete, getMe);
router.put('/profile', protect, uploadSingle('avatar'), profileUpdateValidation, updateProfile);
router.post('/upload-profile-picture', protect, uploadSingle('image'), uploadProfilePicture);
router.post('/upload-banner', protect, uploadSingle('image'), uploadBanner);
router.put('/change-password', protect, changePasswordValidation, changePassword);
router.delete('/account', protect, deleteAccountValidation, deleteAccount);
router.post('/logout', logout);
router.post('/complete-profile', protectAllowIncomplete, completeProfile);
router.post('/complete-google-profile', protectAllowIncomplete, completeGoogleProfile);

// Client-side Google OAuth (popup flow — no redirect URI required)
router.post('/google/token', googleTokenLogin);
router.post('/apple/mobile', appleMobileLogin);

// Legacy server-side Google OAuth routes (kept for reference)
router.get('/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

router.get('/google/callback',
  passport.authenticate('google', { session: false, failureRedirect: `${process.env.CLIENT_URL}/login?error=google_auth_failed` }),
  async (req, res) => {
    try {
      const { token, user } = req.user;
      void recordSuccessfulLogin({ user, authMethod: 'google_passport', request: req });

      // Redirect to frontend with token in URL hash
      const redirectUrl = `${process.env.CLIENT_URL}/login#token=${encodeURIComponent(token)}`;
      return res.redirect(redirectUrl);
    } catch (err) {
      console.error('Google OAuth callback error:', err);
      return res.redirect(`${process.env.CLIENT_URL}/login?error=google_auth_failed`);
    }
  }
);

module.exports = router;
