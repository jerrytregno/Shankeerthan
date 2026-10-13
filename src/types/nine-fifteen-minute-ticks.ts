/** One Nifty websocket print inside the 9:15 minute (09:15:00.000 through 09:15:59.999 IST). */
export interface NineFifteenMinuteTickPoint {
  seq: number;
  /** Server receive time, HH:MM:SS.mmm IST. The archive stores milliseconds, not microseconds. */
  timeIST: string;
  epochMs: number;
  price: number;
  /** Exchange stamp when Kite sent one. Second resolution. */
  exchangeTimeIST: string | null;
}

export interface NineFifteenMinuteTickSeries {
  dateIST: string;
  source: "disk" | "firestore" | "storage" | "none";
  windowLabel: string;
  /** Finest clock the saved ticks carry. */
  timePrecision: "millisecond";
  windowStartMs: number;
  windowEndMs: number;
  tickCount: number;
  firstTimeIST: string | null;
  lastTimeIST: string | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  ticks: NineFifteenMinuteTickPoint[];
}
