import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Server } from "lucide-react";
import { cn, formatCurrency, formatNumber, getChangeClass } from "@/lib/utils";
import { getIndianMarketContext } from "@/lib/market-time";
import "@/styles/prediction-auto-trade.css";
import "@/styles/log-test-page.css";

interface LiveSpotSample {
  seq: number;
  dateIST: string;
  timeIST: string;
  epochMs: number;
  niftySpot: number | null;
  openSpot?: number | null;
  highSpot?: number | null;
  lowSpot?: number | null;
  rangePts?: number | null;
  ticksInSecond: number;
  lastTickAtIST: string | null;
  stale: boolean;
}

interface RawTickRow {
  seq: number;
  dateIST: string;
  timeIST: string;
  epochMs: number;
  exchangeTimeIST: string | null;
  kind: "nifty" | "option";
  instrumentToken: number;
  price: number;
  changePts: number | null;
}

interface BotStatus {
  enabled: boolean;
  phase: string;
  dateIST: string;
  message: string;
  open915: number | null;
  close915?: number | null;
  wsConnected?: boolean;
  entrySpot: number | null;
  exitMode?: "main" | "near_miss" | null;
  indexExitSchedule?: string | null;
  hardStopSpot?: number | null;
  hardStopActive?: boolean;
  hardStopPoints?: number;
  hardStopStartLabel?: string;
  leg: string | null;
  tradingsymbol: string | null;
  targetSpot: number | null;
  lastSpot: number | null;
  entryPrice: number | null;
  lastOptionPrice: number | null;
  quantity: number | null;
  unrealisedPnl: number | null;
  niftyPointsToTarget: number | null;
  pnlTargetAmount: number | null;
  pnlTargetPct: number;
  pnlExitActive: boolean;
  pnlExitStartLabel?: string;
  pnlExitSchedule?: string;
  pnlPct?: number | null;
  pnlLockedPct?: number;
  pnlStopPct?: number | null;
  pnlStopAmount?: number | null;
  pnlTrailArmed?: boolean;
  pnlTrailArmPct?: number;
  pnlTrailStepPct?: number;
  nineFifteenEnabled?: boolean;
  tradeSlot?: "nine-fifteen" | "nine-sixteen";
  nineFifteenMarkPrice?: number | null;
  nineFifteenMarkAt?: string | null;
  nineFifteenMarkChange?: number | null;
  nineFifteenSettled?: boolean;
  nineFifteenNote?: string | null;
  nineFifteenBlocked916?: boolean;
  nineFifteenLadder?: string;
  nineFifteenTakeProfitPct?: number;
  nineFifteenTpLimitPrice?: number | null;
  nineFifteenDeployedCapital?: number | null;
  nineFifteenTpProfitAim?: number | null;
  nineFifteenPnlRemaining?: number | null;
  nineFifteenTpOrderStatus?: "none" | "pending" | "partial" | "complete" | "cancelled" | "failed";
  nineFifteenTpOrderIds?: string[];
  nineFifteenTpFilledQty?: number;
  nineFifteenTpPendingQty?: number;
  nineFifteenTpPlacedAt?: string | null;
  nineFifteenTpLastSyncedAt?: string | null;
  nineFifteenTrailArmPct?: number;
  nineFifteenTrailStepPct?: number;
  sessionConnected: boolean;
  sessionAgeHours: number | null;
  updatedAt?: string;
  spotPollMs?: number;
  logs: { time: string; message: string; type: string }[];
  liveSpotSamples?: LiveSpotSample[];
  liveSpotSampleCount?: number;
  rawTicks?: RawTickRow[];
  rawTickCount?: number;
  rawTickFile?: string | null;
}

interface LiveTick {
  lastSpot: number | null;
  lastOptionPrice: number | null;
  entryPrice: number | null;
  quantity: number | null;
  unrealisedPnl: number | null;
  niftyPointsToTarget: number | null;
  targetSpot: number | null;
  updatedAt: string;
}

