-- AlterTable
ALTER TABLE "ApprovalDecision" ALTER COLUMN "idempotencyKey" DROP NOT NULL,
ALTER COLUMN "idempotencyKey" DROP DEFAULT;
