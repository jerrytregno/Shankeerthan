/**
 * 9:15 and 9:16 morning trades: which losing days could have been skipped with
 * information the bot already has when it enters.
 *
 * The 9:16 trade is scored exactly like the 9:16 backtesting pages (entry at the
 * 9:16 open, 12 / 8 point index target, 40 points against at 9:26 PE / 9:17 CE,
 * otherwise a later return to the entry price counts as a win). Kite has no
 * second-level history, so the 9:15:10 read cannot be rebuilt for past days.
 *
 * Rules are picked on the page's window (20 Aug 2025 onward) and then checked on
 * the year before it, which the search never saw.
 *
 * Run: npx tsx scripts/check-morning-trade-filters.ts
 * FETCH_ONLY=1 writes data/nifty-minute-2y.json.gz (needs a Kite session) and exits.
 * LOSERS=1 also prints every losing trade with its entry-time numbers.
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import "../server/load-env.js";
import { fetchHistoricalCandles } from "../server/kite-candles.js";
import { loadKiteSession } from "../server/kite-session-store.js";
import { groupSessionBars, isCompleteSession } from "../server/session-bars.js";

const CACHE = path.join(process.cwd(), "data", "nifty-minute-2y.json.gz");
const VIX_CACHE = path.join(process.cwd(), "data", "india-vix-daily.json");
const SPOT = "NSE:NIFTY 50";
const VIX = "NSE:INDIA VIX";
const FETCH_FROM = "2024-06-03";
const FETCH_SPAN_DAYS = 30;

const DAY_MINS = 960;
const M915 = 9 * 60 + 15;
const M916 = 9 * 60 + 16;
const M1430 = 14 * 60 + 30;
const M1530 = 15 * 60 + 30;
const PE_CHECK = 9 * 60 + 26;
const CE_CHECK = 9 * 60 + 17;
const MIN_BODY = 15;
const TARGET_CONFIRM = 12;
const TARGET_GAP = 8;
const ADVERSE_STOP = 40;
const PAGE_FROM = "2025-08-20";
const TUESDAY_EXPIRY_FROM = "2025-09-01";
const MAX_SKIP_SHARE = 0.3;

type RawDay = { date: string; bars: number[][] };
type Side = "PE" | "CE";

interface Day {
  date: string;
  weekday: number;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  open: number;
  high: number;
  low: number;
  close: number;
  close1430: number;
  rsi915: number;
}

interface Trade {
  date: string;
  recent: boolean;
  weekday: number;
  side: Side;
  dir: 1 | -1;
  entry: number;
  confirm: boolean;
  target: number;
  win: boolean;
  kind: "target" | "return" | "stop" | "eod";
  exitMin: number;
  /** Nifty points: +target, small or zero on a return to entry, the checkpoint open on a stop, the 15:29 close otherwise. */
  points: number;
  mae: number;
  mfe: number;
  f: Record<string, number>;
}

interface FeatureDef {
  key: string;
  label: string;
  at915: boolean;
}

const FEATURES: FeatureDef[] = [
  { key: "gapOpen", label: "gap at 9:15 open vs yesterday's close, in the trade's direction", at915: true },
  { key: "absGap", label: "size of the opening gap vs yesterday's close", at915: true },
  { key: "prevMove", label: "yesterday open→close, in the trade's direction", at915: true },
  { key: "prevCC", label: "yesterday close vs the day before, in the trade's direction", at915: true },
  { key: "prevRange", label: "yesterday's high−low", at915: true },
  { key: "prevCloseLoc", label: "where yesterday closed in its range (1 = at the end the trade wants)", at915: true },
  { key: "prevLastHour", label: "yesterday 14:30→close, in the trade's direction", at915: true },
  { key: "trend5", label: "5-session move to yesterday's close, in the trade's direction", at915: true },
  { key: "sma20", label: "yesterday's close vs its 20-day average, in the trade's direction", at915: true },
  { key: "openOutside", label: "9:15 open beyond yesterday's high/low, in the trade's direction", at915: true },
  { key: "vixPrev", label: "India VIX at yesterday's close", at915: true },
  { key: "body", label: "9:15 candle body", at915: false },
  { key: "range915", label: "9:15 candle high−low", at915: false },
  { key: "counterWick", label: "9:15 wick against the trade (bounce off the extreme)", at915: false },
  { key: "leadWick", label: "9:15 wick on the open side (first move against the trade)", at915: false },
  { key: "gap916", label: "9:16 open vs 9:15 close, in the trade's direction", at915: false },
  { key: "ext", label: "9:15 close vs yesterday's close, in the trade's direction", at915: false },
  { key: "rsiWith", label: "1-min RSI(14) at the 9:15 close, in the trade's direction", at915: false },
];

