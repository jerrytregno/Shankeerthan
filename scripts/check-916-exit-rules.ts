/**
 * Sanity check for 9:16 index helpers (hard stop removed from live 9:15/9:16 bots).
 *
 * Run: npx tsx scripts/check-916-exit-rules.ts
 */
import {
  activePnlTargetPct,
  activeIndexTargetPoints,
  shouldExitNineSixteen,
  shouldExitOnPnlTarget,
  shouldHardStopNineSixteen,
  isHybrid916AdverseStopSpot,
  shouldHybrid916ReturnToEntryExit,
  isPastHybrid916AdverseCheckpoint,
  NINE_SIXTEEN_HYBRID_ADVERSE_STOP_PTS,
  NINE_SIXTEEN_MINUTE_SPIKE_PTS,
  shouldExitNineSixteenMinuteSpike,
  hybrid916IndexTargetPoints,
  computeHybrid916IndexExitSpot,
  is916RedConfirmFromCaptures,
  isIn91559WsCloseSecond,
  isIn91600WsOpenSecond,
  isIn91659WsCloseSecond,
  isPast916GreenMinuteRetarget,
  is916MinuteGreenClose,
  is916MinuteAgainstLeg,
  isBeyond91559CloseAgainstLeg,
  NINE_FIFTEEN_WS_CLOSE_59_SEC,
  NINE_SIXTEEN_WS_OPEN_00_SEC,
  NINE_SIXTEEN_HYBRID_INDEX_TARGET_GREEN_MINUTE,
  isTuesdayIst,
  getIndexExitScheduleLabel,
  getPnlExitScheduleLabel,
  armNineSixteenTrail,
  stepNineSixteenTrail,
  shouldExitNineSixteenTrail,
  isPastNineSixteenTrailFlat,
  nineSixteenFavourablePoints,
  nineSixteenTrailSpot,
} from "../server/nine-sixteen-logic.js";

// 2026-08-18 is a Tuesday, 2026-08-19 a Wednesday.
const tue = (t: string) => new Date(`2026-08-18T${t}+05:30`).getTime();
const wed = (t: string) => new Date(`2026-08-19T${t}+05:30`).getTime();

console.log("isTuesdayIst tue/wed:", isTuesdayIst(tue("09:16:00")), isTuesdayIst(wed("09:16:00")));
for (const t of ["09:15:59", "09:16:00", "10:30:00", "11:30:00", "13:00:00", "15:20:00"]) {
  console.log(`pnl pct ${t} — tue:`, activePnlTargetPct(tue(t)), "wed:", activePnlTargetPct(wed(t)));
}
console.log("label tue:", getPnlExitScheduleLabel(tue("10:00:00")));
console.log("label wed:", getPnlExitScheduleLabel(wed("10:00:00")));
// Tuesday P&L target must be exactly +5% through 10:00 and +1% from 10:01.
const tuePnlCases: [string, number | null][] = [
  ["09:15:59", null],
  ["09:16:00", 5],
  ["10:00:59", 5],
  ["10:01:00", 1],
  ["15:20:00", 1],
];
for (const [t, want] of tuePnlCases) {
  const got = activePnlTargetPct(tue(t));
  console.log("tue pnl target", t, "=>", got, got === want ? "ok" : `MISMATCH (want ${want})`);
}

for (const t of ["09:16:00", "10:30:00", "11:30:00", "14:00:00"]) {
  console.log(
    `index pts ${t} — tue main/near:`,
    activeIndexTargetPoints("main", tue(t)),
    activeIndexTargetPoints("near_miss", tue(t)),
    "| wed main/near:",
    activeIndexTargetPoints("main", wed(t)),
    activeIndexTargetPoints("near_miss", wed(t)),
  );
}
console.log("index label:", getIndexExitScheduleLabel("main"));

// Tuesday index bands are now identical to every other weekday.
const entrySpot = 24000;
const tueTargets: [string, number, "CE_BUY" | "PE_BUY", boolean][] = [
  ["CE +24 tue @09:20", 24024, "CE_BUY", false],
  ["CE +25 tue @09:20", 24025, "CE_BUY", true],
  ["CE +10 tue @09:20", 24010, "CE_BUY", false],
  ["PE -25 tue @09:20", 23975, "PE_BUY", true],
];
for (const [name, spot, leg, want] of tueTargets) {
  const at = tue("09:20:00");
  const got = shouldExitNineSixteen(spot, entrySpot, leg, activeIndexTargetPoints("main", at));
  console.log("tue index exit", name, "=>", got, got === want ? "ok" : "MISMATCH");
}

