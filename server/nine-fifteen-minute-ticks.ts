import fs from "fs";
import path from "path";
import readline from "readline";
import type { RawTickRow } from "./nine-sixteen-bot.js";
import { flushWsTickLogToDisk } from "./nine-sixteen-bot.js";
import {
  isIn915CloseTickWindow,
  NINE_SIXTEEN_CLOSE_SEAL_SEC,
  NINE_SIXTEEN_OPEN_TICK_START_SEC,
} from "./nine-sixteen-logic.js";
import { getAdminFirestore, getAdminStorageBucket } from "./firebase-admin-app.js";
import { readArchivedMorningTickRows } from "./morning-ws-tick-firebase-archive.js";
import type {
  NineFifteenMinuteTickPoint,
  NineFifteenMinuteTickSeries,
} from "../src/types/nine-fifteen-minute-ticks.js";

const TICK_DIR = path.join(process.cwd(), "data", "ticks");
const UPLOAD_INDEX_FILE = path.join(process.cwd(), "data", "morning-ws-tick-firebase-upload.json");
const FIRESTORE_COLLECTION = "morningWsTicks";
const STORAGE_PREFIX = "morning-ws-ticks";

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function isNineFifteenMinuteDateKey(value: string): boolean {
  return DATE_KEY.test(value);
}

/** 09:15:00.000 inclusive through 09:16:00.000 exclusive, as UTC epoch milliseconds. */
export function nineFifteenMinuteBounds(dateIst: string): { startMs: number; endMs: number } {
  const [year, month, day] = dateIst.split("-").map(Number);
  const istMidnightUtc = Date.UTC(year, month - 1, day) - (5 * 60 + 30) * 60 * 1000;
  return {
    startMs: istMidnightUtc + NINE_SIXTEEN_OPEN_TICK_START_SEC * 1000,
    endMs: istMidnightUtc + NINE_SIXTEEN_CLOSE_SEAL_SEC * 1000,
  };
}

/** HH:MM:SS.mmm IST. Milliseconds match the epoch because IST is a whole number of minutes. */
export function formatIstTimeMs(epochMs: number): string {
  const raw = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(epochMs));
  const match = /^(\d{1,2})(:\d{2}:\d{2})$/.exec(raw);
  const clock = match ? `${String(Number(match[1]) % 24).padStart(2, "0")}${match[2]}` : raw;
  return `${clock}.${String(Math.abs(epochMs) % 1000).padStart(3, "0")}`;
}

function isNifty915Tick(row: RawTickRow): boolean {
  return row.kind === "nifty" && Number.isFinite(row.epochMs) && Number.isFinite(row.price) && row.price > 0 && isIn915CloseTickWindow(row.epochMs);
}

export function toMinuteTickPoint(row: RawTickRow): NineFifteenMinuteTickPoint {
  const timeIST = /^\d{2}:\d{2}:\d{2}\.\d{3}$/.test(row.timeIST) ? row.timeIST : formatIstTimeMs(row.epochMs);
  return {
    seq: row.seq,
    timeIST,
    epochMs: row.epochMs,
    price: row.price,
    exchangeTimeIST: row.exchangeTimeIST,
  };
}

export function filterNineFifteenNiftyTicks(rows: RawTickRow[]): NineFifteenMinuteTickPoint[] {
  return rows
    .filter(isNifty915Tick)
    .map(toMinuteTickPoint)
    .sort((a, b) => a.epochMs - b.epochMs || a.seq - b.seq);
}

function tickFilePath(dateIst: string): string {
  return path.join(TICK_DIR, `ws-ticks-${dateIst}.jsonl`);
}

function storagePathFor(dateIst: string): string {
  return `${STORAGE_PREFIX}/${dateIst}/0915-0920.jsonl`;
}

function datesFromDisk(): string[] {
  try {
    if (!fs.existsSync(TICK_DIR)) return [];
    return fs
      .readdirSync(TICK_DIR)
      .map((name) => /^ws-ticks-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1] ?? "")
      .filter(isNineFifteenMinuteDateKey);
  } catch {
    return [];
  }
}

