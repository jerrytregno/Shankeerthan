/**
 * Last-year study: does the 9:15→9:30 Nifty move point the same way as the day?
 * Run on the server: npx tsx scripts/opening-speed-day-trend.ts
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
const OPEN_MINS = 9 * 60 + 15;
const END_930_MINS = 9 * 60 + 29;
const SESSION_CLOSE_MINS = 15 * 60 + 30;

const BANDS: { label: string; min: number; max: number }[] = [
  { label: "under 10", min: 0, max: 10 },
  { label: "10–20", min: 10, max: 20 },
  { label: "20–30", min: 20, max: 30 },
  { label: "30–40", min: 30, max: 40 },
  { label: "40–60", min: 40, max: 60 },
  { label: "60–80", min: 60, max: 80 },
  { label: "80–120", min: 80, max: 120 },
  { label: "120+", min: 120, max: Infinity },
];

const THRESHOLDS = [5, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120];

interface DayRow {
  date: string;
  open915: number;
  px930: number;
  dayClose: number;
  openingPts: number;
  dayPts: number;
  restPts: number;
  extremeMin: number;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function dir(v: number): -1 | 0 | 1 {
  const n = round2(v);
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "—";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function barAt(bars: MinuteBar[], mins: number): MinuteBar | undefined {
  return bars.find((bar) => bar.mins === mins);
}

function sessionClose(bars: MinuteBar[]): number | null {
  const atClose = bars.find((bar) => bar.mins === SESSION_CLOSE_MINS);
  if (atClose) return atClose.close;
  const last = bars[bars.length - 1];
  return last ? last.close : null;
}

function measureDay(date: string, bars: MinuteBar[]): DayRow | null {
  const openBar = barAt(bars, OPEN_MINS);
  const endBar = barAt(bars, END_930_MINS);
  const closePx = sessionClose(bars);
  if (!openBar || !endBar || closePx == null) return null;

  const window = bars.filter((bar) => bar.mins >= OPEN_MINS && bar.mins <= END_930_MINS);
  if (window.length < 10) return null;

  const openingPts = endBar.close - openBar.open;
  const goingUp = openingPts >= 0;
  let extremeMin = 0;
  let extremePx = goingUp ? -Infinity : Infinity;
  for (const bar of window) {
    const px = goingUp ? bar.high : bar.low;
    const better = goingUp ? px > extremePx : px < extremePx;
    if (better) {
      extremePx = px;
      extremeMin = bar.mins - OPEN_MINS;
    }
  }

  return {
    date,
    open915: round2(openBar.open),
    px930: round2(endBar.close),
    dayClose: round2(closePx),
    openingPts: round2(openingPts),
    dayPts: round2(closePx - openBar.open),
    restPts: round2(closePx - endBar.close),
    extremeMin,
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

interface Tally {
  days: number;
  dayMatch: number;
  dayMiss: number;
  dayFlat: number;
  restMatch: number;
  restMiss: number;
  restFlat: number;
  continueBoth: number;
  morningOnly: number;
}

function tally(rows: DayRow[]): Tally {
  const out: Tally = {
    days: 0,
    dayMatch: 0,
    dayMiss: 0,
    dayFlat: 0,
    restMatch: 0,
    restMiss: 0,
    restFlat: 0,
    continueBoth: 0,
    morningOnly: 0,
  };
  for (const row of rows) {
    const openDir = dir(row.openingPts);
    if (openDir === 0) continue;
    out.days += 1;
    const dayDir = dir(row.dayPts);
    const restDir = dir(row.restPts);
    if (dayDir === 0) out.dayFlat += 1;
    else if (dayDir === openDir) out.dayMatch += 1;
    else out.dayMiss += 1;
    if (restDir === 0) out.restFlat += 1;
    else if (restDir === openDir) out.restMatch += 1;
    else out.restMiss += 1;
    if (dayDir === openDir && restDir === openDir) out.continueBoth += 1;
    if (dayDir === openDir && restDir === -openDir) out.morningOnly += 1;
  }
  return out;
}

function printTally(label: string, rows: DayRow[]): void {
  const t = tally(rows);
  const decidedDay = t.dayMatch + t.dayMiss;
  const decidedRest = t.restMatch + t.restMiss;
  console.log(
    `${label.padEnd(12)} days ${String(t.days).padStart(4)}  ` +
      `day match ${String(t.dayMatch).padStart(4)}  miss ${String(t.dayMiss).padStart(4)}  ` +
      `flat ${String(t.dayFlat).padStart(2)}  (${pct(t.dayMatch, decidedDay)} of decided)  ` +
      `after 9:30 match ${String(t.restMatch).padStart(4)}  miss ${String(t.restMiss).padStart(4)}  ` +
      `(${pct(t.restMatch, decidedRest)})  ` +
      `continued ${t.continueBoth}  morning-only ${t.morningOnly}`,
  );
}

async function main(): Promise<void> {
  const session = loadKiteSession();
  if (!session?.accessToken) throw new Error("No Kite session on this machine");

  const dates = listWeekdayDates(LOOKBACK_CALENDAR_DAYS);
  const rows: DayRow[] = [];
  let skippedIncomplete = 0;

  for (const group of chunk(dates, CHUNK_TRADING_DAYS)) {
    const from = `${group[0]} 09:15:00`;
    const to = `${group[group.length - 1]} 15:30:00`;
    process.stderr.write(`fetch ${from} → ${to}\n`);
    const { candles } = await fetchHistoricalCandles(session.accessToken, SPOT, "minute", from, to);
    if (!Array.isArray(candles)) throw new Error(`Invalid candle payload for ${from}`);
    const byDate = groupSessionBars(candles);
    for (const [date, bars] of byDate) {
      if (!isCompleteSession(bars)) {
        skippedIncomplete += 1;
        continue;
      }
      const row = measureDay(date, bars);
      if (row) rows.push(row);
    }
    await new Promise((resolve) => setTimeout(resolve, FETCH_SPACING_MS));
  }

  rows.sort((a, b) => a.date.localeCompare(b.date));
  const directional = rows.filter((row) => dir(row.openingPts) !== 0);
  const flatOpen = rows.length - directional.length;
  const up = directional.filter((row) => dir(row.openingPts) > 0);
  const down = directional.filter((row) => dir(row.openingPts) < 0);

  console.log("");
  console.log("9:15 → 9:30 speed vs the rest of the session");
  console.log(`Sessions ${rows[0]?.date ?? "?"} → ${rows[rows.length - 1]?.date ?? "?"}  complete ${rows.length}  incomplete skipped ${skippedIncomplete}  flat open ${flatOpen}`);
  console.log("Opening move = 9:29 close − 9:15 open (15 minutes, the price at 9:30).");
  console.log("Day trend = 15:30 close − 9:15 open. After 9:30 = 15:30 close − 9:30 price.");
  console.log("Match = same direction. The day comparison includes the opening move. After 9:30 does not.");
  console.log("");

  printTally("all", directional);
  printTally("open up", up);
  printTally("open down", down);

  const signedRest = directional.map((row) => dir(row.openingPts) * row.restPts);
  const signedDay = directional.map((row) => dir(row.openingPts) * row.dayPts);
  console.log("");
  console.log(
    `Average move in the opening direction: day ${round2(mean(signedDay)).toFixed(2)} pts, ` +
      `after 9:30 ${round2(mean(signedRest)).toFixed(2)} pts ` +
      `(positive means the day kept going that way).`,
  );
  console.log(
    `Average |9:15→9:30| ${round2(mean(directional.map((row) => Math.abs(row.openingPts)))).toFixed(2)} pts ` +
      `(${round2(mean(directional.map((row) => Math.abs(row.openingPts) / 15))).toFixed(2)} pts/min).`,
  );

  console.log("");
  console.log("By absolute 9:15→9:30 speed (points in 15 minutes)");
  for (const band of BANDS) {
    const inBand = directional.filter((row) => {
      const abs = Math.abs(row.openingPts);
      return abs >= band.min && abs < band.max;
    });
    printTally(band.label, inBand);
  }

  console.log("");
  console.log("If we only keep days that moved at least this fast");
  for (const threshold of THRESHOLDS) {
    const kept = directional.filter((row) => Math.abs(row.openingPts) >= threshold);
    printTally(`≥ ${threshold}`, kept);
  }

  console.log("");
  console.log("How early the 15-minute extreme printed (0 = during the 9:15 minute)");
  const speedBands = [
    { label: "0–4 min", test: (m: number) => m <= 4 },
    { label: "5–9 min", test: (m: number) => m >= 5 && m <= 9 },
    { label: "10–14 min", test: (m: number) => m >= 10 },
  ];
  for (const band of speedBands) {
    printTally(band.label, directional.filter((row) => band.test(row.extremeMin)));
  }

  const ranked = [...directional].sort(
    (a, b) => Math.abs(b.openingPts) - Math.abs(a.openingPts),
  );
  console.log("");
  console.log("Fastest 15 openings");
  for (const row of ranked.slice(0, 15)) {
    const day = dir(row.openingPts) === dir(row.dayPts) ? "DAY MATCH" : dir(row.dayPts) === 0 ? "DAY FLAT" : "DAY MISS";
    const rest = dir(row.openingPts) === dir(row.restPts) ? "AFTER MATCH" : dir(row.restPts) === 0 ? "AFTER FLAT" : "AFTER MISS";
    console.log(
      `${row.date}  open ${row.openingPts >= 0 ? "+" : ""}${row.openingPts.toFixed(2)}  ` +
        `day ${row.dayPts >= 0 ? "+" : ""}${row.dayPts.toFixed(2)}  ` +
        `after ${row.restPts >= 0 ? "+" : ""}${row.restPts.toFixed(2)}  ${day}  ${rest}`,
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
