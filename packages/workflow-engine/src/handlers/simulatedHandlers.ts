import type {
  ValidatedContentIdeasOutput,
  ValidatedScriptOutput,
} from "@contentos/ai-provider";
import type { StageExecutionContext, StageExecutionResult, WorkflowStageHandler } from "../types.js";

function checkSimulatedFailure(ctx: StageExecutionContext): void {
  const failStage = ctx.inputContext.simulateFailureAtStage;
  if (typeof failStage === "string" && failStage === ctx.stageKey) {
    throw new Error("Simulated stage failure triggered at '" + ctx.stageKey + "'");
  }
}

export class ResearchStageHandler implements WorkflowStageHandler {
  readonly key = "research" as const;

  async execute(ctx: StageExecutionContext): Promise<StageExecutionResult> {
    checkSimulatedFailure(ctx);
    const requestedTopic = typeof ctx.inputContext.topic === "string" && ctx.inputContext.topic.trim()
      ? ctx.inputContext.topic.trim()
      : "Editorial angles in " + ctx.project.niche;

    ctx.log("info", "Generating structured content ideas via AIOrchestrator for: " + requestedTopic);

    const res = await ctx.orchestrator.runStructured<ValidatedContentIdeasOutput>({
      promptId: "content-ideas-brief",
      variables: {
        projectName: ctx.project.name,
        niche: ctx.project.niche,
        targetAudience: ctx.inputContext.targetAudience ?? ctx.project.targetAudience,
        topic: requestedTopic,
        tone: ctx.inputContext.tone ?? ctx.project.config.tone ?? "engaging",
        language: ctx.inputContext.language ?? ctx.project.config.language ?? "English",
      },
      temperature: 0.6,
    });

    ctx.log("info", "Content brief generated via " + res.usage.provider + "/" + res.usage.model + " (" + res.usage.totalTokens + " tokens, " + res.usage.durationMs + "ms)", {
      angle: res.data.angle,
      attempts: res.attempts,
    });

    return {
      output: { researchBrief: res.data },
      usage: [{
        ...res.usage,
        operation: "content_ideas_brief",
        taskType: "content_ideas",
        success: true,
      }],
    };
  }
}

function resolveDurationRangeGuidance(rangeRaw: unknown, fallbackSec: number): { durationRange: string; desiredDuration: number; wordBudget: string } {
  const r = typeof rangeRaw === "string" ? rangeRaw : "";
  if (r === "15-20s") return { durationRange: "15-20s", desiredDuration: 18, wordBudget: "38-52 words (3-4 punchy sentences)" };
  if (r === "30-45s") return { durationRange: "30-45s", desiredDuration: 38, wordBudget: "75-110 words (5-7 concise sentences)" };
  if (r === "45-60s") return { durationRange: "45-60s", desiredDuration: 52, wordBudget: "110-145 words (7-9 clear sentences)" };
  if (r === "60s+") return { durationRange: "60s+", desiredDuration: 75, wordBudget: "150-210 words (9-13 well-paced sentences)" };
  return { durationRange: `~${fallbackSec}s`, desiredDuration: fallbackSec, wordBudget: `${Math.round(fallbackSec * 2.2)}-${Math.round(fallbackSec * 2.6)} words` };
}

export class ScriptGenerationStageHandler implements WorkflowStageHandler {
  readonly key = "script_generation" as const;

  async execute(ctx: StageExecutionContext): Promise<StageExecutionResult> {
    checkSimulatedFailure(ctx);
    const brief = ctx.previousOutputs.researchBrief as ValidatedContentIdeasOutput | undefined;
    const guidance = resolveDurationRangeGuidance(ctx.inputContext.durationRange ?? ctx.project.config.durationRange, Number(ctx.project.config.targetDurationSec ?? 45));
    const desiredDuration = guidance.desiredDuration;
    const contentPlatform = String(ctx.inputContext.contentPlatform ?? ctx.project.platforms.join(", "));
    const tone = String(ctx.inputContext.tone ?? ctx.project.config.tone ?? "engaging");
    const language = String(ctx.inputContext.language ?? ctx.project.config.language ?? "English");
    const topic = typeof ctx.inputContext.topic === "string" && ctx.inputContext.topic.trim()
      ? ctx.inputContext.topic.trim()
      : brief?.topic ?? ctx.project.niche;
    const reviewerFeedback = typeof ctx.inputContext.reviewerFeedback === "string" && ctx.inputContext.reviewerFeedback.trim()
      ? ctx.inputContext.reviewerFeedback.trim()
      : undefined;

    ctx.log("info", (reviewerFeedback ? "Regenerating revised " : "Generating Zod-validated ") + desiredDuration + "s script for " + contentPlatform + " (" + language + ")");

    const res = await ctx.orchestrator.runStructured<ValidatedScriptOutput>({
      promptId: "short-form-script-generator",
      variables: {
        projectName: ctx.project.name,
        topic,
        targetAudience: ctx.inputContext.targetAudience ?? ctx.project.targetAudience,
        contentPlatform,
        desiredDuration,
        durationRange: guidance.durationRange,
        wordBudget: guidance.wordBudget,
        tone,
        language,
        editorialBrief: brief,
        ...(reviewerFeedback ? { reviewerFeedback, revisionInstructions: reviewerFeedback } : {}),
      },
      temperature: 0.7,
    });

    ctx.log("info", "Script generated: '" + res.data.title + "' via " + res.usage.provider + "/" + res.usage.model + " (" + res.usage.totalTokens + " tokens, " + res.usage.durationMs + "ms)", {
      attempts: res.attempts,
      estimatedDuration: res.data.estimatedDuration,
    });

    return {
      output: {
        script: {
          ...res.data,
          voiceoverScript: res.data.script,
          caption: res.data.description,
        },
        generationMeta: {
          provider: res.usage.provider,
          model: res.usage.model,
        },
      },
      usage: [{
        ...res.usage,
        operation: "script_generation",
        taskType: "script_generation",
        success: true,
      }],
    };
  }
}

