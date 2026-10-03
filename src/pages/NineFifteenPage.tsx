import { AlertTriangle, Clock } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { ServerNineSixteenBotPanel } from "@/components/trade/ServerNineSixteenBotPanel";
import { ServerMomentumScalperBotPanel } from "@/components/trade/ServerMomentumScalperBotPanel";
import { useKite } from "@/contexts/kite-context";
import "@/styles/nine-fifteen-page.css";

export default function NineFifteenPage() {
  const { connected, loginUrl } = useKite();

  return (
    <DashboardShell>
      <div className="nine-fifteen-page">
        <header className="page-header nf-header">
          <div>
            <h1 className="page-title">
              <Clock size={22} />
              9:15 Candle
            </h1>
            <p className="page-subtitle">
              9:15 + 9:16 morning legs armed on server · Traps off on server
            </p>
          </div>
        </header>

        <div className="card nf-live-rules">
          <h2 className="nf-live-rules-title">Live strategies</h2>
          <p className="nf-live-rules-lead text-muted">
            Two independent morning trades on the same server bot, plus Traps later in the session. Each has its
            own enable switch. All times are IST, Monday to Friday.
          </p>

          <div className="nf-live-rules-grid">
            <div className="nf-live-rules-col">
              <h3 className="nf-live-rules-heading">9:15 trade · starts 9:15 AM</h3>
              <ul className="nf-live-rules-list">
                <li>
                  Watches the opening minute and places its order at <strong>9:15:11</strong>.
                </li>
                <li>Trades the at-the-money Nifty option (CE or PE). Some days it does not trade.</li>
                <li>Exits automatically; anything still open is squared off by <strong>3:25 PM</strong>.</li>
              </ul>
            </div>

            <div className="nf-live-rules-col">
              <h3 className="nf-live-rules-heading">9:16 trade · starts 9:16 AM</h3>
              <ul className="nf-live-rules-list">
                <li>
                  Reads the 9:15 candle and places its order at <strong>9:16:01</strong>.
                </li>
                <li>
                  Trades the at-the-money Nifty option (CE or PE). Skipped while the 9:15 trade is still open.
                </li>
                <li>Exits automatically; anything still open is squared off by <strong>3:25 PM</strong>.</li>
              </ul>
            </div>
          </div>
        </div>

        <div className="card nf-live-rules nf-live-rules--traps">
          <h2 className="nf-live-rules-title">Traps bot · 9:16:30 AM – 3:30 PM</h2>
          <ul className="nf-live-rules-list">
            <li>Intraday Nifty option trades through the rest of the session, after the morning window.</li>
            <li>
              Off until you press <strong>Enable</strong> on the panel below. Stops for the day after two losing
              trades.
            </li>
          </ul>
        </div>

        {!connected && (
          <div className="card nf-banner">
            <AlertTriangle size={18} />
            <div>
              <p className="font-medium">Connect Zerodha Kite to run the live server bot</p>
              {loginUrl && (
                <a href={loginUrl} className="btn btn-primary btn-sm" style={{ marginTop: "0.5rem" }}>
                  Connect Kite
                </a>
              )}
            </div>
          </div>
        )}

        {connected && <ServerNineSixteenBotPanel connected={connected} />}
        {connected && <ServerMomentumScalperBotPanel connected={connected} />}
      </div>
    </DashboardShell>
  );
}
