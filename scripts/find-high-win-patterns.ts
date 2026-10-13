/**
 * Search one year of Nifty minute bars for repeatable patterns.
 * A pattern is kept only when it wins at least 90% of trades, makes money,
 * and both halves of the year agree.
 *
 * Run: npx tsx scripts/find-high-win-patterns.ts
 */
import "../server/load-env.js";
import { fetchHistoricalCandles } from "../server/kite-candles.js";
import { loadKiteSession } from "../server/kite-session-store.js";
import {
  chunk,
  groupSessionBars,
  isCompleteSession,
  listWeekdayDates,
  type MinuteBar,
} from "../server/session-bars.js";

const SPOT = "NSE:NIFTY 50";
const LOOKBACK_CALENDAR_DAYS = 365;
const CHUNK_TRADING_DAYS = 25;
const FETCH_SPACING_MS = 500;
const DAY_MINS = 16 * 60;
const OPEN_MINS = 9 * 60 + 15;
const MARK_929 = 9 * 60 + 29;
const ENTRY_930 = 9 * 60 + 30;
const FLAT_EXIT = 15 * 60 + 20;

type Side = "follow" | "fade";

interface Day {
  date: string;
  half: 1 | 2;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  open915: number;
  close929: number;
  open930: number;
  prevClose: number | null;
  lastClose: number;
}

interface Agg {
  family: string;
  name: string;
  n: number;
  wins: number;
  pnl: number;
  worst: number;
  lossStreak: number;
  maxLossStreak: number;
  h1n: number;
  h1w: number;
  h1pnl: number;
  h2n: number;
  h2w: number;
  h2pnl: number;
}

interface Trade {
  date: string;
  pnl: number;
  entryMin: number;
}

type Rule = {
  family: string;
  name: string;
  run: (day: Day) => { pnl: number; entryMin: number } | null;
};

function arrays(): Float64Array {
  return new Float64Array(DAY_MINS).fill(Number.NaN);
}

function hasBar(day: Day, min: number): boolean {
  return min >= 0 && min < DAY_MINS && Number.isFinite(day.c[min]);
}

function nextBar(day: Day, after: number): number | null {
  for (let m = after + 1; m <= FLAT_EXIT; m += 1) {
    if (hasBar(day, m)) return m;
  }
  return null;
}

function lastCloseAt(day: Day, deadline: number): { min: number; close: number } | null {
  for (let m = deadline; m >= OPEN_MINS; m -= 1) {
    if (hasBar(day, m)) return { min: m, close: day.c[m] };
  }
  return null;
}

/**
 * dir +1 buys, -1 sells. Stop is checked before target. A gap through the stop
 * is filled at the open, so the loss can be larger than the stop.
 * entryBarWicks false: the entry minute is judged on its close only.
 */
function bracket(
  day: Day,
  entryMin: number,
  dir: 1 | -1,
  entry: number,
  targetPts: number,
  stopPts: number,
  deadline: number,
  entryBarWicks: boolean,
): number | null {
  if (!hasBar(day, entryMin) || !(targetPts > 0) || !(stopPts > 0)) return null;
  const target = entry + dir * targetPts;
  const stop = entry - dir * stopPts;
  let seen = false;
  for (let m = entryMin; m <= deadline; m += 1) {
    if (!hasBar(day, m)) continue;
    const o = day.o[m];
    const h = day.h[m];
    const l = day.l[m];
    const c = day.c[m];
    const wick = seen || entryBarWicks;
    seen = true;
    if (!wick) {
      if (dir === 1) {
        if (c <= stop) return -stopPts;
        if (c >= target) return targetPts;
      } else if (c >= stop) return -stopPts;
      else if (c <= target) return targetPts;
      continue;
    }
    if (dir === 1) {
      if (o <= stop) return o - entry;
      if (o >= target) return o - entry;
      if (l <= stop) return -stopPts;
      if (h >= target) return targetPts;
    } else {
      if (o >= stop) return entry - o;
      if (o <= target) return entry - o;
      if (h >= stop) return -stopPts;
      if (l <= target) return targetPts;
    }
  }
  const end = lastCloseAt(day, deadline);
  if (!end) return null;
  return dir * (end.close - entry);
}

