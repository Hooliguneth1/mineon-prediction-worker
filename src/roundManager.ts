import { randomUUID } from "node:crypto";
import { PredictionRound, Prisma } from "@prisma/client";
import {
  ensurePredictionBetSchemaColumns,
  ensurePredictionRoundSchemaColumns,
  prisma
} from "./db";
import { config } from "./config";
import { ChainlinkService } from "./chainlinkService";
import { ExchangeTradeData } from "./types";

export class RoundManager {
  private readonly chainlinkService: ChainlinkService;
  private readonly workerId: string;
  private updateInFlight = false;
  private readonly debugRunId = `round-manager-${process.pid}-${Date.now()}`;
  private updateIteration = 0;

  constructor(chainlinkService: ChainlinkService, workerId: string) {
    this.chainlinkService = chainlinkService;
    this.workerId = workerId;
  }

  private async debugLog(
    hypothesisId: string,
    location: string,
    message: string,
    data: Record<string, unknown>
  ): Promise<void> {
    // #region agent log
    await fetch("http://127.0.0.1:7727/ingest/a1bfee3f-da42-483c-a597-7cbff08763e7", { method: "POST", headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "8ed5d2" }, body: JSON.stringify({ sessionId: "8ed5d2", runId: this.debugRunId, hypothesisId, location, message, data, timestamp: Date.now() }) }).catch(() => {});
    // #endregion
  }

  private isMissingSettledColumnError(error: unknown): boolean {
    const code = (error as { code?: string })?.code ?? null;
    const column = (error as { meta?: { column?: string } })?.meta?.column ?? "";
    return code === "P2022" && column.startsWith("PredictionRound.");
  }

  private isMissingAcceptedAtError(error: unknown): boolean {
    const code = (error as { code?: string })?.code ?? null;
    const message =
      (error as { meta?: { message?: string } })?.meta?.message ?? "";
    return (
      code === "P2010" &&
      message.includes('column "acceptedAt" does not exist')
    );
  }

  async initialize(): Promise<void> {
    await this.reconcileDuplicateActiveRounds();
    const ownedActiveRound = await this.getOwnedActiveRound();
    if (ownedActiveRound) {
      console.log("WORKER_CLAIMED_ROUND", {
        workerId: this.workerId,
        roundId: ownedActiveRound.id,
        status: ownedActiveRound.status
      });
    } else {
      const claimedRound = await this.claimUnownedRound();
      if (claimedRound) {
        console.log("WORKER_CLAIMED_ROUND", {
          workerId: this.workerId,
          roundId: claimedRound.id,
          status: claimedRound.status
        });
      } else {
        const anyActiveRound = await this.getAnyActiveRound();
        if (anyActiveRound) {
          console.log("ERROR", {
            message: "Active round exists but owned by another worker",
            roundId: anyActiveRound.id,
            owner: anyActiveRound.processingWorker,
            workerId: this.workerId
          });
          return;
        }
        await this.createBettingRound();
      }
    }
  }

  async update(): Promise<void> {
    if (this.updateInFlight) {
      return;
    }

    this.updateInFlight = true;
    const iteration = ++this.updateIteration;
    const startedAt = Date.now();
    try {
      await this.reconcileDuplicateActiveRounds();
      await this.debugLog("H6", "roundManager.ts:update:start", "Update iteration started", {
        iteration,
        workerId: this.workerId
      });

      await this.debugLog("H6", "roundManager.ts:update:beforeSettleRecoverable", "Before settleRecoverableRounds", {
        iteration
      });
      await this.settleRecoverableRounds();
      await this.debugLog("H6", "roundManager.ts:update:afterSettleRecoverable", "After settleRecoverableRounds", {
        iteration
      });

      await this.debugLog("H6", "roundManager.ts:update:beforeGetOwnedActive", "Before getOwnedActiveRound", {
        iteration
      });
      const round = await this.getOwnedActiveRound();
      await this.debugLog("H6", "roundManager.ts:update:afterGetOwnedActive", "After getOwnedActiveRound", {
        iteration,
        hasRound: Boolean(round),
        roundStatus: round?.status ?? null,
        roundId: round?.id ?? null
      });
      if (!round) {
        const claimedRound = await this.claimUnownedRound();
        if (!claimedRound) {
          const anyActiveRound = await this.getAnyActiveRound();
          if (!anyActiveRound) {
            console.log("ERROR", {
              message: "No active round found; creating a new BETTING round",
              workerId: this.workerId
            });
            await this.createBettingRound();
          }
        }
        return;
      }

      if (round.status === "BETTING") {
        await this.debugLog("H6", "roundManager.ts:update:beforeHandleBetting", "Before handleBettingRound", {
          iteration,
          roundId: round.id
        });
        await this.handleBettingRound(round);
        await this.debugLog("H6", "roundManager.ts:update:afterHandleBetting", "After handleBettingRound", {
          iteration,
          roundId: round.id
        });
        return;
      }

      if (round.status === "LIVE") {
        await this.debugLog("H6", "roundManager.ts:update:beforeHandleLive", "Before handleLiveRound", {
          iteration,
          roundId: round.id
        });
        await this.handleLiveRound(round);
        await this.debugLog("H6", "roundManager.ts:update:afterHandleLive", "After handleLiveRound", {
          iteration,
          roundId: round.id
        });
      }
    } finally {
      this.updateInFlight = false;
      await this.debugLog("H6", "roundManager.ts:update:finally", "Update iteration finished", {
        iteration,
        elapsedMs: Date.now() - startedAt
      });
    }
  }

  private async getOwnedActiveRound(): Promise<PredictionRound | null> {
    try {
      return await prisma.predictionRound.findFirst({
        where: {
          processingWorker: this.workerId,
          status: {
            in: ["BETTING", "LIVE"]
          }
        },
        orderBy: {
          createdAt: "asc"
        }
      });
    } catch (error) {
      if (this.isMissingSettledColumnError(error)) {
        await ensurePredictionRoundSchemaColumns();
        return prisma.predictionRound.findFirst({
          where: {
            processingWorker: this.workerId,
            status: {
              in: ["BETTING", "LIVE"]
            }
          },
          orderBy: {
            createdAt: "asc"
          }
        });
      }
      const roundColumns = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'PredictionRound'"
      ).catch(() => []);
      const dbIdentity = await prisma.$queryRawUnsafe<Array<{ current_database: string; current_user: string }>>(
        "SELECT current_database(), current_user"
      ).catch(() => []);
      await this.debugLog("H3", "roundManager.ts:getOwnedActiveRound:catch", "findFirst failed", {
        workerId: this.workerId,
        errorCode: (error as { code?: string })?.code ?? null,
        errorMeta: (error as { meta?: unknown })?.meta ?? null,
        errorName: (error as { name?: string })?.name ?? "unknown",
        hasSettled: roundColumns.some((c) => c.column_name === "settled"),
        columns: roundColumns.map((c) => c.column_name),
        dbIdentity: dbIdentity[0] ?? null
      });
      throw error;
    }
  }

  private async getAnyActiveRound(): Promise<PredictionRound | null> {
    return prisma.predictionRound.findFirst({
      where: {
        status: {
          in: ["BETTING", "LIVE"]
        }
      },
      orderBy: {
        createdAt: "asc"
      }
    });
  }

  private async claimUnownedRound(): Promise<PredictionRound | null> {
    const candidate = await prisma.predictionRound.findFirst({
      where: {
        processingWorker: null,
        status: {
          in: ["BETTING", "LIVE"]
        }
      },
      orderBy: {
        createdAt: "asc"
      }
    });

    if (!candidate) {
      return null;
    }

    const claim = await prisma.predictionRound.updateMany({
      where: {
        id: candidate.id,
        processingWorker: null
      },
      data: {
        processingWorker: this.workerId
      }
    });

    if (claim.count === 0) {
      return null;
    }

    return prisma.predictionRound.findUnique({
      where: { id: candidate.id }
    });
  }

  private async reconcileDuplicateActiveRounds(): Promise<void> {
    const activeRounds = await prisma.predictionRound.findMany({
      where: {
        status: {
          in: ["BETTING", "LIVE"]
        }
      },
      orderBy: {
        createdAt: "desc"
      },
      select: {
        id: true,
        createdAt: true
      }
    });

    if (activeRounds.length <= 1) {
      return;
    }

    const [keptRound, ...duplicateRounds] = activeRounds;
    const duplicateIds = duplicateRounds.map((round) => round.id);
    const now = new Date();

    const result = await prisma.predictionRound.updateMany({
      where: {
        id: {
          in: duplicateIds
        },
        status: {
          in: ["BETTING", "LIVE"]
        }
      },
      data: {
        status: "CLOSED",
        settled: true,
        settlementStatus: "SETTLED",
        endTradeAt: now
      }
    });

    if (result.count > 0) {
      console.log("DUPLICATE_ACTIVE_ROUNDS_RECONCILED", {
        workerId: this.workerId,
        keptRoundId: keptRound.id,
        closedDuplicateCount: result.count
      });
    }
  }

  private async createBettingRound(): Promise<void> {
    const now = new Date();
    const lockAt = new Date(now.getTime() + config.bettingDurationMs);
    const endsAt = new Date(lockAt.getTime() + config.liveDurationMs);
    const latestTrade = this.chainlinkService.getLatestTrade();

    const round = await prisma.predictionRound.create({
      data: {
        asset: config.asset,
        status: "BETTING",
        bettingStartsAt: now,
        lockAt,
        endsAt,
        startPrice: latestTrade?.price ?? null,
        startTradeId: latestTrade?.tradeId ?? null,
        startTradeAt: latestTrade?.timestamp ?? null,
        processingWorker: this.workerId
      }
    });

    console.log("ROUND_CREATED", {
      roundId: round.id,
      workerId: this.workerId,
      startPrice: round.startPrice,
      bettingStartsAt: round.bettingStartsAt.toISOString(),
      lockAt: round.lockAt.toISOString(),
      endsAt: round.endsAt.toISOString()
    });

    // Seed index=0 as soon as round opens when we already have a snapshot.
    if (round.startPrice !== null) {
      await this.insertPeriodicTick(round, {
        price: round.startPrice,
        tradeId: round.startTradeId ?? `snapshot-${round.id}-0`,
        timestamp: round.startTradeAt ?? now
      });
    }
  }

  private async handleBettingRound(round: PredictionRound): Promise<void> {
    const now = new Date();
    if (now.getTime() < round.lockAt.getTime() - config.transitionToleranceMs) {
      // Ensure start snapshot exists during betting-open window.
      if (round.startPrice === null) {
        const snapshotTrade = this.chainlinkService.getLatestTrade();
        if (snapshotTrade) {
          await prisma.predictionRound.update({
            where: { id: round.id },
            data: {
              startPrice: snapshotTrade.price,
              startTradeId: snapshotTrade.tradeId,
              startTradeAt: snapshotTrade.timestamp
            }
          });
          console.log("ROUND_START_SNAPSHOTTED", {
            roundId: round.id,
            workerId: this.workerId,
            startPrice: snapshotTrade.price,
            tradeId: snapshotTrade.tradeId,
            timestamp: snapshotTrade.timestamp.toISOString()
          });

          await this.insertPeriodicTick(
            {
              ...round,
              startPrice: snapshotTrade.price,
              startTradeId: snapshotTrade.tradeId,
              startTradeAt: snapshotTrade.timestamp
            },
            snapshotTrade
          );
        } else {
          console.log("ERROR", {
            message: "Missing start price during BETTING; waiting for market snapshot",
            roundId: round.id,
            workerId: this.workerId
          });
        }
      } else {
        const trade = this.chainlinkService.consumeRecoveryTrade() ?? this.chainlinkService.getLatestTrade();
        await this.insertPeriodicTick(round, trade);
      }
      return;
    }

    const latestTrade = this.chainlinkService.getLatestTrade();
    if (!latestTrade) {
      console.error("ERROR", {
        message: "No Binance trade available to lock round",
        roundId: round.id
      });
      return;
    }

    await prisma.predictionRound.update({
      where: { id: round.id },
      data: {
        startPrice: round.startPrice ?? latestTrade.price,
        startTradeId: round.startTradeId ?? latestTrade.tradeId,
        startTradeAt: round.startTradeAt ?? latestTrade.timestamp,
        status: "LIVE"
      }
    });

    console.log("ROUND_LOCKED", {
      roundId: round.id,
      workerId: this.workerId,
      startPrice: round.startPrice ?? latestTrade.price,
      tradeId: round.startTradeId ?? latestTrade.tradeId,
      timestamp: (round.startTradeAt ?? latestTrade.timestamp).toISOString()
    });
  }

  private async handleLiveRound(round: PredictionRound): Promise<void> {
    const now = new Date();
    if (now.getTime() >= round.endsAt.getTime() - config.transitionToleranceMs) {
      await this.closeRound(round);
      return;
    }

    const trade = this.chainlinkService.consumeRecoveryTrade() ?? this.chainlinkService.getLatestTrade();
    await this.insertPeriodicTick(round, trade);
  }

  private async closeRound(round: PredictionRound): Promise<void> {
    const latestTrade = this.chainlinkService.getLatestTrade();
    const recoveryTrade = this.chainlinkService.consumeRecoveryTrade();
    await this.insertPeriodicTick(round, latestTrade ?? recoveryTrade ?? null);

    const windowStart = new Date(round.endsAt.getTime() - config.twapWindowMs);
    const ticksForTwap = await prisma.predictionTick.findMany({
      where: {
        roundId: round.id,
        timestamp: {
          gte: windowStart,
          lte: round.endsAt
        }
      }
    });

    let endPrice: number | null = null;
    if (ticksForTwap.length > 0) {
      const sum = ticksForTwap.reduce((acc, tick) => acc + tick.price, 0);
      endPrice = sum / ticksForTwap.length;
    } else if (latestTrade) {
      endPrice = latestTrade.price;
    }

    if (endPrice === null) {
      console.error("ERROR", {
        message: "Unable to settle round: no trade data available",
        roundId: round.id
      });
      return;
    }

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.predictionRound.update({
        where: { id: round.id },
        data: {
          status: "CLOSED",
          endPrice,
          endTradeId: latestTrade?.tradeId ?? null,
          endTradeAt: latestTrade?.timestamp ?? null
        }
      });

      const now = new Date();
      const lockAt = new Date(now.getTime() + config.bettingDurationMs);
      const endsAt = new Date(lockAt.getTime() + config.liveDurationMs);

      await tx.predictionRound.create({
        data: {
          asset: config.asset,
          status: "BETTING",
          bettingStartsAt: now,
          lockAt,
          endsAt,
          processingWorker: this.workerId
        }
      });
    });

    console.log("ROUND_CLOSED", {
      roundId: round.id,
      workerId: this.workerId,
      endPrice,
      twapWindowSeconds: config.twapWindowMs / 1000
    });

    await this.settleRound(round.id);
  }

  private async insertPeriodicTick(
    round: PredictionRound,
    trade: ExchangeTradeData | null
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latestTick = await prisma.predictionTick.findFirst({
        where: { roundId: round.id },
        orderBy: { index: "desc" }
      });
      const nextIndex = latestTick ? latestTick.index + 1 : 0;
      const resolvedPrice =
        trade?.price ?? latestTick?.price ?? round.startPrice ?? null;
      if (resolvedPrice === null) {
        console.log("ERROR", {
          message: "Tick insert skipped: no price available",
          roundId: round.id,
          workerId: this.workerId
        });
        return;
      }

      const resolvedTradeId =
        trade?.tradeId ??
        latestTick?.tradeId ??
        round.startTradeId ??
        `carry-${round.id}-${nextIndex}`;
      const resolvedTimestamp = trade?.timestamp ?? new Date();

      try {
        await prisma.predictionTick.create({
          data: {
            roundId: round.id,
            price: resolvedPrice,
            tradeId: resolvedTradeId,
            timestamp: resolvedTimestamp,
            index: nextIndex
          }
        });

        console.log("TICK_INSERTED", {
          roundId: round.id,
          workerId: this.workerId,
          index: nextIndex,
          price: resolvedPrice,
          tradeId: resolvedTradeId,
          timestamp: resolvedTimestamp.toISOString(),
          isRecovery: trade?.isRecovery ?? false
        });
        return;
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          continue;
        }

        console.error("ERROR", {
          message: "Failed to insert tick",
          roundId: round.id,
          tradeId: resolvedTradeId,
          error
        });
        return;
      }
    }

    console.error("ERROR", {
      message: "Failed to insert tick after retries",
      roundId: round.id,
      tradeId: trade?.tradeId ?? null
    });
  }

  private async settleRecoverableRounds(): Promise<void> {
    let recoverableRounds: Array<{ id: string }> = [];
    try {
      recoverableRounds = await prisma.predictionRound.findMany({
        where: {
          status: "CLOSED",
          settled: false,
          settlementStatus: {
            in: ["PENDING", "PROCESSING"]
          },
          processingWorker: this.workerId
        },
        orderBy: {
          createdAt: "asc"
        },
        select: {
          id: true
        },
        take: 5
      });
    } catch (error) {
      await this.debugLog("H4", "roundManager.ts:settleRecoverableRounds:catch", "findMany recoverable rounds failed", {
        workerId: this.workerId,
        errorCode: (error as { code?: string })?.code ?? null,
        errorMeta: (error as { meta?: unknown })?.meta ?? null,
        errorName: (error as { name?: string })?.name ?? "unknown"
      });
      if (this.isMissingSettledColumnError(error)) {
        console.error("ERROR", {
          message:
            "Skipping settlement recovery because PredictionRound.settled is missing; price loop continues",
          workerId: this.workerId
        });
        return;
      }
      throw error;
    }

    for (const round of recoverableRounds) {
      await this.settleRound(round.id);
    }
  }

  private async settleRound(roundId: string): Promise<void> {
    let round:
      | {
          id: string;
          status: string;
          startPrice: number | Prisma.Decimal | null;
          endPrice: number | Prisma.Decimal | null;
          lockAt: Date;
          processingWorker: string | null;
          settled: boolean;
          upPool: Prisma.Decimal | number;
          downPool: Prisma.Decimal | number;
          betCount: number;
          totalLocked: Prisma.Decimal | number;
        }
      | null = null;
    try {
      round = await prisma.predictionRound.findUnique({
        where: { id: roundId },
        select: {
          id: true,
          status: true,
          startPrice: true,
          endPrice: true,
          lockAt: true,
          processingWorker: true,
          settled: true,
          upPool: true,
          downPool: true,
          betCount: true,
          totalLocked: true
        }
      });
    } catch (error) {
      if (this.isMissingSettledColumnError(error)) {
        console.error("ERROR", {
          message:
            "Skipping round settlement because PredictionRound.settled is missing; round progression continues",
          roundId,
          workerId: this.workerId
        });
        return;
      }
      throw error;
    }

    if (!round) {
      return;
    }

    if (round.processingWorker !== this.workerId) {
      return;
    }

    if (round.status !== "CLOSED" || round.startPrice === null || round.endPrice === null) {
      return;
    }

    if (round.settled) {
      return;
    }

    const startPrice = this.toNumber(round.startPrice);
    const endPrice = this.toNumber(round.endPrice);
    const upPool = this.toNumber(round.upPool);
    const downPool = this.toNumber(round.downPool);
    const totalLocked = this.toNumber(round.totalLocked);
    const settlementTxId = randomUUID();
    const settlementStartedAtMs = Date.now();

    try {
      console.log("ROUND_SNAPSHOT", {
        roundId,
        upPool,
        downPool,
        betCount: round.betCount,
        totalLocked
      });
      await this.debugLog("H7", "roundManager.ts:settleRound:beforeTx", "Before settlement transaction", {
        roundId,
        settlementTxId
      });
      console.log("ROUND_SETTLEMENT_STARTED", {
        roundId,
        settlementTxId
      });

      let didClaim = false;
      let eligibleBetCount = 0;
      let payoutUserCount = 0;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await ensurePredictionBetSchemaColumns();
          await prisma.$transaction(async (tx) => {
            const claim = await tx.predictionRound.updateMany({
              where: {
                id: roundId,
                status: "CLOSED",
                settled: false,
                settlementStatus: "PENDING",
                processingWorker: this.workerId
              },
              data: {
                settlementStatus: "PROCESSING",
                settlementTxId
              }
            });
            await this.debugLog("H7", "roundManager.ts:settleRound:afterClaim", "After settlement claim", {
              roundId,
              settlementTxId,
              claimCount: claim.count
            });

            if (claim.count === 0) {
              return;
            }
            didClaim = true;

            const roundPoolSum = this.roundDownToTokenPrecision(upPool + downPool);
            const totalLockedRounded = this.roundDownToTokenPrecision(totalLocked);
            if (roundPoolSum !== totalLockedRounded) {
              console.error("SETTLEMENT_INTEGRITY_MISMATCH", {
                roundId,
                settlementTxId,
                check: "upPool_plus_downPool_equals_totalLocked",
                upPool,
                downPool,
                totalLocked,
                delta: this.roundDownToTokenPrecision(roundPoolSum - totalLockedRounded)
              });
              throw new Error("SETTLEMENT_INTEGRITY_MISMATCH_ROUND_POOL");
            }

            const lateBets = await tx.predictionBet.findMany({
              where: {
                roundId,
                settled: false,
                acceptedAt: {
                  gte: round.lockAt
                }
              },
              select: {
                id: true,
                amount: true,
                acceptedAt: true
              }
            });

            for (const bet of lateBets) {
              console.log("SETTLEMENT_BET_EXCLUDED_LATE", {
                roundId,
                betId: bet.id,
                acceptedAt: bet.acceptedAt.toISOString(),
                lockAt: round.lockAt.toISOString()
              });
            }

            const bets = await tx.$queryRaw<
              Array<{
                id: string;
                userId: string;
                direction: string;
                amount: Prisma.Decimal | number | string;
                acceptedAt: Date;
              }>
            >`
              SELECT "id", "userId", "direction", "amount", "acceptedAt"
              FROM "PredictionBet"
              WHERE "roundId" = ${roundId}
                AND "settled" = false
                AND "acceptedAt" < ${round.lockAt}
              FOR UPDATE
            `;
            eligibleBetCount = bets.length;
            await this.debugLog("H7", "roundManager.ts:settleRound:afterEligibleBetsQuery", "Loaded eligible bets", {
              roundId,
              settlementTxId,
              eligibleBetsCount: bets.length
            });

            const eligibleSumRaw = await tx.$queryRaw<Array<{ sum: Prisma.Decimal | null }>>`
              SELECT COALESCE(SUM("amount"), 0) AS sum
              FROM "PredictionBet"
              WHERE "roundId" = ${roundId}
                AND "settled" = false
                AND "acceptedAt" < ${round.lockAt}
            `;
            const eligibleAmountSum = this.toNumber(eligibleSumRaw[0]?.sum ?? 0);
            const eligibleAmountSumRounded = this.roundDownToTokenPrecision(eligibleAmountSum);
            const lateAmountSum = this.roundDownToTokenPrecision(
              lateBets.reduce((sum, bet) => sum + this.toNumber(bet.amount), 0)
            );
            const settledPartitionTotal = this.roundDownToTokenPrecision(
              eligibleAmountSumRounded + lateAmountSum
            );
            if (settledPartitionTotal !== totalLockedRounded) {
              console.error("SETTLEMENT_INTEGRITY_MISMATCH", {
                roundId,
                settlementTxId,
                check: "sum_unsettled_eligible_plus_late_equals_totalLocked",
                eligibleAmountSum,
                lateAmountSum,
                totalLocked,
                delta: this.roundDownToTokenPrecision(settledPartitionTotal - totalLockedRounded)
              });
              throw new Error("SETTLEMENT_INTEGRITY_MISMATCH_ELIGIBLE_SUM");
            }

            if (lateBets.length > 0) {
              await tx.predictionBet.updateMany({
                where: {
                  id: {
                    in: lateBets.map((bet) => bet.id)
                  }
                },
                data: {
                  settled: true,
                  won: false,
                  settledAt: new Date(),
                  claimable: false,
                  payoutAmount: new Prisma.Decimal(0)
                }
              });
            }

        if (bets.length === 0) {
          await tx.predictionRound.update({
            where: { id: roundId },
            data: {
              settled: true,
              settlementStatus: "SETTLED"
            }
          });
          console.log("TOTAL_POOL", {
            roundId,
            totalWinning: 0,
            totalLosing: 0
          });
          console.log("WINNERS_COUNT", {
            roundId,
            winnersCount: 0
          });
          return;
        }

            const equalPrice = endPrice === startPrice;
            const winningDirection = endPrice > startPrice ? "UP" : "DOWN";
        const normalizedBets = bets.map((bet) => ({
          ...bet,
          amountNumber: Number(bet.amount)
        }));
            const eligibleUpPool = this.roundDownToTokenPrecision(
              normalizedBets
                .filter((bet) => bet.direction === "UP")
                .reduce((sum, bet) => sum + bet.amountNumber, 0)
            );
            const eligibleDownPool = this.roundDownToTokenPrecision(
              normalizedBets
                .filter((bet) => bet.direction === "DOWN")
                .reduce((sum, bet) => sum + bet.amountNumber, 0)
            );
            const winnerPool = winningDirection === "UP" ? eligibleUpPool : eligibleDownPool;
            const loserPool = winningDirection === "UP" ? eligibleDownPool : eligibleUpPool;

            const winningBets = equalPrice
              ? []
              : normalizedBets.filter((bet) => bet.direction === winningDirection);
            const losingBets = equalPrice
              ? []
              : normalizedBets.filter((bet) => bet.direction !== winningDirection);
            const shouldRefundAll = equalPrice || winnerPool === 0;

            console.log("TOTAL_POOL", {
              roundId,
              totalWinning: winnerPool,
              totalLosing: loserPool
            });

            const payoutsByUser = new Map<string, number>();
            const payoutByBetId = new Map<string, number>();
            if (shouldRefundAll) {
              for (const bet of normalizedBets) {
                const payout = this.roundDownToTokenPrecision(bet.amountNumber);
                payoutsByUser.set(bet.userId, (payoutsByUser.get(bet.userId) ?? 0) + payout);
                payoutByBetId.set(bet.id, payout);
              }
            } else {
              for (const bet of winningBets) {
                const payoutRaw =
                  bet.amountNumber + (bet.amountNumber / winnerPool) * loserPool;
                const payout = this.roundDownToTokenPrecision(payoutRaw);
                payoutsByUser.set(bet.userId, (payoutsByUser.get(bet.userId) ?? 0) + payout);
                payoutByBetId.set(bet.id, payout);
              }
              for (const bet of losingBets) {
                payoutByBetId.set(bet.id, 0);
              }
            }

            const payoutEntries = Array.from(payoutsByUser.entries())
              .filter(([, payout]) => payout > 0)
              .sort(([a], [b]) => a.localeCompare(b));
            payoutUserCount = payoutEntries.length;

        const payoutUserIds = payoutEntries.map(([userId]) => userId);
        const usersBeforePayout = payoutUserIds.length
          ? await tx.user.findMany({
              where: {
                id: {
                  in: payoutUserIds
                }
              },
              select: {
                id: true,
                balance: true,
                miningId: true
              }
            })
          : [];
        const userById = new Map(usersBeforePayout.map((user) => [user.id, user]));

        const latestTransaction = await tx.transaction.findFirst({
          orderBy: {
            blockNumber: "desc"
          },
          select: {
            blockNumber: true
          }
        });
        let nextBlockNumber = (latestTransaction?.blockNumber ?? 0) + 1;

        const transactionType = shouldRefundAll
          ? "PREDICTION_REFUND"
          : "PREDICTION_PAYOUT";

        for (const [userId, payout] of payoutEntries) {
          if (payout <= 0) {
            continue;
          }
          const userBefore = userById.get(userId);
          if (!userBefore) {
            continue;
          }
          const roundedPayout = new Prisma.Decimal(
            payout.toFixed(config.tokenDecimals)
          );
          const updatedUser = await tx.user.update({
            where: { id: userId },
            data: {
              balance: {
                increment: roundedPayout
              }
            },
            select: {
              balance: true
            }
          });

          await tx.transaction.create({
            data: {
              id: `tx${randomUUID().replace(/-/g, "").slice(0, 24)}`,
              txHash: `pred-${settlementTxId}-${nextBlockNumber}`,
              previousTxHash: null,
              blockNumber: nextBlockNumber,
              userId,
              type: transactionType,
              amount: roundedPayout,
              signatureHash: randomUUID().replace(/-/g, ""),
              balanceBefore: userBefore.balance,
              balanceAfter: updatedUser.balance,
              mid: userBefore.miningId,
              relatedBoostId: null,
              relatedRoundId: roundId,
              relatedUserMid: null,
              metadata: {
                settlementTxId,
                roundId,
                mode: shouldRefundAll ? "REFUND" : "PAYOUT"
              }
            }
          });

          nextBlockNumber += 1;
        }

            if (shouldRefundAll) {
              await tx.$executeRaw`
                UPDATE "PredictionBet"
                SET
                  "settled" = true,
                  "won" = false,
                  "settledAt" = NOW(),
                  "claimable" = false,
                  "payoutAmount" = "amount"
                WHERE "roundId" = ${roundId}
                  AND "settled" = false
                  AND "acceptedAt" < ${round.lockAt}
              `;
              console.log("WINNERS_COUNT", {
                roundId,
                winnersCount: normalizedBets.length
              });
            } else {
              for (const bet of winningBets) {
                await tx.predictionBet.update({
                  where: { id: bet.id },
                  data: {
                    settled: true,
                    won: true,
                    settledAt: new Date(),
                    claimable: false,
                    payoutAmount: new Prisma.Decimal(
                      (payoutByBetId.get(bet.id) ?? 0).toFixed(config.tokenDecimals)
                    )
                  }
                });
              }
              if (losingBets.length > 0) {
                await tx.predictionBet.updateMany({
                  where: {
                    id: {
                      in: losingBets.map((bet) => bet.id)
                    }
                  },
                  data: {
                    settled: true,
                    won: false,
                    settledAt: new Date(),
                    claimable: false,
                    payoutAmount: new Prisma.Decimal(0)
                  }
                });
              }
              console.log("WINNERS_COUNT", {
                roundId,
                winnersCount: winningBets.length
              });
            }

            await tx.predictionRound.updateMany({
              where: {
                id: roundId,
                settlementStatus: "PROCESSING",
                settlementTxId
              },
              data: {
                settled: true,
                settlementStatus: "SETTLED"
              }
            });
          });
          break;
        } catch (error) {
          if (attempt === 0 && this.isMissingAcceptedAtError(error)) {
            await ensurePredictionBetSchemaColumns();
            continue;
          }
          throw error;
        }
      }
      await this.debugLog("H7", "roundManager.ts:settleRound:afterTx", "After settlement transaction", {
        roundId,
        settlementTxId,
        didClaim
      });

      if (!didClaim) {
        return;
      }

      console.log("ROUND_SETTLED", {
        roundId,
        settlementTxId
      });
      console.log("SETTLEMENT_METRICS", {
        roundId,
        settlement_duration_ms: Date.now() - settlementStartedAtMs,
        eligible_bet_count: eligibleBetCount,
        payout_user_count: payoutUserCount
      });
    } catch (error) {
      console.error("ERROR", {
        message: "Round settlement failed",
        roundId,
        settlementTxId,
        error
      });
    }
  }

  private toNumber(value: number | Prisma.Decimal | null): number {
    if (value === null) {
      return 0;
    }
    return value instanceof Prisma.Decimal ? value.toNumber() : Number(value);
  }

  private roundDownToTokenPrecision(value: number): number {
    const factor = 10 ** config.tokenDecimals;
    return Math.floor(value * factor) / factor;
  }
}
