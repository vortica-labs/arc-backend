import path from "path";
import type { RequestHandler } from "express";
import { backendControllerPath } from "../legacy/legacy.paths";

type PremiumMembershipController = Record<string, RequestHandler>;

// eslint-disable-next-line @typescript-eslint/no-var-requires
export const premiumMembershipController = require(
  path.join(backendControllerPath, "premiumMembershipController.js")
) as PremiumMembershipController;
