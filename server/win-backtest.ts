/**
 * Win backtest: the fade entries, with a 5-to-10 point trail chosen for the
 * highest win rate. One trade per method per day.
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";
import { formatWeekdayFromDateKey } from "../src/lib/market-time.js";
import type {
  WinBacktestMethod,
  WinBacktestResult,
  WinBacktestTrade,
  WinExitReason,
  WinMethodSummary,
  WinTradeSide,
  WinTrailCandidate,
  WinTrailParams,
} from "../src/types/win-backtest.js";
import { fetchHistoricalCandles } from "./kite-candles.js";
import { NIFTY_INDEX_PROFILE } from "./nine-fifteen-candles.js";
import {
  chunk,
  groupSessionBars,
  isCompleteSession,
  listWeekdayDates,
  type MinuteBar,
} from "./session-bars.js";

const LOOKBACK_CALENDAR_DAYS = 365;
const CHUNK_TRADING_DAYS = 25;
const FETCH_SPACING_MS = 450;
const DAY_MINS = 16 * 60;
const OPEN_MINS = 9 * 60 + 15;
const MARK_929 = 9 * 60 + 29;
const ENTRY_930 = 9 * 60 + 30;
const FLAT_EXIT = 15 * 60 + 20;
const CACHE_VERSION = 4;
const CACHE_MS = 12 * 60 * 60 * 1000;

const STOPS = [25, 30, 40];
const ARMS = [5, 6, 7, 8, 9, 10];
const TRAIL_DISTANCES = [1, 2, 3, 4, 5];
const MIN_LOCK_PTS = 5;
const MAX_PROFIT_PTS = 10;

export interface TrailBar {
  min: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface TrailExit {
  pnl: number;
  exitMin: number;
  exitPrice: number;
  peakPts: number;
  reason: WinExitReason;
}

interface DayBars {
  date: string;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  open915: number;
  close929: number;
  open930: number;
}

interface Setup {
  date: string;
  weekday: string;
  side: WinTradeSide;
  dir: 1 | -1;
  entryMin: number;
  entry: number;
  signalPts: number;
  setupLabel: string;
  path: TrailBar[];
  fixedTargetPts: number;
  fixedStopPts: number;
  fixedDeadline: number;
}

type MethodKind = "clock" | "morning" | "afternoon";

interface MethodDef {
  id: string;
  label: string;
  detail: string;
  kind: MethodKind;
  time?: number;
  look?: number;
  minMove?: number;
  fixedTarget?: number;
  fixedStop: number;
  fixedDeadline: number;
  fixedLabel: string;
}

const METHODS: MethodDef[] = [
  {
    id: "fade-0945",
    label: "9:45 fade",
    detail: "At 9:45, if the last 15 minutes moved 20 points or more, take the other side at the 9:46 open.",
    kind: "clock",
    time: 9 * 60 + 45,
    look: 15,
    minMove: 20,
    fixedTarget: 5,
    fixedStop: 40,
    fixedDeadline: FLAT_EXIT,
    fixedLabel: "Old rule: take 5 points, stop 40, flat at 3:20",
  },
  {
    id: "fade-1000",
    label: "10:00 fade",
    detail: "At 10:00, if the last 30 minutes moved 30 points or more, take the other side at the 10:01 open.",
    kind: "clock",
    time: 10 * 60,
    look: 30,
    minMove: 30,
    fixedTarget: 5,
    fixedStop: 40,
    fixedDeadline: FLAT_EXIT,
    fixedLabel: "Old rule: take 5 points, stop 40, flat at 3:20",
  },
  {
    id: "fade-1030",
    label: "10:30 fade",
    detail: "At 10:30, if the last 15 minutes moved 30 points or more, take the other side at the 10:31 open.",
    kind: "clock",
    time: 10 * 60 + 30,
    look: 15,
    minMove: 30,
    fixedTarget: 5,
    fixedStop: 40,
    fixedDeadline: FLAT_EXIT,
    fixedLabel: "Old rule: take 5 points, stop 40, flat at 3:20",
  },
  {
    id: "morning-extension",
    label: "Morning extension fade",
    detail:
      "If 9:15 to 9:30 moves at least 20 points, wait for another 20 points past the 9:30 price, then take the other side.",
    kind: "morning",
    fixedStop: 40,
    fixedDeadline: 10 * 60,
    fixedLabel: "Old rule: take half of that extra push back by 10:00, stop 40",
  },
  {
    id: "fade-1405",
    label: "14:05 trend-day fade",
    detail:
      "At 14:05, if Nifty is 100+ points from the 9:15 open and today's range is already bigger than yesterday's, take the other side at the 14:06 open.",
    kind: "afternoon",
    time: 14 * 60 + 5,
    minMove: 100,
    fixedTarget: 10,
    fixedStop: 25,
    fixedDeadline: FLAT_EXIT,
    fixedLabel: "Old rule: take 10 points, stop 25, flat at 3:20",
  },
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const CACHE_FILE = path.join(DATA_DIR, "win-backtest.json.gz");
const META_FILE = path.join(DATA_DIR, "win-backtest.meta.json");

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function hhmm(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

function emptyDay(): Float64Array {
  return new Float64Array(DAY_MINS).fill(Number.NaN);
}

function hasBar(day: DayBars, min: number): boolean {
  return min >= 0 && min < DAY_MINS && Number.isFinite(day.c[min]);
}

function nextBar(day: DayBars, after: number): number | null {
  for (let min = after + 1; min <= FLAT_EXIT; min += 1) {
    if (hasBar(day, min)) return min;
  }
  return null;
}

function pathFrom(day: DayBars, entryMin: number): TrailBar[] {
  const pathBars: TrailBar[] = [];
  for (let min = entryMin; min <= FLAT_EXIT; min += 1) {
    if (!hasBar(day, min)) continue;
    pathBars.push({
      min,
      open: day.o[min],
      high: day.h[min],
      low: day.l[min],
      close: day.c[min],
    });
  }
  return pathBars;
}

export function trailParamGrid(): WinTrailParams[] {
  const params: WinTrailParams[] = [];
  for (const stopPts of STOPS) {
    for (const armPts of ARMS) {
      for (const trailPts of TRAIL_DISTANCES) {
        if (trailPts >= armPts) continue;
        params.push({
          stopPts,
          armPts,
          trailPts,
          minLockPts: MIN_LOCK_PTS,
          maxProfitPts: MAX_PROFIT_PTS,
        });
      }
    }
  }
  return params;
}

function exitReason(armedStop: boolean): WinExitReason {
  return armedStop ? "trail" : "stop";
}

/**
 * Initial stop until the favorable move reaches `armPts`. After that the stop
 * follows `trailPts` behind the best price and only moves in the trade's favor.
 * A bar that hits the stop active at its open exits there; the same bar cannot
 * ratchet the stop and then take the new stop.
 */
