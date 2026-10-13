/**
 * Run: npx tsx scripts/check-win-backtest-trail.ts
 */
import { simulateTargetExit, simulateTrailExit } from "../server/win-backtest.js";

let failed = 0;

function check(name: string, cond: boolean): void {
  console.log(name, cond ? "ok" : "MISMATCH");
  if (!cond) failed += 1;
}

const trail = simulateTrailExit(
  [
    { min: 600, open: 100, high: 100, low: 100, close: 100 },
    { min: 601, open: 100, high: 112, low: 100, close: 110 },
    { min: 602, open: 110, high: 111, low: 107, close: 109 },
  ],
  1,
  100,
  { stopPts: 20, armPts: 10, trailPts: 4 },
  700,
);
check("trail locks and exits at the trailed stop", trail?.reason === "trail" && trail.pnl === 8 && trail.exitPrice === 108);

const stopped = simulateTrailExit(
  [
    { min: 600, open: 100, high: 103, low: 100, close: 102 },
    { min: 601, open: 102, high: 102, low: 88, close: 90 },
  ],
  1,
  100,
  { stopPts: 10, armPts: 10, trailPts: 4 },
  700,
);
check("initial stop exits before the trail arms", stopped?.reason === "stop" && stopped.pnl === -10);

const gapped = simulateTrailExit(
  [
    { min: 600, open: 100, high: 101, low: 99, close: 100 },
    { min: 601, open: 80, high: 82, low: 79, close: 81 },
  ],
  1,
  100,
  { stopPts: 10, armPts: 8, trailPts: 3 },
  700,
);
check("gap through the stop fills at the open", gapped?.reason === "stop" && gapped.pnl === -20 && gapped.exitPrice === 80);

const shortTrail = simulateTrailExit(
  [
    { min: 600, open: 200, high: 201, low: 188, close: 190 },
    { min: 601, open: 190, high: 194, low: 189, close: 193 },
  ],
  -1,
  200,
  { stopPts: 20, armPts: 10, trailPts: 5 },
  700,
);
check("short trail exits behind the best low", shortTrail?.reason === "trail" && shortTrail.pnl === 7 && shortTrail.exitPrice === 193);

const held = simulateTrailExit(
  [
    { min: 600, open: 100, high: 130, low: 100, close: 120 },
  ],
  1,
  100,
  { stopPts: 20, armPts: 10, trailPts: 5 },
  700,
);
check("same bar does not take the stop it just ratcheted", held?.reason === "session" && held.pnl === 20 && held.peakPts === 30);

const target = simulateTargetExit(
  [
    { min: 600, open: 100, high: 104, low: 99, close: 103 },
    { min: 601, open: 103, high: 106, low: 102, close: 105 },
  ],
  1,
  100,
  5,
  10,
  700,
);
check("fixed target fills at +5 before the close", target?.pnl === 5 && target.exitPrice === 105);

const capped = simulateTrailExit(
  [{ min: 600, open: 100, high: 112, low: 100, close: 111 }],
  1,
  100,
  { stopPts: 40, armPts: 5, trailPts: 2, minLockPts: 5, maxProfitPts: 10 },
  700,
);
check("profit is closed at +10", capped?.reason === "trail" && capped.pnl === 10 && capped.exitPrice === 110);

const locked = simulateTrailExit(
  [
    { min: 600, open: 100, high: 107, low: 100, close: 106 },
    { min: 601, open: 106, high: 106, low: 104, close: 105 },
  ],
  1,
  100,
  { stopPts: 40, armPts: 5, trailPts: 2, minLockPts: 5, maxProfitPts: 10 },
  700,
);
check("pullback exits at the +5 lock", locked?.reason === "trail" && locked.pnl === 5 && locked.exitPrice === 105);

if (failed > 0) {
  console.error(`${failed} mismatch`);
  process.exit(1);
}
console.log("trail checks passed");