const STATUS_POLL_MS = 8000;
const WS_LIVE_POLL_MS = 1000;
const LIVE_POLL_MS = 500;

export function ServerNineSixteenBotPanel({ connected: _connected }: { connected: boolean }) {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [lastLiveAt, setLastLiveAt] = useState<string | null>(null);
  const [tickView, setTickView] = useState<"seconds" | "raw">("seconds");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/nine-sixteen/bot/status", { credentials: "include" });
      const json = await res.json();
      if (res.ok) setStatus(json.data as BotStatus);
    } catch {
      /* ignore */
    }
  }, []);

  const loadLive = useCallback(async () => {
    try {
      const res = await fetch("/api/nine-sixteen/bot/live", { credentials: "include" });
      const json = await res.json();
      if (!res.ok) return;
      const tick = json.data as LiveTick;
      setLastLiveAt(tick.updatedAt);
      setStatus((prev) => (prev ? { ...prev, ...tick } : prev));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), STATUS_POLL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const inTrade = status?.phase === "in_position" || status?.phase === "exiting";
  const wsLive = Boolean(status?.wsConnected);
  const tradingDisabled = status != null && !status.enabled;

  useEffect(() => {
    if (!wsLive && !inTrade && status?.enabled !== false) return;
    void load();
    const id = window.setInterval(() => void load(), WS_LIVE_POLL_MS);
    return () => window.clearInterval(id);
  }, [wsLive, inTrade, status?.enabled, load]);

  useEffect(() => {
    if (!inTrade) return;

    void loadLive();
    const id = window.setInterval(() => void loadLive(), LIVE_POLL_MS);
    return () => window.clearInterval(id);
  }, [inTrade, loadLive]);

  if (!status) return null;

  const inPosition = status.phase === "in_position" || status.phase === "exiting";
  const sessionDone = status.phase === "done";
  const isLive = inPosition || status.phase === "entering" || wsLive;
  const liveSamples = status.liveSpotSamples ?? [];
  const rawTickRows = status.rawTicks ?? [];
  const latestSpot =
    status.lastSpot ??
    liveSamples.find((s) => s.niftySpot != null)?.niftySpot ??
    null;
  const ticksPerSec = liveSamples.length
    ? liveSamples.slice(0, 30).reduce((sum, s) => sum + s.ticksInSecond, 0) /
      Math.min(30, liveSamples.length)
    : 0;
  const targetReached =
    inPosition && status.niftyPointsToTarget != null && status.niftyPointsToTarget <= 0;

  const livePnl =
    status.unrealisedPnl ??
    (status.entryPrice != null &&
    status.lastOptionPrice != null &&
    status.quantity != null &&
    status.quantity > 0
      ? (status.lastOptionPrice - status.entryPrice) * status.quantity
      : null);

  const onNineFifteenLeg = status.tradeSlot === "nine-fifteen" && inPosition;
  const onNineSixteenLeg = status.tradeSlot === "nine-sixteen" && inPosition;
  const onTpLimitLeg = onNineFifteenLeg || onNineSixteenLeg;
  const livePnlPct =
    status.pnlPct ??
    (livePnl != null && status.entryPrice != null && status.quantity != null && status.quantity > 0
      ? (livePnl / (status.entryPrice * status.quantity)) * 100
      : null);

  const deployedCapital = status.nineFifteenDeployedCapital ?? null;
  const profitAim = status.nineFifteenTpProfitAim ?? status.pnlTargetAmount ?? null;
  const pnlRemaining = status.nineFifteenPnlRemaining ?? null;
  const tpOrderStatus = status.nineFifteenTpOrderStatus ?? "none";
  const tpProgressPct =
    profitAim != null && profitAim > 0 && livePnl != null
      ? Math.min(100, Math.max(0, (livePnl / profitAim) * 100))
      : null;

  function tpStatusLabel(): string {
    switch (tpOrderStatus) {
      case "pending":
        return "Live on Kite — waiting for fill";
      case "partial":
        return "Partially filled";
      case "complete":
        return "Fully filled — closing trade";
      case "cancelled":
        return "Cancelled — market backup active";
      case "failed":
        return "Not placed — market backup active";
      default:
        return "Not armed yet";
    }
  }

  // Both legs exit on a resting take-profit limit (+ market backup at the same %).
  const pnlTargetReached =
    inPosition &&
    status.pnlTargetAmount != null &&
    livePnl != null &&
    livePnl >= status.pnlTargetAmount &&
    onTpLimitLeg;

  const pnlBlockClass =
    livePnl == null
      ? ""
      : livePnl >= 0
        ? "is-up"
        : "is-down";

  return (
    <section className={cn("pat-card card ns916-trader", isLive && "pat-card--live")}>
      <header className="pat-head">
        <div className="pat-head-left">
          <Server size={18} />
          <div>
            <h2 className="pat-title">Server 9:16 bot (Lightsail)</h2>
              <p className="pat-sub">
                9:15 + 9:16 trading armed on server · websocket 9:00–16:00
              </p>
          </div>
        </div>
        <div className="pat-head-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
            <RefreshCw size={14} />
          </button>
          <span className="pat-badge pat-badge--on">9:15 always on</span>
          <span className={cn("pat-badge", status.enabled ? "pat-badge--on" : "pat-badge--off")}>
            {status.enabled ? "9:16 armed" : "9:16 off"}
          </span>
        </div>
      </header>

      {tradingDisabled && (
        <div className="ms-bot-warn ms-bot-warn--hold">
          <strong>9:16 entries are disabled on the server.</strong> Only the 9:15 trade runs — websocket tick
          capture and per-second samples stay active.
        </div>
      )}

      {status.nineFifteenEnabled && (
        <div className="ms-bot-warn ms-bot-warn--hold">
          <strong>
            {status.tradeSlot === "nine-fifteen" && inPosition ? "In the 9:15 trade." : "9:15 trade armed."}
          </strong>
          {status.nineFifteenBlocked916 && <> The 9:16 trade is skipped today.</>}
        </div>
      )}

      <div className="pat-status-row">
        {inPosition && (
          <span className="pat-badge pat-badge--on">In position</span>
        )}
        {sessionDone && (
          <span className="pat-badge pat-badge--open">Session complete</span>
        )}
        <span className={cn("pat-badge", status.enabled ? "pat-badge--on" : "pat-badge--off")}>
          {status.enabled ? "9:16 armed" : "9:16 off"}
        </span>
        <span className={cn("pat-badge", status.wsConnected ? "pat-badge--open" : "pat-badge--off")}>
          {status.wsConnected ? "Websocket live" : "Websocket off"}
        </span>
        <span className={cn("pat-badge", status.sessionConnected ? "pat-badge--open" : "pat-badge--closed")}>
          {status.sessionConnected ? "Kite session saved" : "Kite not connected"}
        </span>
        <span className="pat-scan-note pat-scan-note--watch">{status.message}</span>
      </div>

      {status.nineFifteenSettled && status.nineFifteenNote?.startsWith("TRADE EXITED") && (
        <div className="ns916-exit-banner card">
          <strong>9:15 trade closed</strong>
          <p>{status.nineFifteenNote}</p>
        </div>
      )}

      {inPosition && (
        <div className={cn("pat-pnl-block", pnlBlockClass, (targetReached || pnlTargetReached) && "is-hit")}>
          <div className="pat-pnl-label">
            {onNineFifteenLeg
              ? "Live P&L · 9:15 leg (until exit)"
              : onNineSixteenLeg
                ? "Live P&L · 9:16 leg (until exit)"
                : "Live P&L (Zerodha)"}
          </div>
          <div className={cn("pat-pnl-value", livePnl != null && getChangeClass(livePnl))}>
            {livePnl != null ? formatCurrency(livePnl) : "Syncing…"}
            {livePnlPct != null && (
              <span className="pat-pnl-pct">
                {" "}
                ({livePnlPct >= 0 ? "+" : ""}
                {formatNumber(livePnlPct, 2)}%)
              </span>
            )}
          </div>
          {onTpLimitLeg && deployedCapital != null && (
            <p className="pat-pnl-sub">
              Deployed {formatCurrency(deployedCapital)} · profit aim{" "}
              {profitAim != null ? formatCurrency(profitAim) : "—"}
              {pnlRemaining != null && pnlRemaining > 0
                ? ` · ${formatCurrency(pnlRemaining)} to target`
                : pnlTargetReached
                  ? " · target reached"
                  : ""}
            </p>
          )}
          {onTpLimitLeg && tpProgressPct != null && (
            <div className="pat-pnl-bar" aria-hidden>
              <div
                className="pat-pnl-bar-fill"
                style={{ width: `${tpProgressPct}%` }}
              />
            </div>
          )}
          {!onTpLimitLeg && status.entryPrice != null && status.lastOptionPrice != null && status.quantity != null && (
            <p className="pat-pnl-sub">
              Entry ₹{formatNumber(status.entryPrice, 2)} → LTP ₹{formatNumber(status.lastOptionPrice, 2)} ·{" "}
              {status.quantity} qty
            </p>
          )}
          {onTpLimitLeg && status.entryPrice != null && status.lastOptionPrice != null && status.quantity != null && (
            <p className="pat-pnl-sub">
              Entry ₹{formatNumber(status.entryPrice, 2)} → LTP ₹{formatNumber(status.lastOptionPrice, 2)} ·{" "}
              {status.quantity} qty
            </p>
          )}
          {onTpLimitLeg && pnlTargetReached && (
            <span className="pat-badge pat-badge--on">Profit aim reached</span>
          )}
        </div>
      )}

      {(status.open915 || status.tradingsymbol) && inPosition && (
        <div className="pat-dashboard ns916-dashboard">
          <div className="pat-dashboard-grid ns916-grid">
            {status.tradingsymbol && (
              <div className="pat-stat ns916-stat-symbol">
                <span className="pat-stat-label">Symbol</span>
                <span className="pat-stat-value" title={status.tradingsymbol}>
                  {status.tradingsymbol}
                </span>
              </div>
            )}
            <div className="pat-stat ns916-stat-nifty">
              <span className="pat-stat-label">Nifty spot at entry</span>
              <span className="pat-stat-value">
                {status.entrySpot != null ? formatNumber(status.entrySpot, 2) : "—"}
              </span>
            </div>
            {status.open915 != null && (
              <div className="pat-stat">
                <span className="pat-stat-label">9:15:00 open (WS)</span>
                <span className="pat-stat-value">{formatNumber(status.open915, 2)}</span>
              </div>
            )}
            {status.close915 != null && (
              <div className="pat-stat">
                <span className="pat-stat-label">9:15:59 close (WS)</span>
                <span className="pat-stat-value">{formatNumber(status.close915, 2)}</span>
              </div>
            )}
            <div className="pat-stat">
              <span className="pat-stat-label">Entry avg (option)</span>
              <span className="pat-stat-value">
                {status.entryPrice != null ? `₹${formatNumber(status.entryPrice, 2)}` : "—"}
              </span>
            </div>
            <div className="pat-stat">
              <span className="pat-stat-label">Option LTP</span>
              <span className={cn("pat-stat-value", livePnl != null && getChangeClass(livePnl))}>
                {status.lastOptionPrice != null ? `₹${formatNumber(status.lastOptionPrice, 2)}` : "—"}
              </span>
            </div>
            <div className="pat-stat">
              <span className="pat-stat-label">Qty</span>
              <span className="pat-stat-value">{status.quantity ?? "—"}</span>
            </div>
            <div className="pat-stat">
              <span className="pat-stat-label">Nifty spot (live)</span>
              <span className="pat-stat-value">
                {status.lastSpot != null ? formatNumber(status.lastSpot, 2) : "—"}
              </span>
            </div>
            <div className="pat-stat">
              <span className="pat-stat-label">Take-profit</span>
              <span className={cn("pat-stat-value", pnlTargetReached && "text-up")}>
                {status.pnlTargetAmount != null ? formatCurrency(status.pnlTargetAmount) : "—"}
              </span>
              {onTpLimitLeg && (
                <span className="pat-stat-hint">
                  Resting limit
                  {status.nineFifteenTpLimitPrice != null
                    ? ` @ ₹${formatNumber(status.nineFifteenTpLimitPrice, 2)}`
                    : ""}
                  {livePnlPct != null ? ` · now ${livePnlPct >= 0 ? "+" : ""}${formatNumber(livePnlPct, 2)}%` : ""}
                </span>
              )}
            </div>
            {onTpLimitLeg && (
              <div
                className={cn(
                  "pat-stat ns916-stat-tp-order",
                  tpOrderStatus === "pending" && "ns916-stat-tp-order--live",
                  tpOrderStatus === "partial" && "ns916-stat-tp-order--partial",
                  tpOrderStatus === "complete" && "ns916-stat-tp-order--done",
                  (tpOrderStatus === "failed" || tpOrderStatus === "cancelled") &&
                    "ns916-stat-tp-order--warn",
                )}
              >
                <span className="pat-stat-label">Take-profit limit sell</span>
                <span className="pat-stat-value">{tpStatusLabel()}</span>
                <span className="pat-stat-hint">
                  {status.nineFifteenTpLimitPrice != null
                    ? `Limit ₹${formatNumber(status.nineFifteenTpLimitPrice, 2)} · `
                    : ""}
                  {status.quantity != null
                    ? `${status.nineFifteenTpFilledQty ?? 0}/${status.quantity} qty filled`
                    : ""}
                  {(status.nineFifteenTpOrderIds?.length ?? 0) > 0
                    ? ` · ${status.nineFifteenTpOrderIds?.length} Kite order(s)`
                    : ""}
                  {status.nineFifteenTpLastSyncedAt
                    ? ` · synced ${new Date(status.nineFifteenTpLastSyncedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST`
                    : ""}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {status.logs.length > 0 && (
        <div className="pat-log">
          {status.logs.slice(0, 6).map((entry, idx) => (
            <div
              key={`${entry.time}-${idx}`}
              className={cn(
                "pat-log-line",
                entry.type === "success" && "is-success",
                entry.type === "warning" && "is-warning",
                entry.type === "error" && "is-error",
              )}
            >
              <span className="pat-log-time">{entry.time}</span>
              {entry.message}
            </div>
          ))}
        </div>
      )}

      {(wsLive || liveSamples.length > 0 || tradingDisabled) && (
        <div className="ns916-live-spot">
          <div className="log-test-summary">
            <div className="card log-test-stat">
              <span className="log-test-label">Websocket</span>
              <span className={cn("log-test-value", wsLive ? "text-up" : "text-muted")}>
                {wsLive ? "Live" : "Off"}
              </span>
            </div>
            <div className="card log-test-stat">
              <span className="log-test-label">Last Nifty spot</span>
              <span className="log-test-value">
                {latestSpot != null ? formatNumber(latestSpot, 2) : "—"}
              </span>
            </div>
            <div className="card log-test-stat">
              <span className="log-test-label">Seconds logged</span>
              <span className="log-test-value">{status.liveSpotSampleCount ?? liveSamples.length}</span>
            </div>
            <div className="card log-test-stat">
              <span className="log-test-label">Ticks today</span>
              <span className="log-test-value">{formatNumber(status.rawTickCount ?? 0, 0)}</span>
            </div>
            <div className="card log-test-stat">
              <span className="log-test-label">Avg ticks / sec</span>
              <span className="log-test-value">{formatNumber(ticksPerSec, 2)}</span>
            </div>
          </div>

          <div className="ns916-tick-toggle">
            <button
              type="button"
              className={cn("ns916-tick-tab", tickView === "seconds" && "is-active")}
              onClick={() => setTickView("seconds")}
            >
              Per second (OHLC)
            </button>
            <button
              type="button"
              className={cn("ns916-tick-tab", tickView === "raw" && "is-active")}
              onClick={() => setTickView("raw")}
            >
              Raw ticks ({rawTickRows.length})
            </button>
          </div>

          <div className="card log-test-table-card">
            <div className="log-test-table-wrap ns916-live-spot-table">
              {tickView === "seconds" ? (
                <table className="log-test-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>IST time</th>
                      <th className="text-right">Open</th>
                      <th className="text-right">High</th>
                      <th className="text-right">Low</th>
                      <th className="text-right">Close</th>
                      <th className="text-right">Range</th>
                      <th className="text-right">Ticks</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {liveSamples.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="text-muted log-test-empty">
                          Websocket live — waiting for first per-second Nifty sample…
                        </td>
                      </tr>
                    ) : (
                      liveSamples.map((row) => (
                        <tr
                          key={`${row.seq}-${row.epochMs}`}
                          className={row.stale ? "log-test-stale" : undefined}
                        >
                          <td>{row.seq}</td>
                          <td>{row.timeIST}</td>
                          <td className="text-right">
                            {row.openSpot != null ? formatNumber(row.openSpot, 2) : "—"}
                          </td>
                          <td className="text-right">
                            {row.highSpot != null ? formatNumber(row.highSpot, 2) : "—"}
                          </td>
                          <td className="text-right">
                            {row.lowSpot != null ? formatNumber(row.lowSpot, 2) : "—"}
                          </td>
                          <td className="text-right">
                            {row.niftySpot != null ? formatNumber(row.niftySpot, 2) : "—"}
                          </td>
                          <td className="text-right">
                            {row.rangePts != null ? formatNumber(row.rangePts, 2) : "—"}
                          </td>
                          <td className="text-right">{row.ticksInSecond}</td>
                          <td>{row.stale ? "no new tick" : ""}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              ) : (
                <table className="log-test-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Received IST</th>
                      <th>Exchange IST</th>
                      <th>Instrument</th>
                      <th className="text-right">Price</th>
                      <th className="text-right">Δ prev</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rawTickRows.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-muted log-test-empty">
                          Websocket live — waiting for first tick…
                        </td>
                      </tr>
                    ) : (
                      rawTickRows.map((row) => (
                        <tr key={`${row.kind}-${row.seq}`}>
                          <td>{row.seq}</td>
                          <td>{row.timeIST}</td>
                          <td>{row.exchangeTimeIST ?? "—"}</td>
                          <td>{row.kind === "nifty" ? "Nifty 50" : "Option"}</td>
                          <td className="text-right">{formatNumber(row.price, 2)}</td>
                          <td className={cn("text-right", getChangeClass(row.changePts ?? 0))}>
                            {row.changePts == null
                              ? "—"
                              : `${row.changePts > 0 ? "+" : ""}${formatNumber(row.changePts, 2)}`}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {((lastLiveAt && inPosition) || (status.sessionAgeHours != null && status.sessionAgeHours > 20)) && (
        <p className="pat-idle-note text-muted">
          {lastLiveAt && inPosition && (
            <>Last tick {getIndianMarketContext(new Date(lastLiveAt)).timeIST} IST.</>
          )}
          {status.sessionAgeHours != null && status.sessionAgeHours > 20 && (
            <> Session age {formatNumber(status.sessionAgeHours, 1)}h — reconnect before tomorrow.</>
          )}
        </p>
      )}
    </section>
  );
}
