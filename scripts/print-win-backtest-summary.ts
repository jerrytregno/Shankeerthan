/** Run: npx tsx scripts/print-win-backtest-summary.ts */
import "../server/load-env.js";
import { loadKiteSession } from "../server/kite-session-store.js";
import { ensureWinBacktest } from "../server/win-backtest.js";

const session = loadKiteSession();
if (!session?.accessToken) throw new Error("No Kite session");

const { data } = await ensureWinBacktest(session.accessToken, true);
console.log(`${data.from} → ${data.to}  sessions ${data.sessions}`);
for (const method of data.methods) {
  const { best, summary, fixed } = method;
  console.log(
    `${method.label}: trail stop ${best.stopPts} arm ${best.armPts} trail ${best.trailPts}  ` +
      `${summary.winPct}%  n=${summary.trades}  avg ${summary.avgPts}  total ${summary.totalPts}  ` +
      `worst ${summary.worstPts}  fixed ${fixed.winPct}% n=${fixed.trades} total ${fixed.totalPts}`,
  );
}