export function simulateTrailExit(
  path: TrailBar[],
  dir: 1 | -1,
  entry: number,
  params: WinTrailParams,
  deadline: number,
): TrailExit | null {
  if (path.length === 0 || path[0].min > deadline) return null;
  let stopPrice = entry - dir * params.stopPts;
  let peak = 0;
  let trailed = false;
  let last: TrailBar | null = null;

  for (let index = 0; index < path.length; index += 1) {
    const bar = path[index];
    if (bar.min > deadline) break;
    last = bar;

    if (index > 0) {
      if (dir === 1 && bar.open <= stopPrice) {
        return finish(bar.open, bar.min, dir, entry, peak, exitReason(trailed));
      }
      if (dir === -1 && bar.open >= stopPrice) {
        return finish(bar.open, bar.min, dir, entry, peak, exitReason(trailed));
      }
    }

    const stopHit = dir === 1 ? bar.low <= stopPrice : bar.high >= stopPrice;
    if (stopHit) return finish(stopPrice, bar.min, dir, entry, peak, exitReason(trailed));

    const maxProfit = params.maxProfitPts;
    if (maxProfit != null && maxProfit > 0) {
      const capPrice = entry + dir * maxProfit;
      const gappedThrough =
        index > 0 && (dir === 1 ? bar.open >= capPrice : bar.open <= capPrice);
      const capHit = dir === 1 ? bar.high >= capPrice : bar.low <= capPrice;
      if (gappedThrough) return finish(bar.open, bar.min, dir, entry, maxProfit, "trail");
      if (capHit) return finish(capPrice, bar.min, dir, entry, maxProfit, "trail");
    }

    const favorable = dir === 1 ? bar.high - entry : entry - bar.low;
    if (favorable > peak) {
      peak = favorable;
      if (peak + 1e-9 >= params.armPts) {
        let lock = peak - params.trailPts;
        if (params.minLockPts != null) lock = Math.max(lock, params.minLockPts);
        lock = Math.min(lock, peak);
        const nextStop = entry + dir * lock;
        const improved = dir === 1 ? nextStop > stopPrice : nextStop < stopPrice;
        if (improved) {
          stopPrice = nextStop;
          trailed = true;
        }
      }
    }
  }

  if (!last) return null;
  return finish(last.close, last.min, dir, entry, peak, "session");
}

