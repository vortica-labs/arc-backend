import path from "path";
import type { RequestHandler } from "express";
import { backendControllerPath, backendMiddlewarePath } from "../legacy/legacy.paths";

type AdminController = Record<string, RequestHandler>;
type AdminAuthMiddleware = {
  requireSuperAdmin: RequestHandler;
  requireAdminPermission: (permission: string) => RequestHandler;
  auditLog: (eventName: string) => RequestHandler;
  durableMutationAudit: (eventName: string) => RequestHandler;
};

const loadModule = <T>(modulePath: string): T => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(modulePath) as T;
};

export const adminController = loadModule<AdminController>(path.join(backendControllerPath, "adminController.js"));
export const { requireSuperAdmin, requireAdminPermission, auditLog, durableMutationAudit } = loadModule<AdminAuthMiddleware>(
  path.join(backendMiddlewarePath, "adminAuth.js")
);
