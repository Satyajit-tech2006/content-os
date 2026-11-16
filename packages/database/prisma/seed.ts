import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";

const prisma = new PrismaClient();

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return salt + ":" + hash;
}

async function main() {
  console.log("Seeding ContentOS database...");

  const shortFormTemplate = await prisma.workflowTemplate.upsert({
    where: { id: "tpl_short_form_v1" },
    update: {},
    create: {
      id: "tpl_short_form_v1",
      name: "Short-form Content Production",
      description: "End-to-end automated pipeline for vertical short-form videos (YouTube Shorts, Instagram Reels).",
      version: 1,
      isSystem: true,
      stages: [
        {
          key: "research",
          name: "Research",
          description: "Analyze niche trends, hooks, and source material.",
          order: 0,
          requiredInputs: ["niche", "targetAudience"],
          outputs: ["researchBrief", "angleHooks"],
          retryPolicy: { maxAttempts: 3, backoffMs: 2000 },
          config: {},
        },
        {
          key: "script_generation",
          name: "Script Generation",
          description: "Generate structured hook-body-CTA short-form script.",
          order: 1,
          requiredInputs: ["researchBrief"],
          outputs: ["scriptText", "sceneBreakdown"],
          retryPolicy: { maxAttempts: 3, backoffMs: 2000 },
          config: {},
        },
        {
          key: "media_production",
          name: "Media Production",
          description: "Prepare voiceover, B-roll segments, and visual assets.",
          order: 2,
          requiredInputs: ["sceneBreakdown"],
          outputs: ["audioTrackRef", "visualAssets"],
          retryPolicy: { maxAttempts: 2, backoffMs: 3000 },
          config: {},
        },
        {
          key: "video_rendering",
          name: "Video Rendering",
          description: "Composite vertical 9:16 video timeline with captions.",
          order: 3,
          requiredInputs: ["audioTrackRef", "visualAssets"],
          outputs: ["renderedVideoRef", "durationSec"],
          retryPolicy: { maxAttempts: 2, backoffMs: 5000 },
          config: {},
        },
        {
          key: "quality_control",
          name: "Quality Control",
          description: "Verify aspect ratio, audio levels, and pacing compliance.",
          order: 4,
          requiredInputs: ["renderedVideoRef"],
          outputs: ["qcPassed", "qcScore"],
          retryPolicy: { maxAttempts: 2, backoffMs: 1000 },
          config: {},
        },
        {
          key: "approval",
          name: "Approval",
          description: "Evaluate project approval policy before distribution.",
          order: 5,
          requiredInputs: ["qcPassed"],
          outputs: ["approved", "approvedBy"],
          retryPolicy: { maxAttempts: 1, backoffMs: 1000 },
          config: {},
        },
        {
          key: "publishing",
          name: "Publishing",
          description: "Queue or dispatch to configured social platform adapters.",
          order: 6,
          requiredInputs: ["approved", "renderedVideoRef"],
          outputs: ["publishStatus", "targetPlatforms"],
          retryPolicy: { maxAttempts: 3, backoffMs: 3000 },
          config: {},
        },
      ],
    },
  });

  const demoUser = await prisma.user.upsert({
    where: { email: "founder@contentos.dev" },
    update: {},
    create: {
      email: "founder@contentos.dev",
      name: "Satyajit (Founder)",
      passwordHash: hashPassword("ContentOS2026!"),
    },
  });

  const workspace = await prisma.workspace.upsert({
    where: { slug: "contentos-studio" },
    update: {},
    create: {
      id: "ws_default_studio",
      name: "ContentOS Studio",
      slug: "contentos-studio",
      ownerId: demoUser.id,
      members: {
        create: {
          userId: demoUser.id,
          role: "OWNER",
        },
      },
    },
  });

  await prisma.project.upsert({
    where: { id: "proj_checkpoint_daily" },
    update: {},
    create: {
      id: "proj_checkpoint_daily",
      workspaceId: workspace.id,
      workflowTemplateId: shortFormTemplate.id,
      name: "Checkpoint Daily",
      description: "Daily gaming news, updates, and industry announcements.",
      niche: "Gaming News",
      targetAudience: "Core gamers and industry followers",
      contentFormat: "short_video",
      platforms: ["youtube", "instagram"],
      postingFrequency: 7,
      status: "ACTIVE",
      approvalRequired: true,
      automationEnabled: true,
      config: {
        tone: "sharp, editorial, fast-paced",
        language: "en",
        aspectRatio: "9:16",
        targetDurationSec: 45,
      },
    },
  });

  await prisma.project.upsert({
    where: { id: "proj_gta_clips" },
    update: {},
    create: {
      id: "proj_gta_clips",
      workspaceId: workspace.id,
      workflowTemplateId: shortFormTemplate.id,
      name: "GTA Clips",
      description: "High-energy GTA gameplay highlights and stunts.",
      niche: "Gaming",
      targetAudience: "Action & open-world gaming enthusiasts",
      contentFormat: "short_video",
      platforms: ["youtube", "instagram"],
      postingFrequency: 5,
      status: "PAUSED",
      approvalRequired: false,
      automationEnabled: false,
      config: {
        tone: "high-energy",
        language: "en",
        aspectRatio: "9:16",
        targetDurationSec: 30,
      },
    },
  });

  console.log("Seed completed successfully.");
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
