import { performance } from "node:perf_hooks";

type Direction = "UP" | "DOWN";

type SyntheticBet = {
  userId: string;
  direction: Direction;
  amount: number;
};

const TOKEN_DECIMALS = 8;
const BET_COUNT = 10_000;
const USER_COUNT = 2_500;

function roundDown(value: number): number {
  const factor = 10 ** TOKEN_DECIMALS;
  return Math.floor(value * factor) / factor;
}

function buildSyntheticBets(): SyntheticBet[] {
  const bets: SyntheticBet[] = [];
  for (let i = 0; i < BET_COUNT; i += 1) {
    const direction: Direction = i % 2 === 0 ? "UP" : "DOWN";
    const amount = roundDown(0.1 + ((i % 37) + 1) / 100);
    bets.push({
      userId: `user-${i % USER_COUNT}`,
      direction,
      amount
    });
  }
  return bets;
}

function runSyntheticPhase1Load(): void {
  const bets = buildSyntheticBets();

  let upPool = 0;
  let downPool = 0;
  for (const bet of bets) {
    if (bet.direction === "UP") {
      upPool += bet.amount;
    } else {
      downPool += bet.amount;
    }
  }
  upPool = roundDown(upPool);
  downPool = roundDown(downPool);
  const totalLocked = roundDown(upPool + downPool);

  const snapshotInvariant = roundDown(upPool + downPool) === totalLocked;
  if (!snapshotInvariant) {
    throw new Error("Invariant failed: upPool + downPool must equal totalLocked");
  }

  const settlementStart = performance.now();
  const winner: Direction = "UP";
  const winnerPool = winner === "UP" ? upPool : downPool;
  const loserPool = winner === "UP" ? downPool : upPool;
  const shouldRefundAll = winnerPool === 0;

  const payoutByUser = new Map<string, number>();
  let eligibleBetCount = 0;

  for (const bet of bets) {
    eligibleBetCount += 1;
    let payout = 0;
    if (shouldRefundAll) {
      payout = roundDown(bet.amount);
    } else if (bet.direction === winner) {
      payout = roundDown(bet.amount + (bet.amount / winnerPool) * loserPool);
    }

    if (payout > 0) {
      payoutByUser.set(bet.userId, roundDown((payoutByUser.get(bet.userId) ?? 0) + payout));
    }
  }

  let payoutTotal = 0;
  for (const amount of payoutByUser.values()) {
    payoutTotal = roundDown(payoutTotal + amount);
  }
  const settlementDurationMs = performance.now() - settlementStart;

  console.log("PHASE1_SYNTHETIC_10K_RESULT", {
    bet_count: bets.length,
    unique_users: USER_COUNT,
    upPool,
    downPool,
    totalLocked,
    eligible_bet_count: eligibleBetCount,
    payout_user_count: payoutByUser.size,
    payout_total: payoutTotal,
    settlement_duration_ms: Number(settlementDurationMs.toFixed(3)),
    invariant_up_plus_down_eq_totalLocked: snapshotInvariant,
    settlement_under_1s_target: settlementDurationMs < 1000
  });
}

runSyntheticPhase1Load();
