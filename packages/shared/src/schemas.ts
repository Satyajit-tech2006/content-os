import { z } from "zod";

export const WorkspaceRoleSchema = z.enum(["OWNER", "ADMIN", "EDITOR", "VIEWER"]);
export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>;

export const ProjectStatusSchema = z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const DurationRangeSchema = z.enum([
  "15-20s",
  "30-45s",
  "45-60s",
  "60s+",
]);
export type DurationRange = z.infer<typeof DurationRangeSchema>;

export const VideoStyleSchema = z.enum([
  "isometric_tech", "stock_ken_burns",
  "stickman_explainer",
  "minimal_line_art",
  "kinetic_typography",
  "tech_hud_blueprint",
]);
export type VideoStyle = z.infer<typeof VideoStyleSchema>;

export const ContentFormatSchema = z.enum([
  "short_video",
  "long_video",
  "carousel",
  "article",
]);
export type ContentFormat = z.infer<typeof ContentFormatSchema>;

export const PlatformSchema = z.enum(["youtube", "instagram", "tiktok", "x"]);
export type Platform = z.infer<typeof PlatformSchema>;

export const ExecutionStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const StageStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "SKIPPED",
]);
export type StageStatus = z.infer<typeof StageStatusSchema>;

export const StageKeySchema = z.enum([
  "research",
  "topic_discovery",
  "source_verification",
  "script_generation",
  "voice_generation",
  "media_acquisition",
  "media_production",
  "video_editing",
  "video_rendering",
  "subtitle_generation",
  "quality_control",
  "approval",
  "publishing",
]);
export type StageKey = z.infer<typeof StageKeySchema>;

export const RegisterSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(80),
  email: z.string().trim().email("Invalid email address").toLowerCase(),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
  workspaceName: z.string().trim().min(2).max(80).optional(),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

export const LoginSchema = z.object({
  email: z.string().trim().email().toLowerCase(),
  password: z.string().min(1, "Password is required"),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const CreateWorkspaceSchema = z.object({
  name: z.string().trim().min(2, "Workspace name is required").max(80),
});
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>;

export const ProjectConfigSchema = z
  .object({
    tone: z.string().max(100).default("engaging"),
    language: z.string().max(20).default("en"),
    aspectRatio: z.enum(["9:16", "16:9", "1:1"]).default("9:16"),
    targetDurationSec: z.number().int().min(10).max(3600).default(45),
    durationRange: DurationRangeSchema.default("30-45s"),
    videoStyle: VideoStyleSchema.default("isometric_tech"),
    brandGuidelines: z.string().max(1000).optional(),
    customRules: z.record(z.unknown()).optional(),
  })
  .default({});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const CreateProjectSchema = z.object({
  name: z.string().trim().min(2, "Project name must be at least 2 characters").max(100),
  description: z.string().trim().max(500).optional().default(""),
  niche: z.string().trim().min(2, "Niche is required").max(80),
  targetAudience: z.string().trim().min(2, "Target audience is required").max(200),
  contentFormat: ContentFormatSchema.default("short_video"),
  platforms: z.array(PlatformSchema).min(1, "Select at least one platform"),
  postingFrequency: z.number().int().min(1).max(30).default(3),
  approvalRequired: z.boolean().default(true),
  automationEnabled: z.boolean().default(false),
  workflowTemplateId: z.string().min(1, "Workflow template is required"),
  config: ProjectConfigSchema.optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

export const UpdateProjectSchema = CreateProjectSchema.partial().extend({
  status: ProjectStatusSchema.optional(),
});
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;

export const WorkflowStageDefinitionSchema = z.object({
  key: StageKeySchema,
  name: z.string().min(1),
  description: z.string().optional(),
  order: z.number().int().min(0),
  requiredInputs: z.array(z.string()).default([]),
  outputs: z.array(z.string()).default([]),
  retryPolicy: z
    .object({
      maxAttempts: z.number().int().min(1).max(5).default(3),
      backoffMs: z.number().int().min(500).default(2000),
    })
    .default({ maxAttempts: 3, backoffMs: 2000 }),
  config: z.record(z.unknown()).default({}),
});
export type WorkflowStageDefinition = z.infer<typeof WorkflowStageDefinitionSchema>;

export const TriggerExecutionSchema = z.object({
  topic: z.string().trim().max(1000).optional(),
  durationRange: DurationRangeSchema.optional(),
  videoStyle: VideoStyleSchema.optional(),
  simulateFailureAtStage: StageKeySchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type TriggerExecutionInput = z.infer<typeof TriggerExecutionSchema>;
