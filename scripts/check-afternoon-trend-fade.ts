/**
 * Neighbours of the strongest search result: in the afternoon, Nifty is far
 * from the 9:15 open. Fade or follow it with the 5-to-10 trail.
 *
 * Run: npx tsx scripts/check-afternoon-trend-fade.ts (needs data/nifty-minute-year.json.gz)
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";

type RawDay = { date: string; bars: number[][] };
const raw = JSON.parse(
  zlib.gunzipSync(fs.readFileSync(path.join(process.cwd(), "data", "nifty-minute-year.json.gz"))).toString("utf8"),
) as RawDay[];

const OPEN = 9 * 60 + 15;
const FLAT = 15 * 60 + 20;
const mid = raw[Math.floor(raw.length / 2)].date;

interface Day {
  date: string;
  o: Map<number, number[]>;
  open: number;
  hi: Map<number, number>;
  lo: Map<number, number>;
  prevRange: number;
}

const days: Day[] = [];
let prevRange = Number.NaN;
for (const rd of raw) {
  const o = new Map<number, number[]>();
  const hi = new Map<number, number>();
  const lo = new Map<number, number>();
  let high = -Infinity;
  let low = Infinity;
  for (const bar of rd.bars) {
    o.set(bar[0], bar);
    high = Math.max(high, bar[2]);
    low = Math.min(low, bar[3]);
    hi.set(bar[0], high);
    lo.set(bar[0], low);
  }
  days.push({ date: rd.date, o, open: o.get(OPEN)?.[1] ?? Number.NaN, hi, lo, prevRange });
  prevRange = high - low;
}

function trail(day: Day, entryMin: number, dir: 1 | -1, stopPts: number): number | null {
  const first = day.o.get(entryMin);
  if (!first) return null;
  const entry = first[1];
  let stop = entry - dir * stopPts;
  const cap = entry + dir * 10;
  let peak = 0;
  let last = Number.NaN;
  for (let m = entryMin; m <= FLAT; m += 1) {
    const bar = day.o.get(m);
    if (!bar) continue;
    const [, bo, bh, bl, bc] = bar;
    if (m > entryMin) {
      if (dir === 1 ? bo <= stop : bo >= stop) return dir * (bo - entry);
      if (dir === 1 ? bo >= cap : bo <= cap) return dir * (bo - entry);
    }
    if (dir === 1 ? bl <= stop : bh >= stop) return dir * (stop - entry);
    if (dir === 1 ? bh >= cap : bl <= cap) return 10;
    const fav = dir === 1 ? bh - entry : entry - bl;
    if (fav > peak) {
      peak = fav;
      if (peak >= 5) {
        const next = entry + dir * Math.min(peak, Math.max(peak - 3, 5));
        if (dir === 1 ? next > stop : next < stop) stop = next;
      }
    }
    last = bc;
  }
  return Number.isFinite(last) ? dir * (last - entry) : null;
}

function run(time: number, minAway: number, needWideDay: boolean, side: 1 | -1, stopPts: number) {
  let n = 0;
  let w = 0;
  let sum = 0;
  let n1 = 0;
  let w1 = 0;
  for (const day of days) {
    const bar = day.o.get(time);
    if (!bar || !Number.isFinite(day.open) || !Number.isFinite(day.prevRange)) continue;
    const away = bar[4] - day.open;
    if (Math.abs(away) < minAway) continue;
    if (needWideDay && !((day.hi.get(time) ?? 0) - (day.lo.get(time) ?? 0) > day.prevRange)) continue;
    const dir = (side * (away > 0 ? 1 : -1)) as 1 | -1;
    const pnl = trail(day, time + 1, dir, stopPts);
    if (pnl == null) continue;
    n += 1;
    sum += pnl;
    if (pnl > 0) w += 1;
    if (day.date < mid) {
      n1 += 1;
      if (pnl > 0) w1 += 1;
    }
  }
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
  return `${pct(w, n).padStart(6)} of ${String(n).padStart(3)}  avg ${(n ? sum / n : 0).toFixed(1).padStart(5)}  halves ${pct(w1, n1)} / ${pct(w - w1, n - n1)}`;
}

const hhmm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
for (const needWideDay of [true, false]) {
  console.log("");
  console.log(`Nifty 100+ from the 9:15 open${needWideDay ? " and the day's range already bigger than yesterday's" : ""} · stop 25`);
  for (let t = 13 * 60 + 30; t <= 14 * 60 + 45; t += 5) {
    console.log(`  ${hhmm(t)}  fade ${run(t, 100, needWideDay, -1, 25)}   follow ${run(t, 100, needWideDay, 1, 25)}`);
  }
}
if (process.env.LIST === "1") {
  const t = 14 * 60 + 5;
  let calls = 0;
  let puts = 0;
  let sum = 0;
  console.log("");
  console.log("Every 14:05 trade (100+ from the open, day range bigger than yesterday's, fade, stop 25):");
  for (const day of days) {
    const bar = day.o.get(t);
    if (!bar || !Number.isFinite(day.open) || !Number.isFinite(day.prevRange)) continue;
    const away = bar[4] - day.open;
    if (Math.abs(away) < 100) continue;
    if (!((day.hi.get(t) ?? 0) - (day.lo.get(t) ?? 0) > day.prevRange)) continue;
    const dir = (away > 0 ? -1 : 1) as 1 | -1;
    const pnl = trail(day, t + 1, dir, 25);
    if (pnl == null) continue;
    if (dir === 1) calls += 1;
    else puts += 1;
    sum += pnl;
    console.log(
      `  ${day.date}  ${away > 0 ? "up" : "down"} ${Math.abs(away).toFixed(1)} → ${dir === 1 ? "CALL" : "PUT "}  entry ${day.o.get(t + 1)?.[1].toFixed(2)}  ${pnl > 0 ? "WIN " : "LOSS"} ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}`,
    );
  }
  console.log(`  calls ${calls} · puts ${puts} · total ${sum.toFixed(1)} pts`);
}

console.log("");
console.log("14:05, day range bigger than yesterday's, fade, stop 25, by distance from the open:");
for (const away of [50, 75, 100, 125, 150]) console.log(`  ${String(away).padStart(3)}+  ${run(14 * 60 + 5, away, true, -1, 25)}`);
