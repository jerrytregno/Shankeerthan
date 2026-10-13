/**
 * One-off copy of on-disk 09:15–09:20 websocket ticks into Firestore.
 * Does not import the trading bot. Run from the project root on the server.
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import readline from "readline";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

function serviceAccount() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64?.trim();
  if (b64) return JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (raw) return JSON.parse(raw);
  const cred = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (cred && fs.existsSync(cred)) return JSON.parse(fs.readFileSync(cred, "utf-8"));
  throw new Error("Firestore is not configured");
}

const account = serviceAccount();
const projectId =
  process.env.FIREBASE_PROJECT_ID?.trim() ||
  process.env.VITE_FIREBASE_PROJECT_ID?.trim() ||
  account.project_id;
const app = getApps()[0] ?? initializeApp({ credential: cert(account), projectId });
const db = getFirestore(app);

const TICK_DIR = path.join(process.cwd(), "data", "ticks");
const START = 9 * 3600 + 15 * 60;
const END = 9 * 3600 + 20 * 60 + 59;
const BUDGET = 700_000;

function istSec(epochMs) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return pick("hour") * 3600 + pick("minute") * 60 + pick("second");
}

async function readWindow(dateIst) {
  const file = path.join(TICK_DIR, `ws-ticks-${dateIst}.jsonl`);
  const rows = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf-8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (row.dateIST !== dateIst || !Number.isFinite(row.epochMs)) continue;
    const sec = istSec(row.epochMs);
    if (sec < START || sec > END) continue;
    rows.push(row);
  }
  return rows;
}

function pack(ticks) {
  const chunks = [];
  let batch = [];
  let bytes = 2;
  const flush = () => {
    if (batch.length === 0) return;
    chunks.push(JSON.stringify(batch));
    batch = [];
    bytes = 2;
  };
  for (const tick of ticks) {
    const extra = Buffer.byteLength(JSON.stringify(tick)) + 1;
    if (batch.length > 0 && bytes + extra > BUDGET) flush();
    batch.push(tick);
    bytes += extra;
  }
  flush();
  return chunks.length > 0 ? chunks : ["[]"];
}

const dates = fs
  .readdirSync(TICK_DIR)
  .map((name) => /^ws-ticks-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1] ?? "")
  .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
  .sort();

const sessions = [];
for (const dateIST of dates) {
  const ticks = await readWindow(dateIST);
  const chunks = pack(ticks);
  const parent = db.collection("morningWsTicks").doc(dateIST);
  const state = {
    dateIST,
    uploadedAt: new Date().toISOString(),
    tickCount: ticks.length,
    niftyCount: ticks.filter((tick) => tick.kind === "nifty").length,
    optionCount: ticks.filter((tick) => tick.kind === "option").length,
    storagePath: "",
    windowLabel: "09:15:00–09:20:59 IST",
    sourceFile: path.join(TICK_DIR, `ws-ticks-${dateIST}.jsonl`),
    chunkCount: chunks.length,
  };
  if (chunks.length === 1) {
    await parent.set({ ...state, ticksJson: chunks[0] });
  } else {
    await parent.set(state);
    for (let i = 0; i < chunks.length; i += 1) {
      await parent.collection("chunks").doc(String(i).padStart(4, "0")).set({ ticksJson: chunks[i] });
    }
  }
  sessions.push({ date: dateIST, ticks: state.tickCount, nifty: state.niftyCount, option: state.optionCount, chunks: chunks.length });
  console.log(`saved ${dateIST} · ${state.tickCount} ticks · ${chunks.length} chunk(s)`);
}

console.log(JSON.stringify({ days: sessions.length, sessions }, null, 2));
