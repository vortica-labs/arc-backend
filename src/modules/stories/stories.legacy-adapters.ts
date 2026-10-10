import path from "path";
import type { RequestHandler } from "express";
import { backendControllerPath, backendMiddlewarePath } from "../legacy/legacy.paths";

type StoryController = Record<string, RequestHandler>;
type AuthMiddleware = { protect: RequestHandler; publicOptionalAuth: RequestHandler };
type UploadMiddleware = { uploadFields: (fields: Array<{ name: string; maxCount: number }>) => RequestHandler };
type ValidationMiddleware = { handleValidationErrors: RequestHandler };

const loadModule = <T>(modulePath: string): T => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(modulePath) as T;
};

export const storyController = loadModule<StoryController>(path.join(backendControllerPath, "storyController.js"));
export const { protect, publicOptionalAuth } = loadModule<AuthMiddleware>(path.join(backendMiddlewarePath, "auth.js"));
export const { uploadFields } = loadModule<UploadMiddleware>(path.join(backendMiddlewarePath, "upload.js"));
export const { handleValidationErrors } = loadModule<ValidationMiddleware>(path.join(backendMiddlewarePath, "validation.js"));
