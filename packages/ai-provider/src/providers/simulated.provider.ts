import type {
  AICapability,
  AIGenerateOptions,
  AIGenerateResult,
  AIProvider,
  ProviderHealthResult,
} from "../types.js";

export class SimulatedAIProvider implements AIProvider {
  readonly name = "simulated" as const;
  readonly defaultModel = "simulated-v1";
  get model(): string { return this.defaultModel; }
  readonly supportedCapabilities: readonly AICapability[] = [
    "text_generation",
    "structured_json",
    "summarization",
    "classification",
    "content_rewriting",
  ];

  supports(capability: AICapability): boolean {
    return this.supportedCapabilities.includes(capability);
  }

  async checkHealth(): Promise<ProviderHealthResult> {
    return { provider: "simulated", healthy: true, latencyMs: 0 };
  }

  async generateText(options: AIGenerateOptions): Promise<AIGenerateResult<string>> {
    const inputTokens = Math.ceil(options.prompt.length / 4);
    const rawText = "[Simulated Output] " + options.prompt.slice(0, 140);
    const outputTokens = Math.ceil(rawText.length / 4);
    return {
      data: rawText,
      rawText,
      usage: {
        provider: "simulated",
        model: this.defaultModel,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        estimatedCostUsd: 0,
        durationMs: 5,
      },
    };
  }

  async generateJSON<T>(options: AIGenerateOptions): Promise<AIGenerateResult<T>> {
    const inputTokens = Math.ceil(options.prompt.length / 4);
    const payload = {
      title: "Simulated Content Title",
      hook: "Stop scrolling ? here is the key insight you missed.",
      script: "Full simulated narration body for offline test mode.",
      description: "Simulated platform description.",
      hashtags: ["#contentos", "#localfirst"],
      estimatedDuration: 45,
    };
    const rawText = JSON.stringify(payload);
    const outputTokens = Math.ceil(rawText.length / 4);
    return {
      data: payload as T,
      rawText,
      usage: {
        provider: "simulated",
        model: this.defaultModel,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        estimatedCostUsd: 0,
        durationMs: 5,
      },
    };
  }
}
