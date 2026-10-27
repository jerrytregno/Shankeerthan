/**
 * Sanity checks for the 9:16 weekday limit sell (Wed 3 · Thu 4 · Fri 5 · Mon 6 · Tue 7).
 */
import {
  getNineSixteenTakeProfitPct,
  getNineSixteenLadderLabel,
  nineFifteenTakeProfitLimitPrice,
  nineFifteenTakeProfitAmount,
  formatNineFifteenExitSummary,
  ownLegUnrealisedPnl,
  pnlPctOfEntryCost,
  shouldExitNineFifteenLossPct,
  nineFifteenStopLossTriggerPrice,
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

checkWeekday("Wednesday", "2026-09-02", 3, true);
checkWeekday("Wednesday other colour", "2026-09-02", 3, false);
checkWeekday("Thursday", "2026-09-03", 4, true);
checkWeekday("Thursday other colour", "2026-09-03", 4, false);
checkWeekday("Friday", "2026-09-04", 5, true);
checkWeekday("Friday other colour", "2026-09-04", 5, false);
checkWeekday("Monday", "2026-08-31", 6, true);
checkWeekday("Monday other colour", "2026-08-31", 6, false);
checkWeekday("Tuesday", "2026-09-01", 7, true);
checkWeekday("Tuesday other colour", "2026-09-01", 7, false);

{
  const pct = getNineSixteenTakeProfitPct("2026-09-01", true);
  const limit = nineFifteenTakeProfitLimitPrice(entryPrice, pct);
  const aim = nineFifteenTakeProfitAmount(entryPrice, quantity, pct);
  if (limit !== 42.8) {
    throw new Error(`Tuesday limit on ₹40 should be ₹42.80, got ${limit}`);
  }
  if (aim !== entryPrice * quantity * 0.07) {
    throw new Error(`Tuesday aim should be 7% of deployed capital, got ${aim}`);
  }
  const atTarget = ownLegUnrealisedPnl(entryPrice, quantity, limit);
  const summary = formatNineFifteenExitSummary({
    exitPrice: limit,
    quantity,
    entryPrice,
    pnl: atTarget,
    via: "limit",
    takeProfitPct: pct,
    legTag: "9:16",
  });
  if (!summary.includes("9:16") || !summary.includes("limit sell")) {
    throw new Error(`9:16 limit exit summary missing leg tag: ${summary}`);
  }
  console.log(`  Tuesday limit ₹${limit.toFixed(2)} · aim ₹${Math.round(aim)}`);
  console.log(`  exit summary: ${summary}`);
}

{
  const lossPrice = entryPrice * 0.85;
  const holdPrice = entryPrice * 0.8501;
  const atLoss = pnlPctOfEntryCost(ownLegUnrealisedPnl(entryPrice, quantity, lossPrice), entryPrice, quantity);
  const above = pnlPctOfEntryCost(ownLegUnrealisedPnl(entryPrice, quantity, holdPrice), entryPrice, quantity);
  if (!shouldExitNineFifteenLossPct(atLoss)) throw new Error("−15% P&L should exit");
  if (shouldExitNineFifteenLossPct(above)) throw new Error("just above −15% should hold");
  if (shouldExitNineFifteenLossPct(-14.99)) throw new Error("−14.99% should hold");
  if (!shouldExitNineFifteenLossPct(-15)) throw new Error("−15% should exit");
  const trigger = nineFifteenStopLossTriggerPrice(entryPrice);
  if (trigger !== 32) throw new Error(`−20% trigger on ₹40 should be ₹32, got ${trigger}`);
  const summary = formatNineFifteenExitSummary({
    exitPrice: lossPrice,
    quantity,
    entryPrice,
    pnl: ownLegUnrealisedPnl(entryPrice, quantity, lossPrice),
    via: "loss-stop",
    legTag: "9:15",
  });
  if (!summary.includes("9:15") || !summary.includes("−15%")) {
    throw new Error(`9:15 loss exit summary: ${summary}`);
  }
  console.log(`\n9:15 loss stop · trigger ₹${trigger.toFixed(2)} · ${summary}`);
}

console.log("\nAll 9:16 take-profit checks passed.");
