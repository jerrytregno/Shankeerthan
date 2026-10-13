/**
 * Sanity checks for the 9:16 take-profit limit exit (replaces the old trailing ladder).
 */
import {
  getNineSixteenTakeProfitPct,
  getNineSixteenLadderLabel,
  nineFifteenTakeProfitLimitPrice,
  nineFifteenTakeProfitAmount,
  shouldExitNineFifteenTakeProfit,
  shouldExitNineSixteenTakeProfit,
  formatNineFifteenExitSummary,
  ownLegUnrealisedPnl,
} from "../server/nine-sixteen-logic.js";

const entryPrice = 40;
const quantity = 130;

function checkWeekday(label: string, dateIst: string, expectedPct: number, sameColor: boolean) {
  const pct = getNineSixteenTakeProfitPct(dateIst, sameColor);
  const limit = nineFifteenTakeProfitLimitPrice(entryPrice, pct);
  const aim = nineFifteenTakeProfitAmount(entryPrice, quantity, pct);
  console.log(`\n${label} (${dateIst})`);
  console.log(`  take-profit: +${pct}% (expected ${expectedPct}%)`);
  console.log(`  ladder: ${getNineSixteenLadderLabel(dateIst, "PE_BUY", sameColor)}`);
  console.log(`  limit price: ₹${limit.toFixed(2)} per unit`);
  console.log(`  profit aim: ₹${Math.round(aim)} on ₹${Math.round(entryPrice * quantity)} deployed`);
  if (pct !== expectedPct) {
    throw new Error(`${label}: expected ${expectedPct}% got ${pct}%`);
  }
}

checkWeekday("Wednesday same", "2026-09-02", 3, true);
checkWeekday("Wednesday different", "2026-09-02", 2, false);
checkWeekday("Thursday same", "2026-09-03", 6, true);
checkWeekday("Thursday different", "2026-09-03", 4, false);
checkWeekday("Friday same", "2026-09-04", 9, true);
checkWeekday("Friday different", "2026-09-04", 6, false);
checkWeekday("Monday same", "2026-08-31", 10, true);
checkWeekday("Monday different", "2026-08-31", 7, false);
checkWeekday("Tuesday same", "2026-09-01", 10, true);
checkWeekday("Tuesday different", "2026-09-01", 8, false);
checkWeekday("Tuesday same CE uses same %", "2026-09-01", 10, true);

{
  const pct = getNineSixteenTakeProfitPct("2026-09-01", true);
  const aim = nineFifteenTakeProfitAmount(entryPrice, quantity, pct);
  const atTarget = ownLegUnrealisedPnl(entryPrice, quantity, nineFifteenTakeProfitLimitPrice(entryPrice, pct));
  const below = atTarget != null ? atTarget - 1 : null;
  console.log("\nMarket backup trigger");
  console.log(`  at limit P&L ₹${Math.round(atTarget ?? 0)} → exit? ${shouldExitNineFifteenTakeProfit(atTarget, entryPrice, quantity, pct)}`);
  console.log(`  ₹1 below → exit? ${shouldExitNineFifteenTakeProfit(below, entryPrice, quantity, pct)}`);
  if (!shouldExitNineFifteenTakeProfit(atTarget, entryPrice, quantity, pct)) {
    throw new Error("market backup should fire at target P&L");
  }
  if (shouldExitNineFifteenTakeProfit(below, entryPrice, quantity, pct)) {
    throw new Error("market backup should not fire below target");
  }
  if (!shouldExitNineSixteenTakeProfit(atTarget, entryPrice, quantity, pct)) {
    throw new Error("9:16 market backup helper should fire at target P&L");
  }
  const summary = formatNineFifteenExitSummary({
    exitPrice: nineFifteenTakeProfitLimitPrice(entryPrice, pct),
    quantity,
    entryPrice,
    pnl: atTarget,
    via: "market",
    takeProfitPct: pct,
    legTag: "9:16",
  });
  if (!summary.includes("9:16") || !summary.includes("backup")) {
    throw new Error(`9:16 exit summary missing leg tag: ${summary}`);
  }
  console.log(`  exit summary: ${summary}`);
}

console.log("\nAll 9:16 take-profit checks passed.");
