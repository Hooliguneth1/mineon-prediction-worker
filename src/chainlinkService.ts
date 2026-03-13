import WebSocket from "ws";
import { config } from "./config";
import { ExchangeTradeData } from "./types";

interface BinanceTradeMessage {
  t: number;
  p: string;
  T: number;
}

export class ChainlinkService {
  private socket: WebSocket | null = null;
  private latestTrade: ExchangeTradeData | null = null;
  private pendingRecoveryTrade: ExchangeTradeData | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = 1000;
  private isConnecting = false;

  constructor() {
    this.connect();
  }

  getLatestTrade(): ExchangeTradeData | null {
    return this.latestTrade;
  }

  consumeRecoveryTrade(): ExchangeTradeData | null {
    const trade = this.pendingRecoveryTrade;
    this.pendingRecoveryTrade = null;
    return trade;
  }

  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private connect(): void {
    if (this.isConnecting) {
      return;
    }
    this.isConnecting = true;

    this.socket = new WebSocket(config.binanceWsUrl);

    this.socket.on("open", async () => {
      this.isConnecting = false;
      this.reconnectDelayMs = 1000;
      console.log("BINANCE_WS_CONNECTED", { url: config.binanceWsUrl });
      await this.fetchRecoveryTicker();
    });

    this.socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as BinanceTradeMessage;
        if (typeof message?.t !== "number" || typeof message?.p !== "string") {
          return;
        }

        const trade: ExchangeTradeData = {
          tradeId: String(message.t),
          price: Number(message.p),
          timestamp: new Date(message.T)
        };
        this.latestTrade = trade;
      } catch (error) {
        console.error("ERROR", {
          message: "Failed to parse Binance websocket message",
          error
        });
      }
    });

    this.socket.on("close", () => {
      this.isConnecting = false;
      console.error("ERROR", {
        message: "Binance websocket closed; scheduling reconnect"
      });
      this.scheduleReconnect();
    });

    this.socket.on("error", (error) => {
      this.isConnecting = false;
      console.error("ERROR", {
        message: "Binance websocket error",
        error
      });
      this.socket?.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 15000);
    }, this.reconnectDelayMs);
  }

  private async fetchRecoveryTicker(): Promise<void> {
    try {
      const response = await fetch(config.binanceRestTickerUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const json = (await response.json()) as { price?: string };
      if (!json?.price) {
        throw new Error("Ticker payload missing price");
      }

      const recoveryTrade: ExchangeTradeData = {
        tradeId: `recovery-${Date.now()}`,
        price: Number(json.price),
        timestamp: new Date(),
        isRecovery: true
      };

      this.latestTrade = recoveryTrade;
      this.pendingRecoveryTrade = recoveryTrade;
      console.log("BINANCE_WS_RECOVERY_TICK_READY", {
        tradeId: recoveryTrade.tradeId,
        price: recoveryTrade.price
      });
    } catch (error) {
      console.error("ERROR", {
        message: "Failed to fetch Binance REST ticker during reconnect recovery",
        error
      });
    }
  }
}
