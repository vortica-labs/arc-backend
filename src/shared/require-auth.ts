import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import path from "path";
import { env } from "../config/env";
import { backendMiddlewarePath } from "../modules/legacy/legacy.paths";

type AuthUser = {
  _id?: unknown;
  isActive?: boolean;
  needsProfileCompletion?: boolean;
};

type LegacyAuthMiddleware = {
  getCachedUser: (userId: string) => Promise<AuthUser | null>;
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getCachedUser } = require(path.join(backendMiddlewarePath, "auth.js")) as LegacyAuthMiddleware;

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<Response | void> => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ success: false, message: "Missing auth token" });
  }

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as { id?: string; userId?: string };
    const userId = decoded.id ?? decoded.userId;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Invalid token payload" });
    }

    const user = await getCachedUser(String(userId));
    if (!user || user.isActive === false) {
      return res.status(401).json({ success: false, message: "User account is deactivated or not found." });
    }
    if (user.needsProfileCompletion === true) {
      return res.status(403).json({
        success: false,
        code: "PROFILE_COMPLETION_REQUIRED",
        message: "Complete your profile to continue."
      });
    }

    req.userId = String(userId);
    return next();
  } catch (_error) {
    return res.status(401).json({ success: false, message: "Invalid auth token" });
  }
};
