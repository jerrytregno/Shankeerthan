/** 14:05 trend-day fade — shared between live bot and backtest. */
import { simulateTrailExit, type TrailBar } from "./win-backtest.js";
import type { WinTrailParams } from "../src/types/win-backtest.js";

export const FADE_1405_SIGNAL_MIN = 14 * 60 + 5;
export const FADE_1405_ENTRY_MIN = 14 * 60 + 6;
export const FADE_1405_MIN_AWAY_PTS = 100;
export const FADE_1405_FLAT_MIN = 15 * 60 + 20;

export const FADE_1405_LIVE_TRAIL: WinTrailParams = {
  stopPts: 25,
  armPts: 5,
  trailPts: 4,
  minLockPts: 5,
  maxProfitPts: 10,
};

export type Fade1405Setup = {
  dir: 1 | -1;
  side: "CE" | "PE";
  signalPts: number;
  todayRange: number;
  prevRange: number;
  setupLabel: string;
};

export function fade1405Side(dir: 1 | -1): "CE" | "PE" {
  return dir === 1 ? "CE" : "PE";
}

/** Nifty at 14:05 close vs 9:15 open, and range through 14:05 vs yesterday full session. */
export function evaluateFade1405Setup(
  open915: number,
  close1405: number,
  todayRangeThrough1405: number,
  prevDayFullRange: number,
): Fade1405Setup | null {
  if (!Number.isFinite(open915) || !Number.isFinite(close1405)) return null;
  if (!Number.isFinite(todayRangeThrough1405) || !Number.isFinite(prevDayFullRange)) return null;
  if (prevDayFullRange <= 0 || todayRangeThrough1405 <= prevDayFullRange) return null;
  const move = close1405 - open915;
  if (Math.abs(move) + 1e-9 < FADE_1405_MIN_AWAY_PTS) return null;
  const dir = (move > 0 ? -1 : 1) as 1 | -1;
  const signed = Math.round(move * 10) / 10;
  return {
    dir,
    side: fade1405Side(dir),
    signalPts: signed,
    todayRange: todayRangeThrough1405,
    prevRange: prevDayFullRange,
    setupLabel: `from open ${signed > 0 ? "+" : ""}${signed.toFixed(1)}, range ${todayRangeThrough1405.toFixed(0)} > ${prevDayFullRange.toFixed(0)}`,
  };
}

export type Fade1405LiveTrail = {
  entrySpot: number;
  dir: 1 | -1;
  stopPrice: number;
  peak: number;
  trailed: boolean;
};

export function initFade1405LiveTrail(entrySpot: number, dir: 1 | -1): Fade1405LiveTrail {
  return {
    entrySpot,
    dir,
    stopPrice: entrySpot - dir * FADE_1405_LIVE_TRAIL.stopPts,
    peak: 0,
    trailed: false,
  };
}

/** Update trail on each Nifty print; returns exit spot when stop/target/cap hits. */
export function stepFade1405LiveTrail(
  state: Fade1405LiveTrail,
  spot: number,
  params: WinTrailParams = FADE_1405_LIVE_TRAIL,
): { exitSpot: number; reason: "stop" | "trail" | "cap" } | null {
  const { dir, entrySpot } = state;
  let { stopPrice, peak, trailed } = state;

  if (dir === 1 && spot <= stopPrice) {
    return { exitSpot: spot, reason: trailed ? "trail" : "stop" };
  }
  if (dir === -1 && spot >= stopPrice) {
    return { exitSpot: spot, reason: trailed ? "trail" : "stop" };
  }

  const cap = params.maxProfitPts;
  if (cap != null && cap > 0) {
    const capPrice = entrySpot + dir * cap;
    if (dir === 1 && spot + 1e-9 >= capPrice) return { exitSpot: capPrice, reason: "cap" };
    if (dir === -1 && spot <= capPrice + 1e-9) return { exitSpot: capPrice, reason: "cap" };
  }

  const favorable = dir === 1 ? spot - entrySpot : entrySpot - spot;
  if (favorable > peak) {
    peak = favorable;
    if (peak + 1e-9 >= params.armPts) {
      let lock = peak - params.trailPts;
      if (params.minLockPts != null) lock = Math.max(lock, params.minLockPts);
      lock = Math.min(lock, peak);
      const nextStop = entrySpot + dir * lock;
      const improved = dir === 1 ? nextStop > stopPrice : nextStop < stopPrice;
      if (improved) {
        stopPrice = nextStop;
        trailed = true;
      }
    }
  }

  state.stopPrice = stopPrice;
  state.peak = peak;
  state.trailed = trailed;
  return null;
}

export function backtestFade1405Trail(
  path: TrailBar[],
  dir: 1 | -1,
  entry: number,
  params: WinTrailParams = FADE_1405_LIVE_TRAIL,
) {
  return simulateTrailExit(path, dir, entry, params, FADE_1405_FLAT_MIN);
}
