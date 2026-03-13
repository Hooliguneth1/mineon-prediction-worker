import test from "node:test";
import assert from "node:assert/strict";
import {
  BettingLockedError,
  assertBettingOpenOrThrow,
  getBettingCutoffAt,
  isBetEligibleForSettlement,
  isBettingOpen
} from "./betLock";

test("accepts bet before lock buffer cutoff", () => {
  const lockAt = new Date("2026-02-27T12:00:00.000Z");
  const now = new Date("2026-02-27T11:59:59.499Z");

  assert.equal(isBettingOpen(lockAt, now), true);
  assert.doesNotThrow(() => assertBettingOpenOrThrow("round-1", lockAt, now));
});

test("rejects bet at or after lock buffer cutoff", () => {
  const lockAt = new Date("2026-02-27T12:00:00.000Z");
  const atCutoff = getBettingCutoffAt(lockAt);

  assert.equal(isBettingOpen(lockAt, atCutoff), false);
  assert.throws(
    () => assertBettingOpenOrThrow("round-1", lockAt, atCutoff),
    (error: unknown) =>
      error instanceof BettingLockedError && error.code === "BETTING_LOCKED"
  );
});

test("settlement excludes bets accepted at or after lockAt", () => {
  const lockAt = new Date("2026-02-27T12:00:00.000Z");
  const acceptedBeforeLock = new Date("2026-02-27T11:59:59.999Z");
  const acceptedAtLock = new Date("2026-02-27T12:00:00.000Z");
  const acceptedAfterLock = new Date("2026-02-27T12:00:00.001Z");

  assert.equal(isBetEligibleForSettlement(acceptedBeforeLock, lockAt), true);
  assert.equal(isBetEligibleForSettlement(acceptedAtLock, lockAt), false);
  assert.equal(isBetEligibleForSettlement(acceptedAfterLock, lockAt), false);
});
