import type { Express, NextFunction, Request, Response } from "express";
import path from "path";
import { backendMiddlewarePath } from "./legacy.paths";

type MaybeMiddlewareModule = {
  encryptionMiddleware?: (req: Request, res: Response, next: NextFunction) => void;
  handleValidationErrors?: (req: Request, res: Response, next: NextFunction) => void;
  default?: (err: unknown, req: Request, res: Response, next: NextFunction) => void;
};

const PUBLIC_CACHEABLE_API_PREFIXES = ["/api/health"];

/**
 * Viewer-specific authorization can change between two requests even when the
 * resource itself has not changed. Prevent browsers, proxies, and CDNs from
 * replaying an older authorized representation after an unfollow, block, or
 * privacy-setting update.
 */
export const privacyResponseHeaders = (req: Request, res: Response, next: NextFunction): void => {
  const method = req.method.toUpperCase();
  const isRead = method === "GET" || method === "HEAD";
  const isApiPath = req.path === "/api" || req.path.startsWith("/api/");
  const isExplicitlyPublic = PUBLIC_CACHEABLE_API_PREFIXES.some((prefix) => (
    req.path === prefix || req.path.startsWith(`${prefix}/`)
  ));
  if (isRead && isApiPath && !isExplicitlyPublic) {
    res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.vary("Authorization");
  }
  next();
};

const safeRequire = <T>(modulePath: string): T | null => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(modulePath) as T;
  } catch (_error) {
    return null;
  }
};

export const registerLegacyMiddleware = (app: Express): void => {
  app.use(privacyResponseHeaders);
  const encryption = safeRequire<MaybeMiddlewareModule>(path.join(backendMiddlewarePath, "encryption.js"));
  if (encryption?.encryptionMiddleware) {
    app.use(encryption.encryptionMiddleware);
  }
};

export const registerLegacyErrorHandlers = (app: Express): void => {
  const validation = safeRequire<MaybeMiddlewareModule>(path.join(backendMiddlewarePath, "validation.js"));
  if (validation?.handleValidationErrors) {
    app.use(validation.handleValidationErrors);
  }

  const errorHandler = safeRequire<MaybeMiddlewareModule>(path.join(backendMiddlewarePath, "errorHandler.js"));
  if (typeof errorHandler?.default === "function") {
    app.use(errorHandler.default);
    return;
  }

  if (typeof errorHandler === "function") {
    app.use(errorHandler as unknown as (err: unknown, req: Request, res: Response, next: NextFunction) => void);
  }
};
