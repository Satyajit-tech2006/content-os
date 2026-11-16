import type { AIProviderFactory } from "../factory.js";
import type { ModelRegistry } from "../registry/model-registry.js";
import {
  AIProviderError,
  type AICapability,
  type AIProvider,
  type AITaskType,
  type ProviderName,
} from "../types.js";

const TASK_REQUIRED_CAPABILITY: Record<AITaskType, AICapability> = {
  classification: "classification",
  summarization: "summarization",
  content_ideas: "structured_json",
  script_generation: "structured_json",
  content_rewriting: "content_rewriting",
  basic_coding: "code_generation",
};

export interface ResolvedTaskRoute {
  provider: AIProvider;
  providerName: ProviderName;
  model: string;
  requiredCapability: AICapability;
}

export class AITaskRouter {
  constructor(
    private readonly factory: AIProviderFactory,
    private readonly registry: ModelRegistry
  ) {}

  resolve(task: AITaskType, override?: { provider?: ProviderName; model?: string }): ResolvedTaskRoute {
    const requiredCapability = TASK_REQUIRED_CAPABILITY[task];
    const configuredRoute = this.registry.getRouteForTask(task);
    const providerName = override?.provider ?? configuredRoute.provider;
    const model = override?.model ?? configuredRoute.model;

    const provider = this.factory.getProvider(providerName);
    if (!provider.supports(requiredCapability)) {
      throw new AIProviderError(
        "Provider '" + providerName + "' does not support required capability '" + requiredCapability + "' for task '" + task + "'.",
        { code: "UNSUPPORTED_CAPABILITY", provider: providerName, retryable: false }
      );
    }

    const modelCfg = this.registry.getModelConfig(providerName, model);
    if (modelCfg) {
      if (!modelCfg.enabled) {
        throw new AIProviderError(
          "Model '" + model + "' on provider '" + providerName + "' is disabled in ModelRegistry.",
          { code: "MODEL_DISABLED", provider: providerName, retryable: false }
        );
      }
      if (!modelCfg.capabilities.includes(requiredCapability)) {
        throw new AIProviderError(
          "Model '" + model + "' lacks capability '" + requiredCapability + "' required for task '" + task + "'.",
          { code: "MODEL_CAPABILITY_MISMATCH", provider: providerName, retryable: false }
        );
      }
    }

    return {
      provider,
      providerName,
      model,
      requiredCapability,
    };
  }
}
