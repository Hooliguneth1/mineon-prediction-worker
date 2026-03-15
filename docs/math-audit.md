# Prediction Worker — Mathematical Audit

> **Audited:** `src/betService.ts`, `src/roundManager.ts`, `src/betLock.ts`, `src/config.ts`, `prisma/schema.prisma`
> **Date:** 2026-03-15

---

## Balance Model (confirmed design)

Stakes flow directly between user balances and the round pool. There is no intermediate "locked" state.

| Event | `balance` | `availableBalance` | `upPool` / `downPool` | `totalLocked` |
|---|---|---|---|---|
| Bet placed (UP, 100) | −100 | −100 | `upPool` +100 | +100 |
| Settlement — win (payout 150) | +150 | +150 | — | — |
| Settlement — loss | _(no change)_ | _(no change)_ | — | — |
| Settlement — refund (100) | +100 | +100 | — | — |

`balance` and `availableBalance` move in lockstep for prediction bets. The round pool (`upPool + downPool = totalLocked`) holds the aggregate stake until settlement.

---

## Findings

### CRITICAL — Float `===` equality used for draw detection

**File:** `src/roundManager.ts:895`

```typescript
const equalPrice = endPrice === startPrice;
```

`startPrice` is set from a raw trade price (float). `endPrice` is computed as a TWAP:

```typescript
const sum = ticksForTwap.reduce((acc, tick) => acc + tick.price, 0);
endPrice  = sum / ticksForTwap.length;
```

IEEE 754 double-precision arithmetic means that `sum / N` can produce a value that differs from `startPrice` by a noise-level floating-point error even when the true prices are identical. A genuine draw — which should trigger a full refund — will silently pick a winner direction instead.

**Fix:**
```typescript
const PRICE_EPSILON = 1e-8;
const equalPrice = Math.abs(endPrice - startPrice) < PRICE_EPSILON;
```

---

### HIGH — Double-floor on partition integrity check can trigger a false refund-all

**File:** `src/roundManager.ts:811–828`

The code independently floors the eligible sum and the late-bet sum before adding them:

```typescript
const eligibleAmountSumRounded = this.roundDownToTokenPrecision(eligibleAmountSum);
const lateAmountSum            = this.roundDownToTokenPrecision(lateBets.reduce(...));
const settledPartitionTotal    = this.roundDownToTokenPrecision(
  eligibleAmountSumRounded + lateAmountSum   // ← both already floored
);
if (settledPartitionTotal !== totalLockedRounded) {
  integrityFallbackToRefundAll = true;
}
```

`floor(A) + floor(B)` can be one precision unit less than `floor(A + B)`. This means a perfectly valid round can fail this check and incorrectly trigger a full refund, returning money to losers and shorting the system.

**Concrete example:**
```
eligible sum = 0.000000009  →  floor = 0.00000000
late sum     = 0.000000009  →  floor = 0.00000000
partition    = 0.00000000

totalLocked  = 0.000000018  →  floor = 0.00000001

0.00000000 ≠ 0.00000001  →  false integrity trigger  →  incorrect refund-all
```

**Fix:** Compare raw (unrounded) sums with a tolerance rather than independently flooring each side:

```typescript
const rawPartitionTotal = eligibleAmountSum + lateBets.reduce(
  (s, b) => s + this.toNumber(b.amount), 0
);
const tolerance = 1 / (10 ** config.tokenDecimals); // one token-precision unit
if (Math.abs(rawPartitionTotal - totalLocked) > tolerance) {
  integrityFallbackToRefundAll = true;
}
```

---

### MEDIUM — Divisor (`winnerPool`) is floored before it is used in division

**File:** `src/roundManager.ts:918–929`

```typescript
const eligibleUpPool = this.roundDownToTokenPrecision(   // ← floored
  normalizedBets.filter(b => b.direction === "UP")
    .reduce((sum, b) => sum + b.amountNumber, 0)
);
// ...
const winnerPool = winningDirection === "UP" ? eligibleUpPool : eligibleDownPool;
// ...
const payoutRaw = bet.amountNumber + (bet.amountNumber / winnerPool) * loserPool;
```

Flooring the divisor before division makes it slightly smaller than the true sum, which makes each individual payout fractionally larger than it should be. The subsequent floor on `payoutRaw` absorbs most of the error, but the intent is obscured and the double-rounding is hard to reason about.

**Fix:** Keep full-precision sums for the divisor; only round the final per-bet payout:

```typescript
const winnerPoolRaw = normalizedBets
  .filter(b => b.direction === winningDirection)
  .reduce((sum, b) => sum + b.amountNumber, 0);
const loserPoolRaw = normalizedBets
  .filter(b => b.direction !== winningDirection)
  .reduce((sum, b) => sum + b.amountNumber, 0);

// in payout loop:
const payoutRaw = bet.amountNumber + (bet.amountNumber / winnerPoolRaw) * loserPoolRaw;
const payout    = this.roundDownToTokenPrecision(payoutRaw);
```

---

### MEDIUM — Floor rounding creates untracked dust

**File:** `src/roundManager.ts:957`, `src/roundManager.ts:1195`

Every payout is floored:

```typescript
private roundDownToTokenPrecision(value: number): number {
  const factor = 10 ** config.tokenDecimals;
  return Math.floor(value * factor) / factor;
}
```

