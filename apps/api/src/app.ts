import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { errorHandler } from "./middleware/errorHandler.js";
import authRoutes from "./routes/auth.routes.js";
import workspacesRoutes from "./routes/workspaces.routes.js";
import projectsRoutes from "./routes/projects.routes.js";
import executionsRoutes from "./routes/executions.routes.js";
import assetsRoutes from "./routes/assets.routes.js";
import publishingRoutes from "./routes/publishing.routes.js";
import aiRoutes, { triggerScriptGenerationWorkflow } from "./routes/ai.routes.js";
import femaleLibraryRoutes from "./routes/femaleLibrary.routes.js";
import liveClipperRoutes from "./routes/liveClipper.routes.js";
import { requireAuth } from "./middleware/auth.js";

export function createApp(): Express {
  const app = express();

  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(
    cors({
      origin: env.WEB_ORIGIN,
      credentials: true,
    })
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.method === "GET" } }));

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    skip: (req) => req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1",
    standardHeaders: true,
    legacyHeaders: false,
  });

  const storageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.contentos-storage");
  app.use("/media", express.static(storageDir));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "contentos-api", timestamp: new Date().toISOString() });
  });

  app.use("/api/v1/auth", authLimiter, authRoutes);
  app.use("/api/v1/workspaces", workspacesRoutes);
  app.use("/api/v1/workspaces/:workspaceId/projects", projectsRoutes);
  app.use("/api/v1/workspaces/:workspaceId/executions", executionsRoutes);
  app.use("/api/v1/workspaces/:workspaceId/assets", assetsRoutes);
  app.use("/api/v1/workspaces/:workspaceId/publishing", publishingRoutes);
  app.use("/api/v1/workspaces/:workspaceId/ai", aiRoutes);
  app.use("/api/v1/workspaces/:workspaceId/female-library", femaleLibraryRoutes);
  app.use("/api/v1/workspaces/:workspaceId/live-clipper", liveClipperRoutes);
  app.use("/api/ai", aiRoutes);
  app.post("/api/workflows/script-generation", requireAuth, triggerScriptGenerationWorkflow);
  app.post("/api/v1/workflows/script-generation", requireAuth, triggerScriptGenerationWorkflow);

  app.use(errorHandler);

  return app;
}
