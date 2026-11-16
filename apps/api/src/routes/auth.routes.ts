import { Router, type Request, type Response, type NextFunction } from "express";
import { prisma } from "@contentos/database";
import { LoginSchema, RegisterSchema, UnauthorizedError, ValidationError } from "@contentos/shared";
import { env } from "../config/env.js";
import { generateSessionToken, hashPassword, hashSessionToken, verifyPassword } from "../lib/crypto.js";
import { requireAuth, SESSION_COOKIE_NAME } from "../middleware/auth.js";

const router: Router = Router();

function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    maxAge: env.SESSION_TTL_HOURS * 60 * 60 * 1000,
    path: "/",
  });
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") +
    "-" +
    Math.random().toString(36).slice(2, 6)
  );
}

router.post("/register", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = RegisterSchema.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      throw new ValidationError("An account with this email already exists");
    }

    const rawToken = generateSessionToken();
    const tokenHash = hashSessionToken(rawToken);
    const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 60 * 60 * 1000);
    const workspaceName = input.workspaceName || input.name + "'s Workspace";

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: input.name,
          email: input.email,
          passwordHash: hashPassword(input.password),
        },
      });

      const workspace = await tx.workspace.create({
        data: {
          name: workspaceName,
          slug: slugify(workspaceName),
          ownerId: user.id,
          members: {
            create: {
              userId: user.id,
              role: "OWNER",
            },
          },
        },
      });

      await tx.session.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt,
          userAgent: req.headers["user-agent"],
          ipAddress: req.ip,
        },
      });

      return { user, workspace };
    });

    setSessionCookie(res, rawToken);
    res.status(201).json({
      user: { id: result.user.id, email: result.user.email, name: result.user.name },
      workspace: result.workspace,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/login", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = LoginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user || !verifyPassword(input.password, user.passwordHash)) {
      throw new UnauthorizedError("Invalid email or password");
    }

    const rawToken = generateSessionToken();
    const tokenHash = hashSessionToken(rawToken);
    const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 60 * 60 * 1000);

    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
        userAgent: req.headers["user-agent"],
        ipAddress: req.ip,
      },
    });

    const memberships = await prisma.workspaceMember.findMany({
      where: { userId: user.id },
      include: { workspace: true },
      orderBy: { createdAt: "asc" },
    });

    setSessionCookie(res, rawToken);
    res.json({
      user: { id: user.id, email: user.email, name: user.name },
      workspaces: memberships.map((m) => ({ ...m.workspace, role: m.role })),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/logout", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.sessionId) {
      await prisma.session.delete({ where: { id: req.sessionId } }).catch(() => {});
    }
    res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/me", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const memberships = await prisma.workspaceMember.findMany({
      where: { userId: req.user!.id },
      include: { workspace: true },
      orderBy: { createdAt: "asc" },
    });

    res.json({
      user: req.user,
      workspaces: memberships.map((m) => ({ ...m.workspace, role: m.role })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