Mathematically, total eligible stakes equal total winner payouts (algebraically zero-sum). After flooring each payout, the sum is slightly less:

```
Σ actual_payout_i ≤ winnerPool + loserPool
dust = (winnerPool + loserPool) − Σ actual_payout_i
     ≤ N_winners × 10⁻⁸
```

This dust is never redistributed, never burned, and never tracked. For a round with 1,000 winners the maximum dust is `0.00001` tokens — small but silently retained by the system with no accounting entry.

**Recommendation:** If dust needs to be accounted for, sweep it to a platform fee transaction after settlement. If it is intentional house edge, document it explicitly.

---

### MEDIUM — `toNumber()` loses precision for large token amounts

**File:** `src/roundManager.ts:1188–1193`

```typescript
private toNumber(value: number | Prisma.Decimal | null): number {
  if (value === null) { return 0; }
  return value instanceof Prisma.Decimal ? value.toNumber() : Number(value);
}
```

`Prisma.Decimal` uses `decimal.js` with high internal precision. `.toNumber()` converts to IEEE 754 double (~15–17 significant digits). For `DECIMAL(18,8)` values above ~10⁹ tokens, the 8th decimal place starts to lose precision.

**Fix:** Keep amounts as `Prisma.Decimal` through all payout arithmetic and only convert to string/Decimal for DB writes. Alternatively, work in integer token-units (multiply by `10^tokenDecimals`, use integer arithmetic, then divide at the final output step).

---

### LOW — `lockedBalance` is decremented at settlement but was never incremented (vestigial dead code)

**File:** `src/roundManager.ts:1055–1067`

```typescript
for (const [userId, settledStake] of settledStakeByUser.entries()) {
  await tx.$executeRaw`
    UPDATE "User"
    SET "lockedBalance" = GREATEST("lockedBalance" - ${settledStake}, 0)
    WHERE "id" = ${userId}
  `;
}
```

Under the current balance model, `lockedBalance` is **never written at bet placement**, so this block always decrements from whatever value `lockedBalance` holds for unrelated reasons, clamped to 0. It has no financial effect due to the `GREATEST` clamp, but it is dead code from the old balance model and should be removed to avoid confusion.

**Fix:** Delete the entire `settledStakeByUser` map and the loop that decrements `lockedBalance`. Also remove the reads of `lockedBalance` in `betService.ts` (`userBefore.lockedBalance`, `userAfter.lockedBalance`) that are only used in the `PREDICTION_LOCK` transaction metadata.

---

### LOW — Late-bet stakes are forfeited to the house, not documented

**File:** `src/roundManager.ts:838–853`

Bets accepted within the final 500 ms before `lockAt` (i.e., those that pass the API cutoff but arrive with `acceptedAt >= lockAt`) are settled as an immediate loss with `payoutAmount = 0`. The stake was already deducted from the user's balance at placement and is **not redistributed to eligible winners**, **not refunded**, and **not surfaced as a separate transaction**. It silently becomes system revenue.

This may be intentional (edge-case penalty for racing the lock), but it is not documented anywhere and there is no admin-visible ledger entry for it.

**Recommendation:** Either refund late bets unconditionally, or add an explicit `PREDICTION_LATE_BET_FORFEITED` transaction type so the amounts are traceable.

---

### LOW — Docs state loop interval is 2 s; code uses 1 s

**File:** `docs/prediction-workflow.md:21` vs `src/config.ts:25`

```
# docs say:
Worker checks/transitions in a loop every `2s` (`loopIntervalMs`).

# code:
loopIntervalMs: 1_000,
```

**Fix:** Update `docs/prediction-workflow.md` line 21 and line 46 to say `~1s`.

---

## Payout Formula — Correctness Proof

For a normal (non-refund) settlement with winning bets `w₁, w₂, … wₙ`:

```
winnerPool = Σ wᵢ
loserPool  = L

payoutRaw_i = wᵢ + (wᵢ / winnerPool) × L

Σ payoutRaw_i = Σwᵢ + (L / winnerPool) × Σwᵢ
              = winnerPool + (L / winnerPool) × winnerPool
              = winnerPool + L
              = total eligible stakes          ✓  (algebraically zero-sum)
```

The formula is **mathematically correct**. All eligible stakes are fully redistributed to winners. The only leak is the floor-rounding dust described above.

---

## Summary Table

| # | Severity | File | Issue |
|---|---|---|---|
| 1 | **Critical** | `roundManager.ts:895` | Float `===` for draw detection — true draws may not be caught |
| 2 | **High** | `roundManager.ts:811–828` | Double-floor on partition check — can trigger false refund-all on valid rounds |
| 3 | Medium | `roundManager.ts:918–929` | Divisor floored before division — double-rounding, obscures intent |
| 4 | Medium | `roundManager.ts:957` | Floor-rounding dust retained by system with no accounting entry |
| 5 | Medium | `roundManager.ts:1188` | `toNumber()` loses precision for amounts > ~10⁹ tokens |
| 6 | Low | `roundManager.ts:1055–1067` | `lockedBalance` decremented but never incremented — vestigial dead code |
| 7 | Low | `roundManager.ts:838–853` | Late-bet stakes silently forfeited to house with no ledger entry |
| 8 | Low | `docs/prediction-workflow.md:21` | Loop interval documented as 2 s, actual value is 1 s |
