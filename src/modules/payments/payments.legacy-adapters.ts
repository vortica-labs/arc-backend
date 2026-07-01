import path from "path";
import type { RequestHandler } from "express";
import { backendControllerPath, backendMiddlewarePath } from "../legacy/legacy.paths";

type PaymentController = Record<string, RequestHandler>;
type WebhookController = Record<string, RequestHandler>;
type AuthMiddleware = { protect: RequestHandler };

const loadModule = <T>(modulePath: string): T => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(modulePath) as T;
};

export const paymentController = loadModule<PaymentController>(path.join(backendControllerPath, "paymentController.js"));
export const premiumWebhookController = loadModule<WebhookController>(path.join(backendControllerPath, "premiumWebhookController.js"));
export const { protect } = loadModule<AuthMiddleware>(path.join(backendMiddlewarePath, "auth.js"));
