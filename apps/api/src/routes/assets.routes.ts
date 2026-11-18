import { Router, type Request, type Response, type NextFunction } from "express";
import { prisma, Prisma } from "@contentos/database";
import { AppError, NotFoundError, ValidationError } from "@contentos/shared";
import { z } from "zod";
import { dispatchOutboxEvent } from "../lib/queue.js";
import { requireAuth, requireWorkspaceAccess } from "../middleware/auth.js";

const router: Router = Router({ mergeParams: true });
const assetsListCache = new Map<string, { expiresAt: number; payload: unknown }>();
router.use((req, _res, next) => {
  if (req.method !== "GET" && req.workspaceId) {
    for (const key of assetsListCache.keys()) {
      if (key.startsWith(req.workspaceId + ":")) assetsListCache.delete(key);
    }
  }
  next();
});

router.use(requireAuth, requireWorkspaceAccess());

const UpdateAssetSchema = z.object({
  fileName: z.string().min(1).max(180).optional(),
  title: z.string().min(1).max(240).optional(),
  hook: z.string().max(1000).optional(),
  voiceoverScript: z.string().min(1).optional(),
  description: z.string().max(5000).optional(),
  hashtags: z.array(z.string()).optional(),
  script: z.record(z.unknown()).optional(),
});

const ReviewAssetSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED", "REVISION_REQUESTED"]),
  comment: z.string().max(2000).optional(),
  revisionId: z.string().optional(),
  idempotencyKey: z.string().max(180).optional(),
});

