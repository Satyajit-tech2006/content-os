import { storeArtifact } from "./lib/storage.js";
import { synthesizeVoiceoverMp3, renderVerticalVideoMp4 } from "./lib/mediaRenderer.js";
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
  revisionNum?: number;
  jobId?: string;
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

  if (
    execution.status === "CANCELLED" ||
    execution.status === "COMPLETED" ||
    execution.status === "REJECTED"
  ) {
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

  // Publishing safety: verify an exact approved revision is pinned before running publishing
  let pinnedApprovedRevision: Record<string, unknown> | undefined;
  if (stageKey === "publishing") {
    if (!execution.approvedRevisionId) {
      throw new Error("Publishing blocked: workflow execution has no approvedRevisionId");
    }
    const approvedRevision = await prisma.contentRevision.findFirst({
      where: {
        id: execution.approvedRevisionId,
        workspaceId,
        executionId,
      },
      include: { asset: true },
    });
    if (!approvedRevision) {
      throw new Error("Publishing blocked: approved revision " + execution.approvedRevisionId + " not found");
    }
    if (approvedRevision.asset.approvalStatus !== "APPROVED") {
      throw new Error(
        "Publishing blocked: asset approvalStatus is " +
          approvedRevision.asset.approvalStatus +
          " (expected APPROVED)"
      );
    }
    pinnedApprovedRevision = {
      id: approvedRevision.id,
      assetId: approvedRevision.assetId,
      revisionNumber: approvedRevision.revisionNumber,
      title: approvedRevision.title,
      hook: approvedRevision.hook,
      voiceoverScript: approvedRevision.voiceoverScript,
      description: approvedRevision.description,
      hashtags: approvedRevision.hashtags,
      scriptPayload: approvedRevision.scriptPayload,
    };
  }

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
    const runtimeInputContext: Record<string, unknown> = {
      ...((execution.inputContext as Record<string, unknown>) ?? {}),
      ...(pinnedApprovedRevision ? { approvedRevision: pinnedApprovedRevision } : {}),
    };

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
      inputContext: runtimeInputContext,
      previousOutputs,
      aiProvider,
      orchestrator,
      log,
    });


    // Stage 3 (media_production): synthesize real MP3 voiceover via msedge-tts and register AUDIO asset
    if (stageKey === "media_production") {
      const mergedNow = { ...previousOutputs, ...result.output };
      const scriptData = (mergedNow.script as Record<string, unknown> | undefined) ?? {};
      const title = typeof scriptData.title === "string" && scriptData.title.trim()
        ? scriptData.title.trim()
        : execution.project.name;
      const hook = typeof scriptData.hook === "string" ? scriptData.hook.trim() : "";
      const body = typeof scriptData.voiceoverScript === "string"
        ? scriptData.voiceoverScript
        : typeof scriptData.script === "string"
          ? scriptData.script
          : "";
      const narrationText = body && hook && body.toLowerCase().includes(hook.toLowerCase().slice(0, 20)) ? body : [hook, body].filter(Boolean).join(". ");
      const audioStorageKey = `workspaces/${workspaceId}/executions/${executionId}/voiceover.mp3`;

      log("info", "Synthesizing neural TTS voiceover MP3 via msedge-tts...");
      const aspectRatioVal = String((execution.project.config as Record<string, unknown>)?.aspectRatio ?? "9:16");
      const audioOut = await synthesizeVoiceoverMp3({
        storageKey: audioStorageKey,
        text: narrationText,
        tone: String(runtimeInputContext.tone ?? (execution.project.config as Record<string, unknown>)?.tone ?? "engaging"),
        aspectRatio: aspectRatioVal,
      });
      log("info", `Voiceover MP3 synthesized (${audioOut.bytes} bytes, ${audioOut.durationSec}s via ${audioOut.engine})`);

      result.output = {
        ...result.output,
        audioAsset: {
          storageKey: audioStorageKey,
          mediaUrl: `/media/${audioStorageKey}`,
          mimeType: "audio/mpeg",
          bytes: audioOut.bytes,
          durationSec: audioOut.durationSec,
          engine: audioOut.engine,
        },
      };

      await prisma.contentAsset.upsert({
        where: { storageKey: audioStorageKey },
        update: {
          fileName: (title + " (Voiceover)").slice(0, 120),
          fileSize: BigInt(audioOut.bytes),
          status: "READY",
          metadata: {
            title: title + " (Voiceover)",
            mediaUrl: `/media/${audioStorageKey}`,
            durationSec: audioOut.durationSec,
            engine: audioOut.engine,
          } as Prisma.InputJsonValue,
        },
        create: {
          workspaceId,
          projectId: execution.projectId,
          executionId,
          type: "AUDIO",
          fileName: (title + " (Voiceover)").slice(0, 120),
          mimeType: "audio/mpeg",
          fileSize: BigInt(audioOut.bytes),
          storageKey: audioStorageKey,
          status: "READY",
          approvalStatus: execution.project.approvalRequired ? "PENDING_APPROVAL" : "APPROVED",
          currentRevisionNum: execution.activeRevisionNum,
          metadata: {
            title: title + " (Voiceover)",
            mediaUrl: `/media/${audioStorageKey}`,
            durationSec: audioOut.durationSec,
            engine: audioOut.engine,
          } as Prisma.InputJsonValue,
        },
      });
    }

    // Stage 4 (video_rendering): render real 1080x1920 MP4 via ffmpeg-static and register RENDERED_VIDEO asset
    if (stageKey === "video_rendering") {
      const mergedNow = { ...previousOutputs, ...result.output };
      const scriptData = (mergedNow.script as Record<string, unknown> | undefined) ?? {};
      const title = typeof scriptData.title === "string" && scriptData.title.trim()
        ? scriptData.title.trim()
        : execution.project.name;
      const hook = typeof scriptData.hook === "string" ? scriptData.hook.trim() : "";
      const body = typeof scriptData.voiceoverScript === "string"
        ? scriptData.voiceoverScript
        : typeof scriptData.script === "string"
          ? scriptData.script
          : "";
      const audioStorageKey = `workspaces/${workspaceId}/executions/${executionId}/voiceover.mp3`;
      const videoStorageKey = `workspaces/${workspaceId}/executions/${executionId}/master.mp4`;

      log("info", "Rendering vertical H.264 MP4 video with synced captions via ffmpeg-static...");
      const videoOut = await renderVerticalVideoMp4({
        videoStorageKey,
        audioStorageKey,
        channelName: execution.project.name,
        title,
        hook,
        script: body,
        keywords: Array.isArray(scriptData.hashtags) ? scriptData.hashtags.filter((h): h is string => typeof h === "string") : [],
        storyboard: Array.isArray(scriptData.storyboard) ? scriptData.storyboard : undefined,
        timedCaptions: Array.isArray(mergedNow.timedCaptions) ? (mergedNow.timedCaptions as any) : undefined,
        aspectRatio: String((execution.project.config as Record<string, unknown>)?.aspectRatio ?? "9:16"),
        videoStyle: (runtimeInputContext.videoStyle ?? (execution.project.config as Record<string, unknown>)?.videoStyle ?? "stock_ken_burns") as any,
      });
      log("info", `Rendered MP4 complete (${videoOut.resolution}, ${videoOut.durationSec}s, ${videoOut.bytes} bytes)`);

      result.output = {
        ...result.output,
        renderedMedia: {
          storageKey: videoStorageKey,
          mediaUrl: `/media/${videoStorageKey}`,
          mimeType: "video/mp4",
          durationSec: videoOut.durationSec,
          resolution: videoOut.resolution,
          bytes: videoOut.bytes,
          renderMode: "ffmpeg_local_v1",
        },
      };

      await prisma.contentAsset.upsert({
        where: { storageKey: videoStorageKey },
        update: {
          fileName: (title + " (Master Video)").slice(0, 120),
          fileSize: BigInt(videoOut.bytes),
          status: "READY",
          metadata: {
            title: title + " (Master Video)",
            mediaUrl: `/media/${videoStorageKey}`,
            audioUrl: `/media/${audioStorageKey}`,
            durationSec: videoOut.durationSec,
            resolution: videoOut.resolution,
          } as Prisma.InputJsonValue,
        },
        create: {
          workspaceId,
          projectId: execution.projectId,
          executionId,
          type: "RENDERED_VIDEO",
          fileName: (title + " (Master Video)").slice(0, 120),
          mimeType: "video/mp4",
          fileSize: BigInt(videoOut.bytes),
          storageKey: videoStorageKey,
          status: "READY",
          approvalStatus: execution.project.approvalRequired ? "PENDING_APPROVAL" : "APPROVED",
          currentRevisionNum: execution.activeRevisionNum,
          metadata: {
            title: title + " (Master Video)",
            mediaUrl: `/media/${videoStorageKey}`,
            audioUrl: `/media/${audioStorageKey}`,
            durationSec: videoOut.durationSec,
            resolution: videoOut.resolution,
          } as Prisma.InputJsonValue,
        },
      });
    }

    // If script_generation succeeded, persist immutable ContentRevision + SCRIPT ContentAsset immediately
    if (stageKey === "script_generation") {
      const mergedNow = { ...previousOutputs, ...result.output };
      const scriptData = (mergedNow.script as Record<string, unknown> | undefined) ?? {};
      const genMeta = (result.output.generationMeta as Record<string, unknown> | undefined) ?? {};
      const title =
        typeof scriptData.title === "string" && scriptData.title.trim()
          ? scriptData.title.trim()
          : execution.project.name + " ? Script";
      const hook = typeof scriptData.hook === "string" ? scriptData.hook : null;
      const voiceoverScript =
        typeof scriptData.voiceoverScript === "string"
          ? scriptData.voiceoverScript
          : typeof scriptData.script === "string"
            ? scriptData.script
            : "";
      const description =
        typeof scriptData.description === "string"
          ? scriptData.description
          : typeof scriptData.caption === "string"
            ? scriptData.caption
            : null;
      const hashtags = Array.isArray(scriptData.hashtags)
        ? scriptData.hashtags.filter((h): h is string => typeof h === "string")
        : [];
      const reviewerFeedback =
        typeof runtimeInputContext.reviewerFeedback === "string"
          ? runtimeInputContext.reviewerFeedback
          : null;

      const scriptStorageKey = `workspaces/${workspaceId}/executions/${executionId}/script.json`;
      await storeArtifact(
        scriptStorageKey,
        JSON.stringify(
          {
            title,
            revisionNumber: execution.activeRevisionNum,
            researchBrief: mergedNow.researchBrief ?? null,
            script: scriptData,
          },
          null,
          2
        )
      );

      await prisma.$transaction(async (tx) => {
        const existingAsset = await tx.contentAsset.findUnique({
          where: { storageKey: scriptStorageKey },
        });

        const nextRevNum = existingAsset
          ? Math.max(existingAsset.currentRevisionNum + 1, execution.activeRevisionNum)
          : execution.activeRevisionNum;

        const asset = existingAsset
          ? await tx.contentAsset.update({
              where: { id: existingAsset.id },
              data: {
                fileName: title.slice(0, 120),
                fileSize: BigInt(Buffer.byteLength(JSON.stringify(scriptData), "utf8")),
                approvalStatus: execution.project.approvalRequired ? "PENDING_APPROVAL" : "APPROVED",
                currentRevisionNum: nextRevNum,
                approvedRevisionId: null,
                metadata: {
                  title,
                  approvalStatus: execution.project.approvalRequired ? "PENDING_APPROVAL" : "APPROVED",
                  script: scriptData,
                  researchBrief: mergedNow.researchBrief ?? null,
                } as Prisma.InputJsonValue,
              },
            })
          : await tx.contentAsset.create({
              data: {
                workspaceId,
                projectId: execution.projectId,
                executionId,
                type: "SCRIPT",
                fileName: title.slice(0, 120),
                mimeType: "application/json",
                fileSize: BigInt(Buffer.byteLength(JSON.stringify(scriptData), "utf8")),
                storageKey: scriptStorageKey,
                status: "READY",
                approvalStatus: execution.project.approvalRequired ? "PENDING_APPROVAL" : "APPROVED",
                currentRevisionNum: nextRevNum,
                metadata: {
                  title,
                  approvalStatus: execution.project.approvalRequired ? "PENDING_APPROVAL" : "APPROVED",
                  script: scriptData,
                  researchBrief: mergedNow.researchBrief ?? null,
                } as Prisma.InputJsonValue,
              },
            });

        const revision = await tx.contentRevision.upsert({
          where: {
            assetId_revisionNumber: {
              assetId: asset.id,
              revisionNumber: nextRevNum,
            },
          },
          update: {
            title,
            hook,
            voiceoverScript,
            description,
            hashtags,
            scriptPayload: scriptData as Prisma.InputJsonValue,
            researchBrief: (mergedNow.researchBrief ?? null) as Prisma.InputJsonValue,
            reviewerFeedback,
            stageKey: "script_generation",
            provider: typeof genMeta.provider === "string" ? genMeta.provider : null,
            model: typeof genMeta.model === "string" ? genMeta.model : null,
          },
          create: {
            workspaceId,
            projectId: execution.projectId,
            executionId,
            assetId: asset.id,
            revisionNumber: nextRevNum,
            source: nextRevNum > 1 ? "AI_REVISION" : "AI_GENERATED",
            title,
            hook,
            voiceoverScript,
            description,
            hashtags,
            scriptPayload: scriptData as Prisma.InputJsonValue,
            researchBrief: (mergedNow.researchBrief ?? null) as Prisma.InputJsonValue,
            reviewerFeedback,
            stageKey: "script_generation",
            provider: typeof genMeta.provider === "string" ? genMeta.provider : null,
            model: typeof genMeta.model === "string" ? genMeta.model : null,
          },
        });

        if (!execution.project.approvalRequired) {
          await tx.contentAsset.update({
            where: { id: asset.id },
            data: { approvedRevisionId: revision.id },
          });
          await tx.workflowExecution.update({
            where: { id: executionId },
            data: { approvedRevisionId: revision.id, activeRevisionNum: nextRevNum },
          });
        } else {
          await tx.workflowExecution.update({
            where: { id: executionId },
            data: { activeRevisionNum: nextRevNum },
          });
        }
      });
    }

    // Human-in-the-loop Approval Gate: pause execution cleanly without blocking worker
    if (stageKey === "approval" && execution.project.approvalRequired) {
      log("info", "Workflow paused at approval gate (AWAITING_APPROVAL) pending human review in Content Library");

      const mergedOutputs = { ...previousOutputs, ...result.output };
      await prisma.$transaction([
        prisma.workflowStageExecution.update({
          where: { id: stageRecord.id },
          data: {
            status: "AWAITING_APPROVAL",
            output: result.output as Prisma.InputJsonValue,
            logs: logs as unknown as Prisma.InputJsonValue,
            errorMessage: null,
          },
        }),
        prisma.workflowExecution.update({
          where: { id: executionId },
          data: {
            status: "AWAITING_APPROVAL",
            currentStageIndex: stageOrder,
            outputSummary: mergedOutputs as Prisma.InputJsonValue,
          },
        }),
        prisma.contentAsset.updateMany({
          where: { executionId, workspaceId, type: "SCRIPT" },
          data: { approvalStatus: "PENDING_APPROVAL" },
        }),
      ]);

      logger.info({ executionId, stageOrder }, "Execution paused at AWAITING_APPROVAL");
      return;
    }

    const nextStageOrder = stageOrder + 1;
    const nextStageDef = stageDefs[nextStageOrder];
    const outboxKey = nextStageDef
      ? `exec_${executionId}_stage_${nextStageOrder}_rev_${execution.activeRevisionNum}`
      : null;

    const createdOutbox = await prisma.$transaction(async (tx) => {
      await tx.workflowStageExecution.update({
        where: { id: stageRecord.id },
        data: {
          status: "COMPLETED",
          output: result.output as Prisma.InputJsonValue,
          logs: logs as unknown as Prisma.InputJsonValue,
          errorMessage: null,
          completedAt: new Date(),
        },
      });

      for (const u of result.usage ?? []) {
        await tx.usageRecord.create({
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
        });
      }

      if (nextStageDef && outboxKey) {
        return tx.outboxEvent.upsert({
          where: { idempotencyKey: outboxKey },
          update: {},
          create: {
            workspaceId,
            eventType: "WORKFLOW_STAGE_ENQUEUE",
            idempotencyKey: outboxKey,
            payload: {
              executionId,
              workspaceId,
              stageOrder: nextStageOrder,
              revisionNum: execution.activeRevisionNum,
              jobId: String(outboxKey).replace(/:/g, "_"),
            },
          },
        });
      }
      return null;
    });

    if (nextStageDef && createdOutbox && outboxKey) {
      try {
        await queue.add(
          "execute-stage",
          {
            executionId,
            workspaceId,
            stageOrder: nextStageOrder,
            revisionNum: execution.activeRevisionNum,
            jobId: String(outboxKey).replace(/:/g, "_"),
          },
          {
            jobId: String(outboxKey).replace(/:/g, "_"),
            attempts: nextStageDef.retryPolicy.maxAttempts,
            backoff: {
              type: "exponential",
              delay: nextStageDef.retryPolicy.backoffMs,
            },
          }
        );
        await prisma.outboxEvent.update({
          where: { id: createdOutbox.id },
          data: { status: "PROCESSED", processedAt: new Date() },
        });
      } catch (qErr) {
        logger.warn({ err: qErr, outboxId: createdOutbox.id }, "Immediate stage enqueue failed; outbox dispatcher will retry");
      }
    } else {
      const mergedOutputs = { ...previousOutputs, ...result.output };
      await prisma.workflowExecution.update({
        where: { id: executionId },
        data: {
          status: "COMPLETED",
          outputSummary: mergedOutputs as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });
      logger.info({ executionId }, "Workflow execution completed");
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
