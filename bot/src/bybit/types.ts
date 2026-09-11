export type Side = 'Buy' | 'Sell';

export interface Candle {
  /** Candle open time in ms. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** False while the candle is still forming — strategies only act on closed bars. */
  closed: boolean;
}

export interface Instrument {
  symbol: string;
  tickSize: string;
  qtyStep: string;
  minOrderQty: string;
  maxOrderQty: string;
  /** Bybit's minimum order value in USDT (5 for most linear perps). */
  minNotionalValue: number;
  maxLeverage: number;
}

export interface Ticker {
  symbol: string;
  lastPrice: number;
  bid: number;
  ask: number;
  /** (ask - bid) / mid, as a percentage. */
  spreadPct: number;
}

export interface WalletBalance {
  /** Total equity in USD including unrealised P&L. */
  equity: number;
  /** Funds not currently used as margin. */
  available: number;
}

export interface Position {
  symbol: string;
  side: Side;
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealisedPnl: number;
  leverage: number;
  stopLoss: number | null;
  takeProfit: number | null;
  createdTime: number;
}

export interface ClosedPnl {
  symbol: string;
  side: Side;
  closedPnl: number;
  updatedTime: number;
  orderId: string;
}

export interface OrderRequest {
  symbol: string;
  side: Side;
  qty: string;
  /** Attached server-side so the stop survives the bot process dying. */
  stopLoss?: string;
  takeProfit?: string;
  reduceOnly?: boolean;
  orderLinkId?: string;
}

export interface OrderResult {
  orderId: string;
  orderLinkId: string;
}

export interface ApiKeyInfo {
  note: string;
  /** Bybit's master switch: when true, every order is rejected regardless of scopes. */
  readOnly: boolean;
  unifiedAccount: boolean;
  expiresAt: string | null;
  ipRestriction: string;
  contractScopes: string[];
  canTrade: boolean;
}