function serializeAsset(asset: Record<string, unknown> & { fileSize: bigint }) {
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
    const approvalStatus = req.query.approvalStatus ? String(req.query.approvalStatus) : undefined;

    const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
    const limit = Math.min(25, Math.max(1, Number.parseInt(String(req.query.limit ?? "10"), 10) || 10));
    const skip = (page - 1) * limit;

    const cacheKey = `${workspaceId}:${projectId || ""}:${type || ""}:${approvalStatus || ""}:p${page}:l${limit}`;
    const hit = assetsListCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      res.json(hit.payload);
      return;
    }

    const whereClause = {
      workspaceId,
      ...(projectId && { projectId }),
      ...(type && { type: type as never }),
      ...(approvalStatus && { approvalStatus: approvalStatus as never }),
    };

    const [total, assets] = await Promise.all([
      prisma.contentAsset.count({ where: whereClause }),
      prisma.contentAsset.findMany({
        where: whereClause,
        include: {
          project: { select: { id: true, name: true, niche: true } },
          execution: {
            select: {
              id: true,
              status: true,
              currentStageIndex: true,
              activeRevisionNum: true,
              approvedRevisionId: true,
              createdAt: true,
              completedAt: true,
            },
          },
          revisions: {
            orderBy: { revisionNumber: "desc" },
            take: 1,
            select: {
              id: true,
              assetId: true,
              revisionNumber: true,
              title: true,
              hook: true,
              voiceoverScript: true,
              description: true,
              hashtags: true,
              createdAt: true,
              createdByUser: { select: { id: true, name: true, email: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));
    const payload = {
      assets: assets.map(serializeAsset),
      pagination: { page, limit, total, totalPages },
    };
    assetsListCache.set(cacheKey, { expiresAt: Date.now() + 5000, payload });
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

router.get("/:assetId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = req.workspaceId!;
    const assetId = String(req.params.assetId);

    const asset = await prisma.contentAsset.findFirst({
      where: { id: assetId, workspaceId },
      include: {
        project: { select: { id: true, name: true, niche: true } },
        execution: {
          select: {
            id: true,
            status: true,
            currentStageIndex: true,
            activeRevisionNum: true,
            approvedRevisionId: true,
          },
        },
        revisions: {
          orderBy: { revisionNumber: "desc" },
          include: {
            createdByUser: { select: { id: true, name: true, email: true } },
          },
        },
        approvalDecisions: {
          orderBy: { createdAt: "desc" },
          include: {
            reviewer: { select: { id: true, name: true, email: true } },
            revision: { select: { id: true, revisionNumber: true } },
          },
        },
      },
    });

    if (!asset) {
      throw new NotFoundError("Content asset");
    }

    res.json({ asset: serializeAsset(asset) });
  } catch (err) {
    next(err);
  }
});

router.get("/:assetId/revisions", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = req.workspaceId!;
    const assetId = String(req.params.assetId);

    const asset = await prisma.contentAsset.findFirst({
      where: { id: assetId, workspaceId },
      select: { id: true },
    });
    if (!asset) {
      throw new NotFoundError("Content asset");
    }

    const revisions = await prisma.contentRevision.findMany({
      where: { assetId, workspaceId },
      orderBy: { revisionNumber: "desc" },
      include: {
        createdByUser: { select: { id: true, name: true, email: true } },
      },
    });

    res.json({ revisions });
  } catch (err) {
    next(err);
  }
});

// Manual script editing: creates an immutable MANUAL_EDIT ContentRevision and resets approvalStatus to PENDING_APPROVAL
router.patch(
  "/:assetId",
  requireWorkspaceAccess(["OWNER", "ADMIN", "EDITOR"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId!;
      const assetId = String(req.params.assetId);
      const input = UpdateAssetSchema.parse(req.body);

      const updated = await prisma.$transaction(async (tx) => {
        const existing = await tx.contentAsset.findFirst({
          where: { id: assetId, workspaceId },
          include: {
            revisions: { orderBy: { revisionNumber: "desc" }, take: 1 },
          },
        });
        if (!existing) {
          throw new NotFoundError("Content asset");
        }

        const latestRev = existing.revisions[0];
        const prevMeta = (existing.metadata && typeof existing.metadata === "object"
          ? existing.metadata
          : {}) as Record<string, unknown>;
        const prevScript = (prevMeta.script && typeof prevMeta.script === "object"
          ? prevMeta.script
          : {}) as Record<string, unknown>;

        const mergedScript: Record<string, unknown> = {
          ...prevScript,
          ...(input.script ?? {}),
          ...(input.title !== undefined && { title: input.title }),
          ...(input.hook !== undefined && { hook: input.hook }),
          ...(input.voiceoverScript !== undefined && {
            voiceoverScript: input.voiceoverScript,
            script: input.voiceoverScript,
          }),
          ...(input.description !== undefined && {
            description: input.description,
            caption: input.description,
          }),
          ...(input.hashtags !== undefined && { hashtags: input.hashtags }),
        };

        const nextTitle =
          (typeof mergedScript.title === "string" && mergedScript.title.trim()) ||
          latestRev?.title ||
          existing.fileName;
        const nextHook =
          typeof mergedScript.hook === "string" ? mergedScript.hook : latestRev?.hook ?? null;
        const nextVoiceover =
          typeof mergedScript.voiceoverScript === "string"
            ? mergedScript.voiceoverScript
            : typeof mergedScript.script === "string"
              ? mergedScript.script
              : latestRev?.voiceoverScript ?? "";
        const nextDescription =
          typeof mergedScript.description === "string"
            ? mergedScript.description
            : typeof mergedScript.caption === "string"
              ? mergedScript.caption
              : latestRev?.description ?? null;
        const nextHashtags = Array.isArray(mergedScript.hashtags)
          ? mergedScript.hashtags.filter((h): h is string => typeof h === "string")
          : latestRev?.hashtags ?? [];

        const nextRevNum = existing.currentRevisionNum + 1;

        await tx.contentRevision.create({
          data: {
            workspaceId,
            projectId: existing.projectId,
            executionId: existing.executionId,
            assetId: existing.id,
            revisionNumber: nextRevNum,
            source: "MANUAL_EDIT",
            title: nextTitle,
            hook: nextHook,
            voiceoverScript: nextVoiceover,
            description: nextDescription,
            hashtags: nextHashtags,
            scriptPayload: mergedScript as Prisma.InputJsonValue,
            researchBrief: (latestRev?.researchBrief ?? null) as Prisma.InputJsonValue,
            createdByUserId: req.user!.id,
          },
        });

        if (existing.executionId) {
          await tx.workflowExecution.updateMany({
            where: {
              id: existing.executionId,
              workspaceId,
              status: { in: ["AWAITING_APPROVAL", "RUNNING"] },
            },
            data: {
              activeRevisionNum: nextRevNum,
              approvedRevisionId: null,
            },
          });
        }

        const nextMeta: Record<string, unknown> = {
          ...prevMeta,
          title: nextTitle,
          approvalStatus: "PENDING_APPROVAL",
          script: mergedScript,
          lastEditedBy: req.user?.email,
          lastEditedAt: new Date().toISOString(),
        };

        return tx.contentAsset.update({
          where: { id: assetId },
          data: {
            fileName: (input.fileName ?? nextTitle).slice(0, 120),
            approvalStatus: "PENDING_APPROVAL",
            currentRevisionNum: nextRevNum,
            approvedRevisionId: null,
            metadata: nextMeta as Prisma.InputJsonValue,
          },
          include: {
            project: { select: { id: true, name: true, niche: true } },
            execution: {
              select: {
                id: true,
                status: true,
                currentStageIndex: true,
                activeRevisionNum: true,
                approvedRevisionId: true,
              },
            },
            revisions: {
              orderBy: { revisionNumber: "desc" },
              include: {
                createdByUser: { select: { id: true, name: true, email: true } },
              },
            },
            approvalDecisions: {
              orderBy: { createdAt: "desc" },
              include: {
                reviewer: { select: { id: true, name: true, email: true } },
                revision: { select: { id: true, revisionNumber: true } },
              },
            },
          },
        });
      });

      res.json({ asset: serializeAsset(updated) });
    } catch (err) {
      next(err);
    }
  }
);

// Human-in-the-loop review endpoint (APPROVED / REJECTED / REVISION_REQUESTED) with Transactional Outbox
router.post(
  "/:assetId/review",
  requireWorkspaceAccess(["OWNER", "ADMIN", "EDITOR"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId!;
      const assetId = String(req.params.assetId);
      const input = ReviewAssetSchema.parse(req.body);

      if (input.decision === "REVISION_REQUESTED" && (!input.comment || !input.comment.trim())) {
        throw new ValidationError("Revision feedback comment is required when requesting revisions");
      }

      const asset = await prisma.contentAsset.findFirst({
        where: { id: assetId, workspaceId },
        include: {
          revisions: { orderBy: { revisionNumber: "desc" } },
        },
      });

      if (!asset) {
        throw new NotFoundError("Content asset");
      }

      const prevMeta = (asset.metadata && typeof asset.metadata === "object"
        ? asset.metadata
        : {}) as Record<string, unknown>;
      const prevScript = (prevMeta.script && typeof prevMeta.script === "object"
        ? prevMeta.script
        : {}) as Record<string, unknown>;

      // Ensure a ContentRevision always exists (even for RENDERED_VIDEO assets)
      let targetRevision = input.revisionId
        ? asset.revisions.find((r) => r.id === input.revisionId)
        : asset.revisions[0];

      if (!targetRevision) {
        targetRevision = await prisma.contentRevision.create({
          data: {
            workspaceId,
            projectId: asset.projectId,
            executionId: asset.executionId,
            assetId: asset.id,
            revisionNumber: Math.max(1, asset.currentRevisionNum || 1),
            source: "AI_GENERATED",
            title: String(prevScript.title || prevMeta.title || asset.fileName),
            hook: typeof prevScript.hook === "string" ? prevScript.hook : null,
            voiceoverScript: typeof prevScript.voiceoverScript === "string"
              ? prevScript.voiceoverScript
              : typeof prevScript.script === "string"
                ? prevScript.script
                : asset.fileName,
            description: typeof prevScript.description === "string" ? prevScript.description : null,
            hashtags: Array.isArray(prevScript.hashtags)
              ? prevScript.hashtags.filter((h): h is string => typeof h === "string")
              : [],
            scriptPayload: prevScript as Prisma.InputJsonValue,
            createdByUserId: req.user!.id,
          },
        });
      }

      const nextApprovalStatus =
        input.decision === "APPROVED"
          ? "APPROVED"
          : input.decision === "REJECTED"
            ? "REJECTED"
            : "REVISION_REQUESTED";

      if (!asset.executionId) {
        throw new ValidationError("Content asset is not linked to a workflow execution");
      }

      const decisionRecord = await prisma.approvalDecision.create({
        data: {
          workspaceId,
          projectId: asset.projectId,
          executionId: asset.executionId,
          assetId: asset.id,
          revisionId: targetRevision.id,
          reviewerId: req.user!.id,
          decision: input.decision,
          comment: input.comment?.trim() || null,
          idempotencyKey: input.idempotencyKey ?? null,
        },
      });

      // Update this asset (and any sibling assets in the same execution)
      await prisma.contentAsset.update({
        where: { id: asset.id },
        data: {
          approvalStatus: nextApprovalStatus,
          approvedRevisionId: input.decision === "APPROVED" ? targetRevision.id : null,
          metadata: {
            ...prevMeta,
            approvalStatus: nextApprovalStatus,
            lastDecision: input.decision,
            lastReviewedBy: req.user?.email,
            lastReviewedAt: new Date().toISOString(),
          } as Prisma.InputJsonValue,
        },
      });

      if (asset.executionId) {
        await prisma.contentAsset.updateMany({
          where: {
            workspaceId,
            executionId: asset.executionId,
            id: { not: asset.id },
            approvalStatus: "PENDING_APPROVAL",
          },
          data: {
            approvalStatus: nextApprovalStatus,
          },
        });
      }

      let outboxEventId: string | null = null;

      if (asset.executionId) {
        const execution = await prisma.workflowExecution.findFirst({
          where: { id: asset.executionId, workspaceId },
          include: { stages: { orderBy: { stageOrder: "asc" } } },
        });

        if (execution) {
          const nextExecStatus = input.decision === "REJECTED" ? "REJECTED" : "RUNNING";
          const nextActiveRev =
            input.decision === "REVISION_REQUESTED"
              ? execution.activeRevisionNum + 1
              : execution.activeRevisionNum;

          await prisma.workflowExecution.update({
            where: { id: execution.id },
            data: {
              status: nextExecStatus,
              activeRevisionNum: nextActiveRev,
              approvedRevisionId: input.decision === "APPROVED" ? targetRevision.id : null,
              ...(input.decision === "REJECTED" ? { completedAt: new Date() } : {}),
            },
          });

          const approvalStage = execution.stages.find((s) => s.stageKey === "approval");

          if (input.decision === "APPROVED") {
            if (approvalStage) {
              await prisma.workflowStageExecution.update({
                where: { id: approvalStage.id },
                data: { status: "COMPLETED", completedAt: new Date() },
              });
            }

            const nextStageOrder = approvalStage
              ? approvalStage.stageOrder + 1
              : execution.currentStageIndex + 1;
            const nextStage = execution.stages.find((s) => s.stageOrder === nextStageOrder);

            if (nextStage) {
              const outboxKey = `exec_${execution.id}_approve_rev_${targetRevision.id}`;
              const outbox = await prisma.outboxEvent.upsert({
                where: { idempotencyKey: outboxKey },
                update: {},
                create: {
                  workspaceId,
                  eventType: "WORKFLOW_APPROVAL_RESUME",
                  idempotencyKey: outboxKey,
                  payload: {
                    executionId: execution.id,
                    workspaceId,
                    stageOrder: nextStage.stageOrder,
                    revisionNum: targetRevision.revisionNumber,
                    jobId: String(outboxKey).replace(/:/g, "_"),
                  },
                },
              });
              outboxEventId = outbox.id;
            } else {
              await prisma.workflowExecution.update({
                where: { id: execution.id },
                data: { status: "COMPLETED", completedAt: new Date() },
              });
            }
          } else if (input.decision === "REJECTED") {
            if (approvalStage) {
              await prisma.workflowStageExecution.update({
                where: { id: approvalStage.id },
                data: {
                  status: "REJECTED",
                  completedAt: new Date(),
                  errorMessage: input.comment?.trim() || "Rejected by reviewer",
                },
              });
            }
          } else if (input.decision === "REVISION_REQUESTED") {
            const scriptStage = execution.stages.find((s) => s.stageKey === "script_generation");
            if (scriptStage) {
              await prisma.workflowStageExecution.updateMany({
                where: {
                  executionId: execution.id,
                  stageOrder: { gte: scriptStage.stageOrder },
                },
                data: {
                  status: "PENDING",
                  output: Prisma.JsonNull,
                  errorMessage: null,
                  completedAt: null,
                },
              });

              const prevInput = (execution.inputContext && typeof execution.inputContext === "object"
                ? execution.inputContext
                : {}) as Record<string, unknown>;

              await prisma.workflowExecution.update({
                where: { id: execution.id },
                data: {
                  currentStageIndex: scriptStage.stageOrder,
                  inputContext: {
                    ...prevInput,
                    reviewerFeedback: input.comment!.trim(),
                    revisionNumber: nextActiveRev,
                  } as Prisma.InputJsonValue,
                },
              });

              const outboxKey = `exec_${execution.id}_revise_rev_${nextActiveRev}`;
              const outbox = await prisma.outboxEvent.upsert({
                where: { idempotencyKey: outboxKey },
                update: {},
                create: {
                  workspaceId,
                  eventType: "WORKFLOW_REVISION_RERUN",
                  idempotencyKey: outboxKey,
                  payload: {
                    executionId: execution.id,
                    workspaceId,
                    stageOrder: scriptStage.stageOrder,
                    revisionNum: nextActiveRev,
                    jobId: String(outboxKey).replace(/:/g, "_"),
                  },
                },
              });
              outboxEventId = outbox.id;
            }
          }
        }
      }

      if (outboxEventId) {
        await dispatchOutboxEvent(outboxEventId);
      }

      const refreshedAsset = await prisma.contentAsset.findUniqueOrThrow({
        where: { id: asset.id },
        include: {
          project: { select: { id: true, name: true, niche: true } },
          execution: {
            select: {
              id: true,
              status: true,
              currentStageIndex: true,
              activeRevisionNum: true,
              approvedRevisionId: true,
            },
          },
          revisions: {
            orderBy: { revisionNumber: "desc" },
            include: {
              createdByUser: { select: { id: true, name: true, email: true } },
            },
          },
          approvalDecisions: {
            orderBy: { createdAt: "desc" },
            include: {
              reviewer: { select: { id: true, name: true, email: true } },
              revision: { select: { id: true, revisionNumber: true } },
            },
          },
        },
      });

      res.json({
        decision: decisionRecord,
        asset: serializeAsset(refreshedAsset),
      });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/pending",
  requireWorkspaceAccess(["OWNER", "ADMIN", "EDITOR"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId!;
      const pendingAssets = await prisma.contentAsset.findMany({
        where: { workspaceId, approvalStatus: "PENDING_APPROVAL" },
        select: { id: true, executionId: true },
      });

      const assetIds = pendingAssets.map((a) => a.id);
      const execIds = Array.from(
        new Set(pendingAssets.map((a) => a.executionId).filter((id): id is string => Boolean(id)))
      );

      if (assetIds.length > 0) {
        await prisma.approvalDecision.deleteMany({ where: { workspaceId, assetId: { in: assetIds } } });
        await prisma.contentRevision.deleteMany({ where: { workspaceId, assetId: { in: assetIds } } });
        await prisma.contentAsset.deleteMany({ where: { workspaceId, id: { in: assetIds } } });
      }

      if (execIds.length > 0) {
        await prisma.workflowExecution.updateMany({
          where: { workspaceId, id: { in: execIds }, status: "AWAITING_APPROVAL" },
          data: { status: "REJECTED", completedAt: new Date() },
        });
      }

      res.json({ ok: true, deletedCount: assetIds.length });
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
      include: {
        revisions: { orderBy: { revisionNumber: "desc" } },
      },
    });
    if (!asset) throw new NotFoundError("Content asset");

    const safeName = asset.fileName.replace(/[^a-zA-Z0-9._-]/g, "_") + ".json";
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="' + safeName + '"');
    res.send(
      JSON.stringify(
        {
          id: asset.id,
          type: asset.type,
          fileName: asset.fileName,
          approvalStatus: asset.approvalStatus,
          approvedRevisionId: asset.approvedRevisionId,
          storageKey: asset.storageKey,
          revisions: asset.revisions,
        },
        null,
        2
      )
    );
  } catch (err) {
    next(err);
  }
});

export default router;
