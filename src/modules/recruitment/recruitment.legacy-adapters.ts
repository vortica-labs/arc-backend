import path from "path";
import type { RequestHandler } from "express";
import { backendControllerPath, backendMiddlewarePath } from "../legacy/legacy.paths";

type RecruitmentController = Record<string, RequestHandler>;
type AuthMiddleware = { protect: RequestHandler; publicOptionalAuth: RequestHandler };
type ValidationModule = {
  validateRecruitment: RequestHandler[];
  validateRecruitmentUpdate: RequestHandler[];
  validatePlayerProfile: RequestHandler[];
  validatePlayerProfileUpdate: RequestHandler[];
  validateApplication: RequestHandler[];
  validateApplicationStatus: RequestHandler[];
  validateProfileInterest: RequestHandler[];
};

const loadModule = <T>(modulePath: string): T => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(modulePath) as T;
};

export const recruitmentController = loadModule<RecruitmentController>(path.join(backendControllerPath, "recruitmentController.js"));
export const { protect, publicOptionalAuth } = loadModule<AuthMiddleware>(path.join(backendMiddlewarePath, "auth.js"));
export const {
  validateRecruitment,
  validateRecruitmentUpdate,
  validatePlayerProfile,
  validatePlayerProfileUpdate,
  validateApplication,
  validateApplicationStatus,
  validateProfileInterest
} = loadModule<ValidationModule>(
  path.join(backendMiddlewarePath, "validation.js")
);
