import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { prisma } from "@contentos/database";
import { env } from "../config/env.js";

export const WORKFLOW_QUEUE_NAME = "contentos-workflow-stages";

export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const workflowQueue = new Queue(WORKFLOW_QUEUE_NAME, {
  connection: redisConnection as never,
  defaultJobOptions: {
    removeOnComplete: 200,
    removeOnFail: 500,
  },
});

export interface StageJobPayload {
  executionId: string;
  workspaceId: string;
  stageOrder: number;
  revisionNum?: number;
  jobId?: string;
}

export function buildStageJobId(payload: StageJobPayload): string {
  if (payload.jobId) return String(payload.jobId).replace(/:/g, "_");
  const rev = payload.revisionNum ?? 1;
  return `${payload.executionId}_stage_${payload.stageOrder}_rev_${rev}`;
}

export async function enqueueStageJob(payload: StageJobPayload, attempts = 3, backoffMs = 2000): Promise<void> {
  const jobId = buildStageJobId(payload);
  await workflowQueue.add("execute-stage", payload, {
    jobId,
    attempts,
    backoff: {
      type: "exponential",
      delay: backoffMs,
    },
  });
}

export async function dispatchOutboxEvent(outboxEventId: string, attempts = 3, backoffMs = 2000): Promise<boolean> {
  const event = await prisma.outboxEvent.findUnique({ where: { id: outboxEventId } });
  if (!event || event.status === "PROCESSED") return true;

  try {
    const payload = event.payload as unknown as StageJobPayload;
    await enqueueStageJob({ ...payload, jobId: String(payload.jobId ?? event.idempotencyKey).replace(/:/g, "_")}, attempts, backoffMs);
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: { status: "PROCESSED", processedAt: new Date(), lastError: null },
    });
    return true;
  } catch (err) {
    const nextAttempt = event.attempts + 1;
    const backoffDelay = Math.min(60_000, 2000 * Math.pow(2, nextAttempt));
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: {
        attempts: { increment: 1 },
        lastError: err instanceof Error ? err.message : "Outbox dispatch failed",
        nextRetryAt: new Date(Date.now() + backoffDelay),
      },
    });
    return false;
  }
}

export const PUBLISHING_QUEUE_NAME = "contentos-publishing-dispatch";

export const publishingQueue = new Queue(PUBLISHING_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  },
});
