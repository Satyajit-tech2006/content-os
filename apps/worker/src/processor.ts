import { storeArtifact } from "./lib/storage.js";
import { Queue } from "bullmq";
import { prisma, type Prisma } from "@contentos/database";
import { AIOrchestrator, AIProviderFactory } from "@contentos/ai-provider";
import {
  StageKeySchema,
  WorkflowStageDefinitionSchema,
} from "@contentos/shared";
import {
  defaultStageRegistry,
  type StageLogEntry,
} from "@contentos/workflow-engine";
import { z } from "zod";
import { env } from "./config/env.js";
import type { Logger } from "pino";

export interface StageJobPayload {
  executionId: string;
  workspaceId: string;
  stageOrder: number;
}

export async function processWorkflowStageJob(
  payload: StageJobPayload,
  queue: Queue,
  logger: Logger
): Promise<void> {
  const { executionId, workspaceId, stageOrder } = payload;

  const execution = await prisma.workflowExecution.findFirst({
    where: { id: executionId, workspaceId },
    include: {
      project: true,
      workflowTemplate: true,
      stages: { orderBy: { stageOrder: "asc" } },
    },
  });

  if (!execution) {
    logger.warn({ executionId, workspaceId }, "Execution not found; skipping job");
    return;
  }

  if (execution.status === "CANCELLED" || execution.status === "COMPLETED") {
    logger.info({ executionId, status: execution.status }, "Execution already terminal; skipping");
    return;
  }

  const stageRecord = execution.stages.find((s) => s.stageOrder === stageOrder);
  if (!stageRecord) {
    throw new Error("Stage order " + stageOrder + " not found for execution " + executionId);
  }

  if (stageRecord.status === "COMPLETED") {
    logger.info({ executionId, stageOrder }, "Stage already completed (idempotent skip)");
    return;
  }

  const stageDefs = z
    .array(WorkflowStageDefinitionSchema)
    .parse(execution.workflowTemplate.stages)
    .sort((a, b) => a.order - b.order);

  const currentStageDef = stageDefs[stageOrder];
  const stageKey = StageKeySchema.parse(stageRecord.stageKey);
  const handler = defaultStageRegistry.get(stageKey);

  const previousOutputs: Record<string, unknown> = {};
  for (const prev of execution.stages) {
    if (prev.stageOrder < stageOrder && prev.output && typeof prev.output === "object") {
      Object.assign(previousOutputs, prev.output as Record<string, unknown>);
    }
  }

  const logs: StageLogEntry[] = Array.isArray(stageRecord.logs)
    ? (stageRecord.logs as unknown as StageLogEntry[])
    : [];

  const log = (
    level: StageLogEntry["level"],
    message: string,
    meta?: Record<string, unknown>
  ) => {
    logs.push({ timestamp: new Date().toISOString(), level, message, meta });
  };

  await prisma.$transaction([
    prisma.workflowExecution.update({
      where: { id: executionId },
      data: {
        status: "RUNNING",
        currentStageIndex: stageOrder,
        startedAt: execution.startedAt ?? new Date(),
      },
    }),
    prisma.workflowStageExecution.update({
      where: { id: stageRecord.id },
      data: {
        status: "RUNNING",
        attemptCount: { increment: 1 },
        input: previousOutputs as Prisma.InputJsonValue,
        startedAt: stageRecord.startedAt ?? new Date(),
      },
    }),
  ]);

  const aiFactory = new AIProviderFactory({
  defaultProvider: env.AI_PROVIDER,
  ollamaBaseUrl: env.OLLAMA_BASE_URL,
  ollamaDefaultModel: env.OLLAMA_DEFAULT_MODEL,
  geminiApiKey: env.GEMINI_API_KEY,
  geminiDefaultModel: env.GEMINI_MODEL,
});
const orchestrator = new AIOrchestrator(aiFactory);
const aiProvider = aiFactory.getProvider();

  try {
    const result = await handler.execute({
      executionId,
      workspaceId,
      projectId: execution.projectId,
      project: {
        name: execution.project.name,
        niche: execution.project.niche,
        targetAudience: execution.project.targetAudience,
        contentFormat: execution.project.contentFormat,
        platforms: execution.project.platforms,
        approvalRequired: execution.project.approvalRequired,
        config: (execution.project.config as Record<string, unknown>) ?? {},
      },
      stageKey,
      stageConfig: currentStageDef?.config ?? {},
      inputContext: (execution.inputContext as Record<string, unknown>) ?? {},
      previousOutputs,
      aiProvider,
      orchestrator,
      log,
    });

    await prisma.$transaction([
      prisma.workflowStageExecution.update({
        where: { id: stageRecord.id },
        data: {
          status: "COMPLETED",
          output: result.output as Prisma.InputJsonValue,
          logs: logs as unknown as Prisma.InputJsonValue,
          errorMessage: null,
          completedAt: new Date(),
        },
      }),
      ...(result.usage ?? []).map((u) =>
        prisma.usageRecord.create({
          data: {
            workspaceId,
            projectId: execution.projectId,
            executionId,
            stageKey,
            provider: u.provider,
            model: u.model,
            taskType: u.taskType ?? u.operation,
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            estimatedCostUsd: u.estimatedCostUsd,
            durationMs: u.durationMs,
            success: u.success ?? true,
            errorMessage: u.errorMessage ?? null,
            costMetadata: (u.costMetadata ?? {}) as Prisma.InputJsonValue,
          },
        })
      ),
    ]);

    const nextStageOrder = stageOrder + 1;
    const nextStageDef = stageDefs[nextStageOrder];

    if (nextStageDef) {
      await queue.add(
        "execute-stage",
        { executionId, workspaceId, stageOrder: nextStageOrder },
        {
          jobId: executionId + ":stage:" + nextStageOrder,
          attempts: nextStageDef.retryPolicy.maxAttempts,
          backoff: {
            type: "exponential",
            delay: nextStageDef.retryPolicy.backoffMs,
          },
        }
      );
    } else {
      const mergedOutputs = { ...previousOutputs, ...result.output };
      const scriptData = (mergedOutputs.script as Record<string, unknown> | undefined) ?? {};
      const mediaData = (mergedOutputs.renderedMedia as Record<string, unknown> | undefined) ?? {};
      const approvalStatus = execution.project.approvalRequired ? "PENDING_REVIEW" : "APPROVED";
      const title = typeof scriptData.title === "string" && scriptData.title
        ? scriptData.title
        : execution.project.name + " ? Episode";

      const scriptStorageKey = "workspaces/" + workspaceId + "/executions/" + executionId + "/script.json";
      const videoStorageKey =
        typeof mediaData.storageKey === "string"
          ? mediaData.storageKey
          : "workspaces/" + workspaceId + "/executions/" + executionId + "/master.mp4";

      await Promise.all([
        storeArtifact(scriptStorageKey, JSON.stringify({ title, researchBrief: mergedOutputs.researchBrief ?? null, script: scriptData }, null, 2)),
        storeArtifact(videoStorageKey + ".manifest.json", JSON.stringify({ title, media: mediaData, quality: mergedOutputs.qualityReport ?? null }, null, 2)),
      ]);

      await prisma.$transaction([
        prisma.workflowExecution.update({
          where: { id: executionId },
          data: {
            status: "COMPLETED",
            outputSummary: mergedOutputs as Prisma.InputJsonValue,
            completedAt: new Date(),
          },
        }),
        prisma.contentAsset.upsert({
          where: { storageKey: "workspaces/" + workspaceId + "/executions/" + executionId + "/script.json" },
          update: {},
          create: {
            workspaceId,
            projectId: execution.projectId,
            executionId,
            type: "RAW_FOOTAGE",
            fileName: title.slice(0, 80) + " (Script)",
            mimeType: "application/json",
            fileSize: BigInt(Buffer.byteLength(JSON.stringify(scriptData), "utf8")),
            storageKey: "workspaces/" + workspaceId + "/executions/" + executionId + "/script.json",
            status: "READY",
            metadata: {
              title,
              approvalStatus,
              script: scriptData,
              researchBrief: mergedOutputs.researchBrief ?? null,
              qualityReport: mergedOutputs.qualityReport ?? null,
            } as Prisma.InputJsonValue,
          },
        }),
        prisma.contentAsset.upsert({
          where: {
            storageKey:
              typeof mediaData.storageKey === "string"
                ? mediaData.storageKey
                : "workspaces/" + workspaceId + "/executions/" + executionId + "/master.mp4",
          },
          update: {},
          create: {
            workspaceId,
            projectId: execution.projectId,
            executionId,
            type: "RENDERED_VIDEO",
            fileName: title.slice(0, 80) + ".mp4",
            mimeType: typeof mediaData.mimeType === "string" ? mediaData.mimeType : "video/mp4",
            fileSize: BigInt(4_250_000),
            storageKey:
              typeof mediaData.storageKey === "string"
                ? mediaData.storageKey
                : "workspaces/" + workspaceId + "/executions/" + executionId + "/master.mp4",
            status: "READY",
            metadata: {
              title,
              approvalStatus,
              durationSec: mediaData.durationSec ?? 45,
              resolution: mediaData.resolution ?? "1080x1920",
              renderMode: mediaData.renderMode ?? "simulated_v0.1",
              script: scriptData,
            } as Prisma.InputJsonValue,
          },
        }),
      ]);
      logger.info({ executionId }, "Workflow execution completed and assets persisted");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown stage error";
    log("error", "Stage execution failed: " + message);

    await prisma.$transaction([
      prisma.workflowStageExecution.update({
        where: { id: stageRecord.id },
        data: {
          status: "FAILED",
          logs: logs as unknown as Prisma.InputJsonValue,
          errorMessage: message,
          completedAt: new Date(),
        },
      }),
      prisma.workflowExecution.update({
        where: { id: executionId },
        data: {
          status: "FAILED",
          errorMessage: "Stage " + stageRecord.stageName + " failed: " + message,
          completedAt: new Date(),
        },
      }),
    ]);

    throw err;
  }
}
