import { config } from "./config";

export class BettingLockedError extends Error {
  readonly code = "BETTING_LOCKED";
  readonly cutoffAt: Date;
  readonly lockAt: Date;
  readonly now: Date;
  readonly roundId: string;

  constructor(roundId: string, now: Date, cutoffAt: Date, lockAt: Date) {
    super("BETTING_LOCKED");
    this.roundId = roundId;
    this.now = now;
    this.cutoffAt = cutoffAt;
    this.lockAt = lockAt;
  }
}

export interface NewBetInput {
  userId: string;
  roundId: string;
  direction: "UP" | "DOWN";
  amount: number;
}

export function getBettingCutoffAt(lockAt: Date): Date {
  return new Date(lockAt.getTime() - config.bettingLockBufferMs);
}

export function isBettingOpen(lockAt: Date, now = new Date()): boolean {
  return now.getTime() < getBettingCutoffAt(lockAt).getTime();
}

export function isBetEligibleForSettlement(acceptedAt: Date, lockAt: Date): boolean {
  return acceptedAt.getTime() < lockAt.getTime();
}

export function assertBettingOpenOrThrow(roundId: string, lockAt: Date, now = new Date()): void {
  const cutoffAt = getBettingCutoffAt(lockAt);
  if (now.getTime() >= cutoffAt.getTime()) {
    throw new BettingLockedError(roundId, now, cutoffAt, lockAt);
  }
}

export function buildAcceptedBetData(input: NewBetInput, now = new Date()) {
  return {
    userId: input.userId,
    roundId: input.roundId,
    direction: input.direction,
    amount: input.amount,
    acceptedAt: now
  };
}
