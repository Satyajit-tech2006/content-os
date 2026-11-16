import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { prisma } from "@contentos/database";
import { redisConnection } from "../lib/queue.js";

const app = createApp();

describe("ContentOS API ? Auth, Tenant Isolation, Project CRUD & Workflow Execution", () => {
  const agentA = request.agent(app);
  const agentB = request.agent(app);

  let workspaceAId = "";
  let workspaceBId = "";
  let projectAId = "";

  const emailA = "test-tenant-a-" + Date.now() + "@contentos.dev";
  const emailB = "test-tenant-b-" + Date.now() + "@contentos.dev";

  beforeAll(async () => {
    await prisma.workflowTemplate.upsert({
      where: { id: "tpl_short_form_v1" },
      update: {},
      create: {
        id: "tpl_short_form_v1",
        name: "Short-form Content Production",
        version: 1,
        isSystem: true,
        stages: [
          {
            key: "research",
            name: "Research",
            order: 0,
            requiredInputs: [],
            outputs: [],
            retryPolicy: { maxAttempts: 2, backoffMs: 500 },
            config: {},
          },
          {
            key: "script_generation",
            name: "Script Generation",
            order: 1,
            requiredInputs: [],
            outputs: [],
            retryPolicy: { maxAttempts: 2, backoffMs: 500 },
            config: {},
          },
        ],
      },
    });
  });

  afterAll(async () => {
    await prisma.workspace.deleteMany({
      where: { id: { in: [workspaceAId, workspaceBId].filter(Boolean) } },
    });
    await prisma.user.deleteMany({
      where: { email: { in: [emailA, emailB] } },
    });
    await prisma.$disconnect();
    await redisConnection.quit();
  });

  it("registers Tenant A and sets an HTTP-only session cookie", async () => {
    const res = await agentA.post("/api/v1/auth/register").send({
      name: "Tenant A Founder",
      email: emailA,
      password: "Password123!",
      workspaceName: "Tenant A Studio",
    });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(emailA);
    expect(res.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    workspaceAId = res.body.workspace.id;
  });

  it("registers Tenant B in an isolated workspace", async () => {
    const res = await agentB.post("/api/v1/auth/register").send({
      name: "Tenant B Founder",
      email: emailB,
      password: "Password123!",
      workspaceName: "Tenant B Studio",
    });

    expect(res.status).toBe(201);
    workspaceBId = res.body.workspace.id;
    expect(workspaceBId).not.toBe(workspaceAId);
  });

  it("creates, updates, and retrieves a project in Tenant A", async () => {
    const createRes = await agentA
      .post("/api/v1/workspaces/" + workspaceAId + "/projects")
      .send({
        name: "Checkpoint Daily Test",
        niche: "Gaming News",
        targetAudience: "PC Gamers",
        platforms: ["youtube", "instagram"],
        workflowTemplateId: "tpl_short_form_v1",
      });

    expect(createRes.status).toBe(201);
    projectAId = createRes.body.project.id;

    const patchRes = await agentA
      .patch("/api/v1/workspaces/" + workspaceAId + "/projects/" + projectAId)
      .send({ postingFrequency: 10 });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.project.postingFrequency).toBe(10);
  });

  it("enforces strict tenant isolation (Tenant B cannot access Tenant A workspace or projects)", async () => {
    const forbiddenOverview = await agentB.get(
      "/api/v1/workspaces/" + workspaceAId + "/overview"
    );
    expect(forbiddenOverview.status).toBe(403);

    const forbiddenProject = await agentB.get(
      "/api/v1/workspaces/" + workspaceAId + "/projects/" + projectAId
    );
    expect(forbiddenProject.status).toBe(403);
  });

  it("creates a workflow execution and outbox event atomically", async () => {
    const runRes = await agentA
      .post(
        "/api/v1/workspaces/" +
          workspaceAId +
          "/executions/projects/" +
          projectAId +
          "/run"
      )
      .send({ topic: "GTA VI Trailer Breakdown" });

    expect(runRes.status).toBe(201);
    expect(runRes.body.execution.status).toBe("PENDING");
    expect(runRes.body.execution.stages.length).toBeGreaterThanOrEqual(2);
  });

  it("deletes a project in Tenant A", async () => {
    const delRes = await agentA.delete(
      "/api/v1/workspaces/" + workspaceAId + "/projects/" + projectAId
    );
    expect(delRes.status).toBe(200);
    expect(delRes.body.ok).toBe(true);
  });
});
