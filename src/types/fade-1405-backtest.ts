import type { WinExitReason, WinMethodSummary, WinTrailParams } from "./win-backtest";

export interface Fade1405BacktestTrade {
  date: string;
  weekday: string;
  side: "call" | "put";
  signalPts: number;
  setupLabel: string;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  pnlPts: number;
  peakPts: number;
  exitReason: WinExitReason;
  win: boolean;
}

export interface Fade1405BacktestResult {
  from: string;
  to: string;
  sessions: number;
  builtAt: string;
  detail: string;
  trail: WinTrailParams;
  summary: WinMethodSummary & { tradeDays: number; wins: number; losses: number };
  fixed: WinMethodSummary;
  fixedLabel: string;
  skippedDays: number;
  successes: Fade1405BacktestTrade[];
  failures: Fade1405BacktestTrade[];
}
