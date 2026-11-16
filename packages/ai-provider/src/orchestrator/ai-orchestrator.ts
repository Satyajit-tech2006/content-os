import { z } from "zod";
import type { AIProviderFactory } from "../factory.js";
import { PromptRegistry } from "../prompts/prompt-registry.js";
import { ModelRegistry } from "../registry/model-registry.js";
import { AITaskRouter } from "../router/task-router.js";
import {
  AIProviderError,
  type AITaskType,
  type AITokenUsage,
  type ProviderName,
} from "../types.js";

export interface OrchestratorRunOptions<T> {
  promptId: string;
  promptVersion?: string;
  variables: Record<string, unknown>;
  providerOverride?: ProviderName;
  modelOverride?: string;
  temperature?: number;
  maxRetries?: number;
  timeoutMs?: number;
  schemaOverride?: z.ZodType<T>;
}

export interface OrchestratorExecutionResult<T> {
  data: T;
  rawText: string;
  task: AITaskType;
  promptId: string;
  promptVersion: string;
  usage: AITokenUsage;
  attempts: number;
  validationErrors: string[];
}

export class AIOrchestrator {
  readonly registry: ModelRegistry;
  readonly prompts: PromptRegistry;
  readonly router: AITaskRouter;

  constructor(
    readonly factory: AIProviderFactory,
    registry?: ModelRegistry,
    prompts?: PromptRegistry
  ) {
    this.registry = registry ?? new ModelRegistry();
    this.prompts = prompts ?? new PromptRegistry();
    this.router = new AITaskRouter(this.factory, this.registry);
  }

  async runStructured<T>(options: OrchestratorRunOptions<T>): Promise<OrchestratorExecutionResult<T>> {
    const promptDef = this.prompts.get<T>(options.promptId, options.promptVersion);
    const schema = options.schemaOverride ?? promptDef.outputSchema;
    const route = this.router.resolve(promptDef.task, {
      provider: options.providerOverride,
      model: options.modelOverride,
    });

    const maxRetries = options.maxRetries ?? 2;
    const basePrompt = promptDef.renderTemplate(options.variables);
    let currentPrompt = basePrompt;
    const validationErrors: string[] = [];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalDurationMs = 0;
    let totalCostUsd = 0;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        const res = await route.provider.generateJSON<unknown>({
          model: route.model,
          systemPrompt: promptDef.systemPrompt,
          prompt: currentPrompt,
          temperature: options.temperature ?? 0.65,
          timeoutMs: options.timeoutMs ?? 90_000,
        });

        totalInputTokens += res.usage.inputTokens;
        totalOutputTokens += res.usage.outputTokens;
        totalDurationMs += res.usage.durationMs;
        totalCostUsd += res.usage.estimatedCostUsd;

        const parsed = schema.safeParse(res.data);
        if (parsed.success) {
          return {
            data: parsed.data,
            rawText: res.rawText,
            task: promptDef.task,
            promptId: promptDef.id,
            promptVersion: promptDef.version,
            attempts: attempt,
            validationErrors,
            usage: {
              ...res.usage,
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              totalTokens: totalInputTokens + totalOutputTokens,
              durationMs: totalDurationMs,
              estimatedCostUsd: Number(totalCostUsd.toFixed(6)),
            },
          };
        }

        const issueSummary = parsed.error.issues
          .map((i) => i.path.join(".") + ": " + i.message)
          .join("; ");
        validationErrors.push("Attempt " + attempt + " Zod validation failed: " + issueSummary);

        if (attempt <= maxRetries) {
          currentPrompt = [
            basePrompt,
            "",
            "PREVIOUS OUTPUT FAILED SCHEMA VALIDATION: " + issueSummary,
            "Fix the JSON structure and return ONLY valid JSON matching every required field and type."
          ].join("\n");
        }
      } catch (err) {
        const isRetryable = err instanceof AIProviderError ? err.retryable : false;
        const msg = err instanceof Error ? err.message : String(err);
        validationErrors.push("Attempt " + attempt + " error: " + msg);

        if (!isRetryable || attempt > maxRetries) {
          throw err;
        }

        currentPrompt = [
          basePrompt,
          "",
          "PREVIOUS RESPONSE ERROR: " + msg,
          "Respond strictly with valid JSON only."
        ].join("\n");
      }
    }

    throw new AIProviderError(
      "Structured AI output failed Zod validation after " + (maxRetries + 1) + " attempts: " + validationErrors.join(" | "),
      { code: "SCHEMA_VALIDATION_FAILED", provider: route.providerName, retryable: false }
    );
  }
}
