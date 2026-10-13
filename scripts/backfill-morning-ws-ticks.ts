/**
 * Copy on-disk 09:15–09:20 websocket ticks into Firestore.
 * Run on the server: npx tsx scripts/backfill-morning-ws-ticks.ts
 */
import "../server/load-env.js";
import { backfillMorningWsTicksFromDisk } from "../server/morning-ws-tick-firebase-archive.js";

const saved = await backfillMorningWsTicksFromDisk();
console.log(
  JSON.stringify(
    {
      days: saved.length,
      sessions: saved.map((row) => ({
        date: row.dateIST,
        ticks: row.tickCount,
        nifty: row.niftyCount,
        option: row.optionCount,
      })),
    },
    null,
    2,
  ),
);