function clockRules(): Rule[] {
  const rules: Rule[] = [];
  const times = [9 * 60 + 45, 10 * 60, 10 * 60 + 30, 11 * 60, 12 * 60, 13 * 60 + 30, 14 * 60, 14 * 60 + 30];
  const lookbacks = [5, 15, 30];
  const moves = [10, 20, 30];
  const targets = [5, 8, 12, 15, 20];
  const stops = [8, 12, 15, 25, 40];
  const holds = [30, 200];
  for (const time of times) {
    for (const look of lookbacks) {
      for (const move of moves) {
        for (const side of ["follow", "fade"] as Side[]) {
          for (const target of targets) {
            for (const stop of stops) {
              for (const hold of holds) {
                const deadline = Math.min(FLAT_EXIT, time + hold);
                const holdLabel = hold >= 200 ? "15:20" : `${hold}m`;
                rules.push({
                  family: "clock",
                  name: `${hhmm(time)} ${side} ${look}m move ≥${move} · +${target}/−${stop} · ${holdLabel}`,
                  run: (day) => {
                    const prev = time - look;
                    if (!hasBar(day, time) || !hasBar(day, prev)) return null;
                    const change = day.c[time] - day.c[prev];
                    if (Math.abs(change) < move) return null;
                    const dir = ((change > 0 ? 1 : -1) * (side === "follow" ? 1 : -1)) as 1 | -1;
                    const entryMin = nextBar(day, time);
                    if (entryMin == null) return null;
                    const pnl = bracket(day, entryMin, dir, day.o[entryMin], target, stop, deadline, true);
                    return pnl == null ? null : { pnl, entryMin };
                  },
                });
              }
            }
          }
        }
      }
    }
  }
  return rules;
}

function streakRules(): Rule[] {
  const rules: Rule[] = [];
  const lengths = [3, 4, 5];
  const mins = [12, 20, 30];
  const targets = [8, 12, 15, 20];
  const stops = [8, 12, 15, 25, 40];
  const holds = [20, 45];
  for (const length of lengths) {
    for (const minPts of mins) {
      for (const side of ["follow", "fade"] as Side[]) {
        for (const target of targets) {
          for (const stop of stops) {
            for (const hold of holds) {
              rules.push({
                family: "streak",
                name: `${length} candles ${side} body ≥${minPts} · +${target}/−${stop} · ${hold}m`,
                run: (day) => {
                  let run = 0;
                  let runDir: 1 | -1 | 0 = 0;
                  let runPts = 0;
                  for (let m = OPEN_MINS; m <= 14 * 60; m += 1) {
                    if (!hasBar(day, m)) {
                      run = 0;
                      runDir = 0;
                      runPts = 0;
                      continue;
                    }
                    const body = day.c[m] - day.o[m];
                    const dir = body > 0 ? 1 : body < 0 ? -1 : 0;
                    if (dir === 0 || dir !== runDir) {
                      run = dir === 0 ? 0 : 1;
                      runDir = dir as 1 | -1 | 0;
                      runPts = Math.abs(body);
                    } else {
                      run += 1;
                      runPts += Math.abs(body);
                    }
                    if (m < 9 * 60 + 20 || run < length || runPts < minPts || runDir === 0) continue;
                    const entryMin = nextBar(day, m);
                    if (entryMin == null) return null;
                    const tradeDir = (runDir * (side === "follow" ? 1 : -1)) as 1 | -1;
                    const pnl = bracket(day, entryMin, tradeDir, day.o[entryMin], target, stop, Math.min(FLAT_EXIT, entryMin + hold), true);
                    return pnl == null ? null : { pnl, entryMin };
                  }
                  return null;
                },
              });
            }
          }
        }
      }
    }
  }
  return rules;
}

