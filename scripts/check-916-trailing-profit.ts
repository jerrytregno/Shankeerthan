/**
 * 9:16 trade — trailing profit after the index target, without adding losses.
 *
 * Baseline = the 9:16 backtesting pages: red 9:15 (|Δ| ≥ 15) → PE, green → CE, entry at the
 * 9:16 open, flat 12 (9:16 open keeps the 9:15 colour) / 8 (gap against it) Nifty target,
 * 40 points against at the 9:26 (PE) / 9:17 (CE) bar open, a minute that runs 25 pts
 * against its own open is a loss, otherwise
 * out at that checkpoint if in profit, or later at the entry price.
 *
 * Rule tested: the first touch of the target no longer exits. It locks (target − buffer) and
 * starts a trail: at each minute close the stop moves to (best − trail), best being the best
 * minute high/low (or close) since the touch; any tick at or past the stop exits. Every other
 * exit is unchanged and a trade that never touches its target is untouched, so no win can turn
 * into a loss — the most a winner can give back is the buffer.
 *
 * Inside the minute of the touch, 1-minute bars cannot tell whether price dipped under the new
 * floor. The script replays the same rule on real Nifty websocket ticks
 * (data/ticks/nifty-<date>.csv, "HH:MM:SS.mmm,price") on synthetic morning trades, measures how
 * far the 1-minute model is off per armed trade, and subtracts that from the backtest.
 *
 * Run: npx tsx scripts/check-916-trailing-profit.ts   (needs data/nifty-minute-2y.json.gz)
 * DETAIL="T12 b3 d4 high" prints every changed trade for one rule.
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";

const CACHE = path.join(process.cwd(), "data", "nifty-minute-2y.json.gz");
const TICK_DIR = path.join(process.cwd(), "data", "ticks");
const M915 = 9 * 60 + 15;
const M916 = M915 + 1;
const M917 = M915 + 2;
const PE_CHECK = 9 * 60 + 26;
const CE_CHECK = M917;
const M1530 = 15 * 60 + 30;
const FORCE_EXIT = 15 * 60 + 25;
const MIN_BARS = 330;
const MIN_BODY = 15;
const TARGET_CONFIRM = 12;
const TARGET_GAP = 8;
const ADVERSE_STOP = 40;
const PAGE_SESSIONS = 252;
const SYNTH_FROM = 9 * 60 + 16;
const SYNTH_TO = Number(process.env.SYNTH_TO ?? 10 * 60 + 30);
const SYNTH_ARM_WINDOW = 11;

type RawDay = { date: string; bars: number[][] };
type Side = "PE" | "CE";
type Kind = "target" | "checkpoint" | "return" | "stop" | "eod" | "trail" | "timecap";
type Basis = "high" | "close";

interface Bar {
  m: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

interface Trade {
  date: string;
  side: Side;
  dir: 1 | -1;
  entry: number;
  confirm: boolean;
  target: number;
  bars: Bar[];
}

interface Rule {
  id: string;
  /** Points under a 12-point target that stay locked. */
  buffer: number;
  /** Same for the 8-point target (defaults to `buffer`). */
  buffer8?: number;
  trail: number;
  basis: Basis;
  timeCap?: number;
}

function bufferFor(rule: Rule, target: number): number {
  return target === TARGET_GAP && rule.buffer8 != null ? rule.buffer8 : rule.buffer;
}

interface Result {
  win: boolean;
  pnl: number;
  kind: Kind;
  exitMin: number;
  armMin: number | null;
}

