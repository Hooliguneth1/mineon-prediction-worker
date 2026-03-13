export type RoundStatus = "BETTING" | "LIVE" | "CLOSED";

export interface ExchangeTradeData {
  price: number;
  tradeId: string;
  timestamp: Date;
  isRecovery?: boolean;
}
