import path from "path";
import type { RequestHandler } from "express";
import { backendControllerPath, backendMiddlewarePath, backendModelPath } from "../legacy/legacy.paths";

type RandomConnectController = Record<string, RequestHandler>;
type AuthMiddleware = { protect: RequestHandler; authorize: (role: string) => RequestHandler };
type MongooseModel = {
  countDocuments: (filter?: Record<string, unknown>) => Promise<number>;
};

const loadModule = <T>(modulePath: string): T => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(modulePath) as T;
};

export const randomConnectController = loadModule<RandomConnectController>(path.join(backendControllerPath, "randomConnectController.js"));
export const { protect, authorize } = loadModule<AuthMiddleware>(path.join(backendMiddlewarePath, "auth.js"));
export const ConnectionQueue = loadModule<MongooseModel>(path.join(backendModelPath, "ConnectionQueue.js"));
export const RandomConnection = loadModule<MongooseModel>(path.join(backendModelPath, "RandomConnection.js"));
