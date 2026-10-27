import { useMemo, useState } from "react";
import { Target } from "lucide-react";
import { cn, formatNumber } from "@/lib/utils";
import type {
  NineFifteenHighMinus5BacktestSlice,
  NineFifteenHighMinus5Outcome,
  NineFifteenHighMinus5Trade,
} from "@/types/nine-fifteen-high-minus5-backtest";

type OutcomeFilter = "all" | NineFifteenHighMinus5Outcome;

function outcomeLabel(
  outcome: NineFifteenHighMinus5Outcome,
  signalMinute = "9:15",
  sameDirection = false,
): string {
  switch (outcome) {
    case "win":
      return sameDirection ? "Win" : `Win (in ${signalMinute})`;
    case "late_win":
      return "Late win";
    case "loss":
      return "Loss";
    case "no_entry":
      return "No entry";
  }
}

function outcomeClass(outcome: NineFifteenHighMinus5Outcome): string {
  switch (outcome) {
    case "win":
      return "nf915bt-outcome-win";
    case "late_win":
      return "nf915bt-outcome-late";
    case "loss":
      return "nf915bt-outcome-loss";
    case "no_entry":
      return "nf915bt-outcome-skip";
  }
}

function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="card nf915bt-stat">
      <p className="nf915bt-stat-label">{label}</p>
      <p className={cn("nf915bt-stat-value", tone)}>{value}</p>
      {hint && <p className="nf915bt-stat-hint">{hint}</p>}
    </div>
  );
}

function TradeRow({
  trade,
  signalMinute,
  sameDirection = false,
}: {
  trade: NineFifteenHighMinus5Trade;
  signalMinute: string;
  sameDirection?: boolean;
}) {
  return (
    <tr>
      <td>{trade.date}</td>
      <td>{trade.weekday}</td>
      <td>{formatNumber(trade.open915, 2)}</td>
      <td>{formatNumber(trade.close915, 2)}</td>
      <td>{formatNumber(trade.entryLevel, 2)}</td>
      <td>{formatNumber(trade.tpLevel, 2)}</td>
      <td>{trade.entryTimeIst ?? "—"}</td>
      <td>{trade.tpTimeIst ?? "—"}</td>
      <td>
        <span className={cn("nf915bt-outcome-pill", outcomeClass(trade.outcome))}>
          {outcomeLabel(trade.outcome, signalMinute, sameDirection)}
        </span>
      </td>
    </tr>
  );
}

function sessionLabels(slice: NineFifteenHighMinus5BacktestSlice) {
  return {
    signalMinute: slice.rules.signalMinuteLabel ?? "9:15",
    instrument: slice.rules.instrumentLabel ?? "Nifty",
    lateWinAfter: slice.rules.lateWinAfterIst ?? "9:16:00",
  };
}

function accordionMeta(slice: NineFifteenHighMinus5BacktestSlice): string {
  const { signalMinute } = sessionLabels(slice);
  const entered = slice.stats.wins + slice.stats.lateWins + slice.stats.losses;
  if (slice.rules.sameDirection15) {
    return [
      `${slice.stats.wins} win`,
      `${slice.stats.losses} loss`,
      `${slice.stats.noEntry} no entry`,
      `${slice.stats.winRatePct}% TP (${entered} entered)`,
    ].join(" · ");
  }
  const parts = [
    `${slice.stats.wins} in ${signalMinute}`,
    `${slice.stats.lateWins} late`,
    `${slice.stats.losses} loss`,
  ];
  if (slice.rules.variant === "limit_open_minus_5" && slice.stats.noEntry > 0) {
    parts.push(`${slice.stats.noEntry} no entry`);
  }
  if (slice.rules.variant === "limit_open_plus_5" && slice.stats.noEntry > 0) {
    parts.push(`${slice.stats.noEntry} no entry`);
  }
  parts.push(`${slice.stats.winRatePct}% TP (${entered} entered)`);
  return parts.join(" · ");
}