// Tuesday P&L exit: +5% before 10:01, +1% after — the trade closes the moment it prints.
const entryPrem = 100;
const qty = 500;
const pnlCases: [string, string, number, boolean][] = [
  ["+4% @09:30", "09:30:00", 2000, false],
  ["+5% @09:30", "09:30:00", 2500, true],
  ["+1% @09:30", "09:30:00", 500, false],
  ["+1% @10:01", "10:01:00", 500, true],
  ["+0.9% @10:01", "10:01:00", 450, false],
  ["+1% @14:00", "14:00:00", 500, true],
];
for (const [name, t, pnl, want] of pnlCases) {
  const pct = activePnlTargetPct(tue(t));
  const got = pct != null && shouldExitOnPnlTarget(pnl, entryPrem, qty, pct);
  console.log(
    "tue pnl exit",
    name,
    `target=+${pct}%`,
    "=>",
    got ? "EXIT" : "hold",
    got === want ? "ok" : "MISMATCH",
  );
}

// Hard stop: from 10:00 IST, ±30 adverse Nifty from entry spot (9:15 leg only).
console.log("\n--- 10:00 hard stop (±30 from entry spot · 9:15 leg) ---");
const cases: [string, number, "CE_BUY" | "PE_BUY", string, boolean][] = [
  ["CE -29 @09:59", 23971, "CE_BUY", "09:59:59", false],
  ["CE -30 @09:59", 23970, "CE_BUY", "09:59:59", false],
  ["CE -30 @10:00", 23970, "CE_BUY", "10:00:00", true],
  ["CE -45 @10:30", 23955, "CE_BUY", "10:30:00", true],
  ["CE +30 @10:30", 24030, "CE_BUY", "10:30:00", false],
  ["PE +30 @10:00", 24030, "PE_BUY", "10:00:00", true],
  ["PE +29 @10:00", 24029, "PE_BUY", "10:00:00", false],
  ["PE -30 @10:00", 23970, "PE_BUY", "10:00:00", false],
  ["CE -70 @14:00", 23930, "CE_BUY", "14:00:00", true],
];
for (const [name, spot, leg, t, want] of cases) {
  const got = shouldHardStopNineSixteen(spot, entrySpot, leg, undefined, wed(t));
  console.log("hard stop", name, "=>", got ? "EXIT" : "hold", got === want ? "ok" : `MISMATCH (want ${want})`);
}

console.log("\n--- hybrid 916 parallel index exit ---");
console.log(
  "91559 sec",
  isIn91559WsCloseSecond(wed("09:15:59.500")),
  !isIn91559WsCloseSecond(wed("09:15:58.500")) ? "ok" : "MISMATCH",
);
console.log(
  "91600 sec",
  isIn91600WsOpenSecond(wed("09:16:00.100")),
  !isIn91600WsOpenSecond(wed("09:16:01.100")) ? "ok" : "MISMATCH",
);
console.log("sec constants", NINE_FIFTEEN_WS_CLOSE_59_SEC, NINE_SIXTEEN_WS_OPEN_00_SEC);
const close91559 = 24_000;
const open916Red = 23_995;
const open916Gap = 24_001;
console.log(
  "red confirm",
  is916RedConfirmFromCaptures(open916Red, close91559),
  hybrid916IndexTargetPoints(open916Red, close91559) === 12 ? "ok" : "MISMATCH",
);
console.log(
  "green gap",
  !is916RedConfirmFromCaptures(open916Gap, close91559),
  hybrid916IndexTargetPoints(open916Gap, close91559) === 8 ? "ok" : "MISMATCH",
);
const entrySpotHybrid = 24_010;
const target12 = computeHybrid916IndexExitSpot(entrySpotHybrid, 12, "PE_BUY");
console.log(
  "PE −12 hit",
  shouldExitNineSixteen(target12, entrySpotHybrid, "PE_BUY", 12) ? "ok" : "MISMATCH",
);
console.log(
  "PE −12 hold",
  !shouldExitNineSixteen(target12 + 0.05, entrySpotHybrid, "PE_BUY", 12) ? "ok" : "MISMATCH",
);
console.log(
  "91659 green minute",
  is916MinuteGreenClose(24_005, 24_000),
  !is916MinuteGreenClose(24_000, 24_000.05) ? "ok" : "MISMATCH",
);
console.log(
  "917 retarget window",
  isPast916GreenMinuteRetarget(wed("09:17:00")),
  !isPast916GreenMinuteRetarget(wed("09:16:59.999")) ? "ok" : "MISMATCH",
);
console.log("green minute target pts", NINE_SIXTEEN_HYBRID_INDEX_TARGET_GREEN_MINUTE);