function hhmm(mins: number): string {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

function ruleId(buffer: number, trail: number, basis: Basis, timeCap?: number, buffer8?: number): string {
  const b = buffer8 != null && buffer8 !== buffer ? `b${buffer}/${buffer8}` : `b${buffer}`;
  return `${b} d${trail} ${basis}${timeCap != null ? ` flat ${hhmm(timeCap)}` : ""}`;
}

function buildTrades(raw: RawDay[]): { sessions: string[]; trades: Trade[] } {
  const sessions: string[] = [];
  const trades: Trade[] = [];
  for (const rd of raw) {
    const bars: Bar[] = rd.bars
      .filter((b) => b[0] >= M915 && b[0] <= M1530)
      .map((b) => ({ m: b[0], o: b[1], h: b[2], l: b[3], c: b[4] }))
      .sort((a, b) => a.m - b.m);
    if (bars.length < MIN_BARS) continue;
    const b915 = bars.find((b) => b.m === M915);
    const b916 = bars.find((b) => b.m === M916);
    if (!b915 || !b916) continue;
    if (bars[bars.length - 1].m < M1530 - 1) continue;
    sessions.push(rd.date);

    const change = b915.c - b915.o;
    if (change === 0 || Math.abs(change) < MIN_BODY) continue;
    const side: Side = change < 0 ? "PE" : "CE";
    const entry = b916.o;
    const confirm = side === "PE" ? entry <= b915.c + 1e-9 : entry >= b915.c - 1e-9;
    trades.push({
      date: rd.date,
      side,
      dir: side === "CE" ? 1 : -1,
      entry,
      confirm,
      target: confirm ? TARGET_CONFIRM : TARGET_GAP,
      bars: bars.filter((b) => b.m >= M916),
    });
  }
  return { sessions, trades };
}

const MINUTE_SPIKE = 25;

/** First minute that runs 25 pts against its own open before the flat target. */
function minuteSpikeBeforeTarget(t: Trade): number | null {
  const targetPx = t.entry + t.dir * t.target;
  for (const b of t.bars) {
    const spike = t.side === "PE" ? b.h - b.o : b.o - b.l;
    const spikeHit = spike + 1e-9 >= MINUTE_SPIKE;
    const targetHit = t.side === "CE" ? b.h + 1e-9 >= targetPx : b.l <= targetPx + 1e-9;
    if (targetHit && spikeHit) {
      const openedThrough = t.side === "CE" ? b.o + 1e-9 >= targetPx : b.o <= targetPx + 1e-9;
      if (openedThrough) return null;
      const dist = t.side === "CE" ? targetPx - b.o : b.o - targetPx;
      if (dist <= MINUTE_SPIKE + 1e-9) return null;
    } else if (targetHit) {
      return null;
    }
    if (spikeHit) return b.m;
  }
  return null;
}

/** Mirror of hybrid916Outcome in server/nine-fifteen-candles.ts — win/loss only. */
function pageWin(t: Trade): boolean {
  const deadline = t.side === "PE" ? PE_CHECK : CE_CHECK;
  let targetMin: number | null = null;
  for (const b of t.bars) {
    const hit = t.side === "CE" ? b.h >= t.entry + t.target : b.l <= t.entry - t.target;
    if (hit) {
      targetMin = b.m;
      break;
    }
  }
  const cpBar = t.bars.find((b) => b.m === deadline);
  const adverseOpen = cpBar ? (t.side === "PE" ? cpBar.o - t.entry : t.entry - cpBar.o) : Number.NaN;
  const stopped =
    !(targetMin != null && targetMin <= deadline) && Number.isFinite(adverseOpen) && adverseOpen + 1e-9 >= ADVERSE_STOP;
  const spikeMin = minuteSpikeBeforeTarget(t);
  if (spikeMin != null && !(stopped && spikeMin >= deadline)) {
    const returnBar = stopped
      ? undefined
      : t.bars.find(
          (b) => b.m >= deadline && (t.side === "PE" ? b.l <= t.entry + 1e-9 : b.h + 1e-9 >= t.entry),
        );
    if (returnBar && returnBar.m < spikeMin) {
      /* return to the 9:16 price printed first */
    } else if (returnBar && returnBar.m === spikeMin) {
      const dist = t.side === "PE" ? returnBar.o - t.entry : t.entry - returnBar.o;
      if (dist <= MINUTE_SPIKE + 1e-9) {
        /* return is closer to the open than the 25-pt spike */
      } else {
        return false;
      }
    } else {
      return false;
    }
  }
  if (stopped) return false;
  if (targetMin != null && targetMin <= deadline) return true;
  const returned = t.bars.some(
    (b) => b.m >= deadline && (t.side === "PE" ? b.l <= t.entry + 1e-9 : b.h + 1e-9 >= t.entry),
  );
  return returned || targetMin != null;
}

/** Bar path in favourable points: green O→L→H→C, red O→H→L→C. */
function favPath(bar: Bar, dir: 1 | -1, entry: number): number[] {
  const f = (p: number) => dir * (p - entry);
  return bar.c >= bar.o ? [f(bar.o), f(bar.l), f(bar.h), f(bar.c)] : [f(bar.o), f(bar.h), f(bar.l), f(bar.c)];
}

/** Baseline when `rule` is null; otherwise the target touch arms the trail. */
function simulate(t: Trade, rule: Rule | null): Result {
  const checkpoint = t.side === "PE" ? PE_CHECK : CE_CHECK;
  const T = t.target;
  type Phase = "pre" | "wait" | "armed";
  // `walk` reassigns this, so keep TypeScript from narrowing it to "pre".
  let phase = "pre" as Phase;
  let floor = 0;
  let best = 0;
  let barBest = Number.NEGATIVE_INFINITY;
  let armMin: number | null = null;
  let checkpointDone = false;

  const exit = (kind: Kind, pnl: number, min: number): Result => ({
    win: kind === "stop" || kind === "eod" ? false : pnl >= -1e-9,
    pnl,
    kind,
    exitMin: min,
    armMin,
  });
  const stopLevel = () => (rule ? Math.max(floor, best - rule.trail) : floor);

  const walk = (a: number, b: number, min: number): Result | null => {
    if (phase === "pre") {
      if (b > a && a < T && b >= T) {
        if (!rule) return exit("target", T, min);
        phase = "armed";
        armMin = min;
        floor = T - bufferFor(rule, T);
        best = T;
        barBest = b;
      }
      return null;
    }
    if (phase === "wait") {
      if (b > a && a < 0 && b >= 0) return exit("return", 0, min);
      return null;
    }
    if (b > a) {
      barBest = Math.max(barBest, b);
      return null;
    }
    const s = stopLevel();
    if (b <= s) return exit("trail", s, min);
    return null;
  };

  let lastFav = 0;
  let lastMin = M916;
  for (const bar of t.bars) {
    const pts = favPath(bar, t.dir, t.entry);
    const m = bar.m;
    if (phase === "armed") {
      barBest = Number.NEGATIVE_INFINITY;
      if (pts[0] <= stopLevel()) return exit("trail", pts[0], m);
      if (m >= FORCE_EXIT || (rule?.timeCap != null && m >= rule.timeCap)) return exit("timecap", pts[0], m);
    } else if (m > M916) {
      const r = walk(lastFav, pts[0], m);
      if (r) return r;
    }
    if (!checkpointDone && m >= checkpoint) {
      checkpointDone = true;
      if (phase === "pre") {
        const p = pts[0];
        if (m === checkpoint && -p + 1e-9 >= ADVERSE_STOP) return exit("stop", p, m);
        if (p >= 0) return exit("checkpoint", p, m);
        phase = "wait";
      }
    }
    for (let i = 0; i < 3; i += 1) {
      const r = walk(pts[i], pts[i + 1], m);
      if (r) return r;
    }
    if (phase === "armed" && rule) best = Math.max(best, rule.basis === "high" ? barBest : pts[3]);
    lastFav = pts[3];
    lastMin = m;
  }
  if (phase === "armed") return exit("trail", lastFav, lastMin);
  return exit("eod", lastFav, lastMin);
}

// ---------------------------------------------------------------- tick calibration

type Tick = { s: number; p: number };
type TickBar = Bar & { from: number };

function loadTickDays(): { date: string; ticks: Tick[]; bars: TickBar[] }[] {
  if (!fs.existsSync(TICK_DIR)) return [];
  const dates = fs
    .readdirSync(TICK_DIR)
    .map((n) => /^nifty-(\d{4}-\d{2}-\d{2})\.csv$/.exec(n)?.[1])
    .filter((d): d is string => !!d)
    .sort();
  return dates.map((date) => {
    const ticks: Tick[] = [];
    for (const line of fs.readFileSync(path.join(TICK_DIR, `nifty-${date}.csv`), "utf8").split("\n")) {
      const comma = line.indexOf(",");
      if (comma < 0) continue;
      const [hh, mm, ss] = line.slice(0, comma).split(":");
      const s = Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
      const p = Number(line.slice(comma + 1));
      if (!Number.isFinite(s) || !Number.isFinite(p) || s < M915 * 60 || s >= M1530 * 60) continue;
      ticks.push({ s, p });
    }
    const bars: TickBar[] = [];
    ticks.forEach((t, i) => {
      const m = Math.floor(t.s / 60);
      const last = bars[bars.length - 1];
      if (!last || last.m !== m) bars.push({ m, o: t.p, h: t.p, l: t.p, c: t.p, from: i });
      else {
        last.h = Math.max(last.h, t.p);
        last.l = Math.min(last.l, t.p);
        last.c = t.p;
      }
    });
    return { date, ticks, bars };
  });
}

/** Trail replay on ticks; fills at the tick that crossed the stop. Returns points beyond the target, or null if never armed. */
function tickTrail(
  ticks: Tick[],
  bars: TickBar[],
  k: number,
  dir: 1 | -1,
  target: number,
  rule: Rule,
  armDeadline = bars[k].m + SYNTH_ARM_WINDOW - 1,
): number | null {
  const entry = bars[k].o;
  let armed = false;
  let armMin = 0;
  let floor = 0;
  let best = 0;
  let minuteBest = Number.NEGATIVE_INFINITY;
  let minuteClose = 0;
  let curMin = bars[k].m;
  for (let i = bars[k].from; i < ticks.length; i += 1) {
    const m = Math.floor(ticks[i].s / 60);
    const fav = dir * (ticks[i].p - entry);
    if (m !== curMin) {
      if (armed) best = Math.max(best, rule.basis === "high" ? minuteBest : minuteClose);
      minuteBest = Number.NEGATIVE_INFINITY;
      curMin = m;
      if (!armed && m > armDeadline) return null;
      if (armed && (m >= FORCE_EXIT || (rule.timeCap != null && m >= rule.timeCap))) return fav - target;
    }
    if (!armed) {
      if (fav >= target) {
        armed = true;
        armMin = m;
        floor = target - bufferFor(rule, target);
        best = target;
        minuteBest = fav;
      }
      minuteClose = fav;
      continue;
    }
    if (fav <= Math.max(floor, best - rule.trail)) return fav - target;
    minuteBest = Math.max(minuteBest, fav);
    minuteClose = fav;
  }
  void armMin;
  return armed ? dir * (ticks[ticks.length - 1].p - entry) - target : null;
}

/** Same synthetic trade on the 1-minute bars built from those ticks. */
function barTrail(
  bars: TickBar[],
  k: number,
  dir: 1 | -1,
  target: number,
  rule: Rule,
  armDeadline = bars[k].m + SYNTH_ARM_WINDOW - 1,
): number | null {
  const entry = bars[k].o;
  let armed = false;
  let floor = 0;
  let best = 0;
  let prevClose = 0;
  for (let j = k; j < bars.length; j += 1) {
    const b = bars[j];
    if (!armed && b.m > armDeadline) return null;
    const pts = favPath(b, dir, entry);
    let barBest = Number.NEGATIVE_INFINITY;
    if (armed) {
      if (pts[0] <= Math.max(floor, best - rule.trail)) return pts[0] - target;
      if (b.m >= FORCE_EXIT || (rule.timeCap != null && b.m >= rule.timeCap)) return pts[0] - target;
    }
    const segs: [number, number][] = [
      [j > k ? prevClose : pts[0], pts[0]],
      [pts[0], pts[1]],
      [pts[1], pts[2]],
      [pts[2], pts[3]],
    ];
    for (const [a, z] of segs) {
      if (!armed) {
        if (z > a && a < target && z >= target) {
          armed = true;
          floor = target - bufferFor(rule, target);
          best = target;
          barBest = z;
        }
        continue;
      }
      if (z > a) {
        barBest = Math.max(barBest, z);
        continue;
      }
      const stop = Math.max(floor, best - rule.trail);
      if (z <= stop) return stop - target;
    }
    if (armed) best = Math.max(best, rule.basis === "high" ? barBest : pts[3]);
    prevClose = pts[3];
  }
  return armed ? favPath(bars[bars.length - 1], dir, entry)[3] - target : null;
}

interface Calib {
  n: number;
  tick: number;
  bar: number;
  bias: number;
}

function calibrate(days: ReturnType<typeof loadTickDays>, rule: Rule, target: number): Calib {
  let n = 0;
  let tick = 0;
  let bar = 0;
  for (const d of days) {
    for (let k = 0; k < d.bars.length; k += 1) {
      if (d.bars[k].m < SYNTH_FROM || d.bars[k].m > SYNTH_TO) continue;
      for (const dir of [1, -1] as const) {
        const tk = tickTrail(d.ticks, d.bars, k, dir, target, rule);
        if (tk == null) continue;
        const bk = barTrail(d.bars, k, dir, target, rule);
        n += 1;
        tick += tk;
        bar += bk ?? 0;
      }
    }
  }
  return { n, tick: n ? tick / n : 0, bar: n ? bar / n : 0, bias: n ? (bar - tick) / n : 0 };
}

// ---------------------------------------------------------------- report

interface Cell {
  n: number;
  wins: number;
  losses: number;
  pts: number;
  armed12: number;
  armed8: number;
  worse: number;
  giveBack: number;
  rawGain: number;
  gain: number;
  medianHold: number;
  p90Hold: number;
  lateExits: number;
}

function main() {
  const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(CACHE)).toString("utf8")) as RawDay[];
  raw.sort((a, b) => a.date.localeCompare(b.date));
  const { sessions, trades } = buildTrades(raw);
  const pageFrom = sessions[Math.max(0, sessions.length - PAGE_SESSIONS)];
  const inPage = (t: Trade) => t.date >= pageFrom;

  console.log(`Kite minute bars ${sessions[0]} → ${sessions[sessions.length - 1]} (${sessions.length} sessions)`);
  console.log(`page window = last ${PAGE_SESSIONS} sessions from ${pageFrom}; prior window = the ${sessions.length - PAGE_SESSIONS} before it`);

  for (const side of ["PE", "CE"] as const) {
    for (const [name, pick] of [
      ["page", inPage],
      ["prior", (t: Trade) => !inPage(t)],
    ] as const) {
      const pool = trades.filter((t) => t.side === side && pick(t));
      const pw = pool.filter(pageWin).length;
      const sim = pool.map((t) => simulate(t, null));
      const mismatch = pool.filter((t, i) => pageWin(t) !== sim[i].win).map((t) => t.date);
      const pts = sim.reduce((s, r) => s + r.pnl, 0);
      const kinds = new Map<Kind, number>();
      for (const r of sim) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
      console.log(
        `  ${side} ${name.padEnd(5)} page rule ${pw}/${pool.length} = ${((pw / pool.length) * 100).toFixed(2)}% · ` +
          `simulator ${sim.filter((r) => r.win).length}/${pool.length}${mismatch.length ? ` (mismatch ${mismatch.join(", ")})` : ""}` +
          ` · ${pts.toFixed(0)} Nifty pts · exits ${[...kinds.entries()].map(([k, v]) => `${k} ${v}`).join(", ")}`,
      );
    }
  }

  const rules: Rule[] = [];
  const buffers: [number, number][] = [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
    [3, 2],
    [4, 2],
    [2, 1],
    [3, 1],
  ];
  for (const [buffer, buffer8] of buffers) {
    for (const trail of [4, 6, 8, 10, 15, 20]) {
      for (const basis of ["high", "close"] as const) {
        for (const timeCap of [undefined, 10 * 60, 11 * 60, 12 * 60]) {
          rules.push({ id: ruleId(buffer, trail, basis, timeCap, buffer8), buffer, buffer8, trail, basis, timeCap });
        }
      }
    }
  }

  const tickDays = loadTickDays();
  const calib = new Map<string, { 12: Calib; 8: Calib }>();
  if (tickDays.length) {
    console.log(
      `\nTick calibration: ${tickDays.length} sessions (${tickDays[0].date} → ${tickDays[tickDays.length - 1].date}), ` +
        `synthetic entries ${hhmm(SYNTH_FROM)}–${hhmm(SYNTH_TO)} both directions. Points beyond a fixed exit, per armed trade:`,
    );
    for (const rule of rules) {
      const c12 = calibrate(tickDays, rule, 12);
      const c8 = calibrate(tickDays, rule, 8);
      calib.set(rule.id, { 12: c12, 8: c8 });
      if (rule.timeCap == null) {
        console.log(
          `  ${rule.id.padEnd(22)} T12 n${c12.n} ticks ${c12.tick.toFixed(2).padStart(5)} bars ${c12.bar.toFixed(2).padStart(5)} bias ${c12.bias.toFixed(2).padStart(5)}` +
            ` · T8 n${c8.n} ticks ${c8.tick.toFixed(2).padStart(5)} bars ${c8.bar.toFixed(2).padStart(5)} bias ${c8.bias.toFixed(2).padStart(5)}`,
        );
      }
    }
  }

  const evaluate = (pool: Trade[], rule: Rule): Cell => {
    const base = pool.map((t) => simulate(t, null));
    const res = pool.map((t) => simulate(t, rule));
    let worse = 0;
    let giveBack = 0;
    let armed12 = 0;
    let armed8 = 0;
    let lateExits = 0;
    const holds: number[] = [];
    res.forEach((r, i) => {
      const delta = r.pnl - base[i].pnl;
      if (delta < -0.01) {
        worse += 1;
        giveBack = Math.min(giveBack, delta);
      }
      if (r.armMin != null) {
        if (pool[i].target === 12) armed12 += 1;
        else armed8 += 1;
        holds.push(r.exitMin - r.armMin);
        if (r.exitMin >= 11 * 60) lateExits += 1;
      }
    });
    holds.sort((a, b) => a - b);
    const rawGain = res.reduce((s, r) => s + r.pnl, 0) - base.reduce((s, r) => s + r.pnl, 0);
    const c = calib.get(rule.id);
    const gain = c ? rawGain - armed12 * c[12].bias - armed8 * c[8].bias : rawGain;
    const wins = res.filter((r) => r.win).length;
    return {
      n: pool.length,
      wins,
      losses: pool.length - wins,
      pts: res.reduce((s, r) => s + r.pnl, 0),
      armed12,
      armed8,
      worse,
      giveBack,
      rawGain,
      gain,
      medianHold: holds.length ? holds[Math.floor(holds.length / 2)] : 0,
      p90Hold: holds.length ? holds[Math.min(holds.length - 1, Math.floor(holds.length * 0.9))] : 0,
      lateExits,
    };
  };

  const table = new Map<string, Record<string, Cell>>();
  for (const rule of rules) {
    const cells: Record<string, Cell> = {};
    for (const side of ["PE", "CE"] as const) {
      cells[`${side}/page`] = evaluate(trades.filter((t) => t.side === side && inPage(t)), rule);
      cells[`${side}/prior`] = evaluate(trades.filter((t) => t.side === side && !inPage(t)), rule);
    }
    table.set(rule.id, cells);
  }

  const keys = ["PE/page", "PE/prior", "CE/page", "CE/prior"];
  const sgn = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}`;
  const line = (rule: Rule) => {
    const cells = table.get(rule.id)!;
    return (
      `  ${rule.id.padEnd(24)}` +
      keys
        .map((k) => {
          const c = cells[k];
          return `${sgn(c.gain).padStart(5)} (${sgn(c.rawGain)} raw, ${c.losses}L)`;
        })
        .join("  ") +
      ` · PE hold ${cells["PE/page"].medianHold}/${cells["PE/page"].p90Hold}m, after 11:00 ${cells["PE/page"].lateExits}`
    );
  };

  console.log(
    `\nGain vs baseline in Nifty points, tick-corrected (raw 1-minute gain, losses) — ${keys.join(" · ")}:`,
  );
  const minGain = (rule: Rule) => Math.min(...keys.map((k) => table.get(rule.id)![k].gain));
  const total = (rule: Rule) => keys.reduce((s, k) => s + table.get(rule.id)![k].gain, 0);
  const ranked = [...rules].sort((a, b) => minGain(b) - minGain(a) || total(b) - total(a));
  console.log("\n  — top 25 by worst cell —");
  for (const rule of ranked.slice(0, 25)) console.log(line(rule));
  console.log("\n  — top 15 by total —");
  for (const rule of [...rules].sort((a, b) => total(b) - total(a)).slice(0, 15)) console.log(line(rule));
  console.log("\n  — no time cap, high basis —");
  for (const rule of rules.filter((r) => r.timeCap == null && r.basis === "high")) console.log(line(rule));
  console.log("\n  — flat 10:00, close basis —");
  for (const rule of rules.filter((r) => r.timeCap === 10 * 60 && r.basis === "close")) console.log(line(rule));

  if (process.env.JSON_OUT) {
    const pick = (rule: Rule) => ({
      id: rule.id,
      buffer: rule.buffer,
      buffer8: bufferFor(rule, TARGET_GAP),
      trail: rule.trail,
      basis: rule.basis,
      timeCap: rule.timeCap ?? null,
      cells: table.get(rule.id),
      calib: calib.get(rule.id) ?? null,
    });
    fs.writeFileSync(process.env.JSON_OUT, JSON.stringify(rules.map(pick)));
    console.log(`\nwrote ${process.env.JSON_OUT}`);
  }

  const detail = process.env.DETAIL;
  const rule = detail ? rules.find((r) => r.id === detail) : undefined;
  if (rule) {
    for (const side of ["PE", "CE"] as const) {
      for (const [name, pick] of [
        ["page", inPage],
        ["prior", (t: Trade) => !inPage(t)],
      ] as const) {
        const pool = trades.filter((x) => x.side === side && pick(x));
        const deltas = pool.map((t) => simulate(t, rule).pnl - simulate(t, null).pnl);
        const up = deltas.filter((d) => d > 0.01);
        const down = deltas.filter((d) => d < -0.01);
        const big = [...up].sort((a, b) => b - a).slice(0, 5).map((d) => d.toFixed(1));
        const c = table.get(rule.id)![`${side}/${name}`];
        console.log(
          `\n${side} ${name}: armed ${c.armed12 + c.armed8} (T12 ${c.armed12}, T8 ${c.armed8}) · better ${up.length} (+${up.reduce((s, d) => s + d, 0).toFixed(0)}) · ` +
            `worse ${down.length} (${down.reduce((s, d) => s + d, 0).toFixed(0)}, worst ${Math.min(0, ...down).toFixed(1)}) · biggest gains ${big.join(", ")} · ` +
            `baseline ${(c.pts - c.rawGain).toFixed(0)} → ${c.pts.toFixed(0)} raw → ${(c.pts - c.rawGain + c.gain).toFixed(0)} tick-corrected`,
        );
      }
    }
    for (const side of ["PE", "CE"] as const) {
      console.log(`\n### ${side} page window · ${rule.id}`);
      for (const t of trades.filter((x) => x.side === side && inPage(x))) {
        const b = simulate(t, null);
        const r = simulate(t, rule);
        if (Math.abs(r.pnl - b.pnl) < 0.01) continue;
        console.log(
          `  ${t.date} T${t.target} · ${b.kind} ${b.pnl.toFixed(1)} @${hhmm(b.exitMin)} → ${r.kind} ${r.pnl.toFixed(1)} @${hhmm(r.exitMin)}`,
        );
      }
    }
    const tickDates = new Set(tickDays.map((d) => d.date));
    for (const t of trades.filter((x) => tickDates.has(x.date))) {
      const d = tickDays.find((x) => x.date === t.date)!;
      const k = d.bars.findIndex((b) => b.m === M916);
      const deadline = t.side === "CE" ? M916 : PE_CHECK - 1;
      const armsLikeBaseline = simulate(t, null).kind === "target";
      const tk = k >= 0 && armsLikeBaseline ? tickTrail(d.ticks, d.bars, k, t.dir, t.target, rule, deadline) : null;
      const bk = k >= 0 && armsLikeBaseline ? barTrail(d.bars, k, t.dir, t.target, rule, deadline) : null;
      console.log(
        `  real 9:16 trade ${t.date} ${t.side} T${t.target}: baseline ${simulate(t, null).kind} · trail beyond target ticks ${tk?.toFixed(1) ?? "not armed"} · bars ${bk?.toFixed(1) ?? "not armed"}`,
      );
    }
  }
}

main();
