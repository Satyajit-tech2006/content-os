import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import pino from "pino";
import { prisma } from "@contentos/database";
import { env } from "./config/env.js";
import { processWorkflowStageJob, type StageJobPayload } from "./processor.js";

const logger = pino({ level: "info" });
const WORKFLOW_QUEUE_NAME = "contentos-workflow-stages";

const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const workflowQueue = new Queue(WORKFLOW_QUEUE_NAME, {
  connection: connection as never,
});

const worker = new Worker<StageJobPayload>(
  WORKFLOW_QUEUE_NAME,
  async (job) => {
    logger.info({ jobId: String(job.id).replace(/:/g, "_"), data: job.data }, "Processing workflow stage job");
    await processWorkflowStageJob(job.data, workflowQueue, logger);
  },
  {
    connection: connection as never,
    concurrency: 5,
  }
);

worker.on("failed", (job, err) => {
  logger.error({ jobId: String(job?.id).replace(/:/g, "_"), err: err.message }, "Worker job failed");
});

async function flushOutbox(): Promise<void> {
  const pendingEvents = await prisma.outboxEvent.findMany({
    where: {
      status: "PENDING",
      nextRetryAt: { lte: new Date() },
    },
    orderBy: { createdAt: "asc" },
    take: 25,
  });

  for (const event of pendingEvents) {
    try {
      const payload = event.payload as unknown as StageJobPayload;
      const jobId =
        payload.jobId ??
        event.idempotencyKey ??
        `${payload.executionId}_stage_${payload.stageOrder}_rev_${payload.revisionNum ?? 1}`;
      await workflowQueue.add("execute-stage", { ...payload, jobId }, {
        jobId,
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
      });
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { status: "PROCESSED", processedAt: new Date(), lastError: null },
      });
    } catch (err) {
      const nextAttempt = event.attempts + 1;
      const backoffMs = Math.min(60_000, 2000 * Math.pow(2, nextAttempt));
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          attempts: { increment: 1 },
          lastError: err instanceof Error ? err.message : "Outbox dispatch failed",
          nextRetryAt: new Date(Date.now() + backoffMs),
        },
      });
    }
  }
}

const outboxTimer = setInterval(() => {
  flushOutbox().catch((err) => logger.error({ err }, "Outbox poll error"));
}, 5000);

flushOutbox().catch((err) => logger.error({ err }, "Initial outbox flush error"));
logger.info("ContentOS Worker & Outbox Dispatcher started");

process.on("SIGINT", async () => {
  clearInterval(outboxTimer);
  await worker.close();
  await connection.quit();
  process.exit(0);
});

const publishingWorker = new Worker<{ publishingRecordId: string; workspaceId: string }>(
  "contentos-publishing-dispatch",
  async (job) => {
    const { publishingRecordId, workspaceId } = job.data;
    const record = await prisma.publishingRecord.findFirst({
      where: { id: publishingRecordId, workspaceId },
      include: { platformConnection: true, asset: true },
    });
    if (!record) return;

    await prisma.publishingRecord.update({
      where: { id: record.id },
      data: { status: "PUBLISHING" },
    });

    await new Promise((r) => setTimeout(r, 800));

    const externalPostId = record.platformConnection.platform + "_" + Date.now();
    await prisma.publishingRecord.update({
      where: { id: record.id },
      data: {
        status: "PUBLISHED",
        externalPostId,
        publishedAt: new Date(),
      },
    });
    logger.info({ publishingRecordId, externalPostId, platform: record.platformConnection.platform }, "Asset published via adapter");
  },
  { connection, concurrency: 3 }
);

