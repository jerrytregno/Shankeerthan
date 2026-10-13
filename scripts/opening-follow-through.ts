/**
 * If 9:15→9:30 is up, buy the continuation at 9:30. How far does Nifty follow
 * before it trades back to the 9:30 price, and when does that high print?
 * Same question for a down open. Last year of Nifty minute bars.
 *
 * Run: npx tsx scripts/opening-follow-through.ts
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
const ENTRY_MINS = 9 * 60 + 30;
const SESSION_CLOSE_MINS = 15 * 60 + 30;
const TARGETS = [5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150];

interface DayFollow {
  date: string;
  side: "up" | "down";
  openingPts: number;
  entry: number;
  /** Best extension beyond 9:30 before price trades back to the 9:30 price. */
  legPts: number;
  legMin: number;
  /** True when price came back to the 9:30 print and ended the follow. */
  returned: boolean;
  returnMin: number | null;
  /** Best extension any time from 9:30 to the close, including later re-entries. */
  sessionPts: number;
  sessionMin: number;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function pad2(v: number): string {
  return String(v).padStart(2, "0");
}

function hhmm(mins: number): string {
  return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
}

function barAt(bars: MinuteBar[], mins: number): MinuteBar | undefined {
  return bars.find((bar) => bar.mins === mins);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo] ?? 0;
  const weight = index - lo;
  return (sorted[lo] ?? 0) * (1 - weight) + (sorted[hi] ?? 0) * weight;
}

function measure(date: string, bars: MinuteBar[]): DayFollow | null {
  const openBar = barAt(bars, OPEN_MINS);
  const markBar = barAt(bars, END_930_MINS);
  const entryBar = barAt(bars, ENTRY_MINS);
  if (!openBar || !markBar || !entryBar) return null;

  const openingPts = markBar.close - openBar.open;
  if (Math.abs(openingPts) < 0.05) return null;
  const up = openingPts > 0;
  const entry = entryBar.open;
  const forward = bars.filter((bar) => bar.mins >= ENTRY_MINS && bar.mins <= SESSION_CLOSE_MINS);
  if (forward.length < 30) return null;

  let legPts = 0;
  let legMin = ENTRY_MINS;
  let legOpen = true;
  let returned = false;
  let returnMin: number | null = null;
  let sessionPts = 0;
  let sessionMin = ENTRY_MINS;

  for (const bar of forward) {
    const favorable = up ? bar.high - entry : entry - bar.low;
    if (favorable > sessionPts) {
      sessionPts = favorable;
      sessionMin = bar.mins;
    }
    if (!legOpen) continue;
    if (favorable > legPts) {
      legPts = favorable;
      legMin = bar.mins;
    }
    const backToEntry = up ? bar.low <= entry : bar.high >= entry;
    if (bar.mins > ENTRY_MINS && backToEntry) {
      legOpen = false;
      returned = true;
      returnMin = bar.mins;
    }
  }

  return {
    date,
    side: up ? "up" : "down",
    openingPts: round1(openingPts),
    entry: round1(entry),
    legPts: round1(Math.max(0, legPts)),
    legMin,
    returned,
    returnMin,
    sessionPts: round1(Math.max(0, sessionPts)),
    sessionMin,
  };
}

