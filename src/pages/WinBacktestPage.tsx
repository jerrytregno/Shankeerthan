import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { useKite } from "@/contexts/kite-context";
import type {
  WinBacktestMethod,
  WinBacktestResult,
  WinBacktestTrade,
  WinExitReason,
  WinTrailParams,
} from "@/types/win-backtest";
import "@/styles/win-backtest-page.css";

type ResultFilter = "all" | "wins" | "losses";

const EXIT_LABEL: Record<WinExitReason, string> = {
  stop: "Stop",
  trail: "Trail",
  session: "3:20",
};

function formatSigned(value: number, digits = 1): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}`;
}

function pointsClass(value: number): string {
  if (value > 0) return "winbt-up";
  if (value < 0) return "winbt-down";
  return "";
}

function trailSentence(params: WinTrailParams): string {
  const floor = params.minLockPts ?? 5;
  const cap = params.maxProfitPts ?? 10;
  return `The stop starts ${params.stopPts} points against the trade. Once the trade is ${params.armPts} points in profit, the stop follows ${params.trailPts} points behind the best price and never gives that profit back below +${floor}. If Nifty reaches +${cap}, the trade is closed there. If neither happens, it is closed at 3:20.`;
}

export default function WinBacktestPage() {
  const { connected } = useKite();
  const [data, setData] = useState<WinBacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [methodId, setMethodId] = useState<string>("fade-1030");
  const [resultFilter, setResultFilter] = useState<ResultFilter>("all");

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (refresh) qs.set("refresh", "1");
      const res = await fetch(`/api/kite/win-backtest${qs.size ? `?${qs}` : ""}`, { credentials: "include" });
      const json = (await res.json()) as { data?: WinBacktestResult; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Backtest request failed");
      if (!json.data) throw new Error("Empty backtest response");
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load backtest");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (connected) void load(false);
  }, [connected, load]);

  const method = useMemo(() => {
    if (!data) return null;
    return data.methods.find((item) => item.id === methodId) ?? data.methods[0] ?? null;
  }, [data, methodId]);

  const rows = useMemo(() => {
    if (!method) return [];
    return method.trades.filter((trade) => {
      if (resultFilter === "wins") return trade.pnlPts > 0;
      if (resultFilter === "losses") return trade.pnlPts <= 0;
      return true;
    });
  }, [method, resultFilter]);

  return (
    <DashboardShell>
      <div className="winbt-page">
        <header className="winbt-header">
          <div>
            <h1 className="winbt-title">Win backtesting</h1>
            <p className="winbt-subtitle">
              Last year of Nifty minute bars.               Each method still fades the move that qualified it. The trail locks between 5 and 10
              Nifty points, and the page keeps the stop and trail that won most often. Every day
              that traded is listed below.
            </p>
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => void load(true)} disabled={loading || !connected}>
            <RefreshCw size={14} className={loading ? "spin" : undefined} />
            {loading ? "Running…" : "Run analysis"}
          </button>
        </header>

        {!connected && (
          <div className="card winbt-error">
            <AlertTriangle size={16} />
            <p>Connect Zerodha to pull the last year of Nifty minutes.</p>
          </div>
        )}

        {error && (
          <div className="card winbt-error">
            <AlertTriangle size={16} />
            <p>{error}</p>
          </div>
        )}

        {loading && !data && (
          <div className="card winbt-loading">
            <div className="spinner" />
            <p>Pulling one year of Nifty minutes and testing trailing stops…</p>
          </div>
        )}

        {data && method && (
          <>
            <section className="winbt-methods" aria-label="Methods">
              {data.methods.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`winbt-method ${item.id === method.id ? "active" : ""}`}
                  onClick={() => {
                    setMethodId(item.id);
                    setResultFilter("all");
                  }}
                >
                  <p className="winbt-method-label">{item.label}</p>
                  <p className={`winbt-method-points ${pointsClass(item.summary.totalPts)}`}>
                    {formatSigned(item.summary.totalPts, 0)} pts
                  </p>
                  <p className="winbt-method-meta">
                    {item.summary.winPct.toFixed(1)}% wins · {item.summary.trades} days · stop {item.best.stopPts}, trail after {item.best.armPts}
                  </p>
                </button>
              ))}
            </section>

            <MethodPanel method={method} sessions={data.sessions} rangeLabel={`${data.from} → ${data.to}`} />

            <section className="card">
              <div className="winbt-table-toolbar">
                <h2>Every day ({rows.length})</h2>
                <div className="winbt-filters">
                  <button
                    type="button"
                    className={`btn btn-sm ${resultFilter === "all" ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setResultFilter("all")}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${resultFilter === "wins" ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setResultFilter("wins")}
                  >
                    Wins
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${resultFilter === "losses" ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setResultFilter("losses")}
                  >
                    Losses
                  </button>
                </div>
              </div>
              <div className="winbt-table-wrap">
                <table className="winbt-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Day</th>
                      <th>Trade</th>
                      <th>Setup</th>
                      <th>Entry</th>
                      <th>Entry price</th>
                      <th>Exit</th>
                      <th>Exit price</th>
                      <th>Why</th>
                      <th>Peak</th>
                      <th>Points</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 ? (
                      <tr>
                        <td colSpan={11} className="winbt-empty">
                          No days match this filter.
                        </td>
                      </tr>
                    ) : (
                      rows.map((trade) => <TradeRow key={`${trade.date}-${trade.entryTime}`} trade={trade} />)
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </DashboardShell>
  );
}

