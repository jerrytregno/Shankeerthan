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
            <p className="page-subtitle">9:15 + 9:16 morning legs · optional 14:05 afternoon fade on server</p>
          </div>
        </header>

        <div className="card nf-live-rules">
          <h2 className="nf-live-rules-title">Live strategies — entry &amp; exit rules</h2>
          <p className="nf-live-rules-lead text-muted">
            Morning 9:15 and 9:16 legs plus an optional <strong>14:05 trend-day fade</strong> on the same bot.
            Backtests: <a href="/dashboard/fade-1405-backtest">14:05 fade</a> ·{" "}
            <strong>{NINE_FIFTEEN_RED_916_BACKTEST_TITLE}</strong>.
          </p>

          <div className="nf-live-rules-grid">
            {/* —— 9:15 trade —— */}
            <div className="nf-live-rules-col">
              <h3 className="nf-live-rules-heading">9:15 trade · PE or CE at 9:15:11</h3>
              <p className="nf-live-rules-lead text-muted">
                Burst on the opening minute — red ≥ 5 pts → ATM PE · green ≥ 10 pts → ATM CE. Exit:{" "}
                <strong>trailing P&amp;L ladder</strong> on option LTP websocket ticks from{" "}
                <strong>+3%</strong> (PE and CE) — ratchet targets, exit only on the locked stop floor.
              </p>
              <h4 className="nf-live-rules-subheading">Entry</h4>
              <ol className="nf-live-rules-list">
                <li>
                  <strong>Capture the 9:15 open</strong> — first Nifty websocket tick from{" "}
                  <strong>9:15:00</strong>.
                </li>
                <li>
                  <strong>Read direction at 9:15:10</strong> — last tick strictly before 10 seconds vs that open.
                  <ul className="nf-live-rules-sublist">
                    <li>
                      <strong>Red ≥ 5 pts</strong> (open − mark ≥ <strong>5</strong> at 9:15:10) →{" "}
                      <strong>ATM PE</strong> at <strong>9:15:11.000</strong>
                    </li>
                    <li>
                      <strong>Green ≥ 10 pts</strong> (mark − open ≥ <strong>10</strong> at 9:15:10) →{" "}
                      <strong>ATM CE</strong> at <strong>9:15:11.000</strong>
                    </li>
                    <li>
                      <strong>Red &lt; 5 pts</strong> or <strong>green &lt; 10 pts</strong> or flat → no 9:15 trade
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
              <h4 className="nf-live-rules-subheading">Exit (trailing P&amp;L on option WS tick)</h4>
              <ol className="nf-live-rules-list">
                <li>
                  <strong>Trailing take-profit</strong> (% on <strong>capital deployed</strong> = entry premium ×
                  qty, not Nifty index %). On every option LTP websocket tick: first target{" "}
                  <strong>+3%</strong>. Hitting a target does <strong>not</strong> exit — the bot locks a stop floor
                  and raises the next target (e.g. +3% → lock +2% / next +4% → +4% → lock +3% / next +6% … through
                  +50% → lock +30%, then +10% tiers). If P&amp;L falls to the active stop floor,{" "}
                  <strong>immediate market exit</strong>.
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
                9:15 trade is still open. If the 9:15 signal itself qualifies (red ≥ 5 or green ≥ 10 at the
                10-second read), the buy goes out at <strong>9:15:11</strong>. A tick in the second before that
                order is not a missed trade. If that order does not fill, the 9:16 decision still runs.
              </p>
            </div>

            {/* —— 9:16 trade —— */}
            <div className="nf-live-rules-col">
              <h3 className="nf-live-rules-heading">9:16 trade · PE or CE at 9:16:00</h3>
              <p className="nf-live-rules-lead text-muted">
                Second morning leg on the same server bot — 9:15 candle with |Δ| ≥ 15 buys ATM PE when red or ATM
                CE when green at 9:16:00. Exit is <strong>Nifty trailing profit</strong> (no resting take-profit
                limit on Kite). Always armed on the server alongside the 9:15 trade.
              </p>
              <div className="nf-trail-method" aria-label="9:16 trailing profit method">
                <p className="nf-trail-method-title">9:16 trailing profit (live)</p>
                <p className="nf-trail-method-lead text-muted">
                  Measured in <strong>Nifty points from the spot at fill</strong> in the trade&apos;s favour (PE: entry
                  − spot · CE: spot − entry). Checked on every Nifty websocket tick; the stop ratchets only at{" "}
                  <strong>1-minute closes</strong> so a dip inside the touch minute cannot tighten the stop early.
                </p>
                <ol className="nf-trail-method-steps">
                  <li>
                    <strong>1 — Reach the Nifty target</strong> (see below: ±12 / ±8 / ±6 with retargets). The first
                    tick at that level <strong>does not sell</strong> — it <strong>arms the trail</strong>.
                  </li>
                  <li>
                    <strong>2 — Lock the floor</strong> — stop is set to <strong>target − 2 pts</strong> in your favour
                    (12 → 10, 8 → 6, 6 → 4). Example: PE entry 24,000, −12 target touched → initial stop Nifty{" "}
                    <strong>23,990</strong> (+10 pts locked).
                  </li>
                  <li>
                    <strong>3 — Trail on each minute close</strong> — track the best completed 1-minute close since
                    the touch; stop = <strong>best close − 4 pts</strong> (never moves down). Intra-minute prints
                    update the running close but only ratchet the stop when the clock rolls to a new minute.
                  </li>
                  <li>
                    <strong>4 — Market exit</strong> — sell the full leg when any Nifty tick touches or breaches the
                    stop, or at <strong>10:00:00 IST</strong> if still open. No limit sell at any stage.
                  </li>
                </ol>
                <div className="nf-trail-method-table-wrap">
                  <table className="nf-trail-method-table">
                    <thead>
                      <tr>
                        <th scope="col">Target touched</th>
                        <th scope="col">Stop locked at</th>
                        <th scope="col">Then trails</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>12 pts</td>
                        <td>10 pts</td>
                        <td>best 1-min close − 4</td>
                      </tr>
                      <tr>
                        <td>8 pts</td>
                        <td>6 pts</td>
                        <td>best 1-min close − 4</td>
                      </tr>
                      <tr>
                        <td>6 pts</td>
                        <td>4 pts</td>
                        <td>best 1-min close − 4</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="nf-trail-method-note text-muted">
                  Once the trail is armed, only the trail and <strong>3:25 PM</strong> control profit exit —
                  pre-target adverse rules no longer apply. Before
                  the target touches, those guards and the CE 9:17 entry-spot aim still run.
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
              <h4 className="nf-live-rules-subheading">Exit (Nifty trailing profit — no limit sell)</h4>
              <ol className="nf-live-rules-list">
                <li>
                  <strong>Trailing profit</strong> — see the <strong>9:16 trailing profit (live)</strong> box above
                  for the full lock / trail / stop / 10:00 flat sequence. Summary: target touch → lock target − 2 →
                  ratchet stop to best 1-min close − 4 → market sell on the stop.
                </li>
                <li>
                  <strong>No take-profit limit.</strong> Nothing rests on Kite after the 9:16 market entry fills —
                  every exit is a <strong>market sell</strong>.
                </li>
                <li>
                  <strong>25-pt minute spike</strong> — on every Nifty websocket tick from 9:16, each minute is
                  measured from its own first tick. The moment Nifty is <strong>25 points against that open</strong>{" "}
                  (PE: tick ≥ open + 25 · CE: tick ≤ open − 25), <strong>immediate market exit</strong>. The next
                  minute starts the count again from its own first tick.
                </li>
                <li>
                  <strong>Nifty target — arms the trail, does not sell.</strong> Measured from the Nifty spot at
                  fill:
                  <ul className="nf-live-rules-sublist">
                    <li>
                      <strong>PE leg (red 9:15)</strong>
                      <ul className="nf-live-rules-sublist">
                        <li>
                          <strong>9:16:00 open ≤ 9:15:59 close</strong> (both red) → target Nifty ≤{" "}
                          <strong>entry spot − 12</strong>. Any later print <strong>above the 9:15:59 close</strong>{" "}
                          — from the first tick after entry, until the target is touched — moves it to{" "}
                          <strong>entry spot − 8</strong>.
                        </li>
                        <li>
                          <strong>9:16:00 open &gt; 9:15:59 close</strong> (green gap at 9:16) → target Nifty ≤{" "}
                          <strong>entry spot − 8</strong> (until 9:17:00)
                        </li>
                        <li>
                          <strong>Gap open only — 9:16 minute closes green</strong> (9:16:59 close &gt; 9:15:59 close) →
                          from <strong>9:17:00</strong> target Nifty ≤ <strong>entry spot − 6</strong>
                        </li>
                      </ul>
                    </li>
                    <li>
                      <strong>CE leg (green 9:15)</strong>
                      <ul className="nf-live-rules-sublist">
                        <li>
                          <strong>Until 9:17</strong> — 9:16:00 open ≥ 9:15:59 close (both green) → target Nifty ≥{" "}
                          <strong>entry spot + 12</strong>. A print below the 9:15:59 close before 9:17 moves that to{" "}
                          <strong>+8</strong>. A red gap open uses <strong>+8</strong> until 9:17.
                        </li>
                        <li>
                          <strong>From 9:17</strong> — a CE that has not touched its target aims at the{" "}
                          <strong>Nifty entry spot only</strong>: market sell when Nifty is at or above that entry
                          price. +12, +8 and +6 are finished.
                        </li>
                      </ul>
                    </li>
                  </ul>
                  9:15:59 close = last Nifty websocket tick in the 9:15:59 second; 9:16:00 open = first Nifty
                  websocket tick in the 9:16:00 second; 9:16:59 close = last tick in the 9:16:59 second (even a tick
                  slightly below 9:15:59 close counts the 9:16:00 open as red; slightly above counts as green; an
                  exactly equal open counts as the 9:15 colour for that leg).
                </li>
                <li>
                  <strong>No option P&amp;L ladder on 9:16</strong> — profit is the Nifty trail above, not the 9:15
                  style +3% ladder on option LTP.
                </li>
                <li>
                  <strong>Adverse checkpoint + entry return (before trail is armed)</strong> — measured from the
                  Nifty spot at fill; disabled once the trail is armed.
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
                  <strong>How exits fire</strong> — the 25-pt minute spike, trail stop, and pre-trail guards are evaluated on{" "}
                  <strong>every Nifty / option websocket tick</strong>, plus a <strong>1-second safety check</strong>{" "}
                  if the main loop stalls. Triggers send a <strong>parallel market sell</strong> (max 25 lots per
                  order, up to 9 at once); fills are polled every <strong>0.2 s</strong>.
                </li>
              </ol>
            </div>

            <div className="nf-live-rules-col">
              <h3 className="nf-live-rules-heading">14:05 fade · CE or PE at 14:06</h3>
              <p className="nf-live-rules-lead text-muted">
                Separate afternoon leg after the morning session. Exit follows the{" "}
                <strong>Nifty index trail</strong> (not the 9:16 index targets): stop 25, lock once +5, trail 4,
                cap +10, flat 3:20.
              </p>
              <h4 className="nf-live-rules-subheading">Entry (all must pass at 14:05 close)</h4>
              <ol className="nf-live-rules-list">
                <li>
                  Nifty at the <strong>14:05 close</strong> is <strong>≥ 100 points</strong> from the{" "}
                  <strong>9:15 open</strong> (up or down).
                </li>
                <li>
                  Today&apos;s range from 9:15 through 14:05 is <strong>strictly larger</strong> than{" "}
                  <strong>yesterday&apos;s full-day</strong> high–low range.
                </li>
                <li>
                  <strong>Fade the move</strong> — if Nifty is 100+ above the open, buy <strong>ATM PE</strong>; if
                  100+ below, buy <strong>ATM CE</strong>. Entry at the <strong>14:06 open</strong> (websocket tick).
                </li>
                <li>Skipped if the morning bot is still in a trade or the 14:06 window is missed.</li>
              </ol>
              <h4 className="nf-live-rules-subheading">Exit</h4>
              <ol className="nf-live-rules-list">
                <li>
                  <strong>Nifty trail</strong> — same rules as the{" "}
                  <a href="/dashboard/fade-1405-backtest">14:05 backtest page</a> (25 / 5 / 4 / 10).
                </li>
                <li>
                  <strong>3:25 PM</strong> square-off if still open (same as other legs).
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
