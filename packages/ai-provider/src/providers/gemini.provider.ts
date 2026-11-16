import {
  AIProviderError,
  type AICapability,
  type AIGenerateOptions,
  type AIGenerateResult,
  type AIProvider,
  type ProviderHealthResult,
} from "../types.js";

function estimateGeminiCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  if (model.includes("pro")) {
    return Number(((inputTokens * 1.25 + outputTokens * 5.0) / 1_000_000).toFixed(6));
  }
  return Number(((inputTokens * 0.15 + outputTokens * 0.6) / 1_000_000).toFixed(6));
}

export class GeminiProvider implements AIProvider {
  readonly name = "gemini" as const;
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

  private readonly apiKey: string;

  constructor(apiKey: string, defaultModel = "gemini-2.5-flash") {
    this.apiKey = apiKey;
    this.defaultModel = defaultModel;
  }

  supports(capability: AICapability): boolean {
    return this.supportedCapabilities.includes(capability);
  }

  async checkHealth(): Promise<ProviderHealthResult> {
    const configured = Boolean(this.apiKey && this.apiKey.trim().length > 0);
    return {
      provider: "gemini",
      healthy: configured,
      endpoint: "[https://generativelanguage.googleapis.com](https://generativelanguage.googleapis.com)",
      latencyMs: 0,
      ...(configured ? {} : { error: "GEMINI_API_KEY is not configured" }),
    };
  }

  private async callGemini(options: AIGenerateOptions, jsonMode: boolean): Promise<{ text: string; inputTokens: number; outputTokens: number; durationMs: number; model: string }> {
    const model = options.model || this.defaultModel;
    const started = Date.now();
    const url = "[https://generativelanguage.googleapis.com/v1beta/models/](https://generativelanguage.googleapis.com/v1beta/models/)" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(this.apiKey);

    const body: Record<string, unknown> = {
      contents: [{ role: "user", parts: [{ text: options.prompt }] }],
      generationConfig: {
        temperature: options.temperature ?? 0.7,
        maxOutputTokens: options.maxOutputTokens ?? 2048,
        ...(jsonMode ? { responseMimeType: "application/json" } : {}),
      },
    };

    if (options.systemPrompt) {
      body.systemInstruction = { parts: [{ text: options.systemPrompt }] };
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 45_000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new AIProviderError(
        "Gemini API HTTP " + res.status + ": " + errBody.slice(0, 300),
        { code: "GEMINI_API_ERROR", provider: "gemini", retryable: res.status >= 500 || res.status === 429 }
      );
    }

    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };

    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text) {
      throw new AIProviderError("Gemini API returned empty response", { code: "EMPTY_RESPONSE", provider: "gemini", retryable: true });
    }

    return {
      text,
      inputTokens: json.usageMetadata?.promptTokenCount ?? Math.ceil(options.prompt.length / 4),
      outputTokens: json.usageMetadata?.candidatesTokenCount ?? Math.ceil(text.length / 4),
      durationMs: Date.now() - started,
      model,
    };
  }

  async generateText(options: AIGenerateOptions): Promise<AIGenerateResult<string>> {
    const res = await this.callGemini(options, false);
    const cost = estimateGeminiCostUsd(res.model, res.inputTokens, res.outputTokens);
    return {
      data: res.text,
      rawText: res.text,
      usage: {
        provider: "gemini",
        model: res.model,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        totalTokens: res.inputTokens + res.outputTokens,
        estimatedCostUsd: cost,
        durationMs: res.durationMs,
        costMetadata: { billingType: "cloud_api_per_token", apiCostUsd: cost },
      },
    };
  }

  async generateJSON<T>(options: AIGenerateOptions): Promise<AIGenerateResult<T>> {
    const res = await this.callGemini(options, true);
    const cleaned = res.text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned) as T;
    const cost = estimateGeminiCostUsd(res.model, res.inputTokens, res.outputTokens);
    return {
      data: parsed,
      rawText: res.text,
      usage: {
        provider: "gemini",
        model: res.model,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        totalTokens: res.inputTokens + res.outputTokens,
        estimatedCostUsd: cost,
        durationMs: res.durationMs,
        costMetadata: { billingType: "cloud_api_per_token", apiCostUsd: cost },
      },
    };
  }
}
