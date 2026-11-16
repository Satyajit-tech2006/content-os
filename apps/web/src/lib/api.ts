const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";

export class ApiClientError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
  }
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(API_BASE + path, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiClientError(data?.error?.message || "Request failed", res.status, data?.error?.code);
  }
  return data as T;
}

export interface WorkspaceDTO { id: string; name: string; slug: string; role: string; }
export interface StageExecutionDTO {
  id: string; stageKey: string; stageName: string; stageOrder: number;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "SKIPPED";
  attemptCount: number; output: Record<string, unknown> | null;
  logs: Array<{ timestamp: string; level: string; message: string }>;
  errorMessage: string | null; startedAt: string | null; completedAt: string | null;
}
export interface WorkflowExecutionDTO {
  id: string; projectId: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  currentStageIndex: number; inputContext: Record<string, unknown>;
  outputSummary: Record<string, unknown> | null; errorMessage: string | null;
  startedAt: string | null; completedAt: string | null; createdAt: string;
  project?: { id: string; name: string; niche: string };
  workflowTemplate?: { id: string; name: string };
  stages: StageExecutionDTO[];
}
export interface ProjectDTO {
  id: string; workspaceId: string; workflowTemplateId: string; name: string;
  description: string; niche: string; targetAudience: string; contentFormat: string;
  platforms: string[]; postingFrequency: number; status: "ACTIVE" | "PAUSED" | "ARCHIVED";
  approvalRequired: boolean; automationEnabled: boolean; config: Record<string, unknown>;
  createdAt: string; workflowTemplate?: { id: string; name: string; version?: number; stages?: unknown };
  executions?: WorkflowExecutionDTO[]; _count?: { executions: number };
}
export interface WorkflowTemplateDTO {
  id: string; name: string; description: string; version: number; isSystem: boolean;
  stages: Array<{ key: string; name: string; order: number; description?: string }>;
}
