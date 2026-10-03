import { useCallback, useEffect, useState } from "react";
import { Bot, RefreshCw, Server } from "lucide-react";
import { cn, formatCurrency, formatNumber, getChangeClass } from "@/lib/utils";
import { formatMomentumScalperLog } from "@/lib/momentum-scalper-log-text";
import "@/styles/prediction-auto-trade.css";

interface ExitRuleSummary {
  armPct: number;
  stepPct: number;
  initialStopPnlPct: number;
  initialStopHoldSec: number;
  stopBreachInclusive: boolean;
  hardStopPnlPct: number;
}

interface BotStatus {
  enabled: boolean;
  serverDisabled?: boolean;
  phase: string;
  dateIST: string;
  weekday: string;
  message: string;
  /** Only the fields this panel reads; the API sends the full Day Scalper rule set. */
  rules: {
    minMovePts: number;
    tradeWindowOpenIst: string;
    tradeWindowCloseIst: string;
    tuesdayTradeWindowCloseIst: string;
  };
  wsConnected: boolean;
  tradesToday: number;
  lossesToday?: number;
  stoppedForLossToday?: boolean;
  maxLots?: number;
  plannedLots?: number | null;
  premiumSafetyPct?: number;
  pendingSignal: {
    side: string;
    signalTimeIst: string;
    movePts: number;
    optionMarkPrice?: number | null;
    optionTradingsymbol?: string | null;
    liveRsi?: number | null;
  } | null;
  leg: string | null;
  tradingsymbol: string | null;
  quantity: number | null;
  entryPrice: number | null;
  lastOptionPrice: number | null;
  entryIndexPrice: number | null;
  initialStopPnlPct?: number;
  initialStopHoldSec?: number;
  hardStopPnlPct?: number;
  trailing: boolean;
  pnlPct?: number | null;
  pnlLockedPct?: number;
  pnlTargetPct?: number | null;
  pnlStopPct?: number | null;
  pnlArmPct?: number;
  pnlStepPct?: number;
  lastSpot: number | null;
  unrealisedPnl: number | null;
  indexPnlPts: number | null;
  lastBarTimeIst: string | null;
  completedBars: number;
  nineSixteenSettled?: boolean;
  scanStartIst?: string | null;
  exitProfile?: "opening" | "standard" | null;
  exitRules?: Record<"standard" | "opening", ExitRuleSummary>;
  profitExitPnlPct?: number | null;
  profitExitPrice?: number | null;
  profitExitArmed?: boolean;
  profitExitOrderStatus?: string;
  profitExitGivebackPct?: number;
  forceExitIst?: string;
  liveNiftyRsi?: number | null;
  liveRsiBucketsIst?: string;
  sessionConnected: boolean;
  logs: { time: string; message: string; type: string }[];
}

const STATUS_POLL_MS = 8000;
const LIVE_POLL_MS = 1000;

