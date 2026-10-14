/**
 * 14:05 trend-day fade backtest — same trail as live and Win backtesting page.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Fade1405BacktestResult, Fade1405BacktestTrade } from "../src/types/fade-1405-backtest.js";
import { formatWeekdayFromDateKey } from "../src/lib/market-time.js";
import { buildWinBacktest, ensureWinBacktest } from "./win-backtest.js";
import type { WinBacktestTrade } from "../src/types/win-backtest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const META_FILE = path.join(__dirname, "..", "data", "fade-1405-backtest.meta.json");
const CACHE_VERSION = 2;

function toTrade(row: WinBacktestTrade): Fade1405BacktestTrade {
  return {
    date: row.date,
    weekday: formatWeekdayFromDateKey(row.date),
    side: row.side,
    signalPts: row.signalPts,
    setupLabel: row.setupLabel,
    entryTime: row.entryTime,
    entryPrice: row.entryPrice,
    exitTime: row.exitTime,
    exitPrice: row.exitPrice,
    pnlPts: row.pnlPts,
    peakPts: row.peakPts,
    exitReason: row.exitReason,
    win: row.pnlPts > 0,
  };
}

export function buildFade1405BacktestFromWin(): Fade1405BacktestResult | null {
  const cachePath = path.join(__dirname, "..", "data", "win-backtest.json.gz");
  if (!fs.existsSync(cachePath)) return null;
  // ensureWinBacktest builds in memory when called from API; here we only transform cached win payload if present
  return null;
}

export async function ensureFade1405Backtest(
  accessToken: string,
  refresh = false,
): Promise<{ data: Fade1405BacktestResult; cached: boolean }> {
  const meta = readMeta();
  if (!refresh && meta?.version === CACHE_VERSION && meta.payloadPath && fs.existsSync(meta.payloadPath)) {
    const data = JSON.parse(fs.readFileSync(meta.payloadPath, "utf8")) as Fade1405BacktestResult;
    return { data, cached: true };
  }

  const { data: win } = await ensureWinBacktest(accessToken, refresh);
  const method = win.methods.find((m) => m.id === "fade-1405");
  if (!method) throw new Error("fade-1405 method missing from win backtest");

  const trades = method.trades.map(toTrade);
  const wins = trades.filter((t) => t.win);
  const losses = trades.filter((t) => !t.win);

  const result: Fade1405BacktestResult = {
    from: win.from,
    to: win.to,
    sessions: win.sessions,
    builtAt: win.builtAt,
    trail: method.best,
    summary: {
      trades: method.summary.trades,
      tradeDays: method.summary.trades,
      wins: wins.length,
      losses: losses.length,
      winPct: method.summary.winPct,
      totalPts: method.summary.totalPts,
      avgPts: method.summary.avgPts,
      worstPts: method.summary.worstPts,
      bestPts: method.summary.bestPts,
    },
    fixed: method.fixed,
    fixedLabel: method.fixedLabel,
    skippedDays: win.sessions - method.summary.trades,
    successes: wins.sort((a, b) => b.date.localeCompare(a.date)),
    failures: losses.sort((a, b) => b.date.localeCompare(a.date)),
    detail:
      "At 14:05, if Nifty is 100+ points from the 9:15 open and today's range is already bigger than yesterday's, take the other side at the 14:06 open.",
  };

  fs.mkdirSync(path.dirname(META_FILE), { recursive: true });
  const payloadPath = path.join(path.dirname(META_FILE), "fade-1405-backtest.json");
  fs.writeFileSync(payloadPath, JSON.stringify(result));
  fs.writeFileSync(
    META_FILE,
    JSON.stringify({ version: CACHE_VERSION, at: Date.now(), payloadPath }),
  );
  return { data: result, cached: false };
}

function readMeta(): { version?: number; payloadPath?: string } | null {
  try {
    if (!fs.existsSync(META_FILE)) return null;
    return JSON.parse(fs.readFileSync(META_FILE, "utf8")) as { version?: number; payloadPath?: string };
  } catch {
    return null;
  }
}

/** For tests / scripts without Kite. */
export function fade1405FromWinResult(win: ReturnType<typeof buildWinBacktest>): Fade1405BacktestResult {
  const method = win.methods.find((m) => m.id === "fade-1405")!;
  const trades = method.trades.map(toTrade);
  const wins = trades.filter((t) => t.win);
  const losses = trades.filter((t) => !t.win);
  return {
    from: win.from,
    to: win.to,
    sessions: win.sessions,
    builtAt: win.builtAt,
    trail: method.best,
    summary: {
      trades: method.summary.trades,
      tradeDays: method.summary.trades,
      wins: wins.length,
      losses: losses.length,
      winPct: method.summary.winPct,
      totalPts: method.summary.totalPts,
      avgPts: method.summary.avgPts,
      worstPts: method.summary.worstPts,
      bestPts: method.summary.bestPts,
    },
    fixed: method.fixed,
    fixedLabel: method.fixedLabel,
    skippedDays: win.sessions - method.summary.trades,
    successes: wins.sort((a, b) => b.date.localeCompare(a.date)),
    failures: losses.sort((a, b) => b.date.localeCompare(a.date)),
    detail:
      "At 14:05, if Nifty is 100+ points from the 9:15 open and today's range is already bigger than yesterday's, take the other side at the 14:06 open.",
  };
}
