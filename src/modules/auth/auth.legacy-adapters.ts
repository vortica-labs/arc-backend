import path from "path";
import type { RequestHandler } from "express";
import { backendConfigPath, backendControllerPath, backendMiddlewarePath, backendRootPath } from "../legacy/legacy.paths";

type LegacyAuthController = {
  register: RequestHandler;
  login: RequestHandler;
  getMe: RequestHandler;
  updateProfile: RequestHandler;
  changePassword: RequestHandler;
  deleteAccount: RequestHandler;
  logout: RequestHandler;
  uploadProfilePicture: RequestHandler;
  uploadBanner: RequestHandler;
  completeProfile: RequestHandler;
  completeGoogleProfile: RequestHandler;
  checkUsernameAvailability: RequestHandler;
  checkEmailAvailability: RequestHandler;
  sendOtp: RequestHandler;
  verifyOtpForRegister: RequestHandler;
  verifyOtpAndLogin: RequestHandler;
  resetPasswordWithOtp: RequestHandler;
  checkPasswordSame: RequestHandler;
  generateGuestToken: RequestHandler;
  googleTokenLogin: RequestHandler;
  appleMobileLogin: RequestHandler;
};

type ProgressiveAuthLimiter = {
  progressiveLoginLimiter: RequestHandler;
  progressiveOtpLoginLimiter: RequestHandler;
};

type ProtectMiddleware = {
  protect: RequestHandler;
  protectAllowIncomplete: RequestHandler;
};

type UploadMiddleware = {
  uploadSingle: (fieldName: string) => RequestHandler;
};

type PassportModule = {
  authenticate: (...args: unknown[]) => RequestHandler;
};

type LoginAuditModule = {
  recordSuccessfulLogin: (input: {
    user: unknown;
    authMethod: "google_passport";
    request: unknown;
  }) => Promise<boolean>;
};

const loadModule = <T>(modulePath: string): T => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(modulePath) as T;
};

export const legacyAuthController = loadModule<LegacyAuthController>(path.join(backendControllerPath, "authController.js"));
export const { progressiveLoginLimiter, progressiveOtpLoginLimiter } = loadModule<ProgressiveAuthLimiter>(
  path.join(backendMiddlewarePath, "progressiveAuthLimiter.js")
);
export const { protect, protectAllowIncomplete } = loadModule<ProtectMiddleware>(path.join(backendMiddlewarePath, "auth.js"));
export const { uploadSingle } = loadModule<UploadMiddleware>(path.join(backendMiddlewarePath, "upload.js"));
export const passport = loadModule<PassportModule>("passport");
export const { recordSuccessfulLogin } = loadModule<LoginAuditModule>(path.join(backendRootPath, "utils", "userLoginAudit.js"));

// Ensure strategy is initialized once for auth routes.
loadModule(path.join(backendConfigPath, "passport.js"));
