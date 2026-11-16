import { OllamaProvider } from "./providers/ollama.provider.js";
import { GeminiProvider } from "./providers/gemini.provider.js";
import { SimulatedAIProvider } from "./providers/simulated.provider.js";
import type { AIProvider, ProviderName } from "./types.js";

export interface AIProviderFactoryConfig {
  defaultProvider?: ProviderName;
  ollamaBaseUrl?: string;
  ollamaDefaultModel?: string;
  geminiApiKey?: string;
  geminiDefaultModel?: string;
}

export class AIProviderFactory {
  private readonly providers = new Map<ProviderName, AIProvider>();
  readonly defaultProvider: ProviderName;

  constructor(config: AIProviderFactoryConfig = {}) {
    this.defaultProvider = config.defaultProvider ?? "ollama";
    this.providers.set(
      "ollama",
      new OllamaProvider({
        baseUrl: config.ollamaBaseUrl || "http://localhost:11434",
        defaultModel: config.ollamaDefaultModel || "qwen3:4b",
      })
    );

    if (config.geminiApiKey && config.geminiApiKey.trim().length > 0) {
      this.providers.set(
        "gemini",
        new GeminiProvider(config.geminiApiKey.trim(), config.geminiDefaultModel || "gemini-2.5-flash")
      );
    }

    this.providers.set("simulated", new SimulatedAIProvider());
  }

  getProvider(name?: ProviderName): AIProvider {
    const target = name ?? this.defaultProvider;
    const provider = this.providers.get(target);
    if (!provider) {
      throw new Error("AI provider '" + target + "' is not configured or missing credentials.");
    }
    return provider;
  }

  listConfiguredProviders(): Array<{ name: ProviderName; defaultModel: string; capabilities: readonly string[] }> {
    return Array.from(this.providers.values()).map((p) => ({
      name: p.name,
      defaultModel: p.defaultModel,
      capabilities: p.supportedCapabilities,
    }));
  }
}

// Backward-compatible helper used by existing callers
export function createAIProvider(providerName: string, apiKey?: string, model?: string): AIProvider {
  if (providerName === "gemini" && apiKey && apiKey.trim().length > 0) {
    return new GeminiProvider(apiKey.trim(), model || "gemini-2.5-flash");
  }
  if (providerName === "simulated") {
    return new SimulatedAIProvider();
  }
  return new OllamaProvider({ defaultModel: model || "qwen3:4b" });
}
