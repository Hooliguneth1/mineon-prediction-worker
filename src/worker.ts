import { config } from "./config";
import { assertDatabaseConnection, prisma } from "./db";
import { ChainlinkService } from "./chainlinkService";
import { RoundManager } from "./roundManager";

let priceService: ChainlinkService | null = null;
const debugRunId = `worker-${process.pid}-${Date.now()}`;

function getDbTargetSafe(): { host: string; database: string } {
  try {
    const url = new URL(config.databaseUrl);
    return { host: url.host, database: url.pathname.replace("/", "") };
  } catch {
    return { host: "invalid-url", database: "unknown" };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function debugLog(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>
): Promise<void> {
  // #region agent log
  await fetch("http://127.0.0.1:7727/ingest/a1bfee3f-da42-483c-a597-7cbff08763e7", { method: "POST", headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "8ed5d2" }, body: JSON.stringify({ sessionId: "8ed5d2", runId: debugRunId, hypothesisId, location, message, data, timestamp: Date.now() }) }).catch(() => {});
  // #endregion
}

function isSchemaDriftError(error: unknown): boolean {
  const code = (error as { code?: string })?.code ?? null;
  const column = (error as { meta?: { column?: string } })?.meta?.column ?? null;
  return code === "P2022" && column === "PredictionRound.settled";
}

function isTransientDbConnectionError(error: unknown): boolean {
  const code = (error as { code?: string })?.code ?? null;
  return code === "P1017" || code === "P1001";
}

async function main(): Promise<void> {
  await debugLog("H1", "worker.ts:main:beforeAssertDatabaseConnection", "Worker bootstrap with DB target", {
    pid: process.pid,
    workerId: config.workerId,
    dbTarget: getDbTargetSafe()
  });
  await assertDatabaseConnection();
  console.log("Worker started", {
    workerId: config.workerId
  });

  priceService = new ChainlinkService();
  const roundManager = new RoundManager(priceService, config.workerId);
  await roundManager.initialize();

  while (true) {
    const loopStartedAt = Date.now();
    try {
      await debugLog("H6", "worker.ts:main:beforeRoundManagerUpdate", "Before roundManager.update", {
        pid: process.pid
      });
      await roundManager.update();
      await debugLog("H6", "worker.ts:main:afterRoundManagerUpdate", "After roundManager.update", {
        pid: process.pid,
        elapsedMs: Date.now() - loopStartedAt
      });
    } catch (error) {
      await debugLog("H2", "worker.ts:main:updateCatch", "Worker update loop error", {
        pid: process.pid,
        errorCode: (error as { code?: string })?.code ?? null,
        errorMeta: (error as { meta?: unknown })?.meta ?? null,
        errorName: (error as { name?: string })?.name ?? "unknown"
      });
      if (isSchemaDriftError(error)) {
        await debugLog("H10", "worker.ts:main:updateCatch:schemaDriftWarning", "Schema drift detected in update loop", {
          pid: process.pid,
          workerId: config.workerId,
          dbTarget: getDbTargetSafe()
        });
      }
      if (isTransientDbConnectionError(error)) {
        console.log("ERROR", {
          message: "Transient database connectivity issue detected; attempting reconnect",
          workerId: config.workerId,
          code: (error as { code?: string })?.code ?? null
        });
        try {
          await prisma.$disconnect();
        } catch {
          // Ignore disconnect errors during reconnect path.
        }
        try {
          await assertDatabaseConnection();
          console.log("DB_RECONNECTED", {
            workerId: config.workerId
          });
        } catch (reconnectError) {
          console.error("ERROR", {
            message: "Database reconnect attempt failed",
            workerId: config.workerId,
            reconnectError
          });
        }
      }
      console.error("Error in worker update loop", { error });
    }

    await delay(config.loopIntervalMs);
  }
}

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}. Shutting down worker...`);
  priceService?.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

main().catch(async (error) => {
  await debugLog("H2", "worker.ts:main:startupCatch", "Worker failed to start", {
    pid: process.pid,
    errorCode: (error as { code?: string })?.code ?? null,
    errorMeta: (error as { meta?: unknown })?.meta ?? null,
    errorName: (error as { name?: string })?.name ?? "unknown"
  });
  console.error("Worker failed to start", { error });
  await prisma.$disconnect();
  process.exit(1);
});