console.log("\n--- hybrid 916 parallel index exit · CE mirror ---");
const ok = (cond: boolean) => (cond ? "ok" : "MISMATCH");
console.log("CE both green (open > close) → +12", ok(hybrid916IndexTargetPoints(24_001, close91559, "CE_BUY") === 12));
console.log("CE open = close counts as green → +12", ok(hybrid916IndexTargetPoints(24_000, close91559, "CE_BUY") === 12));
console.log("CE red gap (open < close) → +8", ok(hybrid916IndexTargetPoints(23_999.95, close91559, "CE_BUY") === 8));
const ceTarget12 = computeHybrid916IndexExitSpot(entrySpotHybrid, 12, "CE_BUY");
console.log("CE +12 target spot", ok(ceTarget12 === entrySpotHybrid + 12));
console.log("CE +12 hit", ok(shouldExitNineSixteen(ceTarget12, entrySpotHybrid, "CE_BUY", 12)));
console.log("CE +12 hold", ok(!shouldExitNineSixteen(ceTarget12 - 0.05, entrySpotHybrid, "CE_BUY", 12)));
console.log("CE retarget when 9:16 closes red", ok(is916MinuteAgainstLeg(23_995, 24_000, "CE_BUY")));
console.log("CE no retarget when 9:16 closes green", ok(!is916MinuteAgainstLeg(24_005, 24_000, "CE_BUY")));
console.log(
  "PE beyond 9:15:59 close",
  ok(isBeyond91559CloseAgainstLeg(22_001, 22_000, "PE_BUY")),
);
console.log(
  "PE equal to 9:15:59 close holds",
  ok(!isBeyond91559CloseAgainstLeg(22_000, 22_000, "PE_BUY")),
);
console.log(
  "PE still below 9:15:59 close holds",
  ok(!isBeyond91559CloseAgainstLeg(21_999, 22_000, "PE_BUY")),
);
console.log(
  "CE beyond 9:15:59 close",
  ok(isBeyond91559CloseAgainstLeg(21_999, 22_000, "CE_BUY")),
);
console.log(
  "CE equal to 9:15:59 close holds",
  ok(!isBeyond91559CloseAgainstLeg(22_000, 22_000, "CE_BUY")),
);
console.log("PE retarget when 9:16 closes green", ok(is916MinuteAgainstLeg(24_005, 24_000, "PE_BUY")));
console.log("PE no retarget when 9:16 closes red", ok(!is916MinuteAgainstLeg(23_995, 24_000, "PE_BUY")));

console.log("\n--- 9:16 hybrid adverse + entry return (9:15 leg still uses 10:00 ±30) ---");
console.log(
  "PE +40 @09:26",
  ok(isHybrid916AdverseStopSpot(entrySpot + 40, entrySpot, "PE_BUY")),
);
console.log(
  "PE +39 @09:26",
  ok(!isHybrid916AdverseStopSpot(entrySpot + 39, entrySpot, "PE_BUY")),
);
console.log(
  "CE −40 @09:17",
  ok(isHybrid916AdverseStopSpot(entrySpot - 40, entrySpot, "CE_BUY")),
);
console.log(
  "past PE checkpoint",
  ok(isPastHybrid916AdverseCheckpoint("PE_BUY", wed("09:26:00"))),
);
console.log(
  "PE entry return",
  ok(shouldHybrid916ReturnToEntryExit(entrySpot, entrySpot, "PE_BUY")),
);
console.log("hybrid adverse pts", NINE_SIXTEEN_HYBRID_ADVERSE_STOP_PTS);

