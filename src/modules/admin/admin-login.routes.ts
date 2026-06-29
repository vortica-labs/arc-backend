import { Router } from "express";
import type { Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { env } from "../../config/env";

const router = Router();

/**
 * Brute-force protection: max 10 login attempts per 15 minutes per IP.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many login attempts. Try again in 15 minutes." },
});

/**
 * POST /api/admin/auth/login
 * Body: { username: string, password: string }
 * Returns: { success: true, token: string }
 *
 * Only one admin account is supported. Credentials are stored as env vars:
 *   ADMIN_USERNAME   — the admin username
 *   ADMIN_PASSWORD_HASH — bcrypt hash of the admin password
 *
 * Generate a hash with:  node scripts/generate-admin-hash.js <your-password>
 */
router.post("/login", loginLimiter, async (req: Request, res: Response): Promise<void> => {
  // Guard: ensure credentials are configured in the environment
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD_HASH) {
    res.status(503).json({
      success: false,
      message: "Admin login is not configured on this server.",
    });
    return;
  }

  const { username, password } = req.body as { username?: string; password?: string };

  if (!username || !password) {
    res.status(400).json({ success: false, message: "Username and password are required." });
    return;
  }

  // Constant-time username comparison to avoid user enumeration
  const usernameMatch = username === env.ADMIN_USERNAME;
  const passwordMatch = await bcrypt.compare(password, env.ADMIN_PASSWORD_HASH);

  if (!usernameMatch || !passwordMatch) {
    // Always return the same error regardless of which field was wrong
    res.status(401).json({ success: false, message: "Invalid credentials." });
    return;
  }

  const token = jwt.sign(
    { isHardcodedAdmin: true, username: env.ADMIN_USERNAME, adminRole: "super_admin", adminPermissions: ["*"] },
    env.JWT_SECRET,
    { expiresIn: "8h" }
  );

  console.log(
    `[ADMIN LOGIN] Successful login for "${env.ADMIN_USERNAME}" from IP ${req.ip} at ${new Date().toISOString()}`
  );

  res.json({ success: true, token, expiresIn: "8h" });
});

export default router;
