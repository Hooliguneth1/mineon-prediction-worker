import { PrismaClient } from "@prisma/client";
import { config } from "./config";

export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: config.databaseUrl
    }
  }
});

export async function ensurePredictionRoundSchemaColumns(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "PredictionRound" ADD COLUMN IF NOT EXISTS "settled" BOOLEAN NOT NULL DEFAULT false'
  );
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "PredictionRound" ADD COLUMN IF NOT EXISTS "settlementTxId" TEXT'
  );
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "PredictionRound" ADD COLUMN IF NOT EXISTS "upPool" DECIMAL(18,8) NOT NULL DEFAULT 0'
  );
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "PredictionRound" ADD COLUMN IF NOT EXISTS "downPool" DECIMAL(18,8) NOT NULL DEFAULT 0'
  );
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "PredictionRound" ADD COLUMN IF NOT EXISTS "betCount" INTEGER NOT NULL DEFAULT 0'
  );
}

export async function ensurePredictionBetSchemaColumns(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "PredictionBet" ADD COLUMN IF NOT EXISTS "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP'
  );
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "PredictionBet" ADD COLUMN IF NOT EXISTS "settled" BOOLEAN NOT NULL DEFAULT false'
  );
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "PredictionBet" ADD COLUMN IF NOT EXISTS "won" BOOLEAN NOT NULL DEFAULT false'
  );
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "PredictionBet" ADD COLUMN IF NOT EXISTS "settledAt" TIMESTAMP(3)'
  );
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "PredictionBet" ADD COLUMN IF NOT EXISTS "claimable" BOOLEAN NOT NULL DEFAULT false'
  );
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "PredictionBet" ADD COLUMN IF NOT EXISTS "payoutAmount" DECIMAL(18,8) NOT NULL DEFAULT 0'
  );
}

export async function ensurePredictionIndexes(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "PredictionRound_processingWorker_status_createdAt_idx" ON "PredictionRound" ("processingWorker", "status", "createdAt")'
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "PredictionRound_status_lockAt_idx" ON "PredictionRound" ("status", "lockAt")'
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "PredictionBet_roundId_settled_acceptedAt_idx" ON "PredictionBet" ("roundId", "settled", "acceptedAt")'
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "PredictionBet_userId_createdAt_idx" ON "PredictionBet" ("userId", "createdAt")'
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "PredictionTick_roundId_index_idx" ON "PredictionTick" ("roundId", "index")'
  );
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS "PredictionTick_roundId_timestamp_idx" ON "PredictionTick" ("roundId", "updatedAt")'
  );
}

async function debugLog(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>
): Promise<void> {
  // #region agent log
  await fetch("http://127.0.0.1:7727/ingest/a1bfee3f-da42-483c-a597-7cbff08763e7", { method: "POST", headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "8ed5d2" }, body: JSON.stringify({ sessionId: "8ed5d2", runId: `db-${process.pid}-${Date.now()}`, hypothesisId, location, message, data, timestamp: Date.now() }) }).catch(() => {});
  // #endregion
}

export async function assertDatabaseConnection(): Promise<void> {
  await prisma.$connect();
  await prisma.$queryRaw`SELECT 1`;

  // Self-heal for shared DB drift: some other services may remove columns
  // expected by this worker's Prisma model.
  await ensurePredictionRoundSchemaColumns();
  await ensurePredictionBetSchemaColumns();
  await ensurePredictionIndexes();

  const roundColumns = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'PredictionRound'"
  );
  await debugLog("H1", "db.ts:assertDatabaseConnection:columnsCheck", "PredictionRound schema at startup", {
    hasSettled: roundColumns.some((c) => c.column_name === "settled"),
    columns: roundColumns.map((c) => c.column_name)
  });
  await prisma.predictionRound.findFirst({
    select: { id: true }
  });
}
