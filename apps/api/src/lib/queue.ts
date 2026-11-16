import { Queue } from "bullmq";
import { Redis } from "ioredis";
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
}

export async function enqueueStageJob(payload: StageJobPayload, attempts = 3, backoffMs = 2000): Promise<void> {
  const jobId = payload.executionId + ":stage:" + payload.stageOrder;
  await workflowQueue.add("execute-stage", payload, {
    jobId,
    attempts,
    backoff: {
      type: "exponential",
      delay: backoffMs,
    },
  });
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
