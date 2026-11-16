import { Router, type Request, type Response, type NextFunction } from "express";
import { prisma, Prisma } from "@contentos/database";
import { AppError, NotFoundError, ValidationError } from "@contentos/shared";
import { z } from "zod";
import { dispatchOutboxEvent } from "../lib/queue.js";
import { requireAuth, requireWorkspaceAccess } from "../middleware/auth.js";

const router: Router = Router({ mergeParams: true });

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

    const assets = await prisma.contentAsset.findMany({
      where: {
        workspaceId,
        ...(projectId && { projectId }),
        ...(type && { type: type as never }),
        ...(approvalStatus && { approvalStatus: approvalStatus as never }),
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
            createdAt: true,
            completedAt: true,
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
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    res.json({ assets: assets.map(serializeAsset) });
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

      const txResult = await prisma.$transaction(async (tx) => {
        const asset = await tx.contentAsset.findFirst({
          where: { id: assetId, workspaceId },
          include: {
            revisions: { orderBy: { revisionNumber: "desc" } },
          },
        });

        if (!asset) {
          throw new NotFoundError("Content asset");
        }
        if (!asset.executionId) {
          throw new ValidationError("Content asset is not linked to a workflow execution");
        }

        const execution = await tx.workflowExecution.findFirst({
          where: { id: asset.executionId, workspaceId },
          include: {
            stages: { orderBy: { stageOrder: "asc" } },
          },
        });

        if (!execution) {
          throw new NotFoundError("Workflow execution");
        }

        // Strict state guard: only AWAITING_APPROVAL executions can be reviewed
        if (execution.status !== "AWAITING_APPROVAL") {
          throw new AppError("Workflow execution is in status '" + execution.status + "' and is not awaiting approval", 409, "CONFLICT");
        }

        const targetRevision = input.revisionId
          ? asset.revisions.find((r) => r.id === input.revisionId)
          : asset.revisions[0];

        if (!targetRevision) {
          throw new ValidationError("No content revision found to review");
        }
        if (targetRevision.revisionNumber !== asset.currentRevisionNum) {
          throw new AppError("Cannot review a superseded revision; review the latest revision instead", 409, "CONFLICT");
        }

        // Atomic CAS guard to prevent concurrent double-approval race conditions
        const nextExecStatus = input.decision === "REJECTED" ? "REJECTED" : "RUNNING";
        const nextActiveRev =
          input.decision === "REVISION_REQUESTED"
            ? execution.activeRevisionNum + 1
            : execution.activeRevisionNum;

        const claimed = await tx.workflowExecution.updateMany({
          where: {
            id: execution.id,
            workspaceId,
            status: "AWAITING_APPROVAL",
          },
          data: {
            status: nextExecStatus,
            activeRevisionNum: nextActiveRev,
            approvedRevisionId: input.decision === "APPROVED" ? targetRevision.id : null,
            ...(input.decision === "REJECTED" ? { completedAt: new Date() } : {}),
          },
        });

        if (claimed.count === 0) {
          throw new AppError("Approval decision was already submitted for this execution", 409, "CONFLICT");
        }

        const decisionRecord = await tx.approvalDecision.create({
          data: {
            workspaceId,
            projectId: asset.projectId,
            executionId: execution.id,
            assetId: asset.id,
            revisionId: targetRevision.id,
            reviewerId: req.user!.id,
            decision: input.decision,
            comment: input.comment?.trim() || null,
            idempotencyKey: input.idempotencyKey ?? null,
          },
        });

        const prevMeta = (asset.metadata && typeof asset.metadata === "object"
          ? asset.metadata
          : {}) as Record<string, unknown>;

        const nextApprovalStatus =
          input.decision === "APPROVED"
            ? "APPROVED"
            : input.decision === "REJECTED"
              ? "REJECTED"
              : "REVISION_REQUESTED";

        await tx.contentAsset.update({
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

        const approvalStage = execution.stages.find((s) => s.stageKey === "approval");
        let outboxEventId: string | null = null;

        if (input.decision === "APPROVED") {
          if (approvalStage) {
            await tx.workflowStageExecution.update({
              where: { id: approvalStage.id },
              data: {
                status: "COMPLETED",
                completedAt: new Date(),
              },
            });
          }

          const nextStageOrder = approvalStage
            ? approvalStage.stageOrder + 1
            : execution.currentStageIndex + 1;
          const nextStage = execution.stages.find((s) => s.stageOrder === nextStageOrder);

          if (nextStage) {
            const outboxKey = `exec_${execution.id}_approve_rev_${targetRevision.id}`;
            const outbox = await tx.outboxEvent.upsert({
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
            await tx.workflowExecution.update({
              where: { id: execution.id },
              data: { status: "COMPLETED", completedAt: new Date() },
            });
          }
        } else if (input.decision === "REJECTED") {
          if (approvalStage) {
            await tx.workflowStageExecution.update({
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
          if (!scriptStage) {
            throw new ValidationError("Workflow template does not contain a script_generation stage");
          }

          // Reset script_generation and all downstream stages back to PENDING
          await tx.workflowStageExecution.updateMany({
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

          await tx.workflowExecution.update({
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
          const outbox = await tx.outboxEvent.upsert({
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

        const refreshedAsset = await tx.contentAsset.findUniqueOrThrow({
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

        return { decisionRecord, refreshedAsset, outboxEventId };
      });

      if (txResult.outboxEventId) {
        await dispatchOutboxEvent(txResult.outboxEventId);
      }

      res.json({
        decision: txResult.decisionRecord,
        asset: serializeAsset(txResult.refreshedAsset),
      });
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