function finish(
  exitPrice: number,
  exitMin: number,
  dir: 1 | -1,
  entry: number,
  peak: number,
  reason: WinExitReason,
): TrailExit {
  return {
    pnl: round2(dir * (exitPrice - entry)),
    exitMin,
    exitPrice: round2(exitPrice),
    peakPts: round2(Math.max(0, peak)),
    reason,
  };
}

/** Fixed target. The stop is checked before the target on each bar. */
export function simulateTargetExit(
  path: TrailBar[],
  dir: 1 | -1,
  entry: number,
  targetPts: number,
  stopPts: number,
  deadline: number,
): TrailExit | null {
  if (path.length === 0 || path[0].min > deadline || !(targetPts > 0) || !(stopPts > 0)) return null;
  const target = entry + dir * targetPts;
  const stop = entry - dir * stopPts;
  let last: TrailBar | null = null;

  for (const bar of path) {
    if (bar.min > deadline) break;
    last = bar;
    if (bar !== path[0]) {
      if (dir === 1 && bar.open <= stop) return finish(bar.open, bar.min, dir, entry, 0, "stop");
      if (dir === 1 && bar.open >= target) return finish(bar.open, bar.min, dir, entry, targetPts, "session");
      if (dir === -1 && bar.open >= stop) return finish(bar.open, bar.min, dir, entry, 0, "stop");
      if (dir === -1 && bar.open <= target) return finish(bar.open, bar.min, dir, entry, targetPts, "session");
    }
    const stopHit = dir === 1 ? bar.low <= stop : bar.high >= stop;
    const targetHit = dir === 1 ? bar.high >= target : bar.low <= target;
    if (stopHit) return finish(stop, bar.min, dir, entry, 0, "stop");
    if (targetHit) return finish(target, bar.min, dir, entry, targetPts, "session");
  }

  if (!last) return null;
  const peak = dir === 1 ? last.high - entry : entry - last.low;
  return finish(last.close, last.min, dir, entry, peak, "session");
}

function summarize(pnls: number[]): WinMethodSummary {
  if (pnls.length === 0) {
    return { trades: 0, wins: 0, losses: 0, winPct: 0, totalPts: 0, avgPts: 0, worstPts: 0, bestPts: 0 };
  }
  let wins = 0;
  let total = 0;
  let worst = pnls[0];
  let best = pnls[0];
  for (const pnl of pnls) {
    total += pnl;
    if (pnl > 0) wins += 1;
    if (pnl < worst) worst = pnl;
    if (pnl > best) best = pnl;
  }
  return {
    trades: pnls.length,
    wins,
    losses: pnls.length - wins,
    winPct: round2((wins / pnls.length) * 100),
    totalPts: round2(total),
    avgPts: round2(total / pnls.length),
    worstPts: round2(worst),
    bestPts: round2(best),
  };
}

