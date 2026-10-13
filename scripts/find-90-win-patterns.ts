/**
 * Look for Nifty entries that win at least 90% with the 5-to-10 point trail
 * (lock +5 once 5 points in profit, close at +10). Every rule is also scored
 * on each half of the year so a lucky half cannot pass on its own.
 *
 * Run: npx tsx scripts/find-90-win-patterns.ts
 * FETCH_ONLY=1 writes data/nifty-minute-year.json.gz and exits.
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import "../server/load-env.js";
import { fetchHistoricalCandles } from "../server/kite-candles.js";
import { loadKiteSession } from "../server/kite-session-store.js";
import { chunk, groupSessionBars, isCompleteSession, listWeekdayDates } from "../server/session-bars.js";

const CACHE = path.join(process.cwd(), "data", "nifty-minute-year.json.gz");
const SPOT = "NSE:NIFTY 50";
const DAY_MINS = 960;
const OPEN = 9 * 60 + 15;
const OR_END = 9 * 60 + 44;
const FIRST = 9 * 60 + 20;
const LAST = 15 * 60;
const FLAT = 15 * 60 + 20;
const NM = LAST - FIRST + 1;
const CAP = 10;
const LOCK = 5;
const ARM = 5;
const TRAIL = 3;

const GEOMS = [
  { label: "stop 20", stop: 20, hold: 0 },
  { label: "stop 25", stop: 25, hold: 0 },
  { label: "stop 30", stop: 30, hold: 0 },
  { label: "stop 40", stop: 40, hold: 0 },
  { label: "stop 25, out after 60 min", stop: 25, hold: 60 },
  { label: "stop 30, out after 60 min", stop: 30, hold: 60 },
  { label: "stop 40, out after 60 min", stop: 40, hold: 60 },
];
const G = GEOMS.length;

type RawDay = { date: string; bars: number[][] };

interface Day {
  date: string;
  weekday: number;
  half: 1 | 2;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  hi: Float64Array;
  lo: Float64Array;
  sma20: Float64Array;
  rsi: Float64Array;
  open: number;
  prevOpen: number;
  prevHigh: number;
  prevLow: number;
  prevClose: number;
  orHigh: number;
  orLow: number;
}

interface Kept {
  fam: string;
  key: string;
  desc: string;
  g: number;
  n: number;
  w: number;
  sum: number;
  worst: number;
  n1: number;
  w1: number;
  s1: number;
  n2: number;
  w2: number;
  s2: number;
  base: number;
}

async function loadRaw(): Promise<RawDay[]> {
  if (fs.existsSync(CACHE)) {
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(CACHE)).toString("utf8")) as RawDay[];
  }
  const session = loadKiteSession();
  if (!session?.accessToken) throw new Error("No Kite session and no cached minute bars");
  const out: RawDay[] = [];
  for (const group of chunk(listWeekdayDates(365), 25)) {
    const from = `${group[0]} 09:15:00`;
    const to = `${group[group.length - 1]} 15:30:00`;
    process.stderr.write(`fetch ${from} → ${to}\n`);
    const { candles } = await fetchHistoricalCandles(session.accessToken, SPOT, "minute", from, to);
    if (!Array.isArray(candles)) throw new Error(`Invalid candle payload for ${from}`);
    for (const [date, bars] of groupSessionBars(candles)) {
      if (!isCompleteSession(bars)) continue;
      out.push({ date, bars: bars.map((bar) => [bar.mins, bar.open, bar.high, bar.low, bar.close]) });
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, zlib.gzipSync(JSON.stringify(out)));
  return out;
}

function nanArr(): Float64Array {
  return new Float64Array(DAY_MINS).fill(Number.NaN);
}

function buildDays(raw: RawDay[]): Day[] {
  const days: Day[] = [];
  const mid = raw[Math.floor(raw.length / 2)]?.date ?? "";
  let prevBar: { open: number; high: number; low: number; close: number } | null = null;
  let lastClose: number | null = null;
  let seeded = 0;
  let gainSum = 0;
  let lossSum = 0;
  let avgGain = 0;
  let avgLoss = 0;

  for (const rd of raw) {
    const o = nanArr();
    const h = nanArr();
    const l = nanArr();
    const c = nanArr();
    const hi = nanArr();
    const lo = nanArr();
    const sma20 = nanArr();
    const rsi = nanArr();
    const closes: number[] = [];
    let dayHigh = -Infinity;
    let dayLow = Infinity;
    let orHigh = -Infinity;
    let orLow = Infinity;

    for (const [mins, bo, bh, bl, bc] of rd.bars) {
      o[mins] = bo;
      h[mins] = bh;
      l[mins] = bl;
      c[mins] = bc;
      if (bh > dayHigh) dayHigh = bh;
      if (bl < dayLow) dayLow = bl;
      hi[mins] = dayHigh;
      lo[mins] = dayLow;
      if (mins <= OR_END) {
        if (bh > orHigh) orHigh = bh;
        if (bl < orLow) orLow = bl;
      }
      closes.push(bc);
      if (closes.length >= 20) {
        let sum = 0;
        for (let i = closes.length - 20; i < closes.length; i += 1) sum += closes[i];
        sma20[mins] = sum / 20;
      }
      if (lastClose != null) {
        const change = bc - lastClose;
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;
        if (seeded < 14) {
          gainSum += gain;
          lossSum += loss;
          seeded += 1;
          if (seeded === 14) {
            avgGain = gainSum / 14;
            avgLoss = lossSum / 14;
          }
        } else {
          avgGain = (avgGain * 13 + gain) / 14;
          avgLoss = (avgLoss * 13 + loss) / 14;
        }
        if (seeded >= 14) rsi[mins] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
      lastClose = bc;
    }

    const first = rd.bars[0];
    const last = rd.bars[rd.bars.length - 1];
    days.push({
      date: rd.date,
      weekday: new Date(`${rd.date}T12:00:00+05:30`).getUTCDay(),
      half: rd.date < mid ? 1 : 2,
      o,
      h,
      l,
      c,
      hi,
      lo,
      sma20,
      rsi,
      open: o[OPEN],
      prevOpen: prevBar?.open ?? Number.NaN,
      prevHigh: prevBar?.high ?? Number.NaN,
      prevLow: prevBar?.low ?? Number.NaN,
      prevClose: prevBar?.close ?? Number.NaN,
      orHigh,
      orLow,
    });
    prevBar = { open: first?.[1] ?? Number.NaN, high: dayHigh, low: dayLow, close: last?.[4] ?? Number.NaN };
  }
  return days;
}

function has(day: Day, m: number): boolean {
  return m >= 0 && m < DAY_MINS && day.c[m] === day.c[m];
}

function nextBar(day: Day, after: number): number {
  for (let m = after + 1; m <= Math.min(FLAT, after + 5); m += 1) if (has(day, m)) return m;
  return -1;
}

function simTrail(day: Day, entryMin: number, dir: 1 | -1, stopPts: number, deadline: number): number {
  const { o, h, l, c } = day;
  const entry = o[entryMin];
  let stop = entry - dir * stopPts;
  const cap = entry + dir * CAP;
  let peak = 0;
  let lastClose = Number.NaN;
  for (let m = entryMin; m <= deadline; m += 1) {
    const bo = o[m];
    if (bo !== bo) continue;
    if (m > entryMin) {
      if (dir === 1 ? bo <= stop : bo >= stop) return dir * (bo - entry);
      if (dir === 1 ? bo >= cap : bo <= cap) return dir * (bo - entry);
    }
    if (dir === 1 ? l[m] <= stop : h[m] >= stop) return dir * (stop - entry);
    if (dir === 1 ? h[m] >= cap : l[m] <= cap) return CAP;
    const fav = dir === 1 ? h[m] - entry : entry - l[m];
    if (fav > peak) {
      peak = fav;
      if (peak >= ARM) {
        const next = entry + dir * Math.min(peak, Math.max(peak - TRAIL, LOCK));
        if (dir === 1 ? next > stop : next < stop) stop = next;
      }
    }
    lastClose = c[m];
  }
  return lastClose === lastClose ? dir * (lastClose - entry) : Number.NaN;
}

function hhmm(mins: number): string {
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`;
}

type FeatureDef = {
  id: string;
  thetas: number[];
  value: (day: Day, m: number) => number;
  label: (theta: number) => string;
};

function move(lookback: number): FeatureDef["value"] {
  return (day, m) => day.c[m] - day.c[m - lookback];
}

const FEATURES: FeatureDef[] = [
  { id: "mv1", thetas: [8, 12, 16, 20], value: move(1), label: (t) => `1-min move ${t}+` },
  { id: "mv3", thetas: [10, 15, 20, 30], value: move(3), label: (t) => `3-min move ${t}+` },
  { id: "mv5", thetas: [10, 15, 20, 30, 40], value: move(5), label: (t) => `5-min move ${t}+` },
  { id: "mv10", thetas: [15, 20, 30, 40, 50], value: move(10), label: (t) => `10-min move ${t}+` },
  { id: "mv15", thetas: [15, 20, 30, 40, 50, 60], value: move(15), label: (t) => `15-min move ${t}+` },
  { id: "mv30", thetas: [20, 30, 40, 60, 80], value: move(30), label: (t) => `30-min move ${t}+` },
  { id: "mv60", thetas: [30, 40, 60, 80, 100], value: move(60), label: (t) => `60-min move ${t}+` },
  {
    id: "fromOpen",
    thetas: [30, 50, 75, 100, 150],
    value: (day, m) => day.c[m] - day.open,
    label: (t) => `${t}+ away from the 9:15 open`,
  },
  {
    id: "sma20",
    thetas: [8, 12, 16, 20, 30],
    value: (day, m) => day.c[m] - day.sma20[m],
    label: (t) => `${t}+ away from the 20-min average`,
  },
  {
    id: "rsi",
    thetas: [20, 25, 30, 35],
    value: (day, m) => day.rsi[m] - 50,
    label: (t) => `1-min RSI ${50 + t}+ or ${50 - t} and under`,
  },
  {
    id: "gap",
    thetas: [30, 50, 75, 100],
    value: (day) => day.open - day.prevClose,
    label: (t) => `gap ${t}+ from yesterday's close`,
  },
  {
    id: "prevDay",
    thetas: [50, 100, 150],
    value: (day) => day.prevClose - day.prevOpen,
    label: (t) => `yesterday moved ${t}+`,
  },
  {
    id: "rangePos",
    thetas: [80, 90, 95],
    value: (day, m) => {
      const range = day.hi[m] - day.lo[m];
      if (!(range >= 40)) return Number.NaN;
      return ((day.c[m] - (day.hi[m] + day.lo[m]) / 2) / (range / 2)) * 100;
    },
    label: (t) => `in the outer ${(100 - t) / 2}% of the day's range so far (range 40+)`,
  },
];

type FilterDef = { id: string; test: (day: Day, m: number) => boolean };

function range15(day: Day, m: number): number {
  let high = -Infinity;
  let low = Infinity;
  for (let k = m - 14; k <= m; k += 1) {
    if (!has(day, k)) continue;
    if (day.h[k] > high) high = day.h[k];
    if (day.l[k] < low) low = day.l[k];
  }
  return high - low;
}

const DAY_FILTERS: FilterDef[] = [
  { id: "any day", test: () => true },
  { id: "Monday", test: (day) => day.weekday === 1 },
  { id: "Tuesday (expiry)", test: (day) => day.weekday === 2 },
  { id: "Wednesday", test: (day) => day.weekday === 3 },
  { id: "Thursday", test: (day) => day.weekday === 4 },
  { id: "Friday", test: (day) => day.weekday === 5 },
  { id: "gap under 30", test: (day) => Math.abs(day.open - day.prevClose) < 30 },
  { id: "gap 50+", test: (day) => Math.abs(day.open - day.prevClose) >= 50 },
];

const INTRADAY_FILTERS: FilterDef[] = [
  {
    id: "day range so far under 60% of yesterday's",
    test: (day, m) => day.hi[m] - day.lo[m] < 0.6 * (day.prevHigh - day.prevLow),
  },
  {
    id: "day range so far bigger than yesterday's",
    test: (day, m) => day.hi[m] - day.lo[m] > day.prevHigh - day.prevLow,
  },
  { id: "last 15 min range under 20", test: (day, m) => range15(day, m) < 20 },
  { id: "last 15 min range 40+", test: (day, m) => range15(day, m) >= 40 },
];

const ALL_FILTERS = [...DAY_FILTERS, ...INTRADAY_FILTERS];

function wilsonLow(wins: number, n: number): number {
  if (n === 0) return 0;
  const z = 1.96;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (centre - margin) / denom;
}

async function main(): Promise<void> {
  const raw = await loadRaw();
  if (process.env.FETCH_ONLY === "1") {
    console.log(`cached ${raw.length} sessions ${raw[0]?.date} → ${raw[raw.length - 1]?.date} at ${CACHE}`);
    return;
  }
  const days = buildDays(raw);
  const D = days.length;
  process.stderr.write(`sessions ${D}\n`);

  const tables = GEOMS.map(() => new Float32Array(D * NM * 2).fill(Number.NaN));
  for (let d = 0; d < D; d += 1) {
    const day = days[d];
    for (let m = FIRST; m <= LAST; m += 1) {
      if (!has(day, m)) continue;
      const e = nextBar(day, m);
      if (e < 0) continue;
      const idx = (d * NM + (m - FIRST)) * 2;
      for (let g = 0; g < G; g += 1) {
        const geom = GEOMS[g];
        const deadline = geom.hold > 0 ? Math.min(FLAT, e + geom.hold) : FLAT;
        tables[g][idx] = simTrail(day, e, 1, geom.stop, deadline);
        tables[g][idx + 1] = simTrail(day, e, -1, geom.stop, deadline);
      }
    }
  }
  process.stderr.write("outcomes ready\n");

  const baseByM = GEOMS.map(() => new Float64Array(NM));
  const baseAll: number[] = [];
  for (let g = 0; g < G; g += 1) {
    let allWins = 0;
    let allN = 0;
    for (let k = 0; k < NM; k += 1) {
      let wins = 0;
      let n = 0;
      for (let d = 0; d < D; d += 1) {
        for (let s = 0; s < 2; s += 1) {
          const pnl = tables[g][(d * NM + k) * 2 + s];
          if (pnl !== pnl) continue;
          n += 1;
          if (pnl > 0) wins += 1;
        }
      }
      baseByM[g][k] = n > 0 ? wins / n : 0;
      allWins += wins;
      allN += n;
    }
    baseAll.push(allN > 0 ? allWins / allN : 0);
  }

  const kept: Kept[] = [];
  let tested = 0;
  const tD = new Int32Array(D);
  const tM = new Int32Array(D);
  const tDir = new Int8Array(D);
  const nullSeed = Number(process.env.NULL_SEED ?? 0);
  let rng = nullSeed > 0 ? nullSeed >>> 0 : 0;
  const coin = (): 1 | -1 => {
    rng ^= rng << 13;
    rng >>>= 0;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    rng >>>= 0;
    return rng & 1 ? 1 : -1;
  };
  if (nullSeed > 0) console.log(`Coin-flip run: every trade's call or put is random (seed ${nullSeed}).`);

  function score(count: number, fam: string, key: string, describe: () => string): void {
    if (nullSeed > 0) for (let i = 0; i < count; i += 1) tDir[i] = coin();
    for (let g = 0; g < G; g += 1) {
      tested += 1;
      const table = tables[g];
      const base = baseByM[g];
      let n = 0;
      let w = 0;
      let sum = 0;
      let worst = 0;
      let n1 = 0;
      let w1 = 0;
      let s1 = 0;
      let n2 = 0;
      let w2 = 0;
      let s2 = 0;
      let bsum = 0;
      for (let i = 0; i < count; i += 1) {
        const pnl = table[(tD[i] * NM + (tM[i] - FIRST)) * 2 + (tDir[i] === 1 ? 0 : 1)];
        if (pnl !== pnl) continue;
        const win = pnl > 0 ? 1 : 0;
        n += 1;
        w += win;
        sum += pnl;
        if (pnl < worst) worst = pnl;
        bsum += base[tM[i] - FIRST];
        if (days[tD[i]].half === 1) {
          n1 += 1;
          w1 += win;
          s1 += pnl;
        } else {
          n2 += 1;
          w2 += win;
          s2 += pnl;
        }
      }
      const fullPass = n >= 40 && w / n >= 0.9;
      const h1Pass = n1 >= 20 && w1 / n1 >= 0.92 && s1 / n1 >= 2;
      const h2Pass = n2 >= 20 && w2 / n2 >= 0.92 && s2 / n2 >= 2;
      if (!fullPass && !h1Pass && !h2Pass) continue;
      kept.push({
        fam,
        key,
        desc: describe(),
        g,
        n,
        w,
        sum,
        worst,
        n1,
        w1,
        s1,
        n2,
        w2,
        s2,
        base: n > 0 ? bsum / n : 0,
      });
    }
  }

  const sides: Array<{ id: string; mult: 1 | -1 }> = [
    { id: "fade", mult: -1 },
    { id: "follow", mult: 1 },
  ];

  // Clock rules: decide on the close of one fixed candle, enter on the next open.
  const featVals = new Float64Array(D);
  const filterPass = ALL_FILTERS.map(() => new Uint8Array(D));
  for (let T = FIRST; T <= LAST; T += 5) {
    for (let fi = 0; fi < ALL_FILTERS.length; fi += 1) {
      for (let d = 0; d < D; d += 1) {
        filterPass[fi][d] = has(days[d], T) && ALL_FILTERS[fi].test(days[d], T) ? 1 : 0;
      }
    }
    for (const feat of FEATURES) {
      for (let d = 0; d < D; d += 1) featVals[d] = has(days[d], T) ? feat.value(days[d], T) : Number.NaN;
      for (const theta of feat.thetas) {
        for (const side of sides) {
          for (let fi = 0; fi < ALL_FILTERS.length; fi += 1) {
            let count = 0;
            for (let d = 0; d < D; d += 1) {
              const v = featVals[d];
              if (!(Math.abs(v) >= theta) || !filterPass[fi][d]) continue;
              tD[count] = d;
              tM[count] = T;
              tDir[count] = (side.mult * (v > 0 ? 1 : -1)) as 1 | -1;
              count += 1;
            }
            if (count < 20) continue;
            score(
              count,
              "clock",
              `clock|${T}|${feat.id}|${side.id}`,
              () => `${hhmm(T)} candle close · ${feat.label(theta)} · ${side.id} · ${ALL_FILTERS[fi].id}`,
            );
          }
        }
      }
    }
  }
  process.stderr.write(`clock rules done (${tested})\n`);

  // First trigger inside a window.
  const WINDOWS: Array<[number, number]> = [
    [FIRST, 10 * 60],
    [10 * 60, 11 * 60],
    [11 * 60, 12 * 60],
    [12 * 60, 13 * 60 + 30],
    [13 * 60 + 30, 14 * 60 + 30],
    [14 * 60 + 30, LAST],
    [FIRST, LAST],
  ];
  const firstM = new Int32Array(D);
  const firstSign = new Int8Array(D);
  for (const [from, to] of WINDOWS) {
    for (const feat of FEATURES) {
      for (const theta of feat.thetas) {
        for (let d = 0; d < D; d += 1) {
          firstM[d] = -1;
          const day = days[d];
          for (let m = from; m <= to; m += 1) {
            if (!has(day, m)) continue;
            const v = feat.value(day, m);
            if (Math.abs(v) >= theta) {
              firstM[d] = m;
              firstSign[d] = v > 0 ? 1 : -1;
              break;
            }
          }
        }
        for (const side of sides) {
          for (let fi = 0; fi < DAY_FILTERS.length; fi += 1) {
            let count = 0;
            for (let d = 0; d < D; d += 1) {
              if (firstM[d] < 0 || !DAY_FILTERS[fi].test(days[d], firstM[d])) continue;
              tD[count] = d;
              tM[count] = firstM[d];
              tDir[count] = (side.mult * firstSign[d]) as 1 | -1;
              count += 1;
            }
            if (count < 20) continue;
            score(
              count,
              "window",
              `window|${from}-${to}|${feat.id}|${side.id}`,
              () =>
                `first time ${hhmm(from)}–${hhmm(to)} · ${feat.label(theta)} · ${side.id} · ${DAY_FILTERS[fi].id}`,
            );
          }
        }
      }
    }
  }
  process.stderr.write(`window rules done (${tested})\n`);

  // Levels: first touch after a start time.
  type LevelEvent = { id: string; find: (day: Day, start: number) => [number, number] | null };
  const LEVELS: LevelEvent[] = [
    {
      id: "first touch of yesterday's high",
      find: (day, start) => {
        if (!(day.open < day.prevHigh)) return null;
        for (let m = start; m <= LAST; m += 1) if (has(day, m) && day.h[m] >= day.prevHigh) return [m, 1];
        return null;
      },
    },
    {
      id: "first touch of yesterday's low",
      find: (day, start) => {
        if (!(day.open > day.prevLow)) return null;
        for (let m = start; m <= LAST; m += 1) if (has(day, m) && day.l[m] <= day.prevLow) return [m, -1];
        return null;
      },
    },
    {
      id: "first break of the 9:15–9:44 high",
      find: (day, start) => {
        for (let m = Math.max(start, OR_END + 1); m <= LAST; m += 1) if (has(day, m) && day.h[m] > day.orHigh) return [m, 1];
        return null;
      },
    },
    {
      id: "first break of the 9:15–9:44 low",
      find: (day, start) => {
        for (let m = Math.max(start, OR_END + 1); m <= LAST; m += 1) if (has(day, m) && day.l[m] < day.orLow) return [m, -1];
        return null;
      },
    },
    {
      id: "first break of the 9:15 candle",
      find: (day, start) => {
        const high = day.h[OPEN];
        const low = day.l[OPEN];
        for (let m = Math.max(start, FIRST); m <= LAST; m += 1) {
          if (!has(day, m)) continue;
          const up = day.h[m] > high;
          const down = day.l[m] < low;
          if (up && down) return null;
          if (up) return [m, 1];
          if (down) return [m, -1];
        }
        return null;
      },
    },
    {
      id: "first touch of a round 100 level",
      find: (day, start) => {
        for (let m = start; m <= LAST; m += 1) {
          if (!has(day, m) || !has(day, m - 1)) continue;
          const level = Math.ceil(day.l[m] / 100) * 100;
          if (level > day.h[m]) continue;
          const prev = day.c[m - 1];
          if (prev < level) return [m, 1];
          if (prev > level) return [m, -1];
        }
        return null;
      },
    },
    ...[60, 100, 150].map(
      (range): LevelEvent => ({
        id: `first new day high or low once the day's range is ${range}+`,
        find: (day, start) => {
          for (let m = start; m <= LAST; m += 1) {
            if (!has(day, m) || !has(day, m - 1)) continue;
            if (day.hi[m] - day.lo[m] < range) continue;
            const up = day.h[m] > day.hi[m - 1];
            const down = day.l[m] < day.lo[m - 1];
            if (up && down) return null;
            if (up) return [m, 1];
            if (down) return [m, -1];
          }
          return null;
        },
      }),
    ),
    {
      id: "first return to the 9:15 open after being 40+ away",
      find: (day, start) => {
        let away = 0;
        for (let m = OPEN; m <= LAST; m += 1) {
          if (!has(day, m)) continue;
          if (m >= start && away >= 40 && day.l[m] <= day.open && day.h[m] >= day.open && has(day, m - 1)) {
            return [m, day.c[m - 1] > day.open ? -1 : 1];
          }
          away = Math.max(away, Math.abs(day.h[m] - day.open), Math.abs(day.l[m] - day.open));
        }
        return null;
      },
    },
  ];
  const STARTS = [9 * 60 + 30, 10 * 60, 11 * 60, 12 * 60, 13 * 60, 14 * 60];
  for (const level of LEVELS) {
    for (const start of STARTS) {
      const found = days.map((day) => (Number.isFinite(day.prevClose) ? level.find(day, start) : null));
      for (const side of sides) {
        for (let fi = 0; fi < DAY_FILTERS.length; fi += 1) {
          let count = 0;
          for (let d = 0; d < D; d += 1) {
            const hit = found[d];
            if (!hit || !DAY_FILTERS[fi].test(days[d], hit[0])) continue;
            tD[count] = d;
            tM[count] = hit[0];
            tDir[count] = (side.mult * hit[1]) as 1 | -1;
            count += 1;
          }
          if (count < 20) continue;
          score(
            count,
            "level",
            `level|${level.id}|${start}|${side.id}`,
            () => `${level.id} after ${hhmm(start)} · ${side.id} · ${DAY_FILTERS[fi].id}`,
          );
        }
      }
    }
  }
  process.stderr.write(`level rules done (${tested})\n`);

  const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "—");
  const line = (k: Kept) =>
    `${pct(k.w, k.n)} n=${k.n} avg ${(k.sum / k.n).toFixed(1)} worst ${k.worst.toFixed(1)} | ` +
    `H1 ${pct(k.w1, k.n1)} (${k.n1}) avg ${k.n1 ? (k.s1 / k.n1).toFixed(1) : "—"} | ` +
    `H2 ${pct(k.w2, k.n2)} (${k.n2}) avg ${k.n2 ? (k.s2 / k.n2).toFixed(1) : "—"} | ` +
    `random entry ${(k.base * 100).toFixed(1)}% | ${GEOMS[k.g].label} | ${k.desc}`;

  console.log("");
  console.log(`Sessions ${days[0]?.date} → ${days[D - 1]?.date} (${D}). First half ends ${days.find((d) => d.half === 2)?.date}.`);
  console.log(`Exit: lock +${LOCK} once ${ARM} points in profit, trail ${TRAIL} behind, close at +${CAP}.`);
  console.log(`Rule and exit combinations tested: ${tested}`);
  console.log("");
  console.log("Win rate of a random entry (any minute 9:20–15:00, either direction) with each exit:");
  for (let g = 0; g < G; g += 1) console.log(`  ${GEOMS[g].label.padEnd(28)} ${(baseAll[g] * 100).toFixed(1)}%`);

  const robust = kept.filter(
    (k) =>
      k.n >= 40 &&
      k.n1 >= 15 &&
      k.n2 >= 15 &&
      k.w / k.n >= 0.9 &&
      k.w1 / k.n1 >= 0.9 &&
      k.w2 / k.n2 >= 0.9 &&
      k.sum / k.n >= 2 &&
      k.s1 > 0 &&
      k.s2 > 0,
  );
  robust.sort((a, b) => wilsonLow(b.w, b.n) - wilsonLow(a.w, a.n) || b.sum / b.n - a.sum / a.n);
  const seen = new Set<string>();
  const robustTop: Kept[] = [];
  for (const k of robust) {
    const groupKey = `${k.key}|${GEOMS[k.g].stop}`;
    if (seen.has(groupKey)) continue;
    seen.add(groupKey);
    robustTop.push(k);
  }
  console.log("");
  console.log(`At least 90% in the full year and in each half, 40+ trades, average 2+ points: ${robust.length} rules, ${robustTop.length} distinct`);
  for (const stop of [20, 25, 30, 40]) {
    console.log(`  with stop ${stop}: ${robust.filter((k) => GEOMS[k.g].stop === stop).length}`);
  }
  for (const stop of [20, 25, 30, 40]) {
    const best = robust.find((k) => GEOMS[k.g].stop === stop);
    const bestLow = best ? wilsonLow(best.w, best.n) : 0;
    console.log(
      `  BEST stop ${stop}: ${best ? `${(bestLow * 100).toFixed(1)}% lower edge · ${line(best)}` : "none"}`,
    );
  }
  console.log("Strongest distinct (by the lower edge of the 95% range on the win rate):");
  for (const k of robustTop.slice(0, 30)) console.log(`  ${line(k)}`);

  function holdout(label: string, pick: (k: Kept) => boolean, test: (k: Kept) => [number, number, number]): void {
    const picked = kept.filter(pick);
    let tn = 0;
    let tw = 0;
    let held = 0;
    let checked = 0;
    let baseSum = 0;
    for (const k of picked) {
      const [n, w, s] = test(k);
      if (n < 10) continue;
      checked += 1;
      tn += n;
      tw += w;
      baseSum += k.base;
      if (w / n >= 0.9 && s / n >= 1.5) held += 1;
    }
    console.log("");
    console.log(
      `${label}: ${picked.length} rules picked, ${checked} traded 10+ times in the other half. ` +
        `They won ${pct(tw, tn)} there (random entry ${checked ? ((baseSum / checked) * 100).toFixed(1) : "—"}%). ` +
        `${held} stayed at 90%+ with 1.5+ points average.`,
    );
  }
  holdout(
    "Picked on the first half (92%+, 20+ trades, 2+ points), checked on the second",
    (k) => k.n1 >= 20 && k.w1 / k.n1 >= 0.92 && k.s1 / k.n1 >= 2,
    (k) => [k.n2, k.w2, k.s2],
  );
  holdout(
    "Picked on the second half, checked on the first",
    (k) => k.n2 >= 20 && k.w2 / k.n2 >= 0.92 && k.s2 / k.n2 >= 2,
    (k) => [k.n1, k.w1, k.s1],
  );

  for (const stop of [20, 25, 30]) {
    const tight = robustTop.filter((k) => GEOMS[k.g].stop === stop);
    if (tight.length === 0) continue;
    console.log("");
    console.log(`Stop ${stop} (random entry wins about ${(baseAll[GEOMS.findIndex((g) => g.stop === stop && g.hold === 0)] * 100).toFixed(0)}%):`);
    for (const k of tight.slice(0, 12)) console.log(`  ${line(k)}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