function gapRules(): Rule[] {
  const rules: Rule[] = [];
  const gaps = [20, 35, 50, 75];
  const fills = [0.5, 1];
  const stops = [20, 35, 50];
  const deadlines = [10 * 60 + 30, 12 * 60, FLAT_EXIT];
  for (const gap of gaps) {
    for (const fill of fills) {
      for (const stop of stops) {
        for (const deadline of deadlines) {
          rules.push({
            family: "gap-fade",
            name: `fade gap ≥${gap} to ${fill === 1 ? "full" : "half"} fill · stop ${stop} · ${hhmm(deadline)}`,
            run: (day) => {
              if (day.prevClose == null) return null;
              const gapPts = day.open915 - day.prevClose;
              if (Math.abs(gapPts) < gap) return null;
              const dir = (gapPts > 0 ? -1 : 1) as 1 | -1;
              const targetPts = Math.abs(gapPts) * fill;
              const pnl = bracket(day, OPEN_MINS, dir, day.open915, targetPts, stop, deadline, true);
              return pnl == null ? null : { pnl, entryMin: OPEN_MINS };
            },
          });
        }
      }
    }
  }
  return rules;
}

function rangeOf(day: Day, from: number, to: number): { high: number; low: number } | null {
  let high = -Infinity;
  let low = Infinity;
  for (let m = from; m <= to; m += 1) {
    if (!hasBar(day, m)) continue;
    if (day.h[m] > high) high = day.h[m];
    if (day.l[m] < low) low = day.l[m];
  }
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) return null;
  return { high, low };
}

function orRules(): Rule[] {
  const rules: Rule[] = [];
  const windows = [5, 15, 30];
  const targets = [10, 15, 20, 30];
  const stops = [10, 15, 20, 30, 40];
  const deadlines = [11 * 60, FLAT_EXIT];
  for (const window of windows) {
    const end = OPEN_MINS + window - 1;
    for (const target of targets) {
      for (const stop of stops) {
        for (const deadline of deadlines) {
          rules.push({
            family: "opening-range-break",
            name: `first ${window}m break follow · +${target}/−${stop} · ${hhmm(deadline)}`,
            run: (day) => {
              const range = rangeOf(day, OPEN_MINS, end);
              if (!range) return null;
              for (let m = end + 1; m <= deadline; m += 1) {
                if (!hasBar(day, m)) continue;
                const up = day.h[m] >= range.high;
                const down = day.l[m] <= range.low;
                if (!up && !down) continue;
                if (up && down) return null;
                const dir = (up ? 1 : -1) as 1 | -1;
                const level = up ? range.high : range.low;
                const openedThrough = up ? day.o[m] >= level : day.o[m] <= level;
                const entry = openedThrough ? day.o[m] : level;
                const pnl = bracket(day, m, dir, entry, target, stop, deadline, false);
                return pnl == null ? null : { pnl, entryMin: m };
              }
              return null;
            },
          });
          rules.push({
            family: "failed-break",
            name: `first ${window}m break fails back inside · +${target}/−${stop} · ${hhmm(deadline)}`,
            run: (day) => {
              const range = rangeOf(day, OPEN_MINS, end);
              if (!range) return null;
              let broke: 1 | -1 | 0 = 0;
              for (let m = end + 1; m <= 14 * 60; m += 1) {
                if (!hasBar(day, m)) continue;
                if (broke === 0) {
                  const up = day.h[m] >= range.high;
                  const down = day.l[m] <= range.low;
                  if (up && down) return null;
                  if (up) broke = 1;
                  else if (down) broke = -1;
                  continue;
                }
                const back = broke === 1 ? day.c[m] < range.high : day.c[m] > range.low;
                if (!back) continue;
                const entryMin = nextBar(day, m);
                if (entryMin == null) return null;
                const dir = (-broke) as 1 | -1;
                const pnl = bracket(day, entryMin, dir, day.o[entryMin], target, stop, deadline, true);
                return pnl == null ? null : { pnl, entryMin };
              }
              return null;
            },
          });
        }
      }
    }
  }
  return rules;
}

