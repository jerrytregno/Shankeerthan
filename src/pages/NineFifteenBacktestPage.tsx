import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, TrendingDown } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { BacktestSection } from "@/components/nine-fifteen/HighMinus5BacktestSection";
import { NineFifteenMinuteTickChart } from "@/components/nine-fifteen/NineFifteenMinuteTickChart";
import { useKite } from "@/contexts/kite-context";
import { NSE_SESSIONS_ONE_YEAR } from "@/types/nine-fifteen";
import type { NineFifteenHighMinus5BacktestResult } from "@/types/nine-fifteen-high-minus5-backtest";
import { cn } from "@/lib/utils";
import "@/styles/nine-fifteen-backtest-page.css";

const BACKTEST_WINDOWS = [
  { id: "1y", label: "1 year", sessions: NSE_SESSIONS_ONE_YEAR, historyLabel: "last 1 year" },
  { id: "2y", label: "2 years", sessions: NSE_SESSIONS_ONE_YEAR * 2, historyLabel: "last 2 years" },
] as const;

type BacktestWindowId = (typeof BACKTEST_WINDOWS)[number]["id"];

export default function NineFifteenBacktestPage() {
  const { connected } = useKite();
  const [data, setData] = useState<NineFifteenHighMinus5BacktestResult | null>(null);
  const [windowId, setWindowId] = useState<BacktestWindowId>("1y");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeWindow = BACKTEST_WINDOWS.find((w) => w.id === windowId) ?? BACKTEST_WINDOWS[0];

  const load = useCallback(async (win: (typeof BACKTEST_WINDOWS)[number], refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ days: String(win.sessions) });
      if (refresh) qs.set("refresh", "1");
      const res = await fetch(`/api/kite/nine-fifteen-high-minus5-backtest?${qs}`, {
        credentials: "include",
      });
      const json = (await res.json()) as { data?: NineFifteenHighMinus5BacktestResult; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Backtest request failed");
      if (!json.data) throw new Error("Empty backtest response");
      if (json.data.daysRequested < win.sessions) {
        throw new Error(
          `Only ${json.data.daysRequested} sessions loaded (need ${win.sessions}) — hit Run backtest to rebuild ${win.label}`,
        );
      }
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load backtest");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!connected) return;
    const win = BACKTEST_WINDOWS.find((w) => w.id === windowId) ?? BACKTEST_WINDOWS[0];
    setData(null);
    void load(win, false);
  }, [connected, windowId, load]);

  const rangeLabel = data ? `${data.from} → ${data.to}` : "";

  return (
    <DashboardShell>
      <div className="nf915bt-page">
        <header className="nf915bt-header">
          <div className="nf915bt-header-copy">
            <h1 className="nf915bt-title">9:15 backtesting</h1>
            <p className="nf915bt-subtitle">
              Same-direction 9:15 study on Zerodha 1-minute candles · {activeWindow.label}
              {data ? ` · ${rangeLabel} · ${data.daysRequested} sessions` : ""}. The gap and the 9:15
              candle must point the same way, and the candle must move at least 15 points. Exit is 15
              points from the 9:15 close.
            </p>
          </div>

          <div className="nf915bt-toolbar">
            <div className="nf915bt-window-filter" role="group" aria-label="Backtest date range">
              <span className="nf915bt-filter-label text-muted">Date range</span>
              {BACKTEST_WINDOWS.map((win) => (
                <button
                  key={win.id}
                  type="button"
                  className={cn("btn btn-sm", windowId === win.id ? "btn-primary" : "btn-secondary")}
                  disabled={!connected || loading}
                  onClick={() => setWindowId(win.id)}
                >
                  {win.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void load(activeWindow, true)}
              disabled={loading || !connected}
            >
              <RefreshCw size={14} className={loading ? "spin" : undefined} />
              {loading ? "Running…" : "Run backtest"}
            </button>
          </div>
        </header>

        <NineFifteenMinuteTickChart />

        {!connected && (
          <div className="card nf915bt-error">
            <AlertTriangle size={16} />
            <p>Connect Zerodha to pull Nifty 1-minute history from Kite.</p>
          </div>
        )}

        {error && (
          <div className="card nf915bt-error">
            <AlertTriangle size={16} />
            <p>{error}</p>
          </div>
        )}

        {loading && !data && (
          <div className="card nf915bt-loading">
            <div className="spinner" />
            <p>
              Pulling {activeWindow.label} of Nifty session minutes
              {activeWindow.sessions >= NSE_SESSIONS_ONE_YEAR ? " (first load can take a few minutes)…" : "…"}
            </p>
          </div>
        )}

        {data && !data.sameDirection15 && (
          <div className="card nf915bt-error">
            <AlertTriangle size={16} />
            <p>
              This cache is the old open ±5 studies. Hit <strong>Run backtest</strong> to build the
              same-direction 15-point study.
            </p>
          </div>
        )}

        {data?.sameDirection15 && (
          <div className="nf915bt-accordions">
            <BacktestSection
              slice={data.sameDirection15.all}
              builtAt={data.builtAt}
              rangeLabel={rangeLabel}
              defaultOpen
            />
            <BacktestSection
              slice={data.sameDirection15.pe}
              builtAt={data.builtAt}
              rangeLabel={rangeLabel}
              subtitle="Only the PE trades: opened down, and the 9:15 candle kept falling by 15 points or more."
            />
            <BacktestSection
              slice={data.sameDirection15.ce}
              builtAt={data.builtAt}
              rangeLabel={rangeLabel}
              subtitle="Only the CE trades: opened up, and the 9:15 candle kept rising by 15 points or more."
            />

            <details className="nf915bt-accordion">
              <summary className="nf915bt-accordion-summary">
                <span className="nf915bt-accordion-title">How outcomes are scored</span>
              </summary>
              <div className="nf915bt-accordion-body">
                <section className="card nf915bt-notes">
                  <h2>
                    <TrendingDown size={16} /> Scoring notes
                  </h2>
                  <p>
                    Nifty index points on Zerodha 1-minute candles, not option premium. A 1-minute
                    candle has no 9:15:10 tick, so the 9:15 candle body stands in for that 10-second
                    read, and the 9:15 close stands in for the 9:15:11 price. Take profit is 15 points
                    from that close, from 9:16 through 15:30.
                  </p>
                </section>
              </div>
            </details>
          </div>
        )}
      </div>
    </DashboardShell>
  );
}
