import path from "path";
import type { RequestHandler } from "express";
import { backendControllerPath, backendMiddlewarePath, backendUtilsPath } from "../legacy/legacy.paths";

type PostController = Record<string, RequestHandler>;
type AuthMiddleware = { protect: RequestHandler; optionalAuth: RequestHandler };
type UploadMiddleware = {
  uploadFields: (fields: { name: string; maxCount: number }[]) => RequestHandler;
};
type ValidationMiddleware = { handleValidationErrors: RequestHandler };
type AchievementPostPolicy = {
  validateAchievementPostBody: (body: Record<string, unknown>) => string | null;
};

const loadModule = <T>(modulePath: string): T => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(modulePath) as T;
};

export const postController = loadModule<PostController>(path.join(backendControllerPath, "postController.js"));
export const { protect, optionalAuth } = loadModule<AuthMiddleware>(path.join(backendMiddlewarePath, "auth.js"));
export const { uploadFields } = loadModule<UploadMiddleware>(path.join(backendMiddlewarePath, "upload.js"));
export const { handleValidationErrors } = loadModule<ValidationMiddleware>(path.join(backendMiddlewarePath, "validation.js"));
export const { validateAchievementPostBody } = loadModule<AchievementPostPolicy>(path.join(backendUtilsPath, "achievementPostPolicy.js"));