function MethodPanel({
  method,
  sessions,
  rangeLabel,
}: {
  method: WinBacktestMethod;
  sessions: number;
  rangeLabel: string;
}) {
  return (
    <section className="card winbt-section">
      <h2>{method.label}</h2>
      <p className="winbt-detail">{method.detail}</p>
      <p className="winbt-trail">{trailSentence(method.best)}</p>
      <div className="winbt-stat-grid">
        <div>
          <p className="winbt-stat-label">Trail total</p>
          <p className={`winbt-stat-value ${pointsClass(method.summary.totalPts)}`}>
            {formatSigned(method.summary.totalPts)} pts
          </p>
        </div>
        <div>
          <p className="winbt-stat-label">Win rate</p>
          <p className="winbt-stat-value">{method.summary.winPct.toFixed(1)}%</p>
          <p className="winbt-method-meta">
            {method.summary.wins} wins · {method.summary.losses} losses
          </p>
        </div>
        <div>
          <p className="winbt-stat-label">Average</p>
          <p className={`winbt-stat-value ${pointsClass(method.summary.avgPts)}`}>
            {formatSigned(method.summary.avgPts)} pts
          </p>
        </div>
        <div>
          <p className="winbt-stat-label">Best / worst day</p>
          <p className="winbt-stat-value">
            <span className="winbt-up">{formatSigned(method.summary.bestPts)}</span>
            {" / "}
            <span className="winbt-down">{formatSigned(method.summary.worstPts)}</span>
          </p>
        </div>
        <div>
          <p className="winbt-stat-label">Old fixed target</p>
          <p className={`winbt-stat-value ${pointsClass(method.fixed.totalPts)}`}>
            {formatSigned(method.fixed.totalPts)} pts
          </p>
          <p className="winbt-method-meta">
            {method.fixed.winPct.toFixed(1)}% of {method.fixed.trades} days
          </p>
        </div>
      </div>
      <p className="winbt-method-meta" style={{ marginTop: "0.85rem" }}>
        {method.fixedLabel}. {method.summary.trades} traded days out of {sessions} sessions · {rangeLabel}
      </p>
      <div className="winbt-candidates">
        <h2>Closest trails</h2>
        <div className="winbt-table-wrap">
          <table className="winbt-table">
            <thead>
              <tr>
                <th>Initial stop</th>
                <th>Trail starts</th>
                <th>Distance behind peak</th>
                <th>Win rate</th>
                <th>Total points</th>
              </tr>
            </thead>
            <tbody>
              {method.candidates.map((candidate) => (
                <tr key={`${candidate.params.stopPts}-${candidate.params.armPts}-${candidate.params.trailPts}`}>
                  <td>{candidate.params.stopPts}</td>
                  <td>+{candidate.params.armPts}</td>
                  <td>{candidate.params.trailPts}</td>
                  <td>{candidate.summary.winPct.toFixed(1)}%</td>
                  <td className={pointsClass(candidate.summary.totalPts)}>{formatSigned(candidate.summary.totalPts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function TradeRow({ trade }: { trade: WinBacktestTrade }) {
  return (
    <tr>
      <td>{trade.date}</td>
      <td>{trade.weekday}</td>
      <td>
        <span className={`winbt-side winbt-side-${trade.side}`}>{trade.side}</span>
      </td>
      <td>{trade.setupLabel}</td>
      <td>{trade.entryTime}</td>
      <td>{trade.entryPrice.toFixed(2)}</td>
      <td>{trade.exitTime}</td>
      <td>{trade.exitPrice.toFixed(2)}</td>
      <td>{EXIT_LABEL[trade.exitReason]}</td>
      <td className={pointsClass(trade.peakPts)}>{formatSigned(trade.peakPts)}</td>
      <td className={pointsClass(trade.pnlPts)}>{formatSigned(trade.pnlPts)}</td>
    </tr>
  );
}
