import path from "path";
import type { RequestHandler } from "express";
import { backendControllerPath, backendMiddlewarePath } from "../legacy/legacy.paths";

type TournamentController = Record<string, RequestHandler>;
type AuthMiddleware = { protect: RequestHandler; publicOptionalAuth: RequestHandler };

const loadModule = <T>(modulePath: string): T => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(modulePath) as T;
};

export const tournamentController = loadModule<TournamentController>(path.join(backendControllerPath, "tournamentController.js"));
export const { protect, publicOptionalAuth } = loadModule<AuthMiddleware>(path.join(backendMiddlewarePath, "auth.js"));
