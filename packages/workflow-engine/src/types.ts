import type { AIOrchestrator, AIProvider, AITokenUsage } from "@contentos/ai-provider";
import type { StageKey } from "@contentos/shared";

export interface StageLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
  meta?: Record<string, unknown>;
}

export interface ProjectContext {
  name: string;
  niche: string;
  targetAudience: string;
  contentFormat: string;
  platforms: string[];
  approvalRequired: boolean;
  config: Record<string, unknown>;
}

export interface StageExecutionContext {
  executionId: string;
  workspaceId: string;
  projectId: string;
  project: ProjectContext;
  stageKey: StageKey;
  stageConfig: Record<string, unknown>;
  inputContext: Record<string, unknown>;
  previousOutputs: Record<string, unknown>;
  aiProvider: AIProvider;
  orchestrator: AIOrchestrator;
  log: (level: StageLogEntry["level"], message: string, meta?: Record<string, unknown>) => void;
}

export interface StageUsageMetric extends AITokenUsage {
  operation: string;
  taskType?: string;
  success?: boolean;
  errorMessage?: string;
}

export interface StageExecutionResult {
  output: Record<string, unknown>;
  usage?: StageUsageMetric[];
}

export interface WorkflowStageHandler {
  readonly key: StageKey;
  execute(ctx: StageExecutionContext): Promise<StageExecutionResult>;
}

export type StageHandler = WorkflowStageHandler;
export type StageHandlerResult = StageExecutionResult;
