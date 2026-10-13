import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Clock, RefreshCw, TrendingUp } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useKite } from "@/contexts/kite-context";
import type { Fade1405BacktestResult, Fade1405BacktestTrade } from "@/types/fade-1405-backtest";
import { NSE_SESSIONS_ONE_YEAR } from "@/types/nine-fifteen";
import { cn, formatNumber } from "@/lib/utils";
import "@/styles/nine-fifteen-page.css";

const BACKTEST_WINDOWS = [
  { id: "1y", label: "1 year", sessions: NSE_SESSIONS_ONE_YEAR, historyLabel: "last 1 year" },
] as const;

type BacktestWindowId = (typeof BACKTEST_WINDOWS)[number]["id"];

const EXIT_LABEL = { stop: "Stop", trail: "Trail", session: "3:20" } as const;

const WIN_HIT_HOUR_BUCKETS: { hour: number; label: string }[] = [
  { hour: 14, label: "2 PM" },
  { hour: 15, label: "3 PM" },
];

function exitHourIst(trade: Fade1405BacktestTrade): number | null {
  const match = /^(\d{1,2}):/.exec(trade.exitTime.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  return Number.isFinite(hour) ? hour : null;
}

function buildExitCountsByHour(trades: Fade1405BacktestTrade[]) {
  const counts = new Map<number, number>();
  let unmapped = 0;
  for (const t of trades) {
    const hour = exitHourIst(t);
    if (hour == null || hour < 14 || hour > 15) {
      unmapped += 1;
      continue;
    }
    counts.set(hour, (counts.get(hour) ?? 0) + 1);
  }
  return {
    buckets: WIN_HIT_HOUR_BUCKETS.map((b) => ({ ...b, count: counts.get(b.hour) ?? 0 })),
    unmapped,
  };
}

function ExitHourlyBreakdown({ wins }: { wins: Fade1405BacktestTrade[] }) {
  const { buckets, unmapped } = buildExitCountsByHour(wins);
  const total = wins.length;
  const max = Math.max(1, ...buckets.map((b) => b.count));

  return (
    <div className="nf-wins-hourly card">
      <h4 className="nf-wins-hourly-title">
        <Clock size={15} aria-hidden />
        Winning exits by hour (IST)
      </h4>
      <p className="text-muted nf-wins-hourly-hint">
        Trail or cap exits on 1-minute Kite bars from 14:06 through 3:20 PM.
      </p>
      <div className="nf-wins-hourly-grid">
        {buckets.map((b) => (
          <div key={b.hour} className="nf-wins-hourly-cell">
            <span className="nf-wins-hourly-label">{b.label}</span>
            <div className="nf-wins-hourly-bar-wrap" title={`${b.count} exit${b.count === 1 ? "" : "s"}`}>
              <div className="nf-wins-hourly-bar" style={{ width: `${(b.count / max) * 100}%` }} />
            </div>
            <span className="nf-wins-hourly-count font-mono">{b.count}</span>
          </div>
        ))}
      </div>
      <p className="text-muted nf-wins-hourly-foot">
        {total} winning trade{total === 1 ? "" : "s"}
        {unmapped > 0 ? ` · ${unmapped} without a mapped exit hour` : ""}.
      </p>
    </div>
  );
}

function TradeTable({
  title,
  trades,
  kind,
}: {
  title: string;
  trades: Fade1405BacktestTrade[];
  kind: "win" | "loss";
}) {
  if (trades.length === 0) return null;
  return (
    <details className="nf-failures-details" open={kind === "loss"}>
      <summary className="nf-failures-summary">
        <span className="nf-failures-rule">{title}</span>
        <span className="nf-failures-count text-muted">({trades.length})</span>
      </summary>
      <div className="nf-failures-table-wrap">
        <table className="nf-failures-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Day</th>
              <th>Side</th>
              <th className="text-right">Signal @ 14:05</th>
              <th className="text-right">Entry 14:06</th>
              <th className="text-right">Peak pts</th>
              <th className="text-right">Exit</th>
              <th className="text-right">P&amp;L pts</th>
              <th>Exit</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr key={t.date}>
                <td className="font-mono">{t.date}</td>
                <td>{t.weekday}</td>
                <td>{t.side === "call" ? "CE fade" : "PE fade"}</td>
                <td className="text-right font-mono text-sm">{t.setupLabel}</td>
                <td className="text-right font-mono">
                  {formatNumber(t.entryPrice, 2)}
                  <span className="text-muted"> {t.entryTime}</span>
                </td>
                <td className="text-right font-mono text-sm">{formatNumber(t.peakPts, 1)}</td>
                <td className="text-right font-mono">
                  {formatNumber(t.exitPrice, 2)}
                  <span className="text-muted"> {t.exitTime}</span>
                </td>
                <td
                  className={cn(
                    "text-right font-mono",
                    t.pnlPts > 0 ? "text-up" : t.pnlPts < 0 ? "text-down" : "",
                  )}
                >
                  {t.pnlPts > 0 ? "+" : ""}
                  {formatNumber(t.pnlPts, 1)}
                </td>
                <td className="text-sm text-muted">{EXIT_LABEL[t.exitReason]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export default function Fade1405BacktestPage() {
  const { connected, loginUrl } = useKite();
  const [data, setData] = useState<Fade1405BacktestResult | null>(null);
  const [windowId] = useState<BacktestWindowId>("1y");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeWindow = BACKTEST_WINDOWS.find((w) => w.id === windowId) ?? BACKTEST_WINDOWS[0];

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const qs = refresh ? "?refresh=1" : "";
      const res = await fetch(`/api/kite/fade-1405-backtest${qs}`, { credentials: "include" });
      const json = (await res.json()) as { data?: Fade1405BacktestResult; error?: string };
      if (!res.ok || !json.data) throw new Error(json.error ?? "Backtest failed");
      if (json.data.sessions < activeWindow.sessions) {
        throw new Error(
          `Only ${json.data.sessions} sessions loaded (need ${activeWindow.sessions}) — hit Refresh to rebuild`,
        );
      }
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [activeWindow.sessions]);

  useEffect(() => {
    if (connected) void load(false);
  }, [connected, load]);

  const trail = data?.trail;
  const busy = loading;

  return (
    <DashboardShell>
      <div className="nine-fifteen-page">
        <header className="page-header nf-header">
          <div>
            <h1 className="page-title">
              <TrendingUp size={22} />
              14:05 fade backtesting
            </h1>
            <p className="page-subtitle">
              Nifty 50 · trend-day fade at 14:06 · Zerodha Kite minute data · {activeWindow.label}
              {data ? ` · ${data.from} → ${data.to} · ${data.sessions} sessions` : ""}
            </p>
          </div>
          <div className="nf-header-actions">
            <div className="nf-window-filter" role="group" aria-label="Backtest date range">
              {BACKTEST_WINDOWS.map((win) => (
                <button
                  key={win.id}
                  type="button"
                  className={cn("btn btn-sm", windowId === win.id ? "btn-primary" : "btn-secondary")}
                  disabled
                  title="Win backtest cache is built for ~1 year of sessions"
                >
                  {win.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={!connected || busy}
              onClick={() => void load(true)}
            >
              <RefreshCw size={14} className={loading ? "spin" : ""} />
              Refresh
            </button>
          </div>
        </header>

        {!connected && (
          <div className="card nf-banner">
            <AlertTriangle size={18} />
            <div>
              <p className="font-medium">Connect Zerodha Kite to load historical candles</p>
              {loginUrl && (
                <a href={loginUrl} className="btn btn-primary btn-sm" style={{ marginTop: "0.5rem" }}>
                  Connect Kite
                </a>
              )}
            </div>
          </div>
        )}

        {error && (
          <div className="card nf-error">
            <AlertTriangle size={16} />
            {error}
          </div>
        )}

        {loading && !data && (
          <div className="card nf-loading">
            <RefreshCw size={18} className="spin" />
            Loading {activeWindow.label} of Zerodha Kite sessions (first run builds the Win cache)…
          </div>
        )}

        {loading && data && (
          <div className="card nf-loading nf-loading--inline">
            <RefreshCw size={16} className="spin" />
            Updating backtest…
          </div>
        )}

        {data && (
          <>
            <div className="nf-summary-grid">
              <div className="card nf-summary-card">
                <span className="nf-summary-label">NSE sessions</span>
                <span className="nf-summary-value">{data.sessions}</span>
                <span className="nf-summary-hint">
                  {data.from} → {data.to} · {activeWindow.label}
                </span>
              </div>
              <div className="card nf-summary-card">
                <span className="nf-summary-label">Setups taken</span>
                <span className="nf-summary-value">{data.summary.tradeDays}</span>
                <span className="nf-summary-hint">{data.skippedDays} days skipped (filters not met)</span>
              </div>
              <div className="card nf-summary-card nf-summary-card--up">
                <span className="nf-summary-label">
                  <ArrowUpRight size={14} /> Wins (Nifty trail)
                </span>
                <span className="nf-summary-value">{data.summary.wins}</span>
                <span className="nf-summary-hint">{formatNumber(data.summary.winPct, 2)}% of trades</span>
              </div>
              <div className="card nf-summary-card nf-summary-card--down">
                <span className="nf-summary-label">
                  <ArrowDownRight size={14} /> Losses
                </span>
                <span className="nf-summary-value">{data.summary.losses}</span>
              </div>
              <div className="card nf-summary-card">
                <span className="nf-summary-label">Total Nifty points</span>
                <span className="nf-summary-value">{formatNumber(data.summary.totalPts, 1)}</span>
                <span className="nf-summary-hint">
                  avg {formatNumber(data.summary.avgPts, 2)} · worst {formatNumber(data.summary.worstPts, 1)}
                </span>
              </div>
            </div>

            <div className="card nf-filter-stats">
              <h3 className="nf-filter-stats-title">14:05 trend-day fade · live trail params</h3>
              <p className="nf-filter-stats-source text-muted">
                {data.detail} NSE session days from Zerodha Kite only ({activeWindow.historyLabel}) — weekends and
                holidays omitted when no candles.
              </p>
              <div className="nf-filter-stats-grid">
                <div>
                  <span className="nf-filter-stat-label">Initial stop (pts)</span>
                  <span className="nf-filter-stat-value">{trail?.stopPts ?? 25}</span>
                </div>
                <div>
                  <span className="nf-filter-stat-label">Trail arms at</span>
                  <span className="nf-filter-stat-value">+{trail?.armPts ?? 5}</span>
                </div>
                <div>
                  <span className="nf-filter-stat-label">Trail distance</span>
                  <span className="nf-filter-stat-value">{trail?.trailPts ?? 4}</span>
                </div>
                <div>
                  <span className="nf-filter-stat-label">Profit cap</span>
                  <span className="nf-filter-stat-value">+{trail?.maxProfitPts ?? 10}</span>
                </div>
                <div>
                  <span className="nf-filter-stat-label">Win rate (filtered)</span>
                  <span className="nf-filter-stat-value">{formatNumber(data.summary.winPct, 2)}%</span>
                </div>
                <div>
                  <span className="nf-filter-stat-label">{data.fixedLabel}</span>
                  <span className="nf-filter-stat-value">{formatNumber(data.fixed.winPct, 1)}%</span>
                </div>
              </div>
            </div>

            <div className="nf-cepe-section">
              <div className="card nf-cepe-guide">
                <h2 className="card-title">Entry &amp; exit rules (matches live bot)</h2>
                <p className="nf-cepe-steps text-muted">
                  At the <strong>14:05 close</strong>, if Nifty is <strong>100+ points</strong> from the{" "}
                  <strong>9:15 open</strong> and today&apos;s range (9:15 through 14:05) is{" "}
                  <strong>strictly larger</strong> than <strong>yesterday&apos;s full-day</strong> range, enter the{" "}
                  <strong>fade</strong> at the <strong>14:06 open</strong> (100+ above open → ATM PE · 100+ below → ATM
                  CE). Exit: Nifty index trail — stop <strong>{trail?.stopPts ?? 25}</strong>, arm{" "}
                  <strong>+{trail?.armPts ?? 5}</strong>, trail <strong>{trail?.trailPts ?? 4}</strong>, cap{" "}
                  <strong>+{trail?.maxProfitPts ?? 10}</strong>, session flat <strong>3:20</strong>. Live also uses the{" "}
                  <strong>−30% capital stop</strong> on option LTP and <strong>3:25</strong> square-off like other legs.
                </p>
                <p className="nf-cepe-steps text-muted">
                  {data.summary.wins}/{data.summary.tradeDays} trades won ({formatNumber(data.summary.winPct, 1)}%) ·{" "}
                  {data.skippedDays} sessions had no setup.
                </p>
              </div>

              {data.successes.length > 0 && <ExitHourlyBreakdown wins={data.successes} />}

              <TradeTable title="Winning trades — 14:06 entry" trades={data.successes} kind="win" />
              <TradeTable title="Loss trades — 14:06 entry" trades={data.failures} kind="loss" />
            </div>
          </>
        )}
      </div>
    </DashboardShell>
  );
}
