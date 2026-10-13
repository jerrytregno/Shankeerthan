import {
  evaluateFade1405Setup,
  FADE_1405_ENTRY_MIN,
  FADE_1405_FLAT_MIN,
  FADE_1405_SIGNAL_MIN,
  initFade1405LiveTrail,
  stepFade1405LiveTrail,
  type Fade1405LiveTrail,
  type Fade1405Setup,
} from "./fade-1405-shared.js";

export type { Fade1405Setup } from "./fade-1405-shared.js";

export type Fade1405LiveCallbacks = {
  onEnter: (setup: Fade1405Setup, entrySpot: number) => void | Promise<void>;
  onExit: (reason: string, exitSpot: number) => void | Promise<void>;
  onSkip: (reason: string) => void;
  log: (message: string, type?: "info" | "warning" | "success") => void;
};

let settled = false;
let entryTriggered = false;
let sessionHi = Number.NEGATIVE_INFINITY;
let sessionLo = Number.POSITIVE_INFINITY;
let close1405: number | null = null;
let prevDayRange: number | null = null;
let trail: Fade1405LiveTrail | null = null;
let callbacks: Fade1405LiveCallbacks | null = null;

export function resetFade1405LiveForDay() {
  settled = false;
  entryTriggered = false;
  sessionHi = Number.NEGATIVE_INFINITY;
  sessionLo = Number.POSITIVE_INFINITY;
  close1405 = null;
  prevDayRange = null;
  trail = null;
}

export function isFade1405LiveSettled() {
  return settled;
}

export function markFade1405LiveSettled() {
  settled = true;
}

export function setFade1405PrevDayRange(range: number) {
  prevDayRange = range;
}

export function getFade1405Trail() {
  return trail;
}

export function armFade1405Trail(entrySpot: number, dir: 1 | -1) {
  trail = initFade1405LiveTrail(entrySpot, dir);
}

export function attachFade1405Live(cbs: Fade1405LiveCallbacks) {
  callbacks = cbs;
}

/** Call on each Nifty websocket tick after the morning session is done. */
export async function fade1405LiveOnNiftyTick(
  spot: number,
  secOfDay: number,
  open915: number | null,
  inFadePosition: boolean,
): Promise<void> {
  if (!callbacks || settled) return;
  if (!Number.isFinite(spot) || spot <= 0) return;

  if (secOfDay >= 9 * 60 + 15 && secOfDay <= FADE_1405_FLAT_MIN) {
    sessionHi = Math.max(sessionHi, spot);
    sessionLo = Math.min(sessionLo, spot);
  }

  if (inFadePosition && trail) {
    if (secOfDay >= FADE_1405_FLAT_MIN) {
      await callbacks.onExit("14:05 fade · 3:20 square-off", spot);
      settled = true;
      return;
    }
    const hit = stepFade1405LiveTrail(trail, spot);
    if (hit) {
      await callbacks.onExit(
        `14:05 fade · Nifty trail ${hit.reason} @ ${hit.exitSpot.toFixed(2)}`,
        hit.exitSpot,
      );
      settled = true;
    }
    return;
  }

  if (entryTriggered || secOfDay < FADE_1405_SIGNAL_MIN) return;

  if (secOfDay >= FADE_1405_SIGNAL_MIN && secOfDay < FADE_1405_SIGNAL_MIN + 60) {
    close1405 = spot;
  }

  if (secOfDay < FADE_1405_ENTRY_MIN || secOfDay >= FADE_1405_ENTRY_MIN + 30) {
    if (secOfDay >= FADE_1405_ENTRY_MIN + 30 && !entryTriggered && !settled) {
      callbacks.onSkip("14:05 fade · missed 14:06 entry window");
      settled = true;
    }
    return;
  }

  if (entryTriggered) return;
  entryTriggered = true;

  if (open915 == null || open915 <= 0 || close1405 == null || prevDayRange == null) {
    callbacks.onSkip("14:05 fade · missing open915, 14:05 close, or yesterday range");
    settled = true;
    return;
  }
  const todayRange =
    Number.isFinite(sessionHi) && Number.isFinite(sessionLo) ? sessionHi - sessionLo : Number.NaN;
  const setup = evaluateFade1405Setup(open915, close1405, todayRange, prevDayRange);
  if (!setup) {
    callbacks.onSkip("14:05 fade · setup conditions not met at 14:06");
    settled = true;
    return;
  }
  callbacks.log(
    `14:05 fade setup · ${setup.setupLabel} · ${setup.side} @ 14:06 · trail stop 25 arm +5`,
    "success",
  );
  await callbacks.onEnter(setup, spot);
}