function clockSetup(day: DayBars, method: MethodDef): Setup | null {
  const time = method.time ?? 0;
  const look = method.look ?? 0;
  const prev = time - look;
  if (!hasBar(day, time) || !hasBar(day, prev)) return null;
  const change = day.c[time] - day.c[prev];
  if (Math.abs(change) < (method.minMove ?? 0)) return null;
  const entryMin = nextBar(day, time);
  if (entryMin == null) return null;
  const dir = (change > 0 ? -1 : 1) as 1 | -1;
  const signed = round2(change);
  return {
    date: day.date,
    weekday: formatWeekdayFromDateKey(day.date),
    side: dir === 1 ? "call" : "put",
    dir,
    entryMin,
    entry: day.o[entryMin],
    signalPts: signed,
    setupLabel: `${look}m move ${signed > 0 ? "+" : ""}${signed.toFixed(1)}`,
    path: pathFrom(day, entryMin),
    fixedTargetPts: method.fixedTarget ?? 5,
    fixedStopPts: method.fixedStop,
    fixedDeadline: method.fixedDeadline,
  };
}

function morningSetup(day: DayBars, method: MethodDef): Setup | null {
  if (!hasBar(day, OPEN_MINS) || !hasBar(day, MARK_929) || !hasBar(day, ENTRY_930)) return null;
  const morning = day.c[MARK_929] - day.o[OPEN_MINS];
  if (Math.abs(morning) < 20) return null;
  const morningDir = morning > 0 ? 1 : -1;
  const trigger = day.o[ENTRY_930] + morningDir * 20;
  for (let min = ENTRY_930; min <= 11 * 60; min += 1) {
    if (!hasBar(day, min)) continue;
    const touched = morningDir === 1 ? day.h[min] >= trigger : day.l[min] <= trigger;
    if (!touched) continue;
    const openedThrough = morningDir === 1 ? day.o[min] >= trigger : day.o[min] <= trigger;
    const entry = openedThrough ? day.o[min] : trigger;
    const dir = (-morningDir) as 1 | -1;
    return {
      date: day.date,
      weekday: formatWeekdayFromDateKey(day.date),
      side: dir === 1 ? "call" : "put",
      dir,
      entryMin: min,
      entry,
      signalPts: round2(morning),
      setupLabel: `morning ${morning > 0 ? "+" : ""}${round2(morning).toFixed(1)}, then ${morningDir === 1 ? "+" : "−"}20`,
      path: pathFrom(day, min),
      fixedTargetPts: Math.max(4, Math.abs(entry - day.o[ENTRY_930]) * 0.5),
      fixedStopPts: method.fixedStop,
      fixedDeadline: method.fixedDeadline,
    };
  }
  return null;
}

function dayRange(day: DayBars, untilMin: number): number | null {
  let high = -Infinity;
  let low = Infinity;
  for (let min = OPEN_MINS; min <= untilMin; min += 1) {
    if (!hasBar(day, min)) continue;
    if (day.h[min] > high) high = day.h[min];
    if (day.l[min] < low) low = day.l[min];
  }
  return Number.isFinite(high) && Number.isFinite(low) ? high - low : null;
}

