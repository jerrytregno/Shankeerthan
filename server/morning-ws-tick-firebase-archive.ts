import fs from "fs";
import path from "path";
import readline from "readline";
import type { RawTickRow } from "./nine-sixteen-bot.js";
import { flushWsTickLogToDisk } from "./nine-sixteen-bot.js";
import { istMsOfDay, istSecondsOfDay } from "./nine-sixteen-logic.js";
import { getIndianMarketContext } from "../src/lib/market-time.js";
import { getAdminFirestore, getAdminStorageBucket, isFirebaseAdminConfigured } from "./firebase-admin-app.js";

const TICK_DIR = path.join(process.cwd(), "data", "ticks");
const tickFilePath = (dateIst: string) => path.join(TICK_DIR, `ws-ticks-${dateIst}.jsonl`);

const UPLOAD_STATE_FILE = path.join(process.cwd(), "data", "morning-ws-tick-firebase-upload.json");

/** 09:15:00 IST through 09:20:59 IST (inclusive). */
const ARCHIVE_WINDOW_START_SEC = 9 * 3600 + 15 * 60;
const ARCHIVE_WINDOW_END_SEC = 9 * 3600 + 20 * 60 + 59;

/** Daily upload fires at 10:00:15 IST — after the 10:00 hard-stop window, off the tick hot path. */
const UPLOAD_AT_MS_OF_DAY = (10 * 60 * 60 + 15) * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const FIRESTORE_COLLECTION = "morningWsTicks";
const STORAGE_PREFIX = "morning-ws-ticks";
/** Stay under Firestore's 1 MiB document limit once field overhead is included. */
const TICK_JSON_BUDGET = 700_000;

export interface MorningWsTickUploadState {
  dateIST: string;
  uploadedAt: string;
  tickCount: number;
  niftyCount: number;
  optionCount: number;
  storagePath: string;
  windowLabel: string;
}

interface PersistedUploadIndex {
  byDate: Record<string, MorningWsTickUploadState>;
}

let dailyTimer: NodeJS.Timeout | null = null;
let uploadInFlight = false;
let lastRun: { at: string; ok: boolean; dateIST?: string; error?: string } | null = null;

function archiveDisabled(): boolean {
  return process.env.FIREBASE_MORNING_TICK_ARCHIVE === "0";
}

export function isMorningWsTickArchiveEnabled(): boolean {
  return !archiveDisabled() && isFirebaseAdminConfigured();
}

function tickInArchiveWindow(epochMs: number): boolean {
  const sec = istSecondsOfDay(new Date(epochMs));
  return sec >= ARCHIVE_WINDOW_START_SEC && sec <= ARCHIVE_WINDOW_END_SEC;
}

function loadUploadIndex(): PersistedUploadIndex {
  try {
    if (!fs.existsSync(UPLOAD_STATE_FILE)) return { byDate: {} };
    const parsed = JSON.parse(fs.readFileSync(UPLOAD_STATE_FILE, "utf-8")) as Partial<PersistedUploadIndex>;
    return { byDate: parsed.byDate ?? {} };
  } catch {
    return { byDate: {} };
  }
}

function saveUploadIndex(index: PersistedUploadIndex) {
  fs.mkdirSync(path.dirname(UPLOAD_STATE_FILE), { recursive: true });
  fs.writeFileSync(UPLOAD_STATE_FILE, JSON.stringify(index, null, 2));
}

async function readFilteredTicks(dateIst: string): Promise<RawTickRow[]> {
  const file = tickFilePath(dateIst);
  if (!fs.existsSync(file)) return [];

  const rows: RawTickRow[] = [];
  const stream = fs.createReadStream(file, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: RawTickRow;
    try {
      row = JSON.parse(trimmed) as RawTickRow;
    } catch {
      continue;
    }
    if (row.dateIST !== dateIst) continue;
    if (!Number.isFinite(row.epochMs)) continue;
    if (!tickInArchiveWindow(row.epochMs)) continue;
    rows.push(row);
  }

  return rows;
}