function nineFifteenRules(): Rule[] {
  const rules: Rule[] = [];
  const moves = [10, 15, 25];
  const targets = [8, 12, 15, 20];
  const stops = [10, 15, 25, 40];
  const deadlines = [9 * 60 + 45, 10 * 60, 10 * 60 + 30, FLAT_EXIT];
  for (const move of moves) {
    for (const target of targets) {
      for (const stop of stops) {
        for (const deadline of deadlines) {
          rules.push({
            family: "915-follow",
            name: `9:15 body ≥${move} follow · +${target}/−${stop} · ${hhmm(deadline)}`,
            run: (day) => {
              if (!hasBar(day, OPEN_MINS)) return null;
              const body = day.c[OPEN_MINS] - day.o[OPEN_MINS];
              if (Math.abs(body) < move) return null;
              const dir = (body > 0 ? 1 : -1) as 1 | -1;
              const entryMin = nextBar(day, OPEN_MINS);
              if (entryMin == null) return null;
              const pnl = bracket(day, entryMin, dir, day.o[entryMin], target, stop, deadline, true);
              return pnl == null ? null : { pnl, entryMin };
            },
          });
        }
      }
    }
  }
  return rules;
}

function fade930Rules(): Rule[] {
  const rules: Rule[] = [];
  const mornings = [10, 20, 40];
  const extensions = [8, 12, 15, 20];
  const stops = [10, 15, 25, 40];
  const giveBack = [0.5, 1];
  const deadlines = [10 * 60, 10 * 60 + 30, 11 * 60 + 30];
  for (const morning of mornings) {
    for (const ext of extensions) {
      for (const stop of stops) {
        for (const back of giveBack) {
          for (const deadline of deadlines) {
            rules.push({
              family: "fade-930-extension",
              name: `fade +${ext} after 9:30 when morning ≥${morning} · take ${back === 1 ? "all" : "half"} back · stop ${stop} · ${hhmm(deadline)}`,
              run: (day) => {
                const morningPts = day.close929 - day.open915;
                if (Math.abs(morningPts) < morning) return null;
                const morningDir = morningPts > 0 ? 1 : -1;
                const trigger = day.open930 + morningDir * ext;
                for (let m = ENTRY_930; m <= 11 * 60; m += 1) {
                  if (!hasBar(day, m)) continue;
                  const touched = morningDir === 1 ? day.h[m] >= trigger : day.l[m] <= trigger;
                  if (!touched) continue;
                  const openedThrough = morningDir === 1 ? day.o[m] >= trigger : day.o[m] <= trigger;
                  const entry = openedThrough ? day.o[m] : trigger;
                  const dir = (-morningDir) as 1 | -1;
                  const targetPts = Math.max(4, Math.abs(entry - day.open930) * back);
                  const pnl = bracket(day, m, dir, entry, targetPts, stop, deadline, false);
                  return pnl == null ? null : { pnl, entryMin: m };
                }
                return null;
              },
            });
          }
        }
      }
    }
  }
  return rules;
}

