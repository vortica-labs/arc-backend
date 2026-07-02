import path from "path";
import type { RequestHandler } from "express";
import { backendMiddlewarePath, backendModelPath } from "../legacy/legacy.paths";

type AuthMiddleware = { protect: RequestHandler };
type NotificationModelType = {
  createNotification: (...args: unknown[]) => Promise<any>;
  claimPushDelivery: (...args: unknown[]) => Promise<any>;
  completePushDelivery: (...args: unknown[]) => Promise<unknown>;
  retryPushDelivery: (...args: unknown[]) => Promise<unknown>;
  find: (...args: unknown[]) => any;
  findOne: (...args: unknown[]) => any;
  findById: (...args: unknown[]) => any;
  countDocuments: (...args: unknown[]) => Promise<number>;
  updateMany: (...args: unknown[]) => Promise<unknown>;
};
type UserModelType = {
  findById: (...args: unknown[]) => any;
  updateOne: (...args: unknown[]) => Promise<{ matchedCount?: number }>;
  updateMany: (...args: unknown[]) => Promise<unknown>;
};

const loadModule = <T>(modulePath: string): T => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(modulePath) as T;
};

export const { protect } = loadModule<AuthMiddleware>(path.join(backendMiddlewarePath, "auth.js"));
export const Notification = loadModule<NotificationModelType>(path.join(backendModelPath, "Notification.js"));
export const User = loadModule<UserModelType>(path.join(backendModelPath, "User.js"));