function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayIst(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

async function fetchRaw(): Promise<RawDay[]> {
  const session = loadKiteSession();
  if (!session?.accessToken) throw new Error("No Kite session");
  const out = new Map<string, RawDay>();
  const end = todayIst();
  for (let from = FETCH_FROM; from <= end; from = addDays(from, FETCH_SPAN_DAYS)) {
    const toDate = addDays(from, FETCH_SPAN_DAYS - 1) < end ? addDays(from, FETCH_SPAN_DAYS - 1) : end;
    process.stderr.write(`fetch ${from} → ${toDate}\n`);
    const { candles } = await fetchHistoricalCandles(
      session.accessToken,
      SPOT,
      "minute",
      `${from} 09:15:00`,
      `${toDate} 15:30:00`,
    );
    if (!Array.isArray(candles)) throw new Error(`Invalid candle payload for ${from}`);
    for (const [date, bars] of groupSessionBars(candles)) {
      if (!isCompleteSession(bars)) continue;
      out.set(date, { date, bars: bars.map((bar) => [bar.mins, bar.open, bar.high, bar.low, bar.close]) });
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return [...out.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function nanArr(): Float64Array {
  return new Float64Array(DAY_MINS).fill(Number.NaN);
}

function has(day: Day, min: number): boolean {
  return Number.isFinite(day.c[min]);
}

function buildDays(raw: RawDay[]): Day[] {
  const days: Day[] = [];
  let avgGain = 0;
  let avgLoss = 0;
  let seeded = 0;
  let lastClose: number | null = null;
  for (const rd of raw) {
    const bars = rd.bars.filter((b) => b[0] >= M915 && b[0] <= M1530).sort((a, b) => a[0] - b[0]);
    if (bars.length < 330 || bars[0][0] !== M915 || !bars.some((b) => b[0] === M916)) continue;
    if (bars[bars.length - 1][0] < M1530 - 1) continue;
    const o = nanArr();
    const h = nanArr();
    const l = nanArr();
    const c = nanArr();
    let high = -Infinity;
    let low = Infinity;
    let rsi915 = Number.NaN;
    for (const [m, bo, bh, bl, bc] of bars) {
      o[m] = bo;
      h[m] = bh;
      l[m] = bl;
      c[m] = bc;
      high = Math.max(high, bh);
      low = Math.min(low, bl);
      if (lastClose != null) {
        const change = bc - lastClose;
        const gain = Math.max(change, 0);
        const loss = Math.max(-change, 0);
        if (seeded < 14) {
          avgGain += gain / 14;
          avgLoss += loss / 14;
          seeded += 1;
        } else {
          avgGain = (avgGain * 13 + gain) / 14;
          avgLoss = (avgLoss * 13 + loss) / 14;
        }
      }
      lastClose = bc;
      if (m === M915 && seeded >= 14) {
        rsi915 = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    }
    const last = bars[bars.length - 1];
    let close1430 = Number.NaN;
    for (let m = M1430; m >= M915; m -= 1) {
      if (Number.isFinite(c[m])) {
        close1430 = c[m];
        break;
      }
    }
    days.push({
      date: rd.date,
      weekday: new Date(`${rd.date}T12:00:00Z`).getUTCDay(),
      o,
      h,
      l,
      c,
      open: o[M915],
      high,
      low,
      close: last[4],
      close1430,
      rsi915,
    });
  }
  return days;
}

function isExpiryDay(date: string, weekday: number): boolean {
  return date >= TUESDAY_EXPIRY_FROM ? weekday === 2 : weekday === 4;
}

type VixDay = { date: string; open: number; close: number };
let VIX_PREV_CLOSE = new Map<string, number>();

function loadVix() {
  if (!fs.existsSync(VIX_CACHE)) return;
  const rows = (JSON.parse(fs.readFileSync(VIX_CACHE, "utf8")) as VixDay[]).sort((a, b) => a.date.localeCompare(b.date));
  VIX_PREV_CLOSE = new Map();
  for (let i = 1; i < rows.length; i += 1) VIX_PREV_CLOSE.set(rows[i].date, rows[i - 1].close);
}

/** Same outcome as the 9:16 backtesting pages. `targets` is [same colour, gap] in Nifty points. */
function score916(
  days: Day[],
  index: number,
  targets: [number, number] = [TARGET_CONFIRM, TARGET_GAP],
): Trade | null {
  const day = days[index];
  const prev = days[index - 1];
  const prev2 = days[index - 2];
  const prev6 = days[index - 6];
  if (!prev || !prev2 || !prev6 || index < 21) return null;
  const change = day.c[M915] - day.o[M915];
  if (change === 0 || Math.abs(change) < MIN_BODY) return null;
  const side: Side = change < 0 ? "PE" : "CE";
  const dir: 1 | -1 = side === "CE" ? 1 : -1;
  const entry = day.o[M916];
  const confirm = side === "PE" ? entry <= day.c[M915] + 1e-9 : entry >= day.c[M915] - 1e-9;
  const target = confirm ? targets[0] : targets[1];
  const deadline = side === "PE" ? PE_CHECK : CE_CHECK;

  let targetMin: number | null = null;
  for (let m = M916; m <= M1530; m += 1) {
    if (!has(day, m)) continue;
    const hit = side === "PE" ? day.l[m] <= entry - target : day.h[m] >= entry + target;
    if (hit) {
      targetMin = m;
      break;
    }
  }
  const stopBarOpen = day.o[deadline];
  const adverseAtCheck = Number.isFinite(stopBarOpen) ? dir * (entry - stopBarOpen) : Number.NaN;
  const stopped =
    Number.isFinite(adverseAtCheck) &&
    adverseAtCheck + 1e-9 >= ADVERSE_STOP &&
    !(targetMin != null && targetMin <= deadline);
  let returnMin: number | null = null;
  for (let m = deadline; m <= M1530; m += 1) {
    if (!has(day, m)) continue;
    const back = side === "PE" ? day.l[m] <= entry + 1e-9 : day.h[m] + 1e-9 >= entry;
    if (back) {
      returnMin = m;
      break;
    }
  }
  const win = !stopped && (targetMin != null || returnMin != null);
  let kind: Trade["kind"];
  let exitMin: number;
  if (stopped) {
    kind = "stop";
    exitMin = deadline;
  } else if (targetMin != null && (targetMin <= deadline || returnMin == null || targetMin <= returnMin)) {
    kind = "target";
    exitMin = targetMin;
  } else if (returnMin != null) {
    kind = "return";
    exitMin = returnMin;
  } else {
    kind = "eod";
    exitMin = M1530 - 1;
  }
  const points =
    kind === "stop"
      ? -adverseAtCheck
      : kind === "target"
        ? target
        : kind === "return"
          ? Math.max(0, dir * (day.o[exitMin] - entry))
          : dir * (day.c[exitMin] - entry);
  let mae = 0;
  let mfe = 0;
  for (let m = M916; m <= exitMin; m += 1) {
    if (!has(day, m)) continue;
    mae = Math.max(mae, side === "PE" ? day.h[m] - entry : entry - day.l[m]);
    mfe = Math.max(mfe, side === "PE" ? entry - day.l[m] : day.h[m] - entry);
  }

  let sum20 = 0;
  for (let k = index - 20; k < index; k += 1) sum20 += days[k].close;
  const prevRange = prev.high - prev.low;
  const loc = prevRange > 0 ? (prev.close - prev.low) / prevRange : 0.5;
  const o915 = day.o[M915];
  const c915 = day.c[M915];
  const f: Record<string, number> = {
    gapOpen: dir * (o915 - prev.close),
    absGap: Math.abs(o915 - prev.close),
    prevMove: dir * (prev.close - prev.open),
    prevCC: dir * (prev.close - prev2.close),
    prevRange,
    prevCloseLoc: dir > 0 ? loc : 1 - loc,
    prevLastHour: dir * (prev.close - prev.close1430),
    trend5: dir * (prev.close - prev6.close),
    sma20: dir * (prev.close - sum20 / 20),
    openOutside: dir > 0 ? o915 - prev.high : prev.low - o915,
    body: Math.abs(change),
    range915: day.h[M915] - day.l[M915],
    counterWick: side === "PE" ? c915 - day.l[M915] : day.h[M915] - c915,
    leadWick: side === "PE" ? day.h[M915] - o915 : o915 - day.l[M915],
    gap916: dir * (entry - c915),
    ext: dir * (c915 - prev.close),
    rsiWith: dir > 0 ? day.rsi915 : 100 - day.rsi915,
    vixPrev: VIX_PREV_CLOSE.get(day.date) ?? Number.NaN,
  };
  return {
    date: day.date,
    recent: day.date >= PAGE_FROM,
    weekday: day.weekday,
    side,
    dir,
    entry,
    confirm,
    target,
    win,
    kind,
    exitMin,
    points,
    mae,
    mfe,
    f,
  };
}

/** Win rate and Nifty points by 9:16 target size; a trade 60+ points against before its exit counts as a capital-stop loss of 60. */
function sweepTargets(days: Day[]) {
  console.log("\n=== 9:16 target size [same colour, gap]: win % · with capital stop · points (capital-stop points) ===");
  const pairs: [number, number][] = [[12, 8], [10, 8], [8, 8], [8, 6], [7, 7], [6, 6], [5, 5]];
  for (const targets of pairs) {
    const list: Trade[] = [];
    for (let i = 0; i < days.length; i += 1) {
      const t = score916(days, i, targets);
      if (t) list.push(t);
    }
    const cells = (["PE", "CE"] as const).flatMap((side) =>
      [true, false].map((period) => {
        const pool = list.filter((t) => t.side === side && t.recent === period);
        const w = pool.filter((t) => t.win).length;
        const cap = pool.filter((t) => t.win && t.mae < 60).length;
        const pts = pool.reduce((s, t) => s + t.points, 0);
        const capPts = pool.reduce((s, t) => s + (t.mae >= 60 ? -60 : t.points), 0);
        const pct = (n: number) => `${((n / pool.length) * 100).toFixed(1)}%`;
        return `${side} ${period ? "page" : "before"} ${pct(w)} · ${pct(cap)} · ${pts.toFixed(0)} (${capPts.toFixed(0)})`;
      }),
    );
    console.log(`  ${targets.join("/").padEnd(6)} ${cells.join("  |  ")}`);
  }
}

type Stats = { n: number; w: number; l: number; pct: number };

function stats(trades: Trade[]): Stats {
  const w = trades.filter((t) => t.win).length;
  return { n: trades.length, w, l: trades.length - w, pct: trades.length ? (w / trades.length) * 100 : 0 };
}

function fmt(s: Stats): string {
  return `${s.w}/${s.n} ${s.pct.toFixed(1)}% (${s.l} lost)`;
}

function hhmm(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface Rule {
  label: string;
  at915: boolean;
  skip: (t: Trade) => boolean;
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function candidateRules(pool: Trade[]): Rule[] {
  const rules: Rule[] = [];
  const qs = [0.03, 0.05, 0.075, 0.1, 0.125, 0.15, 0.2, 0.25, 0.3];
  for (const def of FEATURES) {
    const values = pool.map((t) => t.f[def.key]).filter(Number.isFinite).sort((a, b) => a - b);
    if (values.length < 10) continue;
    const seen = new Set<string>();
    for (const q of qs) {
      const low = round1(quantile(values, q));
      const high = round1(quantile(values, 1 - q));
      if (!seen.has(`<${low}`)) {
        seen.add(`<${low}`);
        rules.push({ label: `skip if ${def.key} < ${low}`, at915: def.at915, skip: (t) => t.f[def.key] < low });
      }
      if (!seen.has(`>${high}`)) {
        seen.add(`>${high}`);
        rules.push({ label: `skip if ${def.key} > ${high}`, at915: def.at915, skip: (t) => t.f[def.key] > high });
      }
    }
  }
  for (let wd = 1; wd <= 5; wd += 1) {
    rules.push({ label: `skip ${WEEKDAYS[wd]}`, at915: true, skip: (t) => t.weekday === wd });
  }
  rules.push({ label: "skip expiry day", at915: true, skip: (t) => isExpiryDay(t.date, t.weekday) });
  rules.push({ label: "skip 9:16 gap against 9:15 colour", at915: false, skip: (t) => !t.confirm });
  rules.push({ label: "skip 9:16 same colour as 9:15", at915: false, skip: (t) => t.confirm });
  return rules;
}

function report(title: string, all: Trade[]) {
  const recent = all.filter((t) => t.recent);
  const prior = all.filter((t) => !t.recent);
  const baseR = stats(recent);
  const baseP = stats(prior);
  console.log(`\n=== ${title} ===`);
  console.log(`  page window  ${fmt(baseR)}`);
  console.log(`  year before  ${fmt(baseP)}`);
  const rules = candidateRules(recent);
  const rows = rules
    .map((rule) => {
      const keptR = recent.filter((t) => !rule.skip(t));
      const keptP = prior.filter((t) => !rule.skip(t));
      return { rule, r: stats(keptR), p: stats(keptP) };
    })
    .filter((row) => row.r.n >= recent.length * (1 - MAX_SKIP_SHARE) && row.r.l < baseR.l);
  rows.sort((a, b) => b.r.pct - a.r.pct || b.r.n - a.r.n);
  console.log("  best single skips picked on the page window (max 30% of trades skipped):");
  for (const row of rows.slice(0, 14)) {
    const lostWinsR = baseR.w - row.r.w;
    const lostLossR = baseR.l - row.r.l;
    const lostWinsP = baseP.w - row.p.w;
    const lostLossP = baseP.l - row.p.l;
    console.log(
      `   ${row.rule.at915 ? "[9:15 ok]" : "[9:16 only]"} ${row.rule.label.padEnd(36)} ` +
        `page ${fmt(row.r).padEnd(24)} skips ${lostLossR}L+${lostWinsR}W | ` +
        `year before ${fmt(row.p).padEnd(24)} skips ${lostLossP}L+${lostWinsP}W`,
    );
  }
}

/** Two skips together, each taken from the single-skip list. */
function reportPairs(title: string, all: Trade[]) {
  const recent = all.filter((t) => t.recent);
  const prior = all.filter((t) => !t.recent);
  const baseR = stats(recent);
  const baseP = stats(prior);
  const singles = candidateRules(recent).filter((rule) => {
    const kept = recent.filter((t) => !rule.skip(t));
    return kept.length >= recent.length * 0.8 && stats(kept).l < baseR.l;
  });
  const rows: { label: string; at915: boolean; r: Stats; p: Stats }[] = [];
  for (let i = 0; i < singles.length; i += 1) {
    for (let j = i + 1; j < singles.length; j += 1) {
      const a = singles[i];
      const b = singles[j];
      const keep = (t: Trade) => !a.skip(t) && !b.skip(t);
      const r = stats(recent.filter(keep));
      if (r.n < recent.length * (1 - MAX_SKIP_SHARE)) continue;
      rows.push({ label: `${a.label} · ${b.label}`, at915: a.at915 && b.at915, r, p: stats(prior.filter(keep)) });
    }
  }
  rows.sort((x, y) => y.r.pct - x.r.pct || y.r.n - x.r.n);
  const beatBoth = rows.filter((row) => row.r.pct > baseR.pct && row.p.pct > baseP.pct + 2).length;
  console.log(`\n=== ${title}: pairs of skips (${rows.length} tried, ${beatBoth} also add 2+ points in the year before) ===`);
  for (const row of rows.slice(0, 10)) {
    console.log(
      `   ${row.at915 ? "[9:15 ok]" : "[9:16 only]"} ${row.label.padEnd(66)} page ${fmt(row.r).padEnd(24)} year before ${fmt(row.p)}`,
    );
  }
}

/** Picks the best skip on one period and scores it on the other. */
function reportSwap(title: string, all: Trade[]) {
  const recent = all.filter((t) => t.recent);
  const prior = all.filter((t) => !t.recent);
  const pick = (pool: Trade[]) => {
    const base = stats(pool);
    return candidateRules(pool)
      .map((rule) => ({ rule, s: stats(pool.filter((t) => !rule.skip(t))) }))
      .filter((row) => row.s.n >= pool.length * (1 - MAX_SKIP_SHARE) && row.s.l < base.l)
      .sort((a, b) => b.s.pct - a.s.pct || b.s.n - a.s.n)
      .slice(0, 5);
  };
  console.log(`\n=== ${title}: best skips picked on the year before, scored on the page window ===`);
  const baseR = stats(recent);
  for (const row of pick(prior)) {
    console.log(
      `   ${row.rule.label.padEnd(36)} year before ${fmt(row.s).padEnd(24)} page ${fmt(stats(recent.filter((t) => !row.rule.skip(t))))} (base ${baseR.pct.toFixed(1)}%)`,
    );
  }
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function shuffleWins(pool: Trade[], rand: () => number): Trade[] {
  const wins = pool.map((t) => t.win);
  for (let i = wins.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [wins[i], wins[j]] = [wins[j], wins[i]];
  }
  return pool.map((t, i) => ({ ...t, win: wins[i] }));
}

/** Rules that add at least `lift` points in both periods while skipping at most 30% in each. */
function bothPeriodRules(recent: Trade[], prior: Trade[], rules: Rule[], lift: number) {
  const baseR = stats(recent);
  const baseP = stats(prior);
  const out: { rule: Rule; r: Stats; p: Stats }[] = [];
  for (const rule of rules) {
    const keptR = recent.filter((t) => !rule.skip(t));
    const keptP = prior.filter((t) => !rule.skip(t));
    if (keptR.length < recent.length * (1 - MAX_SKIP_SHARE) || keptP.length < prior.length * (1 - MAX_SKIP_SHARE)) continue;
    const r = stats(keptR);
    const p = stats(keptP);
    if (r.pct >= baseR.pct + lift && p.pct >= baseP.pct + lift) out.push({ rule, r, p });
  }
  return out.sort((a, b) => Math.min(b.r.pct - baseR.pct, b.p.pct - baseP.pct) - Math.min(a.r.pct - baseR.pct, a.p.pct - baseP.pct));
}

function reportBothPeriods(title: string, all: Trade[]) {
  const recent = all.filter((t) => t.recent);
  const prior = all.filter((t) => !t.recent);
  const rules = candidateRules(recent);
  const lift = 2;
  const real = bothPeriodRules(recent, prior, rules, lift);
  const rand = seeded(97);
  const counts: number[] = [];
  for (let k = 0; k < 200; k += 1) {
    counts.push(bothPeriodRules(shuffleWins(recent, rand), shuffleWins(prior, rand), rules, lift).length);
  }
  counts.sort((a, b) => a - b);
  const mean = counts.reduce((s, v) => s + v, 0) / counts.length;
  const beat = counts.filter((v) => v >= real.length).length;
  console.log(
    `\n=== ${title}: skips that add ${lift}+ points in BOTH periods: ${real.length} of ${rules.length} ` +
      `(shuffled outcomes: average ${mean.toFixed(1)}, 95th pct ${counts[Math.floor(counts.length * 0.95)]}, ` +
      `${beat}/200 shuffles found as many) ===`,
  );
  for (const row of real.slice(0, 12)) {
    console.log(`   ${row.rule.at915 ? "[9:15 ok]" : "[9:16 only]"} ${row.rule.label.padEnd(36)} page ${fmt(row.r).padEnd(24)} year before ${fmt(row.p)}`);
  }
}

/** Wins that first went this far against are where the live −30% capital stop would likely have fired. */
const CAPITAL_STOP_PROXY_PTS = 50;

function strictWin(t: Trade): boolean {
  return t.win && t.mae < CAPITAL_STOP_PROXY_PTS;
}

function strictStats(trades: Trade[]): Stats {
  const w = trades.filter(strictWin).length;
  return { n: trades.length, w, l: trades.length - w, pct: trades.length ? (w / trades.length) * 100 : 0 };
}

function logChoose(n: number, k: number): number {
  let out = 0;
  for (let i = 1; i <= k; i += 1) out += Math.log(n - k + i) - Math.log(i);
  return out;
}

/** Chance that skipping `skipped` random trades out of `n` (with `losers` losers) catches at least `caught` losers. */
function hypergeomTail(n: number, losers: number, skipped: number, caught: number): number {
  let p = 0;
  for (let x = caught; x <= Math.min(losers, skipped); x += 1) {
    p += Math.exp(logChoose(losers, x) + logChoose(n - losers, skipped - x) - logChoose(n, skipped));
  }
  return p;
}

function sweepYesterday(title: string, list: Trade[]) {
  console.log(`\n=== ${title}: skip when yesterday closed this many points against the trade ===`);
  for (const pts of [60, 80, 100, 120, 150, 200, 250]) {
    const cells = [true, false].map((period) => {
      const pool = list.filter((t) => t.recent === period);
      const kept = pool.filter((t) => !(t.f.prevCC < -pts));
      const base = stats(pool);
      const s = stats(kept);
      const caught = base.l - s.l;
      const p = hypergeomTail(pool.length, base.l, pool.length - kept.length, caught);
      const strict = strictStats(kept);
      const skipped = pool.filter((t) => t.f.prevCC < -pts);
      const pts1 = skipped.reduce((sum, t) => sum + t.points, 0);
      const pts2 = skipped.reduce((sum, t) => sum + (t.mae >= 60 ? -60 : t.points), 0);
      return (
        `${fmt(s).padEnd(24)} skips ${caught}L+${base.w - s.w}W chance ${p.toFixed(2)} · with capital stop ${strict.pct.toFixed(1)}% · ` +
        `skipped trades made ${pts1.toFixed(0)} pts (${pts2.toFixed(0)} with 60-pt stop)`
      );
    });
    console.log(`   ${String(pts).padStart(3)} pts | page ${cells[0]} | year before ${cells[1]}`);
  }
  for (const period of [true, false]) {
    const pool = list.filter((t) => t.recent === period);
    const tgt = pool.filter((t) => t.kind === "target").length;
    const keptTgt = pool.filter((t) => t.kind === "target" && !(t.f.prevCC < -120));
    const kept = pool.filter((t) => !(t.f.prevCC < -120));
    console.log(
      `   no skip, with capital stop: ${period ? "page" : "year before"} ${fmt(strictStats(pool))} · target hit ` +
        `${((tgt / pool.length) * 100).toFixed(1)}% → ${((keptTgt.length / kept.length) * 100).toFixed(1)}% with the 120 skip`,
    );
  }
}

function printDates(days: Day[], spec: string, trades: Trade[]) {
  const index = new Map(days.map((d, i) => [d.date, i]));
  const scored = new Map(trades.map((t) => [t.date, t]));
  console.log("\n--- pre-open numbers for given dates ---");
  for (const item of spec.split(",")) {
    const [date, side] = item.split(":");
    const i = index.get(date);
    if (i == null || i < 21) {
      console.log(`  ${date} not in data`);
      continue;
    }
    const day = days[i];
    const prev = days[i - 1];
    const prev2 = days[i - 2];
    const dir = side === "CE" ? 1 : -1;
    const body = day.c[M915] - day.o[M915];
    console.log(
      `  ${date} ${WEEKDAYS[day.weekday]} ${side} yesterday ${(prev.close - prev2.close).toFixed(1)} (against trade ${(dir * (prev.close - prev2.close) < 0 ? "yes" : "no")}) ` +
        `gap ${(day.o[M915] - prev.close).toFixed(1)} 9:15 body ${body.toFixed(1)} 9:16 open−9:15 close ${(day.o[M916] - day.c[M915]).toFixed(1)} ` +
        `VIX ${(VIX_PREV_CLOSE.get(date) ?? Number.NaN).toFixed(2)}`,
    );
    const t = scored.get(date);
    console.log(
      t
        ? `      page: ${t.side} ${t.win ? "win" : "loss"} by ${t.kind} at ${fmtMin(t.exitMin)} · worst ${t.mae.toFixed(0)} against · best ${t.mfe.toFixed(1)} in favour`
        : "      page: no 9:16 trade",
    );
  }
}

function fmtMin(m: number) {
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

function printLosers(title: string, trades: Trade[]) {
  console.log(`\n--- ${title} losers (page window) ---`);
  for (const t of trades.filter((x) => x.recent && !x.win)) {
    const f = t.f;
    console.log(
      `  ${t.date} ${WEEKDAYS[t.weekday]} ${t.side} ${t.confirm ? "same" : "gap "} ${t.kind.padEnd(4)} ` +
        `body ${f.body.toFixed(1)} gap ${f.gapOpen.toFixed(1)} ext ${f.ext.toFixed(1)} prevMove ${f.prevMove.toFixed(1)} ` +
        `prevCC ${f.prevCC.toFixed(1)} prevRange ${f.prevRange.toFixed(0)} loc ${f.prevCloseLoc.toFixed(2)} ` +
        `trend5 ${f.trend5.toFixed(0)} sma20 ${f.sma20.toFixed(0)} wick ${f.counterWick.toFixed(1)} 916gap ${f.gap916.toFixed(1)} ` +
        `rsi ${f.rsiWith.toFixed(0)} mae ${t.mae.toFixed(0)} best ${t.mfe.toFixed(1)}`,
    );
  }
}

async function main() {
  if (process.env.FETCH_ONLY === "1") {
    if (process.env.VIX_ONLY !== "1") {
      const raw = await fetchRaw();
      fs.mkdirSync(path.dirname(CACHE), { recursive: true });
      fs.writeFileSync(CACHE, zlib.gzipSync(JSON.stringify(raw)));
      console.log(`wrote ${raw.length} sessions ${raw[0]?.date} → ${raw[raw.length - 1]?.date}`);
    }
    const session = loadKiteSession();
    if (!session?.accessToken) throw new Error("No Kite session");
    const { candles } = await fetchHistoricalCandles(
      session.accessToken,
      VIX,
      "day",
      `${addDays(FETCH_FROM, -40)} 00:00:00`,
      `${todayIst()} 23:59:59`,
    );
    const vix = (candles as unknown[][]).map((row) => ({
      date: String(row[0]).slice(0, 10),
      open: Number(row[1]),
      close: Number(row[4]),
    }));
    fs.writeFileSync(VIX_CACHE, JSON.stringify(vix));
    console.log(`wrote ${vix.length} VIX days ${vix[0]?.date} → ${vix[vix.length - 1]?.date}`);
    return;
  }
  const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(CACHE)).toString("utf8")) as RawDay[];
  loadVix();
  const days = buildDays(raw);
  const trades: Trade[] = [];
  for (let i = 0; i < days.length; i += 1) {
    const trade = score916(days, i);
    if (trade) trades.push(trade);
  }
  const pe = trades.filter((t) => t.side === "PE");
  const ce = trades.filter((t) => t.side === "CE");
  console.log(
    `${days.length} sessions ${days[0].date} → ${days[days.length - 1].date} · page window from ${PAGE_FROM}`,
  );
  for (const [label, list] of [
    ["9:16 red PE", pe],
    ["9:16 green CE", ce],
  ] as const) {
    for (const period of [true, false]) {
      const r = list.filter((t) => t.recent === period);
      const kinds = (k: Trade["kind"]) => r.filter((t) => t.kind === k).length;
      const backInProfit = r.filter((t) => t.kind === "return" && t.points >= 1).length;
      console.log(
        `${label}: ${period ? "page" : "year before"} ${fmt(stats(r))} · target ${kinds("target")} ` +
          `(${((kinds("target") / r.length) * 100).toFixed(1)}%) · back to entry ${kinds("return")} (${backInProfit} of them 1+ pts up) · ` +
          `stopped ${kinds("stop")} · never back ${kinds("eod")} · wins that were 50+ against first ` +
          `${r.filter((t) => t.win && t.mae >= 50).length}`,
      );
    }
  }
  for (const [label, list] of [
    ["9:16 red PE", pe],
    ["9:16 green CE", ce],
  ] as const) {
    for (const period of [true, false]) {
      const p = list.filter((t) => t.recent === period);
      console.log(
        `${label} ${period ? "page window" : "year before"}: 9:16 same colour ${fmt(stats(p.filter((t) => t.confirm)))} · ` +
          `9:16 gap ${fmt(stats(p.filter((t) => !t.confirm)))}`,
      );
    }
  }
  report("9:16 red PE", pe);
  report("9:16 green CE", ce);
  report("9:16 both sides", trades);
  reportPairs("9:16 red PE", pe);
  reportPairs("9:16 green CE", ce);
  reportSwap("9:16 red PE", pe);
  reportSwap("9:16 green CE", ce);
  sweepYesterday("9:16 green CE", ce);
  sweepYesterday("9:16 red PE", pe);
  reportBothPeriods("9:16 red PE", pe);
  reportBothPeriods("9:16 green CE", ce);
  reportBothPeriods("9:16 both sides", trades);
  for (const pts of [50, 60, 80]) {
    const line = [pe, ce].map((list) =>
      [true, false]
        .map((period) => {
          const pool = list.filter((t) => t.recent === period);
          const w = pool.filter((t) => t.win && t.mae < pts).length;
          return `${period ? "page" : "year before"} ${((w / pool.length) * 100).toFixed(1)}%`;
        })
        .join(" / "),
    );
    console.log(`capital stop at ${pts} pts against: PE ${line[0]} · CE ${line[1]}`);
  }
  sweepTargets(days);
  const byDate = new Map(days.map((d) => [d.date, d]));
  console.log("\n=== 9:17 opposite-body exit (9:16 body against the 9:15 body and at least as big) ===");
  for (const side of ["PE", "CE"] as const) {
    for (const period of [true, false]) {
      const pool = trades.filter((t) => t.side === side && t.recent === period);
      const fired = pool.filter((t) => {
        const d = byDate.get(t.date)!;
        const b915 = d.c[M915] - d.o[M915];
        const b916 = d.c[M916] - d.o[M916];
        const targetBy916 = t.kind === "target" && t.exitMin === M916;
        return !targetBy916 && b916 !== 0 && Math.sign(b916) !== Math.sign(b915) && Math.abs(b916) >= Math.abs(b915);
      });
      const exitPts = fired.map((t) => t.dir * (byDate.get(t.date)!.o[M916 + 1] - t.entry));
      const firedWins = fired.filter((t) => t.win).length;
      console.log(
        `  ${side} ${period ? "page" : "year before"}: fires on ${fired.length}/${pool.length} · of those the page had ${firedWins} wins, ${fired.length - firedWins} losses · ` +
          `exit at 9:17 open: ${exitPts.filter((p) => p > 0).length} in profit, ${exitPts.filter((p) => p <= 0).length} not · ` +
          `points ${exitPts.reduce((s, p) => s + p, 0).toFixed(0)} vs page ${fired.reduce((s, t) => s + t.points, 0).toFixed(0)} · ` +
          fired.map((t, i) => `${t.date.slice(2)} ${t.win ? "W" : "L"} ${exitPts[i].toFixed(0)}`).join(", "),
      );
    }
  }
  if (process.env.DATES) printDates(days, process.env.DATES, trades);
  if (process.env.LOSERS === "1") {
    printLosers("9:16 red PE", pe);
    printLosers("9:16 green CE", ce);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
