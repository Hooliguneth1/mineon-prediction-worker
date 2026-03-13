import dotenv from "dotenv";

dotenv.config();

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  databaseUrl: getEnv("DATABASE_URL"),
  binanceWsUrl: process.env.BINANCE_WS_URL ?? "wss://stream.binance.com:9443/ws/btcusdt@trade",
  binanceRestTickerUrl:
    process.env.BINANCE_REST_TICKER_URL ??
    "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
  workerId: process.env.WORKER_ID ?? "prediction-worker-1",
  asset: "BTCUSD",
  bettingDurationMs: 4 * 60_000,
  bettingLockBufferMs: 500,
  liveDurationMs: 60_000,
  transitionToleranceMs: 300,
  loopIntervalMs: 500,
  twapWindowMs: 10_000,
  tokenDecimals: 8
};