function RulesList({
  slice,
  builtAt,
  rangeLabel,
  subtitle,
}: {
  slice: NineFifteenHighMinus5BacktestSlice;
  builtAt: string;
  rangeLabel: string;
  subtitle?: string;
}) {
  const { signalMinute, instrument, lateWinAfter } = sessionLabels(slice);
  const isMarketAtOpen = slice.rules.variant === "market_at_open";
  const isPlusEntry = slice.rules.variant === "limit_open_plus_5";
  const entrySign = isPlusEntry ? "+" : "−";
  const tpSign = isPlusEntry ? "+" : "−";
  const touchSide = isPlusEntry ? "high" : "low";

  return (
    <section className="nf915bt-rules card">
      <h3>Rules</h3>
      {subtitle && <p className="nf915bt-section-subtitle">{subtitle}</p>}
      {slice.rules.sameDirection15 ? (
        <ul>
          <li>
            <strong>Both down</strong> — today’s 9:15 open is below yesterday’s close, and the 9:15 candle
            itself closed at least 15 points lower. Buy PE.
          </li>
          <li>
            <strong>Both up</strong> — today’s 9:15 open is above yesterday’s close, and the 9:15 candle
            itself closed at least 15 points higher. Buy CE.
          </li>
          <li>
            <strong>Skip</strong> — the gap and the 9:15 candle point opposite ways, or the candle moved
            under 15 points.
          </li>
          <li>
            <strong>Entry</strong> — the 9:15 close. A 1-minute candle has no 9:15:10 tick, so the candle
            body stands in for that 10-second read, and the close stands in for the 9:15:11 price.
          </li>
          <li>
            <strong>Take profit</strong> — 15 Nifty points from that close. PE further down, CE further up.
            Checked from 9:16 through 15:30.
          </li>
          <li>
            <strong>Win</strong> — the 15-point target prints. <strong>Loss</strong> — it never does.
          </li>
        </ul>
      ) : (
      <ul>
        {slice.rules.red915Only && (
          <li>
            <strong>Red {signalMinute} only</strong> — trade only when the opening minute closes below its
            open (green/flat days skipped).
          </li>
        )}
        {slice.rules.green915Only && (
          <li>
            <strong>Green {signalMinute} only</strong> — trade only when the opening minute closes above its
            open (red/flat days skipped).
          </li>
        )}
        {isMarketAtOpen ? (
          <>
            <li>
              <strong>Entry</strong> — market fill at the {signalMinute} candle open (every session).
            </li>
            <li>
              <strong>Take profit</strong> — {slice.rules.tpOffsetFromEntry} pts below the {signalMinute}{" "}
              open ({instrument} points).
            </li>
          </>
        ) : (
          <>
            <li>
              <strong>Entry</strong> — limit fill when session {touchSide} touches {signalMinute} candle open{" "}
              {entrySign} {slice.rules.entryOffsetFromOpen} pts.
            </li>
            <li>
              <strong>Take profit</strong> — {slice.rules.tpOffsetFromEntry} pts {tpSign === "+" ? "above" : "below"} the
              entry fill ({instrument} points).
            </li>
            <li>
              <strong>No entry</strong> — price never reached open {entrySign}{" "}
              {slice.rules.entryOffsetFromOpen} that day.
            </li>
          </>
        )}
        <li>
          <strong>Win</strong> — TP touched before {slice.rules.winWindowEndIst} (still inside the{" "}
          {signalMinute} minute).
        </li>
        <li>
          <strong>Late win</strong> — entry filled but TP first touched after {lateWinAfter} (exact time in
          the table).
        </li>
        <li>
          <strong>Loss</strong> — entry filled, TP never touched through {slice.rules.scanEndIst}.
        </li>
      </ul>
      )}
      <p className="nf915bt-muted">
        {rangeLabel} · {slice.stats.sessions} sessions
        {slice.stats.excludedSessions != null && slice.stats.excludedSessions > 0
          ? slice.rules.green915Only
            ? ` · ${slice.stats.excludedSessions} red/flat skipped`
            : ` · ${slice.stats.excludedSessions} green/flat skipped`
          : ""}
        {" · built "}
        {new Date(builtAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
      </p>
    </section>
  );
}

function BacktestSectionBody({
  slice,
  builtAt,
  rangeLabel,
  subtitle,
}: {
  slice: NineFifteenHighMinus5BacktestSlice;
  builtAt: string;
  rangeLabel: string;
  subtitle?: string;
}) {
  const { signalMinute, lateWinAfter } = sessionLabels(slice);
  const [filter, setFilter] = useState<OutcomeFilter>("all");
  const entered = slice.stats.wins + slice.stats.lateWins + slice.stats.losses;
  const showNoEntry =
    slice.rules.sameDirection15 ||
    slice.rules.variant === "limit_open_minus_5" ||
    slice.rules.variant === "limit_open_plus_5";

  const filterOptions = useMemo(() => {
    const keys: OutcomeFilter[] = ["all", "win", "late_win", "loss"];
    if (showNoEntry) keys.push("no_entry");
    return keys;
  }, [showNoEntry]);

  const filtered = useMemo(() => {
    if (filter === "all") return slice.trades;
    return slice.trades.filter((t) => t.outcome === filter);
  }, [filter, slice.trades]);

  return (
    <>
      <RulesList slice={slice} builtAt={builtAt} rangeLabel={rangeLabel} subtitle={subtitle} />

      <section className="nf915bt-stat-grid">
        <StatCard
          label={slice.rules.sameDirection15 ? "Win" : `Win (in ${signalMinute})`}
          value={String(slice.stats.wins)}
          hint={
            slice.rules.sameDirection15
              ? `15-pt target hit · ${slice.stats.winRatePct}% of ${entered} entered`
              : `${slice.stats.inMinuteWinPct}% of ${entered} entered`
          }
          tone="text-up"
        />
        {!slice.rules.sameDirection15 && (
        <StatCard
          label="Late win"
          value={String(slice.stats.lateWins)}
          hint={`TP after ${lateWinAfter} — time in table`}
          tone="nf915bt-tone-late"
        />
        )}
        <StatCard
          label="Loss"
          value={String(slice.stats.losses)}
          hint="Entered, TP never hit"
          tone="text-down"
        />
        {showNoEntry && (
          <StatCard
            label="No entry"
            value={String(slice.stats.noEntry)}
            hint={slice.rules.sameDirection15 ? "Gap and the 9:15 candle did not both qualify" : `Open ${slice.rules.variant === "limit_open_plus_5" ? "+" : "−"} ${slice.rules.entryOffsetFromOpen} never touched`}
          />
        )}
        <StatCard
          label="TP hit rate"
          value={`${slice.stats.winRatePct}%`}
          hint={`${slice.stats.wins + slice.stats.lateWins} / ${entered} entered`}
        />
      </section>

      <section className="card nf915bt-table-section">
        <div className="nf915bt-table-toolbar">
          <h3>
            <Target size={16} /> Session log
          </h3>
          <div className="nf915bt-filters">
            {filterOptions.map((key) => (
              <button
                key={key}
                type="button"
                className={cn("btn btn-sm", filter === key ? "btn-primary" : "btn-ghost")}
                onClick={() => setFilter(key)}
              >
                {key === "all" ? "All" : outcomeLabel(key as NineFifteenHighMinus5Outcome, signalMinute, slice.rules.sameDirection15)}
              </button>
            ))}
          </div>
        </div>
        <div className="nf915bt-table-wrap">
          <table className="nf915bt-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Day</th>
                <th>{signalMinute} open</th>
                <th>{signalMinute} close</th>
                <th>Entry</th>
                <th>TP</th>
                <th>Entry time</th>
                <th>TP time</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="nf915bt-empty">
                    No trades in this filter.
                  </td>
                </tr>
              ) : (
                filtered.map((trade) => (
                  <TradeRow
                    key={trade.date}
                    trade={trade}
                    signalMinute={signalMinute}
                    sameDirection={slice.rules.sameDirection15}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export interface BacktestSectionProps {
  slice: NineFifteenHighMinus5BacktestSlice;
  builtAt: string;
  rangeLabel: string;
  subtitle?: string;
  defaultOpen?: boolean;
}

export function BacktestSection({
  slice,
  builtAt,
  rangeLabel,
  subtitle,
  defaultOpen = false,
}: BacktestSectionProps) {
  return (
    <details className="nf915bt-accordion" open={defaultOpen}>
      <summary className="nf915bt-accordion-summary">
        <span className="nf915bt-accordion-title">{slice.label}</span>
        <span className="nf915bt-accordion-meta">{accordionMeta(slice)}</span>
      </summary>
      <div className="nf915bt-accordion-body">
        <BacktestSectionBody
          slice={slice}
          builtAt={builtAt}
          rangeLabel={rangeLabel}
          subtitle={subtitle}
        />
      </div>
    </details>
  );
}
