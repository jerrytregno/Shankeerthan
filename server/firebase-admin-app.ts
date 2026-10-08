import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import fs from "fs";

let adminApp: App | null = null;

function parseServiceAccountJson(): Record<string, unknown> | null {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64?.trim();
  if (b64) {
    try {
      return JSON.parse(Buffer.from(b64, "base64").toString("utf-8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (raw) {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (path && fs.existsSync(path)) {
    try {
      return JSON.parse(fs.readFileSync(path, "utf-8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  return null;
}

export function isFirebaseAdminConfigured(): boolean {
  return parseServiceAccountJson() != null;
}

export function getFirebaseAdminApp(): App | null {
  if (adminApp) return adminApp;
  const existing = getApps()[0];
  if (existing) {
    adminApp = existing;
    return adminApp;
  }

  const serviceAccount = parseServiceAccountJson();
  if (!serviceAccount) return null;

  const projectId =
    process.env.FIREBASE_PROJECT_ID?.trim() ||
    process.env.VITE_FIREBASE_PROJECT_ID?.trim() ||
    (typeof serviceAccount.project_id === "string" ? serviceAccount.project_id : undefined);

  const storageBucket =
    process.env.FIREBASE_STORAGE_BUCKET?.trim() ||
    process.env.VITE_FIREBASE_STORAGE_BUCKET?.trim() ||
    (projectId ? `${projectId}.appspot.com` : undefined);

  adminApp = initializeApp({
    credential: cert(serviceAccount as Parameters<typeof cert>[0]),
    projectId,
    storageBucket,
  });
  return adminApp;
}

export function getAdminFirestore() {
  const app = getFirebaseAdminApp();
  if (!app) return null;
  return getFirestore(app);
}

export function getAdminStorageBucket() {
  const app = getFirebaseAdminApp();
  if (!app) return null;
  return getStorage(app).bucket();
}
