import { Router, type Request, type Response, type NextFunction } from "express";
import { prisma } from "@contentos/database";
import { CreateWorkspaceSchema } from "@contentos/shared";
import { requireAuth, requireWorkspaceAccess } from "../middleware/auth.js";

const router: Router = Router();

router.use(requireAuth);

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const memberships = await prisma.workspaceMember.findMany({
      where: { userId: req.user!.id },
      include: { workspace: true },
      orderBy: { createdAt: "asc" },
    });

    res.json({
      workspaces: memberships.map((m) => ({ ...m.workspace, role: m.role })),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = CreateWorkspaceSchema.parse(req.body);
    const slug =
      input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "") +
      "-" +
      Math.random().toString(36).slice(2, 6);

    const workspace = await prisma.workspace.create({
      data: {
        name: input.name,
        slug,
        ownerId: req.user!.id,
        members: {
          create: {
            userId: req.user!.id,
            role: "OWNER",
          },
        },
      },
    });

    res.status(201).json({ workspace: { ...workspace, role: "OWNER" } });
  } catch (err) {
    next(err);
  }
});

router.get(
  "/:workspaceId/overview",
  requireWorkspaceAccess(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId!;

      const [
        totalProjects,
        activeProjects,
        totalExecutions,
        completedExecutions,
        failedExecutions,
        runningExecutions,
        recentExecutions,
        projects,
      ] = await Promise.all([
        prisma.project.count({ where: { workspaceId } }),
        prisma.project.count({ where: { workspaceId, status: "ACTIVE" } }),
        prisma.workflowExecution.count({ where: { workspaceId } }),
        prisma.workflowExecution.count({ where: { workspaceId, status: "COMPLETED" } }),
        prisma.workflowExecution.count({ where: { workspaceId, status: "FAILED" } }),
        prisma.workflowExecution.count({
          where: { workspaceId, status: { in: ["PENDING", "RUNNING"] } },
        }),
        prisma.workflowExecution.findMany({
          where: { workspaceId },
          include: {
            project: { select: { id: true, name: true, niche: true } },
            workflowTemplate: { select: { id: true, name: true } },
            stages: {
              select: { id: true, stageKey: true, stageName: true, stageOrder: true, status: true },
              orderBy: { stageOrder: "asc" },
            },
          },
          orderBy: { createdAt: "desc" },
          take: 10,
        }),
        prisma.project.findMany({
          where: { workspaceId },
          include: {
            workflowTemplate: { select: { id: true, name: true } },
            _count: { select: { executions: true } },
          },
          orderBy: { createdAt: "desc" },
        }),
      ]);

      res.json({
        stats: {
          totalProjects,
          activeProjects,
          totalExecutions,
          completedExecutions,
          failedExecutions,
          runningExecutions,
        },
        projects,
        recentExecutions,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/:workspaceId/templates",
  requireWorkspaceAccess(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId!;
      const templates = await prisma.workflowTemplate.findMany({
        where: {
          OR: [{ isSystem: true }, { workspaceId }],
        },
        orderBy: { createdAt: "asc" },
      });
      res.json({ templates });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/:workspaceId/usage",
  requireWorkspaceAccess(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId!;
      const [agg, recent] = await Promise.all([
        prisma.usageRecord.aggregate({
          where: { workspaceId },
          _sum: { inputTokens: true, outputTokens: true, estimatedCostUsd: true },
          _count: { id: true },
        }),
        prisma.usageRecord.findMany({
          where: { workspaceId },
          orderBy: { createdAt: "desc" },
          take: 25,
        }),
      ]);
      res.json({
        totals: {
          calls: agg._count.id,
          inputTokens: agg._sum.inputTokens ?? 0,
          outputTokens: agg._sum.outputTokens ?? 0,
          estimatedCostUsd: Number((agg._sum.estimatedCostUsd ?? 0).toFixed(6)),
        },
        records: recent,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