function speedRules(): Rule[] {
  const rules: Rule[] = [];
  const speeds = [15, 25, 40];
  const targets = [8, 12, 15, 20];
  const stops = [8, 12, 15, 25, 40];
  const holds = [15, 30];
  for (const speed of speeds) {
    for (const side of ["follow", "fade"] as Side[]) {
      for (const target of targets) {
        for (const stop of stops) {
          for (const hold of holds) {
            rules.push({
              family: "one-minute-speed",
              name: `first ${speed}pt minute ${side} · +${target}/−${stop} · ${hold}m`,
              run: (day) => {
                for (let m = 9 * 60 + 20; m <= 11 * 60; m += 1) {
                  if (!hasBar(day, m)) continue;
                  const body = day.c[m] - day.o[m];
                  if (Math.abs(body) < speed) continue;
                  const entryMin = nextBar(day, m);
                  if (entryMin == null) return null;
                  const dir = ((body > 0 ? 1 : -1) * (side === "follow" ? 1 : -1)) as 1 | -1;
                  const pnl = bracket(day, entryMin, dir, day.o[entryMin], target, stop, Math.min(FLAT_EXIT, entryMin + hold), true);
                  return pnl == null ? null : { pnl, entryMin };
                }
                return null;
              },
            });
          }
        }
      }
    }
  }
  return rules;
}

