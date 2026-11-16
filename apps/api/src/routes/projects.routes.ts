import { Router, type Request, type Response, type NextFunction } from "express";
import { prisma, type Prisma } from "@contentos/database";
import {
  CreateProjectSchema,
  NotFoundError,
  ProjectConfigSchema,
  UpdateProjectSchema,
  ValidationError,
} from "@contentos/shared";
import { requireAuth, requireWorkspaceAccess } from "../middleware/auth.js";

const router: Router = Router({ mergeParams: true });

router.use(requireAuth, requireWorkspaceAccess());

router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = req.workspaceId!;
    const projects = await prisma.project.findMany({
      where: { workspaceId },
      include: {
        workflowTemplate: { select: { id: true, name: true, version: true } },
        _count: { select: { executions: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.json({ projects });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/",
  requireWorkspaceAccess(["OWNER", "ADMIN", "EDITOR"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId!;
      const input = CreateProjectSchema.parse(req.body);

      const template = await prisma.workflowTemplate.findFirst({
        where: {
          id: input.workflowTemplateId,
          OR: [{ isSystem: true }, { workspaceId }],
        },
      });
      if (!template) {
        throw new ValidationError("Selected workflow template does not exist");
      }

      const validatedConfig = ProjectConfigSchema.parse(input.config ?? {});

      const project = await prisma.project.create({
        data: {
          workspaceId,
          workflowTemplateId: input.workflowTemplateId,
          name: input.name,
          description: input.description,
          niche: input.niche,
          targetAudience: input.targetAudience,
          contentFormat: input.contentFormat,
          platforms: input.platforms,
          postingFrequency: input.postingFrequency,
          approvalRequired: input.approvalRequired,
          automationEnabled: input.automationEnabled,
          config: validatedConfig as Prisma.InputJsonValue,
        },
        include: {
          workflowTemplate: { select: { id: true, name: true, version: true } },
        },
      });

      res.status(201).json({ project });
    } catch (err) {
      next(err);
    }
  }
);

router.get("/:projectId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = req.workspaceId!;
    const projectId = String(req.params.projectId);

    const project = await prisma.project.findFirst({
      where: { id: projectId, workspaceId },
      include: {
        workflowTemplate: true,
        executions: {
          include: {
            stages: { orderBy: { stageOrder: "asc" } },
          },
          orderBy: { createdAt: "desc" },
          take: 20,
        },
      },
    });

    if (!project) {
      throw new NotFoundError("Project");
    }

    res.json({ project });
  } catch (err) {
    next(err);
  }
});

router.patch(
  "/:projectId",
  requireWorkspaceAccess(["OWNER", "ADMIN", "EDITOR"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId!;
      const projectId = String(req.params.projectId);
      const input = UpdateProjectSchema.parse(req.body);

      const existing = await prisma.project.findFirst({
        where: { id: projectId, workspaceId },
      });
      if (!existing) {
        throw new NotFoundError("Project");
      }

      if (input.workflowTemplateId) {
        const template = await prisma.workflowTemplate.findFirst({
          where: {
            id: input.workflowTemplateId,
            OR: [{ isSystem: true }, { workspaceId }],
          },
        });
        if (!template) {
          throw new ValidationError("Selected workflow template does not exist");
        }
      }

      const project = await prisma.project.update({
        where: { id: projectId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.niche !== undefined && { niche: input.niche }),
          ...(input.targetAudience !== undefined && { targetAudience: input.targetAudience }),
          ...(input.contentFormat !== undefined && { contentFormat: input.contentFormat }),
          ...(input.platforms !== undefined && { platforms: input.platforms }),
          ...(input.postingFrequency !== undefined && { postingFrequency: input.postingFrequency }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.approvalRequired !== undefined && { approvalRequired: input.approvalRequired }),
          ...(input.automationEnabled !== undefined && { automationEnabled: input.automationEnabled }),
          ...(input.workflowTemplateId !== undefined && { workflowTemplateId: input.workflowTemplateId }),
          ...(input.config !== undefined && {
            config: ProjectConfigSchema.parse(input.config) as Prisma.InputJsonValue,
          }),
        },
        include: {
          workflowTemplate: { select: { id: true, name: true, version: true } },
        },
      });

      res.json({ project });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/:projectId",
  requireWorkspaceAccess(["OWNER", "ADMIN"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId!;
      const projectId = String(req.params.projectId);

      const existing = await prisma.project.findFirst({
        where: { id: projectId, workspaceId },
      });
      if (!existing) {
        throw new NotFoundError("Project");
      }

      await prisma.project.delete({ where: { id: projectId } });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