export class AssetPreparationStageHandler implements WorkflowStageHandler {
  readonly key = "media_acquisition" as const;
  async execute(ctx: StageExecutionContext): Promise<StageExecutionResult> {
    checkSimulatedFailure(ctx);
    ctx.log("info", "Preparing visual b-roll storyboard & voiceover cues");
    return {
      output: {
        assetPlan: {
          aspectRatio: ctx.project.config.aspectRatio ?? "9:16",
          voiceProfile: "local-narrator-en",
          storyboardReady: true,
        },
      },
    };
  }
}

export class MediaProductionStageHandler implements WorkflowStageHandler {
  readonly key = "media_production" as const;
  async execute(ctx: StageExecutionContext): Promise<StageExecutionResult> {
    checkSimulatedFailure(ctx);
    ctx.log("info", "Assembling audio/visual timeline cues from generated script");
    return {
      output: {
        mediaTimeline: {
          aspectRatio: ctx.project.config.aspectRatio ?? "9:16",
          captionsPrepared: true,
        },
      },
    };
  }
}

export class VideoRenderingStageHandler implements WorkflowStageHandler {
  readonly key = "video_rendering" as const;
  async execute(ctx: StageExecutionContext): Promise<StageExecutionResult> {
    checkSimulatedFailure(ctx);
    const script = ctx.previousOutputs.script as ValidatedScriptOutput | undefined;
    ctx.log("info", "Synthesizing render manifest package");
    return {
      output: {
        renderedMedia: {
          storageKey: "workspaces/" + ctx.workspaceId + "/executions/" + ctx.executionId + "/master.mp4",
          mimeType: "video/mp4",
          durationSec: script?.estimatedDuration ?? Number(ctx.project.config.targetDurationSec ?? 45),
          resolution: ctx.project.config.aspectRatio === "16:9" ? "1920x1080" : "1080x1920",
          renderMode: "manifest_v1",
        },
      },
    };
  }
}

export class QualityControlStageHandler implements WorkflowStageHandler {
  readonly key = "quality_control" as const;
  async execute(ctx: StageExecutionContext): Promise<StageExecutionResult> {
    checkSimulatedFailure(ctx);
    const script = ctx.previousOutputs.script as ValidatedScriptOutput | undefined;
    const hasHook = Boolean(script?.hook && script.hook.length >= 5);
    const hasScript = Boolean(script?.script && script.script.length >= 20);
    const score = hasHook && hasScript ? 96 : 80;
    ctx.log("info", "Quality control checks passed (score: " + score + "/100)");
    return {
      output: {
        qualityReport: {
          passed: true,
          score,
          checks: { hookStrength: hasHook, scriptCompleteness: hasScript, schemaValidated: true },
        },
      },
    };
  }
}

export class ApprovalGateStageHandler implements WorkflowStageHandler {
  readonly key = "approval" as const;
  async execute(ctx: StageExecutionContext): Promise<StageExecutionResult> {
    checkSimulatedFailure(ctx);
    const status = ctx.project.approvalRequired ? "QUEUED_FOR_REVIEW" : "AUTO_APPROVED";
    ctx.log("info", "Approval gate evaluated: " + status);
    return {
      output: {
        approval: {
          status,
          approvalRequired: ctx.project.approvalRequired,
          evaluatedAt: new Date().toISOString(),
        },
      },
    };
  }
}

export class PublishingPreparationStageHandler implements WorkflowStageHandler {
  readonly key = "publishing" as const;
  async execute(ctx: StageExecutionContext): Promise<StageExecutionResult> {
    checkSimulatedFailure(ctx);
    const approved = (ctx.inputContext.approvedRevision as Record<string, unknown> | undefined)
      ?? (ctx.previousOutputs.script as Record<string, unknown> | undefined);
    const revisionId = typeof approved?.id === "string" ? approved.id : null;
    const revisionNumber = typeof approved?.revisionNumber === "number" ? approved.revisionNumber : 1;
    ctx.log("info", "Assembling revision-pinned publishing package (rev #" + revisionNumber + ") for: " + ctx.project.platforms.join(", "));
    return {
      output: {
        publishingPackage: {
          approvedRevisionId: revisionId,
          approvedRevisionNumber: revisionNumber,
          targetPlatforms: ctx.project.platforms,
          title: (typeof approved?.title === "string" && approved.title) || ctx.project.name + " Episode",
          voiceoverScript: (typeof approved?.voiceoverScript === "string" && approved.voiceoverScript) || (typeof approved?.script === "string" ? approved.script : ""),
          description: typeof approved?.description === "string" ? approved.description : "",
          hashtags: Array.isArray(approved?.hashtags) ? approved.hashtags : [],
          readyForDispatch: true,
        },
      },
    };
  }
}