function afternoonSetup(day: DayBars, prevDay: DayBars | undefined, method: MethodDef): Setup | null {
  const time = method.time ?? 0;
  if (!prevDay || !hasBar(day, OPEN_MINS) || !hasBar(day, time)) return null;
  const move = day.c[time] - day.o[OPEN_MINS];
  if (Math.abs(move) < (method.minMove ?? 0)) return null;
  const todayRange = dayRange(day, time);
  const prevRange = dayRange(prevDay, DAY_MINS - 1);
  if (todayRange == null || prevRange == null || todayRange <= prevRange) return null;
  const entryMin = nextBar(day, time);
  if (entryMin == null) return null;
  const dir = (move > 0 ? -1 : 1) as 1 | -1;
  const signed = round2(move);
  return {
    date: day.date,
    weekday: formatWeekdayFromDateKey(day.date),
    side: dir === 1 ? "call" : "put",
    dir,
    entryMin,
    entry: day.o[entryMin],
    signalPts: signed,
    setupLabel: `from open ${signed > 0 ? "+" : ""}${signed.toFixed(1)}, range ${round2(todayRange).toFixed(0)} > ${round2(prevRange).toFixed(0)}`,
    path: pathFrom(day, entryMin),
    fixedTargetPts: method.fixedTarget ?? 10,
    fixedStopPts: method.fixedStop,
    fixedDeadline: method.fixedDeadline,
  };
}

function setupsFor(method: MethodDef, days: DayBars[]): Setup[] {
  const setups: Setup[] = [];
  for (let index = 0; index < days.length; index += 1) {
    const day = days[index];
    const setup =
      method.kind === "clock"
        ? clockSetup(day, method)
        : method.kind === "morning"
          ? morningSetup(day, method)
          : afternoonSetup(day, days[index - 1], method);
    if (setup && setup.path.length > 0) setups.push(setup);
  }
  return setups;
}

function toTrade(setup: Setup, exit: TrailExit): WinBacktestTrade {
  return {
    date: setup.date,
    weekday: setup.weekday,
    side: setup.side,
    signalPts: setup.signalPts,
    setupLabel: setup.setupLabel,
    entryTime: hhmm(setup.entryMin),
    entryPrice: round2(setup.entry),
    exitTime: hhmm(exit.exitMin),
    exitPrice: exit.exitPrice,
    pnlPts: exit.pnl,
    peakPts: exit.peakPts,
    exitReason: exit.reason,
  };
}

function evaluateMethod(method: MethodDef, days: DayBars[], grid: WinTrailParams[]): WinBacktestMethod {
  const setups = setupsFor(method, days);
  const fixedPnls: number[] = [];
  for (const setup of setups) {
    if (setup.entryMin > setup.fixedDeadline) continue;
    const exit = simulateTargetExit(
      setup.path,
      setup.dir,
      setup.entry,
      setup.fixedTargetPts,
      setup.fixedStopPts,
      setup.fixedDeadline,
    );
    if (exit) fixedPnls.push(exit.pnl);
  }

  let bestParams = grid[0];
  let bestSummary = summarize([]);
  let bestTrades: WinBacktestTrade[] = [];
  const ranked: WinTrailCandidate[] = [];

  for (const params of grid) {
    const trades: WinBacktestTrade[] = [];
    const pnls: number[] = [];
    for (const setup of setups) {
      const exit = simulateTrailExit(setup.path, setup.dir, setup.entry, params, FLAT_EXIT);
      if (!exit) continue;
      trades.push(toTrade(setup, exit));
      pnls.push(exit.pnl);
    }
    const summary = summarize(pnls);
    ranked.push({ params, summary });
    const better =
      summary.winPct > bestSummary.winPct + 1e-9 ||
      (summary.winPct === bestSummary.winPct && summary.totalPts > bestSummary.totalPts + 1e-9);
    if (better || bestTrades.length === 0) {
      bestParams = params;
      bestSummary = summary;
      bestTrades = trades;
    }
  }

  ranked.sort((a, b) => b.summary.winPct - a.summary.winPct || b.summary.totalPts - a.summary.totalPts);
  bestTrades.sort((a, b) => b.date.localeCompare(a.date));

  return {
    id: method.id,
    label: method.label,
    detail: method.detail,
    best: bestParams,
    summary: bestSummary,
    fixedLabel: method.fixedLabel,
    fixed: summarize(fixedPnls),
    candidates: ranked.slice(0, 5),
    trades: bestTrades,
  };
}

