import { Router, type Request, type Response, type NextFunction } from "express";
import { prisma, type Prisma } from "@contentos/database";
import { NotFoundError } from "@contentos/shared";
import { z } from "zod";
import { requireAuth, requireWorkspaceAccess } from "../middleware/auth.js";

const router: Router = Router({ mergeParams: true });

router.use(requireAuth, requireWorkspaceAccess());

const UpdateAssetSchema = z.object({
  fileName: z.string().min(1).max(180).optional(),
  approvalStatus: z.enum(["PENDING_REVIEW", "APPROVED", "REJECTED"]).optional(),
  script: z.record(z.unknown()).optional(),
});

function serializeAsset(asset: {
  id: string;
  workspaceId: string;
  projectId: string;
  executionId: string | null;
  type: string;
  fileName: string;
  mimeType: string;
  fileSize: bigint;
  storageKey: string;
  status: string;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  project?: { id: string; name: string; niche: string };
}) {
  return {
    ...asset,
    fileSize: Number(asset.fileSize),
  };
}

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = req.workspaceId!;
    const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
    const type = req.query.type ? String(req.query.type) : undefined;

    const assets = await prisma.contentAsset.findMany({
      where: {
        workspaceId,
        ...(projectId && { projectId }),
        ...(type && { type: type as never }),
      },
      include: {
        project: { select: { id: true, name: true, niche: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    res.json({ assets: assets.map(serializeAsset) });
  } catch (err) {
    next(err);
  }
});

router.patch(
  "/:assetId",
  requireWorkspaceAccess(["OWNER", "ADMIN", "EDITOR"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId!;
      const assetId = String(req.params.assetId);
      const input = UpdateAssetSchema.parse(req.body);

      const existing = await prisma.contentAsset.findFirst({
        where: { id: assetId, workspaceId },
      });
      if (!existing) {
        throw new NotFoundError("Content asset");
      }

      const prevMeta = (existing.metadata && typeof existing.metadata === "object"
        ? existing.metadata
        : {}) as Record<string, unknown>;

      const nextMeta: Record<string, unknown> = {
        ...prevMeta,
        ...(input.approvalStatus !== undefined && {
          approvalStatus: input.approvalStatus,
          reviewedAt: new Date().toISOString(),
          reviewedBy: req.user?.email,
        }),
        ...(input.script !== undefined && { script: input.script }),
      };

      const updated = await prisma.contentAsset.update({
        where: { id: assetId },
        data: {
          ...(input.fileName !== undefined && { fileName: input.fileName }),
          metadata: nextMeta as Prisma.InputJsonValue,
        },
        include: {
          project: { select: { id: true, name: true, niche: true } },
        },
      });

      res.json({ asset: serializeAsset(updated) });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/:assetId",
  requireWorkspaceAccess(["OWNER", "ADMIN"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId!;
      const assetId = String(req.params.assetId);
      const existing = await prisma.contentAsset.findFirst({
        where: { id: assetId, workspaceId },
      });
      if (!existing) {
        throw new NotFoundError("Content asset");
      }
      await prisma.contentAsset.delete({ where: { id: assetId } });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

router.get("/:assetId/download", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = req.workspaceId!;
    const assetId = String(req.params.assetId);
    const asset = await prisma.contentAsset.findFirst({
      where: { id: assetId, workspaceId },
    });
    if (!asset) throw new NotFoundError("Content asset");

    const safeName = asset.fileName.replace(/[^a-zA-Z0-9._-]/g, "_") + ".json";
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="' + safeName + '"');
    res.send(JSON.stringify({
      id: asset.id,
      type: asset.type,
      fileName: asset.fileName,
      storageKey: asset.storageKey,
      metadata: asset.metadata,
    }, null, 2));
  } catch (err) {
    next(err);
  }
});

export default router;
