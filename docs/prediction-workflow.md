# Prediction Worker Workflow

This document describes how prediction rounds progress so the UI can stay in sync with worker behavior.

## 1) Round lifecycle

- Round creation is **worker-driven**, not cron-driven.
- A new round is created:
  - on startup if no active round exists, and
  - immediately after a LIVE round is closed.
- Status progression is:
  - `BETTING -> LIVE -> CLOSED`
- Settlement is tracked separately from status:
  - `settled: boolean`
  - `settlementStatus: PENDING | PROCESSING | SETTLED`

### Transition triggers

- `BETTING -> LIVE` when `now >= lockAt - 300ms` (`transitionToleranceMs`).
- `LIVE -> CLOSED` when `now >= endsAt - 300ms`.
- Worker checks/transitions in a loop every `0.5s` (`loopIntervalMs`).

## 2) Timestamps and durations

When creating a round:

- `bettingStartsAt = now`
- `lockAt = now + bettingDurationMs` (`240s`)
- `endsAt = lockAt + liveDurationMs` (`60s`)

This is a **rolling schedule relative to now** (not fixed slots like `:00/:05/:10`).

Intended duration:

- Betting phase: `240s`
- Live phase: `60s`
- Total round span (`bettingStartsAt -> endsAt`): `300s`

Bet acceptance cutoff uses a small safety buffer:

- bets are rejected at `lockAt - 500ms` (`bettingLockBufferMs`)

## 3) Ticks

- Ticks are written by the worker during `BETTING` and `LIVE`.
- In practice, worker attempts tick insert roughly every loop (`~0.5s`).
- A seed tick (`index=0`) is inserted when the round opens if a snapshot is available.
- A final tick is attempted before close.

### Price source

- Source is Binance BTCUSDT market data:
  - WebSocket trade stream (`BINANCE_WS_URL`)
  - REST ticker fallback on reconnect (`BINANCE_REST_TICKER_URL`)

If worker is paused/stopped, tick writing stops.

## 4) Pause/restart behavior

- While paused/stopped:
  - rounds do not actively transition in DB (no worker loop running),
  - timestamps continue aging in real time.
- On restart:
  - worker claims existing active round (`BETTING`/`LIVE`) if present,
  - transitions catch up immediately based on current time vs `lockAt`/`endsAt`,
  - if no active round exists, a new `BETTING` round is created,
  - recoverable closed-unsettled rounds are retried for settlement.

## 5) Settlement

- Settlement is triggered by worker logic, not external cron.
- Primary trigger:
  - after `LIVE -> CLOSED`, worker calls settlement for that round.
- Recovery trigger:
  - each loop retries `CLOSED` rounds with `settled=false` and `settlementStatus in (PENDING, PROCESSING)`.

### Settlement and ticks

- `endPrice` is computed from TWAP over the last `10s` window (`twapWindowMs`) using `PredictionTick`s.
- If no ticks in that window, fallback is latest trade price.
- If no price is available, settlement is deferred.

### Settlement completion

- Round remains `CLOSED`; settlement marks:
  - `settled=true`
  - `settlementStatus=SETTLED`
- UI should treat "fully finished" as `status=CLOSED && settled=true`.

## UI sync checklist

- Active round: `status in [BETTING, LIVE]`
- Lock betting slightly before lock (`~500ms` buffer)
- Expect transition timing granularity around worker loop (`~0.5s`) plus tolerance (`300ms`)
- Finished/settled round: `status=CLOSED && settled=true`
