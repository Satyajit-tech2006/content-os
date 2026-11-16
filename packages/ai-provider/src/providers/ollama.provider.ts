import {
  AIProviderError,
  type AICapability,
  type AIGenerateOptions,
  type AIGenerateResult,
  type AIProvider,
  type InstalledModelInfo,
  type ProviderHealthResult,
} from "../types.js";

export interface OllamaProviderConfig {
  baseUrl?: string;
  defaultModel?: string;
  timeoutMs?: number;
}

interface OllamaTagsResponse {
  models?: Array<{
    name: string;
    size?: number;
    modified_at?: string;
    details?: {
      family?: string;
      parameter_size?: string;
      quantization_level?: string;
    };
  }>;
}

interface OllamaChatResponse {
  model?: string;
  message?: { role?: string; content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

export class OllamaProvider implements AIProvider {
  readonly name = "ollama" as const;
  readonly defaultModel: string;
  get model(): string { return this.defaultModel; }
  readonly supportedCapabilities: readonly AICapability[] = [
    "text_generation",
    "structured_json",
    "summarization",
    "classification",
    "content_rewriting",
    "code_generation",
  ];

  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;

  constructor(config: OllamaProviderConfig = {}) {
    this.baseUrl = (config.baseUrl || "http://localhost:11434").replace(/\/+$/, "");
    this.defaultModel = config.defaultModel || "llama3.2:3b";
    this.defaultTimeoutMs = config.timeoutMs ?? 240_000;
  }

  supports(capability: AICapability): boolean {
    return this.supportedCapabilities.includes(capability);
  }

  async listInstalledModels(): Promise<InstalledModelInfo[]> {
    try {
      const res = await fetch(this.baseUrl + "/api/tags", {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        throw new AIProviderError(
          "Ollama /api/tags returned HTTP " + res.status,
          { code: "OLLAMA_HTTP_ERROR", provider: "ollama", retryable: true }
        );
      }
      const json = (await res.json()) as OllamaTagsResponse;
      return (json.models ?? []).map((m) => ({
        name: m.name,
        sizeBytes: m.size,
        modifiedAt: m.modified_at,
        family: m.details?.family,
        parameterSize: m.details?.parameter_size,
        quantizationLevel: m.details?.quantization_level,
      }));
    } catch (err) {
      if (err instanceof AIProviderError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new AIProviderError(
        "Ollama daemon is unreachable at " + this.baseUrl + " (" + msg + "). Start Ollama with `ollama serve`.",
        { code: "OLLAMA_UNAVAILABLE", provider: "ollama", retryable: false }
      );
    }
  }

  async checkHealth(): Promise<ProviderHealthResult> {
    const started = Date.now();
    try {
      const models = await this.listInstalledModels();
      return {
        provider: "ollama",
        healthy: true,
        endpoint: this.baseUrl,
        latencyMs: Date.now() - started,
        installedModels: models.map((m) => m.name),
      };
    } catch (err) {
      return {
        provider: "ollama",
        healthy: false,
        endpoint: this.baseUrl,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async ensureModelInstalled(modelName: string): Promise<void> {
    const installed = await this.listInstalledModels();
    const normalizedTarget = modelName.trim().toLowerCase();
    const found = installed.some((m) => {
      const n = m.name.toLowerCase();
      return n === normalizedTarget || n === normalizedTarget + ":latest" || n.replace(/:latest$/, "") === normalizedTarget;
    });

    if (!found) {
      const availableList = installed.map((m) => m.name).join(", ") || "none";
      throw new AIProviderError(
        "Local Ollama model '" + modelName + "' is not installed. Run `ollama pull " + modelName + "`. Installed models: [" + availableList + "].",
        { code: "MODEL_NOT_INSTALLED", provider: "ollama", retryable: false }
      );
    }
  }

  private async chat(
    options: AIGenerateOptions,
    jsonMode: boolean
  ): Promise<{ text: string; inputTokens: number; outputTokens: number; durationMs: number; model: string }> {
    const model = options.model || this.defaultModel;
    await this.ensureModelInstalled(model);

    const started = Date.now();
    const messages: Array<{ role: string; content: string }> = [];
    if (options.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: options.prompt });

    const payload: Record<string, unknown> = {
      model,
      messages,
      stream: false,
      think: false,
      keep_alive: "10m",
      options: {
        num_ctx: 4096,
        temperature: options.temperature ?? 0.6,
        ...(options.maxOutputTokens ? { num_predict: options.maxOutputTokens } : {}),
      },
    };

    if (jsonMode) {
      payload.format = "json";
    }

    let res: Response;
    try {
      res = await fetch(this.baseUrl + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(options.timeoutMs ?? this.defaultTimeoutMs),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new AIProviderError(
        "Ollama inference failed for model '" + model + "': " + msg,
        { code: "OLLAMA_REQUEST_FAILED", provider: "ollama", retryable: true }
      );
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new AIProviderError(
        "Ollama /api/chat HTTP " + res.status + ": " + errBody.slice(0, 300),
        { code: "OLLAMA_API_ERROR", provider: "ollama", retryable: res.status >= 500 }
      );
    }

    const data = (await res.json()) as OllamaChatResponse;
    const text = (data.message?.content ?? "").trim();
    if (!text) {
      throw new AIProviderError(
        "Ollama returned an empty response for model '" + model + "'",
        { code: "EMPTY_RESPONSE", provider: "ollama", retryable: true }
      );
    }

    const inputTokens = data.prompt_eval_count ?? Math.ceil(options.prompt.length / 4);
    const outputTokens = data.eval_count ?? Math.ceil(text.length / 4);
    return {
      text,
      inputTokens,
      outputTokens,
      durationMs: Date.now() - started,
      model,
    };
  }

  async generateText(options: AIGenerateOptions): Promise<AIGenerateResult<string>> {
    const res = await this.chat(options, false);
    return {
      data: res.text,
      rawText: res.text,
      usage: {
        provider: "ollama",
        model: res.model,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        totalTokens: res.inputTokens + res.outputTokens,
        estimatedCostUsd: 0,
        durationMs: res.durationMs,
        costMetadata: {
          billingType: "local_self_hosted",
          apiCostUsd: 0,
          note: "Zero external API fee; local GPU/CPU electricity and hardware depreciation apply.",
        },
      },
    };
  }

  async generateJSON<T>(options: AIGenerateOptions): Promise<AIGenerateResult<T>> {
    const res = await this.chat(options, true);
    const cleaned = res.text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
    let parsed: T;
    try {
      parsed = JSON.parse(cleaned) as T;
    } catch (err) {
      throw new AIProviderError(
        "Ollama model '" + res.model + "' returned malformed JSON: " + (err instanceof Error ? err.message : String(err)),
        { code: "MALFORMED_JSON", provider: "ollama", retryable: true }
      );
    }

    return {
      data: parsed,
      rawText: res.text,
      usage: {
        provider: "ollama",
        model: res.model,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        totalTokens: res.inputTokens + res.outputTokens,
        estimatedCostUsd: 0,
        durationMs: res.durationMs,
        costMetadata: {
          billingType: "local_self_hosted",
          apiCostUsd: 0,
          note: "Zero external API fee; local GPU/CPU electricity and hardware depreciation apply.",
        },
      },
    };
  }
}
