import { Router, type Request, type Response, type NextFunction } from "express";
import { prisma, type Prisma } from "@contentos/database";
import {
  NotFoundError,
  TriggerExecutionSchema,
  ValidationError,
  WorkflowStageDefinitionSchema,
} from "@contentos/shared";
import { z } from "zod";
import { enqueueStageJob } from "../lib/queue.js";
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
            payload: {
              executionId: createdExecution.id,
              workspaceId,
              stageOrder: 0,
            },
          },
        });

        return { execution: createdExecution, outboxEvent: event };
      });

      try {
        const firstStage = stageDefinitions[0];
        await enqueueStageJob(
          { executionId: execution.id, workspaceId, stageOrder: 0 },
          firstStage.retryPolicy.maxAttempts,
          firstStage.retryPolicy.backoffMs
        );
        await prisma.outboxEvent.update({
          where: { id: outboxEvent.id },
          data: { status: "PROCESSED", processedAt: new Date() },
        });
      } catch (queueErr) {
        logger.warn(
          { err: queueErr, outboxEventId: outboxEvent.id },
          "Immediate queue dispatch failed; outbox poller will retry"
        );
      }

      res.status(201).json({ execution });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