function packTickChunks(ticks: RawTickRow[]): string[] {
  const chunks: string[] = [];
  let batch: RawTickRow[] = [];
  let bytes = 2;
  const flush = () => {
    if (batch.length === 0) return;
    chunks.push(JSON.stringify(batch));
    batch = [];
    bytes = 2;
  };
  for (const tick of ticks) {
    const extra = Buffer.byteLength(JSON.stringify(tick)) + 1;
    if (batch.length > 0 && bytes + extra > TICK_JSON_BUDGET) flush();
    batch.push(tick);
    bytes += extra;
  }
  flush();
  return chunks.length > 0 ? chunks : ["[]"];
}

async function saveTicksInFirestore(
  dateIst: string,
  ticks: RawTickRow[],
  state: MorningWsTickUploadState,
): Promise<void> {
  const db = getAdminFirestore();
  if (!db) throw new Error("Firestore is not configured");
  const parent = db.collection(FIRESTORE_COLLECTION).doc(dateIst);
  const chunks = packTickChunks(ticks);
  const base = {
    ...state,
    sourceFile: tickFilePath(dateIst),
    chunkCount: chunks.length,
  };
  if (chunks.length === 1) {
    await parent.set({ ...base, ticksJson: chunks[0] });
    return;
  }
  await parent.set(base);
  for (let i = 0; i < chunks.length; i += 1) {
    await parent.collection("chunks").doc(String(i).padStart(4, "0")).set({ ticksJson: chunks[i] });
  }
}

/** Storage is optional. A missing bucket must not block the Firestore copy. */
async function trySaveStorageCopy(dateIst: string, ticks: RawTickRow[], windowLabel: string): Promise<string> {
  const bucket = getAdminStorageBucket();
  if (!bucket) return "";
  const storagePath = `${STORAGE_PREFIX}/${dateIst}/0915-0920.jsonl`;
  const body = ticks.length > 0 ? `${ticks.map((t) => JSON.stringify(t)).join("\n")}\n` : "";
  try {
    await bucket.file(storagePath).save(body, {
      contentType: "application/x-ndjson",
      metadata: {
        metadata: {
          dateIST: dateIst,
          windowLabel,
          tickCount: String(ticks.length),
        },
      },
    });
    return storagePath;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[morning-ws-tick-archive] storage copy skipped for ${dateIst}: ${message}`);
    return "";
  }
}

export async function uploadMorningWsTicksForDate(dateIst: string): Promise<MorningWsTickUploadState> {
  const db = getAdminFirestore();
  if (!db) {
    throw new Error("Firestore is not configured");
  }

  const index = loadUploadIndex();
  const existing = index.byDate[dateIst];
  if (existing?.uploadedAt) {
    const snap = await db.collection(FIRESTORE_COLLECTION).doc(dateIst).get();
    if (snap.exists) return existing;
  }

  flushWsTickLogToDisk();

  const ticks = await readFilteredTicks(dateIst);
  const niftyCount = ticks.filter((t) => t.kind === "nifty").length;
  const optionCount = ticks.filter((t) => t.kind === "option").length;

  const windowLabel = "09:15:00–09:20:59 IST";
  const storagePath = await trySaveStorageCopy(dateIst, ticks, windowLabel);

  const uploadedAt = new Date().toISOString();
  const state: MorningWsTickUploadState = {
    dateIST: dateIst,
    uploadedAt,
    tickCount: ticks.length,
    niftyCount,
    optionCount,
    storagePath,
    windowLabel,
  };

  await saveTicksInFirestore(dateIst, ticks, state);

  index.byDate[dateIst] = state;
  saveUploadIndex(index);
  return state;
}

/** Copy every on-disk morning window into Firestore. Safe to run again. */
export async function backfillMorningWsTicksFromDisk(): Promise<MorningWsTickUploadState[]> {
  if (!fs.existsSync(TICK_DIR)) return [];
  const dates = fs
    .readdirSync(TICK_DIR)
    .map((name) => /^ws-ticks-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1] ?? "")
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();
  const saved: MorningWsTickUploadState[] = [];
  for (const dateIst of dates) {
    saved.push(await uploadMorningWsTicksForDate(dateIst));
  }
  return saved;
}

export async function readArchivedMorningTickRows(dateIst: string): Promise<RawTickRow[] | null> {
  const db = getAdminFirestore();
  if (!db) return null;
  const parent = db.collection(FIRESTORE_COLLECTION).doc(dateIst);
  const snap = await parent.get();
  if (!snap.exists) return null;
  const data = snap.data() ?? {};
  const parts: string[] = [];
  if (typeof data.ticksJson === "string" && data.ticksJson.length > 0) {
    parts.push(data.ticksJson);
  } else if (typeof data.chunkCount === "number" && data.chunkCount > 0) {
    const chunkSnap = await parent.collection("chunks").get();
    const ordered = chunkSnap.docs.sort((a, b) => a.id.localeCompare(b.id));
    for (const doc of ordered) {
      const json = doc.data().ticksJson;
      if (typeof json === "string") parts.push(json);
    }
  }
  const rows: RawTickRow[] = [];
  for (const part of parts) {
    const parsed = JSON.parse(part) as RawTickRow[];
    if (Array.isArray(parsed)) rows.push(...parsed);
  }
  return rows;
}

async function runScheduledUpload(reason: string): Promise<void> {
  if (!isMorningWsTickArchiveEnabled()) return;
  if (uploadInFlight) return;

  const dateIst = getIndianMarketContext().dateIST;
  const index = loadUploadIndex();
  if (index.byDate[dateIst]?.uploadedAt) {
    console.log(`[morning-ws-tick-archive] ${dateIst} already uploaded — skip (${reason})`);
    return;
  }

  uploadInFlight = true;
  try {
    const result = await uploadMorningWsTicksForDate(dateIst);
    lastRun = { at: new Date().toISOString(), ok: true, dateIST: dateIst };
    console.log(
      `[morning-ws-tick-archive] ${reason} · ${result.dateIST} · ${result.tickCount} ticks → Firestore/${FIRESTORE_COLLECTION} + Storage/${result.storagePath}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastRun = { at: new Date().toISOString(), ok: false, dateIST: dateIst, error: message };
    console.error(`[morning-ws-tick-archive] ${reason} failed: ${message}`);
  } finally {
    uploadInFlight = false;
  }
}

