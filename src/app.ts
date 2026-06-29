import cors from "cors";
import compression from "compression";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import mongoose from "mongoose";
import passport from "passport";
import { env } from "./config/env";
import { registerModules } from "./modules";
import { registerLegacyErrorHandlers } from "./modules/legacy/legacy.middleware";

export const createApp = () => {
  const app = express();
  app.set("trust proxy", 1);
  const allowedOrigins = env.CORS_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean);
  const officialFrontendOrigins = new Set([
    "https://squadhunt.in",
    "https://www.squadhunt.in",
    "https://admin.squadhunt.in"
  ]);

  app.use(helmet({
    crossOriginOpenerPolicy: { policy: "unsafe-none" }
  }));
  app.use(compression());
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow server-to-server and same-origin requests with no Origin header.
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin) || officialFrontendOrigins.has(origin)) return callback(null, true);
        return callback(new Error(`Origin ${origin} not allowed by CORS`));
      },
      credentials: true
    })
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "2mb" }));
  app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));
  app.use(passport.initialize());

  app.use((req, res, next) => {
    if (req.path === "/api/health" || req.path === "/api/simple-health" || req.path === "/api/test-connection") {
      return next();
    }
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        success: false,
        message: "Database connection not ready. Please try again in a moment."
      });
    }
    return next();
  });

  app.get("/", (_req, res) => res.json({ success: true, message: "ARC Backend running" }));
  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  registerModules(app);
  registerLegacyErrorHandlers(app);

  app.use((_req, res) => {
    res.status(404).json({ success: false, message: "Route not found" });
  });

  return app;
};