export function ServerMomentumScalperBotPanel({ connected }: { connected: boolean }) {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/momentum-scalper/bot/status", { credentials: "include" });
      const json = await res.json();
      if (res.ok) setStatus(json.data as BotStatus);
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = useCallback(async (enabled: boolean) => {
    setLoading(true);
    try {
      const res = await fetch("/api/momentum-scalper/bot/toggle", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const json = await res.json();
      if (res.ok) setStatus(json.data as BotStatus);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!connected) return;
    void load();
    const inTrade = status?.phase === "in_position" || status?.phase === "exiting";
    const interval = setInterval(() => void load(), inTrade || status?.wsConnected ? LIVE_POLL_MS : STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, [connected, load, status?.phase, status?.wsConnected]);

  const scanSchedule = status?.scanStartIst ?? "after 9:16:30–15:30";
  const profitExitPrice = status?.profitExitPrice ?? null;
  const maxLots = status?.maxLots ?? 25;
  const plannedLots = status?.plannedLots ?? null;

  if (!connected) {
    return (
      <section className="pat-card card">
        <header className="pat-head">
          <div className="pat-head-left">
            <Server size={18} />
            <div>
              <h2 className="pat-title">Traps — server bot</h2>
              <p className="pat-sub">Connect Zerodha to run the live bot on the server.</p>
            </div>
          </div>
        </header>
      </section>
    );
  }

  if (!status) return null;

  const inPosition = status.phase === "in_position" || status.phase === "exiting";

  return (
    <section className={cn("pat-card card", (inPosition || status.wsConnected) && "pat-card--live")}>
      <header className="pat-head">
        <div className="pat-head-left">
          <Server size={18} />
          <div>
            <h2 className="pat-title">Traps — server bot</h2>
            <p className="pat-sub">Runs on the server · Kite websocket 9:00–16:00 IST</p>
          </div>
        </div>
        <div className="pat-head-actions">
          <button
            type="button"
            className={cn("btn btn-sm", status.enabled ? "btn-secondary" : "btn-primary")}
            disabled={loading || status.stoppedForLossToday === true || status.serverDisabled === true}
            onClick={() => void toggle(!status.enabled)}
          >
            <Bot size={14} />
            {status.serverDisabled
              ? "Disabled on server"
              : status.enabled
                ? "Disable bot"
                : "Enable bot"}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
      </header>

      <div className="ms-bot-instructions">
        <ol className="ms-bot-instructions-list">
          <li>
            <strong>Manual arm only.</strong> Traps starts <strong>disabled</strong> every day — press{" "}
            <strong>Enable</strong> in this panel to arm it. Nothing runs until you do.
          </li>
          <li>
            <strong>Entry window — {scanSchedule} IST.</strong> A trade still open at the cutoff keeps
            running until it exits. Two losing trades stop the bot for the day.
          </li>
        </ol>
      </div>

      <div className="pat-status-row">
        <span className={cn("pat-badge", status.enabled ? "pat-badge--on" : "pat-badge--off")}>
          {status.serverDisabled
            ? "Off (server)"
            : status.stoppedForLossToday
              ? "Stopped (2 losses)"
              : status.enabled
                ? "Enabled"
                : "Disabled"}
        </span>
        <span className="pat-badge">{status.phase}</span>
        <span className={cn("pat-badge", status.wsConnected ? "pat-badge--on" : "pat-badge--off")}>
          WS {status.wsConnected ? "connected" : "connecting…"}
        </span>
        <span className="pat-badge">{status.completedBars} bars from ticks</span>
      </div>

      <p className="pat-sub" style={{ marginBottom: "0.75rem" }}>
        {status.message}
      </p>

      {!status.nineSixteenSettled && status.enabled && (
        <p className="ms-bot-warn ms-bot-warn--hold">
          <strong>On hold.</strong> Waiting for the 9:16 trade to finish (after{" "}
          <strong>9:16:30 IST</strong>) or outside the entry window ({scanSchedule}). Bars are still
          being built from ticks in the meantime.
        </p>
      )}

      {status.serverDisabled && (
        <p className="ms-bot-warn ms-bot-warn--hold">
          <strong>Disabled on server.</strong> Traps is turned off via{" "}
          <strong>MOMENTUM_SCALPER_BOT_ENABLED=0</strong> — no new entries until the env is changed and
          the server restarts.
        </p>
      )}

      {!status.enabled && !status.stoppedForLossToday && !status.serverDisabled && (
        <p className="ms-bot-warn ms-bot-warn--hold">
          <strong>Disabled.</strong> Press <strong>Enable bot</strong> to arm Traps — nothing runs until
          you do.
        </p>
      )}

      <div className="pat-metric-grid">
        <div className="pat-metric">
          <span className="pat-metric-label">Nifty spot</span>
          <span className="pat-metric-value">
            {status.lastSpot != null ? formatNumber(status.lastSpot, 2) : "—"}
          </span>
        </div>
        <div className="pat-metric">
          <span className="pat-metric-label">Trades today</span>
          <span className="pat-metric-value">{status.tradesToday}</span>
        </div>
        <div className="pat-metric">
          <span className="pat-metric-label">Size</span>
          <span className="pat-metric-value">
            {plannedLots != null
              ? `${plannedLots} lot${plannedLots === 1 ? "" : "s"} armed`
              : `${maxLots} lot${maxLots === 1 ? "" : "s"} max`}
          </span>
        </div>
        <div className="pat-metric">
          <span className="pat-metric-label">Last bar (WS)</span>
          <span className="pat-metric-value">{status.lastBarTimeIst ?? "—"}</span>
        </div>
        {status.pendingSignal && (
          <div className="pat-metric pat-metric--wide">
            <span className="pat-metric-label">Pending signal</span>
            <span className="pat-metric-value">
              {status.pendingSignal.side} · {status.pendingSignal.signalTimeIst}
            </span>
            <span className="pat-metric-hint">
              {status.pendingSignal.optionMarkPrice != null
                ? `${status.pendingSignal.optionTradingsymbol ?? "option"} at ₹${status.pendingSignal.optionMarkPrice.toFixed(2)} · buying at market`
                : "waiting for entry"}
            </span>
          </div>
        )}
        {status.tradingsymbol && (
          <>
            <div className="pat-metric pat-metric--wide">
              <span className="pat-metric-label">Position</span>
              <span className="pat-metric-value">
                {status.leg} · {status.tradingsymbol} × {status.quantity ?? "—"}
              </span>
            </div>
            <div className="pat-metric">
              <span className="pat-metric-label">Index entry</span>
              <span className="pat-metric-value">
                {status.entryIndexPrice != null ? formatNumber(status.entryIndexPrice, 2) : "—"}
              </span>
            </div>
            <div className="pat-metric">
              <span className="pat-metric-label">Take-profit limit</span>
              <span className="pat-metric-value">
                {profitExitPrice != null ? `₹${formatNumber(profitExitPrice, 2)}` : "—"}
              </span>
              <span className="pat-metric-hint">
                {status.profitExitArmed
                  ? `limit ${status.profitExitOrderStatus ?? "pending"} on Kite`
                  : "placing limit"}
              </span>
            </div>
            <div className="pat-metric">
              <span className="pat-metric-label">P&L %</span>
              <span
                className={cn(
                  "pat-metric-value",
                  status.pnlPct != null && getChangeClass(status.pnlPct),
                )}
              >
                {status.pnlPct != null ? `${formatNumber(status.pnlPct, 2)}%` : "—"}
              </span>
              <span className="pat-metric-hint">of premium paid</span>
            </div>
            <div className="pat-metric">
              <span className="pat-metric-label">Option P&L</span>
              <span
                className={cn(
                  "pat-metric-value",
                  status.unrealisedPnl != null && getChangeClass(status.unrealisedPnl),
                )}
              >
                {status.unrealisedPnl != null ? formatCurrency(status.unrealisedPnl) : "—"}
              </span>
            </div>
            <div className="pat-metric">
              <span className="pat-metric-label">Index P&L</span>
              <span
                className={cn(
                  "pat-metric-value",
                  status.indexPnlPts != null && getChangeClass(status.indexPnlPts),
                )}
              >
                {status.indexPnlPts != null
                  ? `${status.indexPnlPts >= 0 ? "+" : ""}${formatNumber(status.indexPnlPts, 2)} pts`
                  : "—"}
              </span>
            </div>
          </>
        )}
      </div>

      {status.logs.length > 0 && (
        <div className="pat-log-block ms-log-block">
          {status.logs.slice(0, 8).map((entry, idx) => {
            const line = formatMomentumScalperLog(entry.message);
            return (
              <div
                key={`${entry.time}-${idx}`}
                className={cn(
                  "ms-log-line",
                  entry.type === "success" && "is-success",
                  entry.type === "warning" && "is-warning",
                  entry.type === "error" && "is-error",
                )}
              >
                <div className="ms-log-line-head">
                  <span className="pat-log-time">{entry.time}</span>
                  <span className={cn("ms-log-badge", line.badgeClass)}>{line.badge}</span>
                </div>
                <p className="ms-log-text">{line.text}</p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
