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

export async function uploadMorningWsTicksForDate(dateIst: string): Promise<MorningWsTickUploadState> {
  const db = getAdminFirestore();
  const bucket = getAdminStorageBucket();
  if (!db || !bucket) {
    throw new Error("Firebase Admin is not configured (service account missing)");
  }

  const index = loadUploadIndex();
  const existing = index.byDate[dateIst];
  if (existing?.uploadedAt) {
    return existing;
  }

  flushWsTickLogToDisk();

  const ticks = await readFilteredTicks(dateIst);
  const niftyCount = ticks.filter((t) => t.kind === "nifty").length;
  const optionCount = ticks.filter((t) => t.kind === "option").length;

  const windowLabel = "09:15:00–09:20:59 IST";
  const storagePath = `${STORAGE_PREFIX}/${dateIst}/0915-0920.jsonl`;
  const body = ticks.length > 0 ? `${ticks.map((t) => JSON.stringify(t)).join("\n")}\n` : "";

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

  await db.collection(FIRESTORE_COLLECTION).doc(dateIst).set({
    ...state,
    sourceFile: tickFilePath(dateIst),
    previewTicks: ticks.slice(0, 25),
    tailTicks: ticks.length > 25 ? ticks.slice(-10) : [],
  });

  index.byDate[dateIst] = state;
  saveUploadIndex(index);
  return state;
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