console.log("\n--- 9:16 minute spike (35 pts from this minute's open) ---");
console.log("pts", NINE_SIXTEEN_MINUTE_SPIKE_PTS);
console.log("threshold is 35", ok(NINE_SIXTEEN_MINUTE_SPIKE_PTS === 35));
console.log("PE +35 exits", ok(shouldExitNineSixteenMinuteSpike(24_035, 24_000, "PE_BUY")));
console.log("PE +34.99 holds", ok(!shouldExitNineSixteenMinuteSpike(24_034.99, 24_000, "PE_BUY")));
console.log("CE −35 exits", ok(shouldExitNineSixteenMinuteSpike(23_965, 24_000, "CE_BUY")));
console.log("CE −34.99 holds", ok(!shouldExitNineSixteenMinuteSpike(23_965.01, 24_000, "CE_BUY")));
console.log("open tick holds", ok(!shouldExitNineSixteenMinuteSpike(24_000, 24_000, "PE_BUY")));

console.log("\n--- 9:16 trail (lock target − 2 · stop = best 1-min close − 4 · flat 10:00) ---");
console.log("PE favourable = entry − spot", ok(nineSixteenFavourablePoints(23_988, 24_000, "PE_BUY") === 12));
console.log("CE favourable = spot − entry", ok(nineSixteenFavourablePoints(24_008, 24_000, "CE_BUY") === 8));
{
  const t12 = armNineSixteenTrail(12, 12.5, wed("09:20:10"));
  console.log("12-pt target locks 10", ok(t12.floorPoints === 10 && t12.stopPoints === 10));
  console.log("8-pt target locks 6", ok(armNineSixteenTrail(8, 8, wed("09:16:20")).stopPoints === 6));
  console.log("6-pt target locks 4", ok(armNineSixteenTrail(6, 6, wed("09:17:05")).stopPoints === 4));
  console.log("PE stop level is entry − 10", ok(nineSixteenTrailSpot(t12.stopPoints, 24_000, "PE_BUY") === 23_990));
  console.log("CE stop level is entry + 10", ok(nineSixteenTrailSpot(t12.stopPoints, 24_000, "CE_BUY") === 24_010));

  // Inside the arming minute the stop stays at the floor whatever the high.
  let t = t12;
  for (const [time, pts] of [
    ["09:20:20", 13],
    ["09:20:40", 19],
    ["09:20:59", 14],
  ] as const) {
    t = stepNineSixteenTrail(t, pts, wed(time));
  }
  console.log("no ratchet inside the minute (high 19)", ok(t.stopPoints === 10 && t.bestClosePoints === 12));
  console.log("dip to 10.5 inside the minute holds", ok(!shouldExitNineSixteenTrail(t, 10.5)));

  // 9:20 closed at 14 → stop max(10, 14 − 4) = 10.
  t = stepNineSixteenTrail(t, 13.5, wed("09:21:00.200"));
  console.log("9:20 close 14 → best 14, stop stays 10", ok(t.bestClosePoints === 14 && t.stopPoints === 10));
  t = stepNineSixteenTrail(t, 18, wed("09:21:30"));
  t = stepNineSixteenTrail(t, 19.2, wed("09:21:59"));
  // 9:21 closed at 19.2 → stop 15.2.
  t = stepNineSixteenTrail(t, 16, wed("09:22:00.100"));
  console.log("9:21 close 19.2 → stop 15.2", ok(Math.abs(t.stopPoints - 15.2) < 1e-9));
  console.log("15.25 holds", ok(!shouldExitNineSixteenTrail(t, 15.25)));
  console.log("15.2 exits", ok(shouldExitNineSixteenTrail(t, 15.2)));

  // A lower close never lowers the stop.
  t = stepNineSixteenTrail(t, 15.5, wed("09:22:59"));
  t = stepNineSixteenTrail(t, 15.6, wed("09:23:00.100"));
  console.log("lower 9:22 close keeps stop 15.2", ok(Math.abs(t.stopPoints - 15.2) < 1e-9 && t.bestClosePoints === 19.2));

  // A gap of several minutes uses the last print before it as that minute's close.
  t = stepNineSixteenTrail(t, 30, wed("09:23:40"));
  t = stepNineSixteenTrail(t, 29, wed("09:27:00.050"));
  console.log("close 30 after a quiet spell → stop 26", ok(t.stopPoints === 26));
}
console.log("flat at 09:59:59 holds", ok(!isPastNineSixteenTrailFlat(wed("09:59:59"))));
console.log("flat at 10:00:00 exits", ok(isPastNineSixteenTrailFlat(wed("10:00:00"))));
