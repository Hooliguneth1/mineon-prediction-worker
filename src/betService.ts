import { randomUUID } from "node:crypto";
import { PredictionBet, Prisma, PrismaClient } from "@prisma/client";
import { assertBettingOpenOrThrow, BettingLockedError, buildAcceptedBetData, NewBetInput } from "./betLock";

export class RoundNotAcceptingBetsError extends Error {
  constructor(roundId: string) {
    super(`Round ${roundId} is not accepting bets`);
  }
}

export class InsufficientAvailableBalanceError extends Error {
  constructor(userId: string) {
    super(`User ${userId} has insufficient available balance`);
  }
}

// P2034: write conflict or deadlock under Serializable isolation — safe to retry.
function isSerializationError(error: unknown): boolean {
  return (error as { code?: string })?.code === "P2034";
}

const MAX_BET_PLACEMENT_ATTEMPTS = 3;

export async function placeBetServerAuthoritative(
  prisma: PrismaClient,
  input: NewBetInput,
  nowProvider: () => Date = () => new Date()
): Promise<PredictionBet> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_BET_PLACEMENT_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
        const amount = new Prisma.Decimal(input.amount.toFixed(8));
        const round = await tx.predictionRound.findUnique({
          where: { id: input.roundId },
          select: { id: true, status: true, lockAt: true }
        });

        if (!round || round.status !== "BETTING") {
          throw new RoundNotAcceptingBetsError(input.roundId);
        }

        const now = nowProvider();
        assertBettingOpenOrThrow(round.id, round.lockAt, now);

        const userBefore = await tx.user.findUnique({
          where: { id: input.userId },
          select: {
            id: true,
            miningId: true,
            balance: true,
            availableBalance: true
          }
        });
        if (!userBefore) {
          throw new Error(`User ${input.userId} not found`);
        }

        const balanceUpdate = await tx.user.updateMany({
          where: {
            id: input.userId,
            balance: {
              gte: amount
            },
            availableBalance: {
              gte: amount
            }
          },
          data: {
            balance: {
              decrement: amount
            },
            availableBalance: {
              decrement: amount
            }
          }
        });
        if (balanceUpdate.count === 0) {
          throw new InsufficientAvailableBalanceError(input.userId);
        }

        const userAfter = await tx.user.findUnique({
          where: { id: input.userId },
          select: {
            balance: true,
            availableBalance: true
          }
        });
        if (!userAfter) {
          throw new Error(`User ${input.userId} not found after balance update`);
        }

        const bet = await tx.predictionBet.create({
          data: buildAcceptedBetData(input, now)
        });

        const poolUpdate =
          input.direction === "UP"
            ? {
                upPool: {
                  increment: amount
                }
              }
            : {
                downPool: {
                  increment: amount
                }
              };

        await tx.predictionRound.update({
          where: { id: round.id },
          data: {
            ...poolUpdate,
            totalLocked: {
              increment: amount
            },
            betCount: {
              increment: 1
            }
          }
        });

        const latestTransaction = await tx.transaction.findFirst({
          orderBy: {
            blockNumber: "desc"
          },
          select: {
            blockNumber: true
          }
        });
        const blockNumber = (latestTransaction?.blockNumber ?? 0) + 1;

        await tx.transaction.create({
          data: {
            id: `tx${randomUUID().replace(/-/g, "").slice(0, 24)}`,
            txHash: `pred-lock-${round.id}-${bet.id}-${blockNumber}`,
            previousTxHash: null,
            blockNumber,
            userId: input.userId,
            type: "PREDICTION_LOCK",
            amount,
            signatureHash: randomUUID().replace(/-/g, ""),
            balanceBefore: userBefore.balance,
            balanceAfter: userAfter.balance,
            mid: userBefore.miningId,
            relatedBoostId: null,
            relatedRoundId: round.id,
            relatedUserMid: null,
            metadata: {
              roundId: round.id,
              betId: bet.id,
              direction: input.direction,
              availableBalanceBefore: userBefore.availableBalance.toString(),
              availableBalanceAfter: userAfter.availableBalance.toString()
            }
          }
        });

        console.log("BET_ACCEPTED", {
          roundId: input.roundId,
          userId: input.userId,
          acceptedAt: bet.acceptedAt.toISOString()
        });

        return bet;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    } catch (error) {
      lastError = error;

      if (error instanceof BettingLockedError) {
        console.log("BET_REJECTED_LOCKED", {
          roundId: error.roundId,
          now: error.now.toISOString(),
          cutoffAt: error.cutoffAt.toISOString()
        });
        throw error;
      }

      if (isSerializationError(error) && attempt < MAX_BET_PLACEMENT_ATTEMPTS - 1) {
        console.log("BET_PLACEMENT_SERIALIZATION_RETRY", {
          roundId: input.roundId,
          userId: input.userId,
          attempt: attempt + 1
        });
        continue;
      }

      throw error;
    }
  }

  // Exhausted all retries on serialization conflicts — surface as a clean spend error.
  throw lastError;
}
