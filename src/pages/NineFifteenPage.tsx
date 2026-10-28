import { AlertTriangle, Clock } from "lucide-react";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { ServerNineSixteenBotPanel } from "@/components/trade/ServerNineSixteenBotPanel";
import { useKite } from "@/contexts/kite-context";
import { NINE_FIFTEEN_RED_916_BACKTEST_TITLE } from "@/types/nine-fifteen";
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
            <p className="page-subtitle">9:15 + 9:16 morning legs</p>
          </div>
        </header>

        <div className="card nf-live-rules">
          <h2 className="nf-live-rules-title">Live strategies — entry &amp; exit rules</h2>
          <p className="nf-live-rules-lead text-muted">
            Morning 9:15 and 9:16 legs on the same bot. Backtest:{" "}
            <strong>{NINE_FIFTEEN_RED_916_BACKTEST_TITLE}</strong>.
          </p>

          <div className="nf-live-rules-grid">
            {/* —— 9:15 trade —— */}
            <div className="nf-live-rules-col">
              <h3 className="nf-live-rules-heading">9:15 trade · PE or CE at 9:15:11</h3>
              <p className="nf-live-rules-lead text-muted">
                Enter at 9:15:11 only when yesterday's close and the first 10 seconds point the same way, and
                that move is already 15 points. Opened down and still falling buys ATM PE. Opened up and still
                rising buys ATM CE. Exit when Nifty has moved <strong>15 points</strong> from the 9:15:11 price.
              </p>
              <h4 className="nf-live-rules-subheading">Entry</h4>
              <ol className="nf-live-rules-list">
                <li>
                  <strong>Capture the 9:15 open</strong> — first Nifty websocket tick from{" "}
                  <strong>9:15:00</strong>.
                </li>
                <li>
                  <strong>Read direction at 9:15:10</strong> — last tick strictly before 10 seconds vs that open,
                  and compare the open with yesterday's 15:30 close.
                  <ul className="nf-live-rules-sublist">
                    <li>
                      Opened down, and the first 10 seconds kept falling by <strong>15 points or more</strong> →{" "}
                      <strong>ATM PE</strong> at <strong>9:15:11</strong>
                    </li>
                    <li>
                      Opened up, and the first 10 seconds kept rising by <strong>15 points or more</strong> →{" "}
                      <strong>ATM CE</strong> at <strong>9:15:11</strong>
                    </li>
                    <li>
                      The gap and the 10-second move point opposite ways, or the move is under 15 points → no
                      9:15 trade
                    </li>
                  </ul>
                </li>
                <li>
                  <strong>Order window</strong> — insufficient-fund downsize retries until <strong>9:15:15</strong>{" "}
                  (skip 9:15 leg if not in by 9:15:16); partial top-ups until <strong>9:15:20</strong>.
                </li>
                <li>
                  ATM CE + PE are pre-resolved at <strong>9:15:04</strong> so :11 is placement only.
                </li>
                <li>
                  <strong>Sizing &amp; orders</strong> — full available balance; max <strong>25 lots</strong> per
                  Kite order (split in parallel if larger). <strong>Entry = NRML market BUY</strong> at the live
                  print (fast fill at 9:15:11 — not a limit entry). Sizing uses two REST LTP reads 1s apart
                  (size on the lower quote) plus a <strong>3% margin cushion</strong> (Kite blocks margin a little
                  above the last price for market orders), so the first order is not refused for funds.
                </li>
                <li>
                  <strong>Partial fill / margin short</strong> — on insufficient funds at 9:15:11, reduce{" "}
                  <strong>1 lot</strong> (or Kite&apos;s scaled size) and retry instantly until{" "}
                  <strong>9:15:15</strong>. After a partial fill, top-up until <strong>9:15:20</strong> with the same
                  downsize logic.
                </li>
              </ol>
              <h4 className="nf-live-rules-subheading">Exit</h4>
              <ol className="nf-live-rules-list">
                <li>
                  <strong>9:15 open stop</strong> — on every Nifty websocket tick after the fill,{" "}
                  <strong>immediate market exit</strong> if Nifty crosses back through the{" "}
                  <strong>9:15 open</strong> (first tick of that minute). <strong>PE</strong> when Nifty goes above
                  the open. <strong>CE</strong> when Nifty goes below the open. A tick exactly at the open holds.
                </li>
                <li>
                  <strong>P&amp;L −15% stop</strong> — on every option LTP websocket tick, if unrealised P&amp;L
                  touches <strong>−15%</strong> of the premium paid, <strong>immediate market exit</strong>. This
                  cancels the resting stop-loss first.
                </li>
                <li>
                  <strong>Stop-loss order at −20%</strong> — the moment the buy fills, an <strong>SL-M sell</strong>{" "}
                  rests at entry premium × 0.80 (₹0.05 tick), same NRML product as the buy. If Kite rejects it, the
                  bot sends it again immediately. It is the backstop if a tick is missed; the −15% rule sells first
                  whenever the bot sees the print.
                </li>
                <li>
                  <strong>15 Nifty points from the 9:15:11 fill</strong> — PE when Nifty falls 15 points from the
                  price at entry, CE when Nifty rises 15 points. Immediate market exit.
                </li>
                <li>
                  <strong>3:25 PM</strong> — square off at market if still open regardless of P&amp;L.
                </li>
                <li>
                  <strong>9:15:57 flip for 9:16</strong> — from <strong>9:15:57</strong> through 9:15:59, if the leg is{" "}
                  <strong>not in profit</strong> and Nifty has moved ≥ <strong>15 pts against</strong> the 9:15 leg vs
                  the <strong>9:15 open</strong> (PE: spot ≥ open + 15 · CE: spot ≤ open − 15),{" "}
                  <strong>immediate market exit</strong> so the bot can take the 9:16 trade on the sealed 9:15 candle
                  (|Δ| ≥ 15, red → PE · green → CE). ATM pre-resolve for 9:16 warms from <strong>9:15:58</strong>.
                </li>
                <li>
                  <strong>Hard stop — from 10:00 AM IST</strong> — exit at market if Nifty moves{" "}
                  <strong>30 points against</strong> the entry direction from the spot at fill:{" "}
                  <strong>PE</strong> when spot ≥ entry + 30. Runs alongside the trailing ladder; whichever hits first
                  closes the leg.
                </li>
                <li>
                  <strong>Small-body exit @ 9:16:01</strong> — if the 9:15 leg is still open when the{" "}
                  <strong>websocket 9:15:59 close</strong> seals and <strong>|close − open| &lt; 5</strong>, exit
                  at market on the <strong>first Nifty WS tick at 9:16:01</strong>, whatever the P&amp;L.
                </li>
              </ol>
              <p className="nf-live-rules-foot text-muted">
                When the 9:15 leg closes before 9:16:00, the 9:16 decision still runs at 9:16:00 unless the
                9:15 trade is still open. If the 9:15 signal itself qualifies (same-direction gap and a 15-point
                10-second move), the buy goes out at <strong>9:15:11</strong>. A tick in the second before that
                order is not a missed trade. If that order does not fill, the 9:16 decision still runs.
              </p>
            </div>

            {/* —— 9:16 trade —— */}
            <div className="nf-live-rules-col">
              <h3 className="nf-live-rules-heading">9:16 trade · PE or CE at 9:16:00</h3>
              <p className="nf-live-rules-lead text-muted">
                Second morning leg on the same server bot — 9:15 candle with |Δ| ≥ 15 buys ATM PE when red or ATM
                CE when green at 9:16:00. The moment the buy fills, a <strong>limit sell</strong> rests at the
                weekday profit % on the entry premium. Always armed on the server alongside the 9:15 trade.
              </p>
              <div className="nf-trail-method" aria-label="9:16 limit sell">
                <p className="nf-trail-method-title">9:16 limit sell (live)</p>
                <p className="nf-trail-method-lead text-muted">
                  Placed the instant the entry fills. Price = entry premium × (1 + weekday %), rounded to ₹0.05.
                  Same % for PE and CE. There is no Nifty trail and no market sell when P&amp;L merely reaches
                  that %.
                </p>
                <div className="nf-trail-method-table-wrap">
                  <table className="nf-trail-method-table">
                    <thead>
                      <tr>
                        <th scope="col">Monday</th>
                        <th scope="col">Tuesday</th>
                        <th scope="col">Wednesday</th>
                        <th scope="col">Thursday</th>
                        <th scope="col">Friday</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>6%</td>
                        <td>7%</td>
                        <td>3%</td>
                        <td>4%</td>
                        <td>5%</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="nf-trail-method-note text-muted">
                  The 35-pt minute spike, the 40-pt checkpoint, and entry return still market-sell and cancel this
                  limit. <strong>3:25 PM</strong> square-off if it is still open.
                </p>
              </div>
              <h4 className="nf-live-rules-subheading">Entry</h4>
              <ol className="nf-live-rules-list">
                <li>
                  <strong>Δ = 9:15 close − open</strong>
                  <ul className="nf-live-rules-sublist">
                    <li>Flat → no trade</li>
                    <li>
                      |Δ| &lt; <strong>15</strong> → no trade
                    </li>
                    <li>
                      Red, <strong>|Δ| ≥ 15</strong> → <strong>PE</strong> (main entry band)
                    </li>
                    <li>
                      Green, <strong>|Δ| ≥ 15</strong> → <strong>CE</strong> (main entry band)
                    </li>
                  </ul>
                </li>
                <li>
                  <strong>9:15 close from websocket</strong> — last Nifty tick strictly before{" "}
                  <strong>9:16:00</strong> (logged as 9:15:59 close).
                </li>
                <li>
                  <strong>9:16 still runs</strong> if the 9:15 order does not fill. It is blocked only while that
                  9:15 order is still being sent, or when the 9:15 leg is still open at 9:16:00.
                </li>
                <li>
                  <strong>Order on the first Nifty websocket tick @ 9:16:00</strong> · option websocket armed from{" "}
                  <strong>9:15:58</strong> (ATM CE + PE pre-resolved), so the latest option price is already known —
                  no waiting for a new option tick. If no tick prints in that second, entry falls back at 9:16:01
                  using the sealed 9:15:59 close.
                </li>
                <li>
                  <strong>Entry = NRML market BUY</strong> at 9:16:00 (WS tick) · lots sized on the latest option websocket
                  price plus a <strong>3% margin cushion</strong> (Kite blocks margin a little above the last price
                  for market orders) · retries until <strong>9:16:30</strong>.
                </li>
                <li>
                  <strong>Blocked</strong> when the 9:15 leg is still open at 9:16:00.
                </li>
                <li>
                  <strong>Partial fill / margin short</strong> — tops up missing qty until <strong>9:16:30</strong>;
                  on insufficient margin, steps lots down instantly (25 → 24 → 23…) from Kite&apos;s quoted figures.
                </li>
              </ol>
              <h4 className="nf-live-rules-subheading">Exit (weekday limit sell)</h4>
              <ol className="nf-live-rules-list">
                <li>
                  <strong>Limit sell at the fill</strong> — see the <strong>9:16 limit sell (live)</strong> box
                  above. Wednesday 3% · Thursday 4% · Friday 5% · Monday 6% · Tuesday 7% on the entry premium.
                  The order rests on Kite until it fills, a stop cancels it, or 3:25 PM squares the leg off.
                </li>
                <li>
                  <strong>35-pt minute spike</strong> — on every Nifty websocket tick from 9:16, each minute is
                  measured from its own first tick. When Nifty is <strong>35 points against that open</strong>{" "}
                  (PE: tick ≥ open + 35 · CE: tick ≤ open − 35), the bot waits for a <strong>second tick</strong>{" "}
                  still beyond 35, then sells at market and cancels the resting limit. One tick is not enough. A
                  tick back inside 35 clears the count. The next minute starts again from its own first tick.
                </li>
                <li>
                  <strong>No Nifty trail and no option P&amp;L ladder on 9:16</strong> — profit is the limit sell
                  above, not a market exit when the option prints that %.
                </li>
                <li>
                  <strong>Adverse checkpoint + entry return</strong> — measured from the Nifty spot at fill. A
                  market exit here cancels the resting limit.
                  <ul className="nf-live-rules-sublist">
                    <li>
                      <strong>PE (put buy)</strong> — on the first Nifty websocket tick at or after{" "}
                      <strong>9:26:00 IST</strong>, exit at market if Nifty ≥ <strong>entry spot + 40</strong>.
                    </li>
                    <li>
                      <strong>CE (call buy)</strong> — on the first Nifty websocket tick at or after{" "}
                      <strong>9:17:00 IST</strong>, exit at market if Nifty ≤ <strong>entry spot − 40</strong>.
                    </li>
                    <li>
                      If that checkpoint does <strong>not</strong> trip the 40-pt stop, the bot arms an{" "}
                      <strong>entry return</strong> exit and squares off at market the instant Nifty touches the
                      entry spot again (PE: spot ≤ entry · CE: spot ≥ entry) on any later websocket tick.
                    </li>
                  </ul>
                  The 9:15 leg still uses the <strong>10:00 AM ±30</strong> hard stop; the 9:16 leg does not.
                </li>
                <li>
                  <strong>3:25 PM</strong> force square-off if still open.
                </li>
                <li>
                  <strong>How exits fire</strong> — the limit sell rests on Kite from the fill. The 35-pt minute
                  spike (2 ticks), the 40-pt checkpoint, and entry return are evaluated on{" "}
                  <strong>every Nifty websocket tick</strong>, plus a <strong>1-second safety check</strong> if the
                  main loop stalls. Those triggers cancel the limit and send a <strong>parallel market sell</strong>{" "}
                  (max 25 lots per order, up to 9 at once); fills are polled every <strong>0.2 s</strong>.
                </li>
              </ol>
            </div>
          </div>
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
      </div>
    </DashboardShell>
  );
}
