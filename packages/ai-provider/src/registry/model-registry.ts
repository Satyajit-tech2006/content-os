import type {
  AICapability,
  AITaskType,
  ModelConfig,
  ModelSwitchEvent,
  ProviderName,
} from "../types.js";

export const DEFAULT_LOCAL_MODELS: ModelConfig[] = [
  {
    id: "ollama:qwen3:4b",
    provider: "ollama",
    model: "qwen3:4b",
    capabilities: ["text_generation", "structured_json", "content_rewriting", "summarization"],
    contextWindow: 32768,
    enabled: true,
    description: "General text generation, creative hooks, and script reasoning (fits 4GB VRAM).",
  },
  {
    id: "ollama:llama3.2:3b",
    provider: "ollama",
    model: "llama3.2:3b",
    capabilities: ["text_generation", "structured_json", "summarization", "classification"],
    contextWindow: 8192,
    enabled: true,
    description: "Lightweight, fast classification and summarization.",
  },
  {
    id: "ollama:qwen2.5-coder:3b",
    provider: "ollama",
    model: "qwen2.5-coder:3b",
    capabilities: ["text_generation", "structured_json", "code_generation"],
    contextWindow: 16384,
    enabled: true,
    description: "Basic coding assistance and structured schema repair.",
  },
];

export const DEFAULT_TASK_ROUTES: Record<AITaskType, { provider: ProviderName; model: string }> = {
  classification: { provider: "ollama", model: "llama3.2:3b" },
  summarization: { provider: "ollama", model: "llama3.2:3b" },
  content_ideas: { provider: "ollama", model: "qwen3:4b" },
  script_generation: { provider: "ollama", model: "qwen3:4b" },
  content_rewriting: { provider: "ollama", model: "qwen3:4b" },
  basic_coding: { provider: "ollama", model: "qwen2.5-coder:3b" },
};

export class ModelRegistry {
  private readonly models = new Map<string, ModelConfig>();
  private readonly taskRoutes = new Map<AITaskType, { provider: ProviderName; model: string }>();
  private readonly switchHistory: ModelSwitchEvent[] = [];

  constructor(initialModels: ModelConfig[] = DEFAULT_LOCAL_MODELS) {
    for (const cfg of initialModels) {
      this.registerModel(cfg);
    }
    for (const [task, route] of Object.entries(DEFAULT_TASK_ROUTES) as Array<[AITaskType, { provider: ProviderName; model: string }]>) {
      this.taskRoutes.set(task, { ...route });
    }
  }

  registerModel(config: ModelConfig): void {
    this.models.set(config.provider + ':' + config.model, config);
  }

  listModels(): ModelConfig[] {
    return Array.from(this.models.values());
  }

  getModelConfig(provider: ProviderName, model: string): ModelConfig | undefined {
    return this.models.get(provider + ':' + model);
  }

  getRouteForTask(task: AITaskType): { provider: ProviderName; model: string; config?: ModelConfig } {
    const route = this.taskRoutes.get(task) ?? DEFAULT_TASK_ROUTES[task];
    return {
      ...route,
      config: this.getModelConfig(route.provider, route.model),
    };
  }

  getAllRoutes(): Record<string, { provider: ProviderName; model: string }> {
    const out: Record<string, { provider: ProviderName; model: string }> = {};
    for (const [task, route] of this.taskRoutes.entries()) {
      out[task] = route;
    }
    return out;
  }

  selectModelForTask(
    task: AITaskType,
    provider: ProviderName,
    model: string,
    reason = "manual_selection",
    actor?: string
  ): ModelSwitchEvent {
    const prev = this.taskRoutes.get(task);
    const existing = this.getModelConfig(provider, model);
    if (!existing) {
      this.registerModel({
        id: provider + ':' + model,
        provider,
        model,
        capabilities: ["text_generation", "structured_json"],
        enabled: true,
        description: "Dynamically registered model",
      });
    }
    this.taskRoutes.set(task, { provider, model });
    const event: ModelSwitchEvent = {
      timestamp: new Date().toISOString(),
      task,
      fromModel: prev ? prev.provider + ":" + prev.model : "none",
      toModel: provider + ":" + model,
      provider,
      reason,
      actor,
    };
    this.switchHistory.push(event);
    return event;
  }

  getSwitchHistory(): ModelSwitchEvent[] {
    return [...this.switchHistory];
  }

  supportsCapability(provider: ProviderName, model: string, capability: AICapability): boolean {
    const cfg = this.getModelConfig(provider, model);
    if (!cfg) return false;
    return cfg.enabled && cfg.capabilities.includes(capability);
  }
}
