export type ProviderName = "ollama" | "gemini" | "simulated";

export type AICapability =
  | "text_generation"
  | "structured_json"
  | "summarization"
  | "classification"
  | "content_rewriting"
  | "code_generation";

export type AITaskType =
  | "classification"
  | "summarization"
  | "content_ideas"
  | "script_generation"
  | "content_rewriting"
  | "basic_coding";

export interface ModelConfig {
  id: string;
  provider: ProviderName;
  model: string;
  capabilities: AICapability[];
  contextWindow?: number;
  enabled: boolean;
  description?: string;
}

export interface AIGenerateOptions {
  model?: string;
  systemPrompt?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface AITokenUsage {
  provider: ProviderName;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  durationMs: number;
  costMetadata?: Record<string, unknown>;
}

export interface AIGenerateResult<T = string> {
  data: T;
  rawText: string;
  usage: AITokenUsage;
}

export interface InstalledModelInfo {
  name: string;
  sizeBytes?: number;
  modifiedAt?: string;
  family?: string;
  parameterSize?: string;
  quantizationLevel?: string;
}

export interface ProviderHealthResult {
  provider: ProviderName;
  healthy: boolean;
  endpoint?: string;
  latencyMs: number;
  installedModels?: string[];
  error?: string;
}

export interface ModelSwitchEvent {
  timestamp: string;
  task: AITaskType | string;
  fromModel: string;
  toModel: string;
  provider: ProviderName;
  reason: string;
  actor?: string;
}

export interface AIProvider {
  readonly name: ProviderName;
  readonly defaultModel: string;
  readonly model: string;
  readonly supportedCapabilities: readonly AICapability[];
  supports(capability: AICapability): boolean;
  checkHealth(): Promise<ProviderHealthResult>;
  listInstalledModels?(): Promise<InstalledModelInfo[]>;
  generateText(options: AIGenerateOptions): Promise<AIGenerateResult<string>>;
  generateJSON<T>(options: AIGenerateOptions): Promise<AIGenerateResult<T>>;
}

export class AIProviderError extends Error {
  readonly code: string;
  readonly provider: ProviderName;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { code: string; provider: ProviderName; retryable?: boolean }
  ) {
    super(message);
    this.name = "AIProviderError";
    this.code = options.code;
    this.provider = options.provider;
    this.retryable = options.retryable ?? false;
  }
}
