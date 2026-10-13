export type WinTradeSide = "call" | "put";
export type WinExitReason = "stop" | "trail" | "session";

export interface WinTrailParams {
  /** Points against the entry before the trail has locked anything. */
  stopPts: number;
  /** Favorable points required before the stop starts following the best price. */
  armPts: number;
  /** How far the stop sits behind the best price once the trail is on. */
  trailPts: number;
  /** Once the trail is on, the stop never sits below this many points of profit. */
  minLockPts?: number;
  /** Close the trade when the favorable move reaches this many points. */
  maxProfitPts?: number;
}

export interface WinBacktestTrade {
  date: string;
  weekday: string;
  side: WinTradeSide;
  /** What the method saw, in Nifty points. Positive means the faded move was up. */
  signalPts: number;
  setupLabel: string;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  pnlPts: number;
  peakPts: number;
  exitReason: WinExitReason;
}

export interface WinMethodSummary {
  trades: number;
  wins: number;
  losses: number;
  winPct: number;
  totalPts: number;
  avgPts: number;
  worstPts: number;
  bestPts: number;
}

export interface WinTrailCandidate {
  params: WinTrailParams;
  summary: WinMethodSummary;
}

export interface WinBacktestMethod {
  id: string;
  label: string;
  detail: string;
  best: WinTrailParams;
  summary: WinMethodSummary;
  /** The old fixed target, measured on the entries it could still take. */
  fixedLabel: string;
  fixed: WinMethodSummary;
  candidates: WinTrailCandidate[];
  trades: WinBacktestTrade[];
}

export interface WinBacktestResult {
  from: string;
  to: string;
  sessions: number;
  builtAt: string;
  methods: WinBacktestMethod[];
}
