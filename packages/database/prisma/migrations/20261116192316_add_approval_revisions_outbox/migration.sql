/*
  Warnings:

  - A unique constraint covering the columns `[idempotencyKey]` on the table `OutboxEvent` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `idempotencyKey` to the `OutboxEvent` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ContentApprovalStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'REVISION_REQUESTED');

-- CreateEnum
CREATE TYPE "ApprovalAction" AS ENUM ('APPROVED', 'REJECTED', 'REVISION_REQUESTED');

-- CreateEnum
CREATE TYPE "RevisionSource" AS ENUM ('AI_GENERATED', 'AI_REVISION', 'MANUAL_EDIT');

-- AlterEnum
ALTER TYPE "AssetType" ADD VALUE 'SCRIPT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ExecutionStatus" ADD VALUE 'AWAITING_APPROVAL';
ALTER TYPE "ExecutionStatus" ADD VALUE 'REJECTED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StageStatus" ADD VALUE 'AWAITING_APPROVAL';
ALTER TYPE "StageStatus" ADD VALUE 'REJECTED';

-- DropIndex
DROP INDEX "OutboxEvent_status_createdAt_idx";

-- AlterTable
ALTER TABLE "ContentAsset" ADD COLUMN     "approvalStatus" "ContentApprovalStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
ADD COLUMN     "approvedRevisionId" TEXT,
ADD COLUMN     "currentRevisionNum" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "OutboxEvent" ADD COLUMN     "idempotencyKey" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
ADD COLUMN     "nextRetryAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "WorkflowExecution" ADD COLUMN     "activeRevisionNum" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "approvedRevisionId" TEXT;

-- CreateTable
CREATE TABLE "ContentRevision" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "executionId" TEXT,
    "assetId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "source" "RevisionSource" NOT NULL DEFAULT 'AI_GENERATED',
    "title" TEXT NOT NULL,
    "hook" TEXT,
    "voiceoverScript" TEXT NOT NULL,
    "description" TEXT,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scriptPayload" JSONB NOT NULL,
    "researchBrief" JSONB,
    "reviewerFeedback" TEXT,
    "stageKey" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalDecision" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "decision" "ApprovalAction" NOT NULL,
    "comment" TEXT,
    "idempotencyKey" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentRevision_workspaceId_assetId_revisionNumber_idx" ON "ContentRevision"("workspaceId", "assetId", "revisionNumber");

-- CreateIndex
CREATE INDEX "ContentRevision_executionId_idx" ON "ContentRevision"("executionId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentRevision_assetId_revisionNumber_key" ON "ContentRevision"("assetId", "revisionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalDecision_idempotencyKey_key" ON "ApprovalDecision"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ApprovalDecision_workspaceId_assetId_createdAt_idx" ON "ApprovalDecision"("workspaceId", "assetId", "createdAt");

-- CreateIndex
CREATE INDEX "ApprovalDecision_executionId_idx" ON "ApprovalDecision"("executionId");

-- CreateIndex
CREATE INDEX "ContentAsset_workspaceId_approvalStatus_idx" ON "ContentAsset"("workspaceId", "approvalStatus");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_idempotencyKey_key" ON "OutboxEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_nextRetryAt_createdAt_idx" ON "OutboxEvent"("status", "nextRetryAt", "createdAt");

-- AddForeignKey
ALTER TABLE "ContentRevision" ADD CONSTRAINT "ContentRevision_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentRevision" ADD CONSTRAINT "ContentRevision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentRevision" ADD CONSTRAINT "ContentRevision_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "WorkflowExecution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentRevision" ADD CONSTRAINT "ContentRevision_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "ContentAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentRevision" ADD CONSTRAINT "ContentRevision_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDecision" ADD CONSTRAINT "ApprovalDecision_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDecision" ADD CONSTRAINT "ApprovalDecision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDecision" ADD CONSTRAINT "ApprovalDecision_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "WorkflowExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDecision" ADD CONSTRAINT "ApprovalDecision_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "ContentAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDecision" ADD CONSTRAINT "ApprovalDecision_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "ContentRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDecision" ADD CONSTRAINT "ApprovalDecision_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "OutboxEvent" ALTER COLUMN "idempotencyKey" DROP DEFAULT;
