import type { NextFunction, Request, Response } from "express";
import { prisma, type WorkspaceRole } from "@contentos/database";
import { ForbiddenError, UnauthorizedError } from "@contentos/shared";
import { hashSessionToken } from "../lib/crypto.js";

export const SESSION_COOKIE_NAME = "contentos_sid";

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      sessionId?: string;
      workspaceRole?: WorkspaceRole;
      workspaceId?: string;
    }
  }
}

export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const rawToken = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    if (!rawToken) {
      throw new UnauthorizedError();
    }

    const tokenHash = hashSessionToken(rawToken);
    const session = await prisma.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!session || session.expiresAt < new Date()) {
      throw new UnauthorizedError("Session expired or invalid");
    }

    req.user = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    };
    req.sessionId = session.id;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireWorkspaceAccess(allowedRoles?: WorkspaceRole[]) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new UnauthorizedError();
      }

      const workspaceId =
        (req.params.workspaceId as string | undefined) ||
        (req.headers["x-workspace-id"] as string | undefined);

      if (!workspaceId) {
        throw new ForbiddenError("Workspace context is required");
      }

      const membership = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId,
            userId: req.user.id,
          },
        },
      });

      if (!membership) {
        throw new ForbiddenError("You do not have access to this workspace");
      }

      if (allowedRoles && !allowedRoles.includes(membership.role)) {
        throw new ForbiddenError("Insufficient workspace permissions");
      }

      req.workspaceId = workspaceId;
      req.workspaceRole = membership.role;
      next();
    } catch (err) {
      next(err);
    }
  };
}