function hhmm(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function evaluate(rule: Rule, days: Day[]): Agg & { trades: Trade[] } {
  const agg: Agg = {
    family: rule.family,
    name: rule.name,
    n: 0,
    wins: 0,
    pnl: 0,
    worst: 0,
    lossStreak: 0,
    maxLossStreak: 0,
    h1n: 0,
    h1w: 0,
    h1pnl: 0,
    h2n: 0,
    h2w: 0,
    h2pnl: 0,
  };
  const trades: Trade[] = [];
  for (const day of days) {
    const trade = rule.run(day);
    if (!trade || !Number.isFinite(trade.pnl)) continue;
    const win = trade.pnl > 0;
    agg.n += 1;
    agg.pnl += trade.pnl;
    if (win) {
      agg.wins += 1;
      agg.lossStreak = 0;
    } else {
      agg.lossStreak += 1;
      if (agg.lossStreak > agg.maxLossStreak) agg.maxLossStreak = agg.lossStreak;
    }
    if (trade.pnl < agg.worst) agg.worst = trade.pnl;
    if (day.half === 1) {
      agg.h1n += 1;
      agg.h1pnl += trade.pnl;
      if (win) agg.h1w += 1;
    } else {
      agg.h2n += 1;
      agg.h2pnl += trade.pnl;
      if (win) agg.h2w += 1;
    }
    trades.push({ date: day.date, pnl: trade.pnl, entryMin: trade.entryMin });
  }
  return { ...agg, trades };
}

function passes(row: Agg): boolean {
  if (row.n < 40) return false;
  if (row.wins / row.n < 0.9) return false;
  if (row.pnl / row.n < 4) return false;
  if (row.h1n < 12 || row.h2n < 12) return false;
  if (row.h1w / row.h1n < 0.85 || row.h2w / row.h2n < 0.85) return false;
  if (row.h1pnl <= 0 || row.h2pnl <= 0) return false;
  return true;
}

function fadeHoldTo930(days: Day[]): void {
  console.log("");
  console.log("Fade the push past 9:30 and hold until Nifty comes back to the 9:30 price, or until 15:20. No stop.");
  for (const ext of [8, 10, 15, 20, 30]) {
    let n = 0;
    let wins = 0;
    let pnl = 0;
    let worst = 0;
    let h1n = 0;
    let h1w = 0;
    let h1pnl = 0;
    let h2n = 0;
    let h2w = 0;
    let h2pnl = 0;
    for (const day of days) {
      const morning = day.close929 - day.open915;
      if (!Number.isFinite(morning) || Math.abs(morning) < 10 || !Number.isFinite(day.open930)) continue;
      const morningDir = morning > 0 ? 1 : -1;
      const trigger = day.open930 + morningDir * ext;
      let entryMin = -1;
      let entry = 0;
      for (let m = ENTRY_930; m <= 11 * 60; m += 1) {
        if (!hasBar(day, m)) continue;
        const touched = morningDir === 1 ? day.h[m] >= trigger : day.l[m] <= trigger;
        if (!touched) continue;
        const openedThrough = morningDir === 1 ? day.o[m] >= trigger : day.o[m] <= trigger;
        entry = openedThrough ? day.o[m] : trigger;
        entryMin = m;
        break;
      }
      if (entryMin < 0) continue;
      const dir = (-morningDir) as 1 | -1;
      let result: number | null = null;
      let seen = false;
      for (let m = entryMin; m <= FLAT_EXIT; m += 1) {
        if (!hasBar(day, m)) continue;
        const back = dir === 1 ? day.h[m] >= day.open930 : day.l[m] <= day.open930;
        if (!seen) {
          seen = true;
          const closeBack = dir === 1 ? day.c[m] >= day.open930 : day.c[m] <= day.open930;
          if (closeBack) {
            result = Math.abs(entry - day.open930);
            break;
          }
          continue;
        }
        if (back) {
          result = Math.abs(entry - day.open930);
          break;
        }
      }
      if (result == null) {
        const end = lastCloseAt(day, FLAT_EXIT);
        if (!end) continue;
        result = dir * (end.close - entry);
      }
      const win = result > 0;
      n += 1;
      pnl += result;
      if (win) wins += 1;
      if (result < worst) worst = result;
      if (day.half === 1) {
        h1n += 1;
        h1pnl += result;
        if (win) h1w += 1;
      } else {
        h2n += 1;
        h2pnl += result;
        if (win) h2w += 1;
      }
    }
    if (n === 0) continue;
    console.log(
      `  +${ext} past 9:30, morning ≥10: ${((wins / n) * 100).toFixed(1)}%  n=${n}  avg ${(pnl / n).toFixed(1)}  ` +
        `total ${round1(pnl).toFixed(0)}  worst ${round1(worst).toFixed(1)}  ` +
        `halves ${h1n ? ((h1w / h1n) * 100).toFixed(0) : "—"}% / ${h2n ? ((h2w / h2n) * 100).toFixed(0) : "—"}%`,
    );
  }
}

function line(row: Agg): string {
  const wr = ((row.wins / row.n) * 100).toFixed(1);
  const avg = (row.pnl / row.n).toFixed(1);
  const h1 = ((row.h1w / row.h1n) * 100).toFixed(0);
  const h2 = ((row.h2w / row.h2n) * 100).toFixed(0);
  return `${wr}%  n=${row.n}  avg ${avg} pts  total ${round1(row.pnl).toFixed(0)}  ` +
    `halves ${h1}% (${row.h1n}) / ${h2}% (${row.h2n})  worst ${round1(row.worst).toFixed(1)}  ` +
    `loss streak ${row.maxLossStreak}  after 1pt friction avg ${(row.pnl / row.n - 1).toFixed(1)}  ${row.family}  ${row.name}`;
}

async function loadDays(): Promise<Day[]> {
  const session = loadKiteSession();
  if (!session?.accessToken) throw new Error("No Kite session on this machine");
  const dates = listWeekdayDates(LOOKBACK_CALENDAR_DAYS);
  const built: Day[] = [];
  for (const group of chunk(dates, CHUNK_TRADING_DAYS)) {
    const from = `${group[0]} 09:15:00`;
    const to = `${group[group.length - 1]} 15:30:00`;
    process.stderr.write(`fetch ${from} → ${to}\n`);
    const { candles } = await fetchHistoricalCandles(session.accessToken, SPOT, "minute", from, to);
    if (!Array.isArray(candles)) throw new Error(`Invalid candle payload for ${from}`);
    const byDate = groupSessionBars(candles);
    for (const [date, bars] of byDate) {
      if (!isCompleteSession(bars)) continue;
      built.push(toDay(date, bars));
    }
    await new Promise((resolve) => setTimeout(resolve, FETCH_SPACING_MS));
  }
  built.sort((a, b) => a.date.localeCompare(b.date));
  const mid = built[Math.floor(built.length / 2)]?.date ?? "9999";
  for (const day of built) day.half = day.date < mid ? 1 : 2;
  let prev: number | null = null;
  for (const day of built) {
    day.prevClose = prev;
    prev = day.lastClose;
  }
  return built;
}

function toDay(date: string, bars: MinuteBar[]): Day {
  const o = arrays();
  const h = arrays();
  const l = arrays();
  const c = arrays();
  for (const bar of bars) {
    o[bar.mins] = bar.open;
    h[bar.mins] = bar.high;
    l[bar.mins] = bar.low;
    c[bar.mins] = bar.close;
  }
  const last = bars[bars.length - 1];
  return {
    date,
    half: 1,
    o,
    h,
    l,
    c,
    open915: o[OPEN_MINS],
    close929: c[MARK_929],
    open930: o[ENTRY_930],
    prevClose: null,
    lastClose: last?.close ?? c[FLAT_EXIT],
  };
}

async function main(): Promise<void> {
  const days = await loadDays();
  const rules = [
    ...clockRules(),
    ...streakRules(),
    ...gapRules(),
    ...orRules(),
    ...nineFifteenRules(),
    ...fade930Rules(),
    ...speedRules(),
  ];
  process.stderr.write(`sessions ${days.length}  rules ${rules.length}\n`);
  const kept: Array<Agg & { trades: Trade[] }> = [];
  const ninety: Agg[] = [];
  const money: Agg[] = [];
  let bestNear = { wr: 0, row: null as Agg | null };
  for (let i = 0; i < rules.length; i += 1) {
    const row = evaluate(rules[i], days);
    if (passes(row)) kept.push(row);
    if (row.n >= 40 && row.wins / row.n >= 0.9) ninety.push(row);
    if (row.n >= 80 && row.h1n >= 25 && row.h2n >= 25 && row.h1pnl > 0 && row.h2pnl > 0) money.push(row);
    if (row.n >= 60 && row.h1pnl > 0 && row.h2pnl > 0 && row.h1n >= 20 && row.h2n >= 20) {
      const wr = row.wins / row.n;
      if (wr > bestNear.wr) bestNear = { wr, row };
    }
    if ((i + 1) % 500 === 0) process.stderr.write(`checked ${i + 1}/${rules.length}\n`);
  }
  ninety.sort((a, b) => b.pnl / b.n - a.pnl / a.n);
  money.sort((a, b) => b.pnl - a.pnl);
  kept.sort((a, b) => b.pnl - a.pnl);
  console.log("");
  console.log(`Sessions ${days[0]?.date} → ${days[days.length - 1]?.date} (${days.length})`);
  console.log(`Rules tested ${rules.length}. Kept when win rate ≥ 90%, at least 40 trades, average ≥ 4 Nifty points, and both halves ≥ 85% and profitable.`);
  console.log(`Patterns kept: ${kept.length}`);
  console.log("");
  const shown = kept.slice(0, 20);
  for (const row of shown) console.log(line(row));
  if (kept[0]) {
    console.log("");
    console.log(`Trades for the strongest: ${kept[0].name}`);
    for (const trade of kept[0].trades) {
      console.log(`  ${trade.date}  ${hhmm(trade.entryMin)}  ${trade.pnl >= 0 ? "+" : ""}${round1(trade.pnl).toFixed(1)}`);
    }
  }
  if (kept.length === 0 && bestNear.row) {
    console.log("");
    console.log("No rule cleared 90% with both halves agreeing. Highest win rate that was profitable in both halves, with at least 60 trades:");
    console.log(line(bestNear.row));
  }
  console.log("");
  console.log(`Rules with ≥90% wins and at least 40 trades, ignoring the half-year check: ${ninety.length}`);
  for (const row of ninety.slice(0, 12)) console.log(line(row));
  console.log("");
  console.log("Largest point totals among rules with at least 80 trades that made money in both halves:");
  for (const row of money.slice(0, 8)) console.log(line(row));
  fadeHoldTo930(days);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
