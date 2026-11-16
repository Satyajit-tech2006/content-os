import { Router, type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";
import { prisma } from "@contentos/database";
import { NotFoundError, ValidationError } from "@contentos/shared";
import { z } from "zod";
import { requireAuth, requireWorkspaceAccess } from "../middleware/auth.js";
import { publishingQueue } from "../lib/queue.js";

const router: Router = Router({ mergeParams: true });
router.use(requireAuth, requireWorkspaceAccess());

const CreateConnectionSchema = z.object({
  platform: z.enum(["youtube", "instagram", "tiktok", "x"]),
  accountName: z.string().min(1).max(120),
  externalAccountId: z.string().min(1).max(120),
  projectId: z.string().optional(),
  accessToken: z.string().optional().default("simulated_oauth_token"),
});

const DispatchPublishSchema = z.object({
  assetId: z.string().min(1),
  platformConnectionId: z.string().min(1),
  scheduledFor: z.string().datetime().optional(),
});

router.get("/connections", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = req.workspaceId!;
    const connections = await prisma.platformConnection.findMany({
      where: { workspaceId },
      include: { project: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({
      connections: connections.map(({ encryptedCredentials: _hidden, ...rest }) => rest),
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/connections",
  requireWorkspaceAccess(["OWNER", "ADMIN"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId!;
      const input = CreateConnectionSchema.parse(req.body);
      const conn = await prisma.platformConnection.create({
        data: {
          workspaceId,
          projectId: input.projectId || null,
          platform: input.platform,
          accountName: input.accountName,
          externalAccountId: input.externalAccountId,
          encryptedCredentials: Buffer.from(input.accessToken).toString("base64"),
          status: "CONNECTED",
        },
      });
      const { encryptedCredentials: _hidden, ...safeConn } = conn;
      res.status(201).json({ connection: safeConn });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/connections/:connectionId",
  requireWorkspaceAccess(["OWNER", "ADMIN"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId!;
      const connectionId = String(req.params.connectionId);
      const existing = await prisma.platformConnection.findFirst({
        where: { id: connectionId, workspaceId },
      });
      if (!existing) throw new NotFoundError("Platform connection");
      await prisma.platformConnection.delete({ where: { id: connectionId } });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

router.get("/records", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = req.workspaceId!;
    const records = await prisma.publishingRecord.findMany({
      where: { workspaceId },
      include: {
        project: { select: { id: true, name: true } },
        asset: { select: { id: true, fileName: true, type: true } },
        platformConnection: { select: { id: true, platform: true, accountName: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json({ records });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/dispatch",
  requireWorkspaceAccess(["OWNER", "ADMIN", "EDITOR"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId!;
      const input = DispatchPublishSchema.parse(req.body);

      const [asset, connection] = await Promise.all([
        prisma.contentAsset.findFirst({ where: { id: input.assetId, workspaceId } }),
        prisma.platformConnection.findFirst({ where: { id: input.platformConnectionId, workspaceId } }),
      ]);

      if (!asset) throw new NotFoundError("Content asset");
      if (!connection) throw new NotFoundError("Platform connection");

      const meta = (asset.metadata && typeof asset.metadata === "object" ? asset.metadata : {}) as Record<string, unknown>;
      if (meta.approvalStatus === "REJECTED") {
        throw new ValidationError("Cannot publish a rejected content asset");
      }

      const idempotencyKey = crypto.createHash("sha256").update(workspaceId + ":" + asset.id + ":" + connection.id).digest("hex").slice(0, 32);

      const record = await prisma.publishingRecord.upsert({
        where: { idempotencyKey },
        update: {
          status: "QUEUED",
          errorMessage: null,
          scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
        },
        create: {
          workspaceId,
          projectId: asset.projectId,
          assetId: asset.id,
          platformConnectionId: connection.id,
          idempotencyKey,
          status: "QUEUED",
          scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
        },
        include: {
          project: { select: { id: true, name: true } },
          asset: { select: { id: true, fileName: true, type: true } },
          platformConnection: { select: { id: true, platform: true, accountName: true } },
        },
      });

      const delay = input.scheduledFor ? Math.max(0, new Date(input.scheduledFor).getTime() - Date.now()) : 0;
      await publishingQueue.add(
        "publish-asset",
        { publishingRecordId: record.id, workspaceId },
        { jobId: record.id + '-' + Date.now(), delay }
      );

      res.status(201).json({ record });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
