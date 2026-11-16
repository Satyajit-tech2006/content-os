import { Router, type Request, type Response, type NextFunction } from "express";
import { AIOrchestrator, AIProviderFactory, type AITaskType, type ProviderName } from "@contentos/ai-provider";
import { prisma, type Prisma } from "@contentos/database";
import { NotFoundError, ValidationError, type StageKey } from "@contentos/shared";
import { z } from "zod";
import { requireAuth, requireWorkspaceAccess } from "../middleware/auth.js";
import { dispatchOutboxEvent } from "../lib/queue.js";

const router: Router = Router({ mergeParams: true });

const factory = new AIProviderFactory({
  defaultProvider: (process.env.AI_PROVIDER as ProviderName) || "ollama",
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
  ollamaDefaultModel: process.env.OLLAMA_DEFAULT_MODEL || "qwen3:4b",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiDefaultModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
});

export const sharedOrchestrator = new AIOrchestrator(factory);

const SelectModelSchema = z.object({
  task: z.enum(["classification", "summarization", "content_ideas", "script_generation", "content_rewriting", "basic_coding"]),
  provider: z.enum(["ollama", "gemini", "simulated"]),
  model: z.string().min(1).max(120),
  reason: z.string().max(240).optional(),
});

export const ScriptWorkflowInputSchema = z.object({
  projectId: z.string().min(1),
  topic: z.string().min(2).max(300),
  targetAudience: z.string().min(2).max(200).optional(),
  contentPlatform: z.string().min(2).max(100).optional(),
  desiredDuration: z.number().int().min(10).max(600).default(45),
  tone: z.string().min(2).max(100).default("engaging"),
  language: z.string().min(2).max(60).default("English"),
});

router.use(requireAuth);

router.get("/health", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const ollamaHealth = await factory.getProvider("ollama").checkHealth();
    res.json({
      defaultProvider: factory.defaultProvider,
      ollama: ollamaHealth,
      configuredProviders: factory.listConfiguredProviders(),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/providers", (_req: Request, res: Response) => {
  res.json({
    defaultProvider: factory.defaultProvider,
    providers: factory.listConfiguredProviders(),
  });
});

router.get("/models", (_req: Request, res: Response) => {
  res.json({
    models: sharedOrchestrator.registry.listModels(),
    taskRoutes: sharedOrchestrator.registry.getAllRoutes(),
    prompts: sharedOrchestrator.prompts.list(),
    switchHistory: sharedOrchestrator.registry.getSwitchHistory(),
  });
});

router.get("/models/installed", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const ollama = factory.getProvider("ollama");
    const health = await ollama.checkHealth();
    if (!health.healthy) {
      res.status(503).json({
        healthy: false,
        error: health.error,
        installed: [],
        registered: sharedOrchestrator.registry.listModels(),
      });
      return;
    }
    const installed = ollama.listInstalledModels ? await ollama.listInstalledModels() : [];
    const installedNames = new Set(installed.map((m) => m.name.toLowerCase()));
    const registered = sharedOrchestrator.registry.listModels().map((m) => ({
      ...m,
      installedLocally:
        installedNames.has(m.model.toLowerCase()) ||
        installedNames.has(m.model.toLowerCase() + ":latest"),
    }));
    res.json({ healthy: true, installed, registered });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/models/select",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = SelectModelSchema.parse(req.body);
      const event = sharedOrchestrator.registry.selectModelForTask(
        input.task as AITaskType,
        input.provider as ProviderName,
        input.model,
        input.reason ?? "api_admin_selection",
        req.user?.email
      );
      res.json({
        switchEvent: event,
        taskRoutes: sharedOrchestrator.registry.getAllRoutes(),
      });
    } catch (err) {
      next(err);
    }
  }
);

export async function triggerScriptGenerationWorkflow(req: Request, res: Response, next: NextFunction) {
  try {
    const input = ScriptWorkflowInputSchema.parse(req.body);
    const project = await prisma.project.findFirst({
      where: {
        id: input.projectId,
        ...(req.workspaceId ? { workspaceId: req.workspaceId } : {}),
      },
      include: { workflowTemplate: true },
    });
    if (!project) throw new NotFoundError("Project");

    const membership = await prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: project.workspaceId, userId: req.user!.id },
      },
    });
    if (!membership || membership.role === "VIEWER") {
      throw new ValidationError("Insufficient workspace permissions to trigger script generation");
    }

    const stages = (project.workflowTemplate?.stages as Array<{ key: StageKey; order: number; name?: string }>) ?? [
      { key: "research", order: 1, name: "Editorial Ideas" },
      { key: "script_generation", order: 2, name: "Script Generation" },
    ];
    const sortedStages = [...stages].sort((a, b) => a.order - b.order);
    const firstStage = sortedStages[0];
    if (!firstStage) throw new ValidationError("Workflow template has no stages");

    const { execution, outboxEvent } = await prisma.$transaction(async (tx) => {
      const created = await tx.workflowExecution.create({
        data: {
          workspaceId: project.workspaceId,
          projectId: project.id,
          workflowTemplateId: project.workflowTemplateId,
          status: "PENDING",
          currentStageIndex: 0,
          inputContext: {
            topic: input.topic,
            targetAudience: input.targetAudience ?? project.targetAudience,
            contentPlatform: input.contentPlatform ?? project.platforms.join(", "),
            desiredDuration: input.desiredDuration,
            tone: input.tone,
            language: input.language,
          } as Prisma.InputJsonValue,
          stages: {
            create: sortedStages.map((s, idx) => ({
              workspaceId: project.workspaceId,
              stageKey: s.key,
              stageName: s.name || s.key,
              stageOrder: idx,
              status: "PENDING",
            })),
          },
        },
        include: { stages: { orderBy: { stageOrder: "asc" } } },
      });

      const event = await tx.outboxEvent.create({
        data: {
          workspaceId: project.workspaceId,
          eventType: "WORKFLOW_EXECUTION_START",
          idempotencyKey: `exec:${created.id}:stage:0:rev:1`,
          payload: {
            executionId: created.id,
            workspaceId: project.workspaceId,
            stageOrder: 0,
            revisionNum: 1,
            jobId: `exec:${created.id}:stage:0:rev:1`,
          },
        },
      });

      return { execution: created, outboxEvent: event };
    });

    await dispatchOutboxEvent(outboxEvent.id);

    res.status(201).json({ execution });
  } catch (err) {
    next(err);
  }
}

export default router;
