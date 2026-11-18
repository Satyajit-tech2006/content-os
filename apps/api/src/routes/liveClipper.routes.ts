import { Router, type Router as ExpressRouter } from "express";
import { requireAuth, requireWorkspaceAccess } from "../middleware/auth.js";
import {
  getTwitchWatcherStatus,
  simulateChatSpike,
  startTwitchLiveWatcher,
  stopTwitchLiveWatcher,
} from "../services/twitchClipper.service.js";

const router: ExpressRouter = Router({ mergeParams: true });

router.use(requireAuth, requireWorkspaceAccess());

router.get("/status", (req, res) => {
  const workspaceId = req.workspaceId!;
  res.json({ watcher: getTwitchWatcherStatus(workspaceId) });
});

router.post("/start", requireWorkspaceAccess(["OWNER", "ADMIN", "EDITOR"]), async (req, res, next) => {
  try {
    const workspaceId = req.workspaceId!;
    const { channel, projectId, preRollSec, postRollSec, sensitivity } = req.body ?? {};
    if (!channel || !projectId) {
      res.status(400).json({ error: "channel and projectId are required" });
      return;
    }
    const watcher = await startTwitchLiveWatcher({
      workspaceId,
      projectId: String(projectId),
      channel: String(channel),
      preRollSec: preRollSec ? Number(preRollSec) : undefined,
      postRollSec: postRollSec ? Number(postRollSec) : undefined,
      sensitivity: sensitivity ? Number(sensitivity) : undefined,
    });
    res.json({ watcher });
  } catch (err) {
    next(err);
  }
});

router.post("/stop", requireWorkspaceAccess(["OWNER", "ADMIN", "EDITOR"]), async (req, res, next) => {
  try {
    const workspaceId = req.workspaceId!;
    await stopTwitchLiveWatcher(workspaceId);
    res.json({ status: "STOPPED" });
  } catch (err) {
    next(err);
  }
});

router.post("/simulate", requireWorkspaceAccess(["OWNER", "ADMIN", "EDITOR"]), async (req, res, next) => {
  try {
    const workspaceId = req.workspaceId!;
    const watcher = await simulateChatSpike(workspaceId);
    res.json({ watcher });
  } catch (err) {
    next(err);
  }
});

export default router;