function summarize(label: string, rows: DayFollow[]): void {
  const leg = rows.map((row) => row.legPts).sort((a, b) => a - b);
  const session = rows.map((row) => row.sessionPts).sort((a, b) => a - b);
  const held = rows.filter((row) => !row.returned).length;
  console.log("");
  console.log(`=== ${label}  n=${rows.length}  never came back to 9:30: ${held} ===`);
  console.log(
    `Follow before return to 9:30:  median ${round1(percentile(leg, 0.5)).toFixed(1)}  ` +
      `p25 ${round1(percentile(leg, 0.25)).toFixed(1)}  p75 ${round1(percentile(leg, 0.75)).toFixed(1)}  ` +
      `p90 ${round1(percentile(leg, 0.9)).toFixed(1)}  max ${round1(leg[leg.length - 1] ?? 0).toFixed(1)}`,
  );
  console.log(
    `Best extension any time to the close:  median ${round1(percentile(session, 0.5)).toFixed(1)}  ` +
      `p75 ${round1(percentile(session, 0.75)).toFixed(1)}  p90 ${round1(percentile(session, 0.9)).toFixed(1)}`,
  );

  console.log("Exit target if you take it on the first follow (scratch at the 9:30 price when it returns):");
  let best = { target: 0, expectancy: -1, hits: 0 };
  for (const target of TARGETS) {
    const hits = rows.filter((row) => row.legPts + 1e-9 >= target);
    const expectancy = rows.length > 0 ? (hits.length / rows.length) * target : 0;
    const hitMins = hits.map((row) => row.legMin).sort((a, b) => a - b);
    const medianHit = hitMins.length > 0 ? hhmm(Math.round(percentile(hitMins, 0.5))) : "—";
    console.log(
      `  +${String(target).padStart(3)} pts  hit ${String(hits.length).padStart(3)}/${rows.length} ` +
        `(${rows.length ? ((hits.length / rows.length) * 100).toFixed(1) : "0"}%)  ` +
        `median time ${medianHit}  avg captured ${expectancy.toFixed(1)} pts`,
    );
    if (expectancy > best.expectancy) best = { target, expectancy, hits: hits.length };
  }
  console.log(`Best fixed exit in that list: +${best.target} pts (${best.hits}/${rows.length}, ${best.expectancy.toFixed(1)} pts average).`);

  const buckets = [
    { label: "9:30–9:45", from: ENTRY_MINS, to: 9 * 60 + 45 },
    { label: "9:46–10:00", from: 9 * 60 + 46, to: 10 * 60 },
    { label: "10:01–10:30", from: 10 * 60 + 1, to: 10 * 60 + 30 },
    { label: "10:31–11:00", from: 10 * 60 + 31, to: 11 * 60 },
    { label: "11:01–12:00", from: 11 * 60 + 1, to: 12 * 60 },
    { label: "12:01–14:00", from: 12 * 60 + 1, to: 14 * 60 },
    { label: "14:01–15:30", from: 14 * 60 + 1, to: SESSION_CLOSE_MINS },
  ];
  console.log("When the first-follow high/low printed:");
  for (const bucket of buckets) {
    const count = rows.filter((row) => row.legMin >= bucket.from && row.legMin <= bucket.to).length;
    console.log(`  ${bucket.label.padEnd(14)} ${String(count).padStart(3)}  (${rows.length ? ((count / rows.length) * 100).toFixed(1) : "0"}%)`);
  }
  const peakMins = rows.map((row) => row.legMin).sort((a, b) => a - b);
  console.log(`Median time of that extreme: ${hhmm(Math.round(percentile(peakMins, 0.5)))}`);

  const byMorning = [
    { label: "morning |move| under 30", test: (row: DayFollow) => Math.abs(row.openingPts) < 30 },
    { label: "morning |move| 30–60", test: (row: DayFollow) => Math.abs(row.openingPts) >= 30 && Math.abs(row.openingPts) < 60 },
    { label: "morning |move| 60+", test: (row: DayFollow) => Math.abs(row.openingPts) >= 60 },
  ];
  console.log("Median first follow by how far 9:15→9:30 already moved:");
  for (const band of byMorning) {
    const group = rows.filter(band.test).map((row) => row.legPts).sort((a, b) => a - b);
    console.log(`  ${band.label.padEnd(28)} n=${String(group.length).padStart(3)}  median ${round1(percentile(group, 0.5)).toFixed(1)}  p75 ${round1(percentile(group, 0.75)).toFixed(1)}`);
  }

  const biggest = [...rows].sort((a, b) => b.legPts - a.legPts).slice(0, 8);
  console.log("Largest first follows:");
  for (const row of biggest) {
    console.log(
      `  ${row.date}  morning ${row.openingPts >= 0 ? "+" : ""}${row.openingPts.toFixed(1)}  ` +
        `follow +${row.legPts.toFixed(1)} at ${hhmm(row.legMin)}  ` +
        `${row.returned ? `back to entry ${hhmm(row.returnMin ?? row.legMin)}` : "held through the close"}`,
    );
  }
}

async function main(): Promise<void> {
  const session = loadKiteSession();
  if (!session?.accessToken) throw new Error("No Kite session on this machine");

  const dates = listWeekdayDates(LOOKBACK_CALENDAR_DAYS);
  const rows: DayFollow[] = [];
  let skipped = 0;

  for (const group of chunk(dates, CHUNK_TRADING_DAYS)) {
    const from = `${group[0]} 09:15:00`;
    const to = `${group[group.length - 1]} 15:30:00`;
    process.stderr.write(`fetch ${from} → ${to}\n`);
    const { candles } = await fetchHistoricalCandles(session.accessToken, SPOT, "minute", from, to);
    if (!Array.isArray(candles)) throw new Error(`Invalid candle payload for ${from}`);
    const byDate = groupSessionBars(candles);
    for (const [date, bars] of byDate) {
      if (!isCompleteSession(bars)) {
        skipped += 1;
        continue;
      }
      const row = measure(date, bars);
      if (row) rows.push(row);
    }
    await new Promise((resolve) => setTimeout(resolve, FETCH_SPACING_MS));
  }

  rows.sort((a, b) => a.date.localeCompare(b.date));
  const up = rows.filter((row) => row.side === "up");
  const down = rows.filter((row) => row.side === "down");
  console.log("");
  console.log(`Sessions ${rows[0]?.date ?? "?"} → ${rows[rows.length - 1]?.date ?? "?"}  traded ${rows.length}  skipped incomplete ${skipped}`);
  console.log("Entry is the 9:30 open, in the direction of 9:15 open → 9:29 close.");
  console.log("Follow = furthest Nifty runs that way before a later minute trades back to the 9:30 price.");
  summarize("CALL — 9:15 to 9:30 was up", up);
  summarize("PUT — 9:15 to 9:30 was down", down);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