function datesFromUploadIndex(): string[] {
  try {
    if (!fs.existsSync(UPLOAD_INDEX_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(UPLOAD_INDEX_FILE, "utf-8")) as {
      byDate?: Record<string, unknown>;
    };
    return Object.keys(parsed.byDate ?? {}).filter(isNineFifteenMinuteDateKey);
  } catch {
    return [];
  }
}

async function datesFromFirestore(): Promise<string[]> {
  const db = getAdminFirestore();
  if (!db) return [];
  try {
    const refs = await db.collection(FIRESTORE_COLLECTION).listDocuments();
    return refs.map((ref) => ref.id).filter(isNineFifteenMinuteDateKey);
  } catch (err) {
    console.error("[nine-fifteen-minute-ticks] firestore list failed", err);
    return [];
  }
}

export async function listNineFifteenMinuteTickDates(): Promise<string[]> {
  const [firestoreDates] = await Promise.all([datesFromFirestore()]);
  const merged = new Set<string>([...datesFromDisk(), ...datesFromUploadIndex(), ...firestoreDates]);
  return [...merged].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

async function readJsonlNifty915(readLine: AsyncIterable<string> | Iterable<string>): Promise<NineFifteenMinuteTickPoint[]> {
  const points: NineFifteenMinuteTickPoint[] = [];
  for await (const line of readLine) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: RawTickRow;
    try {
      row = JSON.parse(trimmed) as RawTickRow;
    } catch {
      continue;
    }
    if (!isNifty915Tick(row)) continue;
    points.push(toMinuteTickPoint(row));
  }
  points.sort((a, b) => a.epochMs - b.epochMs || a.seq - b.seq);
  return points;
}

async function readDiskTicks(dateIst: string): Promise<NineFifteenMinuteTickPoint[] | null> {
  const file = tickFilePath(dateIst);
  if (!fs.existsSync(file)) return null;
  flushWsTickLogToDisk();
  const stream = fs.createReadStream(file, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  return readJsonlNifty915(rl);
}

async function readFirestoreTicks(dateIst: string): Promise<NineFifteenMinuteTickPoint[] | null> {
  const rows = await readArchivedMorningTickRows(dateIst);
  if (!rows) return null;
  return filterNineFifteenNiftyTicks(rows);
}

async function readStorageTicks(dateIst: string): Promise<NineFifteenMinuteTickPoint[] | null> {
  const bucket = getAdminStorageBucket();
  if (!bucket) return null;
  const file = bucket.file(storagePathFor(dateIst));
  try {
    const [exists] = await file.exists();
    if (!exists) return null;
    const [buf] = await file.download();
    return readJsonlNifty915(buf.toString("utf-8").split("\n"));
  } catch (err) {
    console.error("[nine-fifteen-minute-ticks] storage read failed", err);
    throw err instanceof Error ? err : new Error("Could not read saved 9:15 ticks");
  }
}

function seriesFromPoints(
  dateIst: string,
  source: NineFifteenMinuteTickSeries["source"],
  ticks: NineFifteenMinuteTickPoint[],
): NineFifteenMinuteTickSeries {
  const bounds = nineFifteenMinuteBounds(dateIst);
  const prices = ticks.map((tick) => tick.price);
  return {
    dateIST: dateIst,
    source,
    windowLabel: "09:15:00.000–09:15:59.999 IST",
    timePrecision: "millisecond",
    windowStartMs: bounds.startMs,
    windowEndMs: bounds.endMs,
    tickCount: ticks.length,
    firstTimeIST: ticks[0]?.timeIST ?? null,
    lastTimeIST: ticks[ticks.length - 1]?.timeIST ?? null,
    open: prices[0] ?? null,
    high: prices.length > 0 ? Math.max(...prices) : null,
    low: prices.length > 0 ? Math.min(...prices) : null,
    close: prices[prices.length - 1] ?? null,
    ticks,
  };
}

export async function loadNineFifteenMinuteTicks(dateIst: string): Promise<NineFifteenMinuteTickSeries> {
  const disk = await readDiskTicks(dateIst);
  if (disk && disk.length > 0) return seriesFromPoints(dateIst, "disk", disk);

  const fromDb = await readFirestoreTicks(dateIst);
  if (fromDb && fromDb.length > 0) return seriesFromPoints(dateIst, "firestore", fromDb);

  let stored: NineFifteenMinuteTickPoint[] | null = null;
  try {
    stored = await readStorageTicks(dateIst);
  } catch (err) {
    console.error("[nine-fifteen-minute-ticks] storage read failed", err);
  }
  if (stored && stored.length > 0) return seriesFromPoints(dateIst, "storage", stored);

  if (disk) return seriesFromPoints(dateIst, "disk", disk);
  if (fromDb) return seriesFromPoints(dateIst, "firestore", fromDb);
  if (stored) return seriesFromPoints(dateIst, "storage", stored);
  return seriesFromPoints(dateIst, "none", []);
}
