# Prediction Worker Workflow

This document describes how prediction rounds progress so the UI and API consumers can stay in sync with worker behaviour. All values are taken directly from `src/config.ts`, `src/roundManager.ts`, `src/betService.ts`, and `src/betLock.ts`.

---

## 1) Round lifecycle

- Round creation is **worker-driven**, not cron-driven.
- A new `BETTING` round is created:
  - on startup if no active round exists, and
  - atomically inside the same DB transaction that closes a `LIVE` round.
- Status progression: `BETTING → LIVE → CLOSED`
- Settlement is tracked separately from status:
  - `settled: boolean` (default `false`)
  - `settlementStatus: PENDING | PROCESSING | SETTLED` (default `PENDING`)

### Transition triggers

| Transition | Condition |
|---|---|
| `BETTING → LIVE` | `now >= lockAt - 300ms` (`transitionToleranceMs`) |
| `LIVE → CLOSED` | `now >= endsAt - 300ms` |

- Worker checks and applies transitions in a loop every **`1s`** (`loopIntervalMs`).
- Transitions are guarded by `updateInFlight` — only one loop iteration runs at a time.

### Duplicate round reconciliation

On every loop iteration, if more than one `BETTING`/`LIVE` round exists, the worker keeps the **most recently created** round and force-closes all older ones (`status=CLOSED`, `settled=true`, `settlementStatus=SETTLED`). Bets on force-closed rounds are **not individually settled** — this is an abnormal recovery path.

---

## 2) Timestamps and durations

When a round is created:

- `bettingStartsAt = now`
- `lockAt = now + 240s` (`bettingDurationMs`)
- `endsAt = lockAt + 60s` (`liveDurationMs`)

This is a **rolling schedule relative to now** — no fixed clock slots.

| Phase | Duration |
|---|---|
| Betting | 240s |
| Live | 60s |
| Total span | 300s |

---

## 3) Bet placement

### Acceptance window

Bets are accepted while `round.status === "BETTING"` **and** `now < lockAt - 500ms` (`bettingLockBufferMs`).

The hard API cutoff is `lockAt - 500ms`. Bets submitted after this cutoff are rejected with `BettingLockedError` before they are written to the database.

### Errors thrown at placement

| Error | Condition |
|---|---|
| `RoundNotAcceptingBetsError` | Round not found or `status !== "BETTING"` |
| `BettingLockedError` | `now >= lockAt - 500ms` |
| `InsufficientAvailableBalanceError` | `user.balance < amount` or `user.availableBalance < amount` |

### Balance model

Prediction bets use a **direct deduction** model — there is no intermediate locked state.

| Event | `balance` | `availableBalance` |
|---|---|---|
| Bet placed | `− amount` | `− amount` |
| Settlement — win | `+ payout` | `+ payout` |
| Settlement — loss | _(no change)_ | _(no change)_ |
| Settlement — refund | `+ stake` | `+ stake` |

The stake moves directly into the round pool (`upPool` / `downPool` / `totalLocked` on `PredictionRound`) at placement.

### Double-spend protection

- Transaction isolation: `Serializable` (PostgreSQL SSI).
- Balance decrement is an atomic `UPDATE WHERE balance >= amount AND availableBalance >= amount`; if it touches 0 rows the bet is rejected immediately.
- Concurrent bets from the same user that trigger a `P2034` write-conflict are automatically retried up to **3 times** before surfacing an error.

### Transaction record

A `PREDICTION_LOCK` transaction is written for every accepted bet.

---

## 4) Ticks (price snapshots)

- Ticks are written by the worker during both `BETTING` and `LIVE` phases.
- The worker attempts a tick insert on every loop iteration (~`1s`).
- A seed tick (`index=0`) is inserted immediately when the round opens if a price snapshot is already available.
- A final tick is attempted just before the round is closed.

### Price source

- Primary: Binance BTCUSDT WebSocket trade stream (`BINANCE_WS_URL`).
- Fallback on reconnect: Binance REST ticker (`BINANCE_REST_TICKER_URL`).
- If no price is available at all, the tick insert is skipped.

If the worker is paused or stopped, tick writing stops and timestamps continue aging in real time.

---

## 5) Pause / restart behaviour

| State | Effect |
|---|---|
| Worker stopped | No transitions, no ticks — DB timestamps age in real time |
| Worker restarted | Claims existing `BETTING`/`LIVE` round if present; catches up transitions immediately |
| No active round found | Creates a new `BETTING` round |
| Recoverable rounds found | Retries settlement for all `CLOSED` rounds with `settled=false` and `settlementStatus IN (PENDING, PROCESSING)` (up to 5 per loop iteration) |

---

## 6) Settlement

### Triggers

