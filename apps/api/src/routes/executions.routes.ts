import { Router, type Request, type Response, type NextFunction } from "express";
import { prisma, type Prisma } from "@contentos/database";
import {
  AppError,
  NotFoundError,
  TriggerExecutionSchema,
  ValidationError,
  WorkflowStageDefinitionSchema,
} from "@contentos/shared";
import { z } from "zod";
import { dispatchOutboxEvent } from "../lib/queue.js";
import { logger } from "../lib/logger.js";
import { requireAuth, requireWorkspaceAccess } from "../middleware/auth.js";

const router: Router = Router({ mergeParams: true });

router.use(requireAuth, requireWorkspaceAccess());

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = req.workspaceId!;
    const projectId = req.query.projectId ? String(req.query.projectId) : undefined;

    const executions = await prisma.workflowExecution.findMany({
      where: {
        workspaceId,
        ...(projectId && { projectId }),
      },
      include: {
        project: { select: { id: true, name: true, niche: true } },
        workflowTemplate: { select: { id: true, name: true } },
        stages: { orderBy: { stageOrder: "asc" } },
      },
      orderBy: { createdAt: "desc" },
      take: 30,
    });

    res.json({ executions });
  } catch (err) {
    next(err);
  }
});

router.get("/:executionId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = req.workspaceId!;
    const executionId = String(req.params.executionId);

    const execution = await prisma.workflowExecution.findFirst({
      where: { id: executionId, workspaceId },
      include: {
        project: { select: { id: true, name: true, niche: true } },
        workflowTemplate: true,
        stages: { orderBy: { stageOrder: "asc" } },
      },
    });

    if (!execution) {
      throw new NotFoundError("Workflow execution");
    }

    res.json({ execution });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/projects/:projectId/run",
  requireWorkspaceAccess(["OWNER", "ADMIN", "EDITOR"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId!;
      const projectId = String(req.params.projectId);
      const input = TriggerExecutionSchema.parse(req.body ?? {});

      const project = await prisma.project.findFirst({
        where: { id: projectId, workspaceId },
        include: { workflowTemplate: true },
      });

      if (!project) {
        throw new NotFoundError("Project");
      }

      if (project.status !== "ACTIVE") {
        throw new ValidationError("Cannot trigger workflow on a paused or archived project");
      }

      const stageDefinitions = z
        .array(WorkflowStageDefinitionSchema)
        .min(1)
        .parse(project.workflowTemplate.stages)
        .sort((a, b) => a.order - b.order);

      const { execution, outboxEvent } = await prisma.$transaction(async (tx) => {
        const createdExecution = await tx.workflowExecution.create({
          data: {
            workspaceId,
            projectId: project.id,
            workflowTemplateId: project.workflowTemplateId,
            status: "PENDING",
            currentStageIndex: 0,
            inputContext: input as Prisma.InputJsonValue,
            stages: {
              create: stageDefinitions.map((stage, idx) => ({
                workspaceId,
                stageKey: stage.key,
                stageName: stage.name,
                stageOrder: idx,
                status: "PENDING",
              })),
            },
          },
          include: {
            stages: { orderBy: { stageOrder: "asc" } },
          },
        });

        const event = await tx.outboxEvent.create({
          data: {
            workspaceId,
            eventType: "WORKFLOW_EXECUTION_START",
            idempotencyKey: `exec_${createdExecution.id}_stage_0_rev_1`,
            payload: {
              executionId: createdExecution.id,
              workspaceId,
              stageOrder: 0,
              revisionNum: 1,
              jobId: `exec_${createdExecution.id}_stage_0_rev_1`,
            },
          },
        });

        return { execution: createdExecution, outboxEvent: event };
      });

      const firstStage = stageDefinitions[0];
      const dispatched = await dispatchOutboxEvent(
        outboxEvent.id,
        firstStage.retryPolicy.maxAttempts,
        firstStage.retryPolicy.backoffMs
      );
      if (!dispatched) {
        logger.warn({ outboxEventId: outboxEvent.id }, "Immediate queue dispatch failed; outbox poller will retry");
      }

      res.status(201).json({ execution });
    } catch (err) {
      next(err);
    }
  }
);


router.post(
  "/:executionId/retry",
  requireWorkspaceAccess(["OWNER", "ADMIN", "EDITOR"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId!;
      const executionId = String(req.params.executionId);

      const { execution, outboxEventId } = await prisma.$transaction(async (tx) => {
        const existing = await tx.workflowExecution.findFirst({
          where: { id: executionId, workspaceId },
          include: { stages: { orderBy: { stageOrder: "asc" } } },
        });
        if (!existing) {
          throw new NotFoundError("Workflow execution");
        }
        if (existing.status !== "FAILED") {
          throw new AppError("Only FAILED executions can be retried (current: " + existing.status + ")", 409, "CONFLICT");
        }

        const failedStage =
          existing.stages.find((s) => s.status === "FAILED") ??
          existing.stages.find((s) => s.stageOrder === existing.currentStageIndex);

        if (!failedStage) {
          throw new ValidationError("No failed stage found to retry");
        }

        const claimed = await tx.workflowExecution.updateMany({
          where: { id: executionId, workspaceId, status: "FAILED" },
          data: {
            status: "RUNNING",
            errorMessage: null,
            completedAt: null,
            currentStageIndex: failedStage.stageOrder,
          },
        });
        if (claimed.count === 0) {
          throw new AppError("Execution retry already in progress", 409, "CONFLICT");
        }

        await tx.workflowStageExecution.update({
          where: { id: failedStage.id },
          data: {
            status: "PENDING",
            errorMessage: null,
            completedAt: null,
          },
        });

        const outboxKey = `exec_${executionId}_retry_stage_${failedStage.stageOrder}_attempt_${failedStage.attemptCount + 1}`;
        const outbox = await tx.outboxEvent.upsert({
          where: { idempotencyKey: outboxKey },
          update: {},
          create: {
            workspaceId,
            eventType: "WORKFLOW_STAGE_RETRY",
            idempotencyKey: outboxKey,
            payload: {
              executionId,
              workspaceId,
              stageOrder: failedStage.stageOrder,
              revisionNum: existing.activeRevisionNum,
              jobId: String(outboxKey).replace(/:/g, "_"),
            },
          },
        });

        const refreshed = await tx.workflowExecution.findUniqueOrThrow({
          where: { id: executionId },
          include: {
            project: { select: { id: true, name: true, niche: true } },
            workflowTemplate: true,
            stages: { orderBy: { stageOrder: "asc" } },
          },
        });

        return { execution: refreshed, outboxEventId: outbox.id };
      });

      await dispatchOutboxEvent(outboxEventId);
      res.json({ execution });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
