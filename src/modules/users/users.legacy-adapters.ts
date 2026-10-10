import path from "path";
import type { RequestHandler } from "express";
import { backendControllerPath, backendMiddlewarePath } from "../legacy/legacy.paths";

type UserController = Record<string, RequestHandler>;
type AuthMiddleware = {
  protect: RequestHandler;
  optionalAuth: RequestHandler;
  publicOptionalAuth: RequestHandler;
};
type ValidationMiddleware = { handleValidationErrors: RequestHandler };

const loadModule = <T>(modulePath: string): T => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(modulePath) as T;
};

export const userController = loadModule<UserController>(path.join(backendControllerPath, "userController.js"));
export const { protect, optionalAuth, publicOptionalAuth } = loadModule<AuthMiddleware>(path.join(backendMiddlewarePath, "auth.js"));
export const { handleValidationErrors } = loadModule<ValidationMiddleware>(path.join(backendMiddlewarePath, "validation.js"));