export function buildWinBacktest(days: DayBars[]): WinBacktestResult {
  const grid = trailParamGrid();
  const methods = METHODS.map((method) => evaluateMethod(method, days, grid));
  return {
    from: days[0]?.date ?? "",
    to: days[days.length - 1]?.date ?? "",
    sessions: days.length,
    builtAt: new Date().toISOString(),
    methods,
  };
}

function toDay(date: string, bars: MinuteBar[]): DayBars {
  const o = emptyDay();
  const h = emptyDay();
  const l = emptyDay();
  const c = emptyDay();
  for (const bar of bars) {
    o[bar.mins] = bar.open;
    h[bar.mins] = bar.high;
    l[bar.mins] = bar.low;
    c[bar.mins] = bar.close;
  }
  return {
    date,
    o,
    h,
    l,
    c,
    open915: o[OPEN_MINS],
    close929: c[MARK_929],
    open930: o[ENTRY_930],
  };
}

async function fetchYear(accessToken: string): Promise<DayBars[]> {
  const dates = listWeekdayDates(LOOKBACK_CALENDAR_DAYS);
  const built: DayBars[] = [];
  for (const group of chunk(dates, CHUNK_TRADING_DAYS)) {
    const from = `${group[0]} 09:15:00`;
    const to = `${group[group.length - 1]} 15:30:00`;
    const { candles } = await fetchHistoricalCandles(accessToken, NIFTY_INDEX_PROFILE.spotKey, "minute", from, to);
    if (!Array.isArray(candles)) throw new Error(`Invalid candle payload for ${from}`);
    const byDate = groupSessionBars(candles);
    for (const [date, bars] of byDate) {
      if (!isCompleteSession(bars)) continue;
      built.push(toDay(date, bars));
    }
    await new Promise((resolve) => setTimeout(resolve, FETCH_SPACING_MS));
  }
  built.sort((a, b) => a.date.localeCompare(b.date));
  if (built.length === 0) throw new Error("No complete Nifty sessions in the last year");
  return built;
}

function readMeta(): { at: number; version?: number } | null {
  try {
    if (!fs.existsSync(META_FILE)) return null;
    return JSON.parse(fs.readFileSync(META_FILE, "utf8")) as { at: number; version?: number };
  } catch {
    return null;
  }
}

function readCache(): WinBacktestResult | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = zlib.gunzipSync(fs.readFileSync(CACHE_FILE));
    const parsed = JSON.parse(raw.toString("utf8")) as { data?: WinBacktestResult };
    return parsed.data ?? null;
  } catch {
    return null;
  }
}

function writeCache(result: WinBacktestResult): number {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify({ data: result })));
  fs.renameSync(tmp, CACHE_FILE);
  const at = Date.now();
  fs.writeFileSync(META_FILE, JSON.stringify({ at, version: CACHE_VERSION }));
  return at;
}

let inflight: Promise<WinBacktestResult> | null = null;

export async function ensureWinBacktest(
  accessToken: string,
  force = false,
): Promise<{ data: WinBacktestResult; cached: boolean; builtAt: number }> {
  const meta = force ? null : readMeta();
  if (meta && meta.version === CACHE_VERSION && Date.now() - meta.at < CACHE_MS) {
    const cached = readCache();
    if (cached) return { data: cached, cached: true, builtAt: meta.at };
  }

  if (!inflight) {
    inflight = fetchYear(accessToken)
      .then((days) => {
        const result = buildWinBacktest(days);
        writeCache(result);
        return result;
      })
      .finally(() => {
        inflight = null;
      });
  }

  const data = await inflight;
  return { data, cached: false, builtAt: Date.now() };
}
