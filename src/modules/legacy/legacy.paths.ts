import path from "path";

/**
 * Paths to the legacy JS source that now lives inside modular-backend.
 * Previously these pointed to `../backend`; they now resolve within
 * `src/legacy-src/` so the modular-backend is fully self-contained.
 */
export const backendRootPath = path.resolve(process.cwd(), "src", "legacy-src");
export const backendRoutePath = path.join(backendRootPath, "routes");
export const backendMiddlewarePath = path.join(backendRootPath, "middleware");
export const backendConfigPath = path.join(backendRootPath, "config");
export const backendControllerPath = path.join(backendRootPath, "controllers");
export const backendModelPath = path.join(backendRootPath, "models");
export const backendUtilsPath = path.join(backendRootPath, "utils");