- **Primary:** immediately after `LIVE → CLOSED` transition.
- **Recovery:** each loop iteration retries unsettled `CLOSED` rounds owned by this worker.

### End price computation

`endPrice` is the **arithmetic mean** of all `PredictionTick` prices in the window `[endsAt - 10s, endsAt]` (`twapWindowMs`).

- If no ticks exist in that window, fallback is the latest available trade price.
- If no price is available at all, settlement is **deferred** until the next loop iteration.

### Reentrancy protection

Settlement uses an atomic claim: the round's `settlementStatus` is transitioned from `PENDING → PROCESSING` inside the DB transaction. If `count === 0` (another worker already claimed it), the current worker exits immediately. The entire settlement — including all balance credits and bet updates — happens inside one atomic DB transaction. If it fails, it rolls back fully and the round returns to `PENDING` for retry.

### Eligible bets

Only bets with **`acceptedAt < lockAt`** (strict) are eligible for settlement payouts. Bets placed after `lockAt` (those that somehow passed the API layer's `lockAt - 500ms` cutoff but arrived late) are treated as immediate losses with `payoutAmount = 0`.

Note: if an integrity mismatch is detected (see below), all unsettled bets — including late ones — are refunded instead.

---

## 7) Settlement outcomes

### Win

- **Condition:** `endPrice > startPrice` → direction `UP` wins; `endPrice < startPrice` → direction `DOWN` wins.
- **Payout formula:** `stake + (stake / winnerPool) × loserPool` (floored to 8 decimal places).
- The formula is zero-sum: total payout across all winners equals total eligible stakes.
- Bet fields: `settled=true`, `won=true`, `payoutAmount=<payout>`, `claimable=false`.
- User fields: `balance += payout`, `availableBalance += payout`.
- Transaction type: `PREDICTION_PAYOUT`.

### Loss

- **Condition:** bet direction does not match winning direction.
- Bet fields: `settled=true`, `won=false`, `payoutAmount=0`, `claimable=false`.
- User fields: no change (stake was already deducted at placement).
- No transaction written.

### Refund (full stake returned)

Triggered when **any** of the following is true:

| Condition | Meaning |
|---|---|
| `\|endPrice − startPrice\| < 1e-8` | Draw — prices are equal within epsilon |
| `winnerPool === 0` | All eligible bets are on one side; no loser pool exists |
| Integrity fallback | `sum(all bet amounts) ≠ totalLocked` within 1-unit tolerance |

- In a draw or zero-pool refund, only **eligible** bets (`acceptedAt < lockAt`) are refunded.
- In an integrity fallback, **all** unsettled bets (including late ones) are refunded.
- Bet fields: `settled=true`, `won=false`, `payoutAmount=<original stake>`, `claimable=false`.
- User fields: `balance += stake`, `availableBalance += stake`.
- Transaction type: `PREDICTION_REFUND`.

### Late bet (forfeited)

- **Condition:** `acceptedAt >= lockAt` and no integrity fallback triggered.
- Bet fields: `settled=true`, `won=false`, `payoutAmount=0`, `claimable=false`.
- Stake is **not** returned and is **not** redistributed to eligible winners.
- No transaction written.

### No bets placed

- Round is marked `settled=true`, `settlementStatus=SETTLED` with no balance changes.

---

## 8) Settlement integrity check

Before settling, the worker verifies:

```
|sum(eligible bet amounts) + sum(late bet amounts) − totalLocked| ≤ 10⁻⁸
```

This uses actual `PredictionBet` rows as the source of truth. If the check fails, `integrityFallbackToRefundAll` is set and all unsettled bets are refunded.

The denormalized `upPool` / `downPool` fields on `PredictionRound` are **not** used for this check — they are logged in `ROUND_SNAPSHOT` for diagnostics only and can be stale (e.g. after a schema migration).

---

## 9) Transaction types (prediction-related)

| Type | When written |
|---|---|
| `PREDICTION_LOCK` | Bet accepted — records stake deduction |
| `PREDICTION_PAYOUT` | Settlement — win payout credited |
| `PREDICTION_REFUND` | Settlement — full stake refund credited |

---

## 10) UI / API sync checklist

| Query | Meaning |
|---|---|
| `status IN [BETTING, LIVE]` | Active round |
| `status = CLOSED AND settled = true` | Fully finished and settled |
| `status = CLOSED AND settled = false` | Closed but settlement in progress |

- Lock betting UI at `lockAt - 500ms` (`bettingLockBufferMs`).
- Expect transition timing granularity of up to **~1s** (worker loop) plus **300ms** (`transitionToleranceMs`).
- `settlementStatus` transitions: `PENDING → PROCESSING → SETTLED`.
- A bet's `payoutAmount` is the definitive payout figure once `settled = true`.
- `claimable` is always `false` — payouts are credited automatically; no user claim step exists.
