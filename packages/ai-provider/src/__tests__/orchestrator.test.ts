import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AIOrchestrator,
  AIProviderError,
  AIProviderFactory,
  ModelRegistry,
  OllamaProvider,
  type ValidatedScriptOutput,
  type AICapability,
  type AIGenerateOptions,
  type AIGenerateResult,
  type AIProvider,
  type ProviderHealthResult,
} from "../index.js";

class MockScriptProvider implements AIProvider {
  readonly name = "ollama" as const;
  readonly defaultModel = "qwen3:4b";
  get model(): string { return this.defaultModel; }
  readonly supportedCapabilities: readonly AICapability[] = ["text_generation", "structured_json", "summarization", "classification"];
  private calls = 0;

  constructor(private readonly responses: Array<() => unknown>) {}

  supports(cap: AICapability): boolean { return this.supportedCapabilities.includes(cap); }
  async checkHealth(): Promise<ProviderHealthResult> { return { provider: "ollama", healthy: true, latencyMs: 1 }; }
  async generateText(opts: AIGenerateOptions): Promise<AIGenerateResult<string>> {
    return { data: opts.prompt, rawText: opts.prompt, usage: { provider: "ollama", model: this.defaultModel, inputTokens: 10, outputTokens: 10, totalTokens: 20, estimatedCostUsd: 0, durationMs: 2 } };
  }
  async generateJSON<T>(_opts: AIGenerateOptions): Promise<AIGenerateResult<T>> {
    const fn = this.responses[Math.min(this.calls, this.responses.length - 1)];
    this.calls++;
    const val = fn();
    return {
      data: val as T,
      rawText: JSON.stringify(val),
      usage: { provider: "ollama", model: this.defaultModel, inputTokens: 25, outputTokens: 40, totalTokens: 65, estimatedCostUsd: 0, durationMs: 12 },
    };
  }
}

describe("ContentOS Local-First AI Infrastructure", () => {
  it("routes tasks to configured local models and records explicit switch events", () => {
    const registry = new ModelRegistry();
    assert.equal(registry.getRouteForTask("classification").model, "llama3.2:3b");
    assert.equal(registry.getRouteForTask("script_generation").model, "qwen3:4b");
    assert.equal(registry.getRouteForTask("basic_coding").model, "qwen2.5-coder:3b");

    const evt = registry.selectModelForTask("script_generation", "ollama", "llama3.2:3b", "vram_test", "founder@contentos.dev");
    assert.equal(evt.fromModel, "ollama:qwen3:4b");
    assert.equal(evt.toModel, "ollama:llama3.2:3b");
    assert.equal(registry.getSwitchHistory().length, 1);
  });

  it("rejects task routing when model lacks required capability", () => {
    const factory = new AIProviderFactory();
    const registry = new ModelRegistry();
    registry.selectModelForTask("basic_coding", "ollama", "llama3.2:3b");
    const orchestrator = new AIOrchestrator(factory, registry);

    assert.throws(
      () => orchestrator.router.resolve("basic_coding"),
      (err: unknown) => err instanceof AIProviderError && err.code === "MODEL_CAPABILITY_MISMATCH"
    );
  });

  it("retries when first structured JSON response fails Zod validation and succeeds on repair attempt", async () => {
    const mockProvider = new MockScriptProvider([
      () => ({ title: "Too short", hook: "x" }),
      () => ({
        title: "Why RTX 2050 Local AI Changes SaaS Architecture",
        hook: "Stop paying per-token API bills while building your MVP.",
        script: "Here is how running Qwen3 4B locally via Ollama gives you deterministic JSON workflows with zero API cost.",
        description: "Local-first AI architecture walkthrough.",
        hashtags: ["#LocalAI", "#Ollama", "#ContentOS"],
        estimatedDuration: 45,
      }),
    ]);

    const factory = new AIProviderFactory();
    (factory as unknown as { providers: Map<string, AIProvider> }).providers.set("ollama", mockProvider);
    const orchestrator = new AIOrchestrator(factory);

    const result = await orchestrator.runStructured<ValidatedScriptOutput>({
      promptId: "short-form-script-generator",
      variables: { topic: "Local AI", projectName: "Checkpoint Daily" },
    });

    assert.equal(result.attempts, 2);
    assert.equal(result.validationErrors.length, 1);
    assert.equal(result.usage.estimatedCostUsd, 0);
    assert.equal(result.data.title, "Why RTX 2050 Local AI Changes SaaS Architecture");
  });

  it("returns clear diagnostic health error when Ollama daemon is unreachable", async () => {
    const offlineOllama = new OllamaProvider({ baseUrl: "http://127.0.0.1:19999" });
    const health = await offlineOllama.checkHealth();
    assert.equal(health.healthy, false);
    assert.match(health.error ?? "", /unreachable/i);
  });
});
