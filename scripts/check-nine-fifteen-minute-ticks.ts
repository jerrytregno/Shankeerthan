/**
 * Run: npx tsx scripts/check-nine-fifteen-minute-ticks.ts
 */
import type { RawTickRow } from "../server/nine-sixteen-bot.js";
import {
  filterNineFifteenNiftyTicks,
  formatIstTimeMs,
  nineFifteenMinuteBounds,
} from "../server/nine-fifteen-minute-ticks.js";

const date = "2026-10-09";
const bounds = nineFifteenMinuteBounds(date);
const at = (isoUtc: string) => Date.parse(isoUtc);

const start = at("2026-10-09T03:45:00.000Z");
const before = at("2026-10-09T03:44:59.999Z");
const lastMs = at("2026-10-09T03:45:59.999Z");
const seal = at("2026-10-09T03:46:00.000Z");

const ok = (name: string, cond: boolean) => {
  console.log(name, cond ? "ok" : "MISMATCH");
  if (!cond) process.exitCode = 1;
};

ok("window starts 09:15:00.000 IST", bounds.startMs === start);
ok("window ends 09:16:00.000 IST", bounds.endMs === seal);
ok("ms label", formatIstTimeMs(start + 123) === "09:15:00.123");

function row(epochMs: number, price: number, kind: RawTickRow["kind"], seq: number): RawTickRow {
  return {
    seq,
    dateIST: date,
    timeIST: formatIstTimeMs(epochMs),
    epochMs,
    exchangeTimeIST: null,
    kind,
    instrumentToken: kind === "nifty" ? 256265 : 1,
    price,
    changePts: null,
  };
}

const ticks = filterNineFifteenNiftyTicks([
  row(before, 22000, "nifty", 1),
  row(seal, 22010, "nifty", 2),
  row(start + 400, 22002, "option", 3),
  row(lastMs, 22008.5, "nifty", 5),
  row(start + 50, 22001.25, "nifty", 4),
  row(start, 22000.5, "nifty", 6),
]);

ok("keeps the three 9:15 nifty ticks", ticks.length === 3);
ok("sorted by time", ticks.map((tick) => tick.seq).join(",") === "6,4,5");
ok("keeps millisecond time", ticks[0].timeIST === "09:15:00.000");
ok("keeps the 59.999 tick", ticks[2].timeIST === "09:15:59.999");
ok("drops the option tick and the ticks outside the minute", ticks.every((tick) => tick.price !== 22000 && tick.price !== 22010 && tick.price !== 22002));

if (process.exitCode) {
  console.error("nine-fifteen minute tick checks failed");
} else {
  console.log("nine-fifteen minute tick checks passed");
}