function msUntilUpload(nowMs = Date.now()): number {
  const delay = UPLOAD_AT_MS_OF_DAY - istMsOfDay(nowMs);
  return delay > 0 ? delay : delay + DAY_MS;
}

function scheduleNextUpload(): void {
  if (dailyTimer) clearTimeout(dailyTimer);
  if (!isMorningWsTickArchiveEnabled()) return;

  const delay = msUntilUpload();
  dailyTimer = setTimeout(() => {
    void runScheduledUpload("10:00:15 IST").finally(scheduleNextUpload);
  }, delay);
  dailyTimer.unref?.();

  const mins = Math.round(delay / 60_000);
  console.log(
    `[morning-ws-tick-archive] next 09:15–09:20 tick upload in ${Math.floor(mins / 60)}h ${mins % 60}m (10:00:15 IST)`,
  );
}

export function getMorningWsTickArchiveStatus() {
  return {
    enabled: isMorningWsTickArchiveEnabled(),
    configured: isFirebaseAdminConfigured(),
    uploadAtIst: "10:00:15",
    windowIst: "09:15:00–09:20:59",
    firestoreCollection: FIRESTORE_COLLECTION,
    uploadInFlight,
    lastRun,
    recentUploads: loadUploadIndex().byDate,
  };
}

/**
 * Arms the daily archive job. If the server starts after today's upload time and today's file
 * is not uploaded yet, runs once in the background (does not block bot startup).
 */
export function startMorningWsTickFirebaseArchive(): void {
  if (archiveDisabled()) {
    console.log("[morning-ws-tick-archive] disabled (FIREBASE_MORNING_TICK_ARCHIVE=0)");
    return;
  }
  if (!isFirebaseAdminConfigured()) {
    console.warn(
      "[morning-ws-tick-archive] not scheduled — set FIREBASE_SERVICE_ACCOUNT_JSON (or BASE64 / GOOGLE_APPLICATION_CREDENTIALS)",
    );
    return;
  }

  scheduleNextUpload();

  if (istMsOfDay() >= UPLOAD_AT_MS_OF_DAY) {
    const dateIst = getIndianMarketContext().dateIST;
    if (!loadUploadIndex().byDate[dateIst]?.uploadedAt) {
      console.log("[morning-ws-tick-archive] startup: today's upload window passed — uploading now");
      void runScheduledUpload("startup catch-up");
    }
  }
}
