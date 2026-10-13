import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { NineFifteenMinuteTickSeries } from "@/types/nine-fifteen-minute-ticks";

const VB_W = 1000;
const VB_H = 440;
const PAD = { l: 84, r: 20, t: 16, b: 58 };

function formatPts(price: number): string {
  return price.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function clockLabel(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  const hour = String(Number(pick("hour")) % 24).padStart(2, "0");
  return `${hour}:${pick("minute")}:${pick("second")}.000`;
}

function yTicks(min: number, max: number): number[] {
  const count = 5;
  if (!(max > min)) return [min];
  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, i) => max - step * i);
}

export function NineFifteenMinuteTickChart() {
  const selectId = useId();
  const frameRef = useRef<HTMLDivElement>(null);
  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState("");
  const [series, setSeries] = useState<NineFifteenMinuteTickSeries | null>(null);
  const [datesError, setDatesError] = useState<string | null>(null);
  const [seriesError, setSeriesError] = useState<string | null>(null);
  const [loadingDates, setLoadingDates] = useState(true);
  const [loadingSeries, setLoadingSeries] = useState(false);
  const [frameWidth, setFrameWidth] = useState(960);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const node = frameRef.current;
    if (!node) return;
    const update = () => setFrameWidth(node.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadingDates, loadingSeries, series]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoadingDates(true);
      setDatesError(null);
      try {
        const res = await fetch("/api/nine-fifteen/ws-minute-ticks/dates", { credentials: "include" });
        const json = (await res.json()) as { dates?: string[]; error?: string };
        if (!res.ok) throw new Error(json.error ?? "Could not list saved 9:15 minutes");
        if (cancelled) return;
        const next = json.dates ?? [];
        setDates(next);
        setDate((current) => current || next[0] || "");
      } catch (err) {
        if (!cancelled) setDatesError(err instanceof Error ? err.message : "Could not list saved 9:15 minutes");
      } finally {
        if (!cancelled) setLoadingDates(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadSeries = useCallback(async (day: string) => {
    setLoadingSeries(true);
    setSeriesError(null);
    setHover(null);
    try {
      const res = await fetch(`/api/nine-fifteen/ws-minute-ticks?date=${encodeURIComponent(day)}`, {
        credentials: "include",
      });
      const json = (await res.json()) as { data?: NineFifteenMinuteTickSeries; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not load 9:15 ticks");
      if (!json.data) throw new Error("Empty tick response");
      setSeries(json.data);
    } catch (err) {
      setSeries(null);
      setSeriesError(err instanceof Error ? err.message : "Could not load 9:15 ticks");
    } finally {
      setLoadingSeries(false);
    }
  }, []);

  useEffect(() => {
    if (!date) return;
    void loadSeries(date);
  }, [date, loadSeries]);

  const plot = useMemo(() => layoutSeries(series, frameWidth), [series, frameWidth]);
  const active = hover != null && series ? series.ticks[hover] : null;

  return (
    <section className="card nf915bt-tick-card" aria-labelledby="nf915-tick-chart-title">
      <div className="nf915bt-tick-head">
        <div>
          <h2 id="nf915-tick-chart-title" className="nf915bt-tick-title">
            9:15 minute websocket
          </h2>
          <p className="nf915bt-section-subtitle">
            Every Nifty tick saved for that minute. The vertical axis is the index. The horizontal
            axis is the time each tick was received, to the millisecond. The saved record does not
            include microseconds.
          </p>
        </div>
        <label className="nf915bt-tick-date" htmlFor={selectId}>
          <span className="nf915bt-filter-label text-muted">Session</span>
          <select
            id={selectId}
            className="select"
            value={date}
            disabled={loadingDates || dates.length === 0}
            onChange={(event) => setDate(event.target.value)}
          >
            {dates.length === 0 ? <option value="">No saved minutes</option> : null}
            {dates.map((day) => (
              <option key={day} value={day}>
                {day}
              </option>
            ))}
          </select>
        </label>
      </div>

      {datesError ? <p className="nf915bt-tick-error">{datesError}</p> : null}
      {seriesError ? <p className="nf915bt-tick-error">{seriesError}</p> : null}

      {!loadingSeries && series && series.tickCount > 0 ? (
        <dl className="nf915bt-tick-stats">
          <div>
            <dt>Ticks</dt>
            <dd>{series.tickCount.toLocaleString("en-IN")}</dd>
          </div>
          <div>
            <dt>Open</dt>
            <dd>{series.open != null ? formatPts(series.open) : "—"}</dd>
          </div>
          <div>
            <dt>High</dt>
            <dd>{series.high != null ? formatPts(series.high) : "—"}</dd>
          </div>
          <div>
            <dt>Low</dt>
            <dd>{series.low != null ? formatPts(series.low) : "—"}</dd>
          </div>
          <div>
            <dt>Close</dt>
            <dd>{series.close != null ? formatPts(series.close) : "—"}</dd>
          </div>
          <div>
            <dt>First tick</dt>
            <dd>{series.firstTimeIST ?? "—"}</dd>
          </div>
          <div>
            <dt>Last tick</dt>
            <dd>{series.lastTimeIST ?? "—"}</dd>
          </div>
        </dl>
      ) : null}

      <div className="nf915bt-tick-frame" ref={frameRef}>
        {loadingDates || loadingSeries ? (
          <div className="nf915bt-tick-empty">
            <div className="spinner" />
            <p>{loadingDates ? "Looking up saved 9:15 minutes…" : `Loading ${date}…`}</p>
          </div>
        ) : !date ? (
          <div className="nf915bt-tick-empty">
            <p>
              No 9:15 websocket minute is saved yet. Minutes appear after the morning archive, and
              from the last 10 sessions kept on this server.
            </p>
          </div>
        ) : series && series.tickCount === 0 ? (
          <div className="nf915bt-tick-empty">
            <p>No Nifty ticks were saved for the 9:15 minute on {date}.</p>
          </div>
        ) : plot && series ? (
          <TickSvg series={series} plot={plot} hover={hover} onHover={setHover} />
        ) : null}
      </div>

      <p className="nf915bt-tick-readout" aria-live="polite">
        {active ? (
          <>
            <strong>{active.timeIST}</strong>
            <span>Nifty {formatPts(active.price)}</span>
            <span>
              tick {hover != null ? hover + 1 : ""} of {series?.tickCount}
            </span>
            {active.exchangeTimeIST ? <span>exchange {active.exchangeTimeIST}</span> : null}
          </>
        ) : !loadingSeries && series && series.tickCount > 0 ? (
          <span>Move across the line to read each tick’s exact time and Nifty price.</span>
        ) : null}
      </p>
    </section>
  );
}

interface PlotLayout {
  points: string;
  coords: { x: number; y: number }[];
  yMin: number;
  yMax: number;
  yLevels: number[];
  xLabels: { x: number; text: string; anchor: "start" | "middle" | "end" }[];
  plotW: number;
  plotH: number;
}

function layoutSeries(series: NineFifteenMinuteTickSeries | null, frameWidth: number): PlotLayout | null {
  if (!series || series.tickCount === 0) return null;
  const plotW = VB_W - PAD.l - PAD.r;
  const plotH = VB_H - PAD.t - PAD.b;
  const low = series.low ?? series.ticks[0].price;
  const high = series.high ?? low;
  const pad = Math.max((high - low) * 0.12, 0.5);
  const yMin = low - pad;
  const yMax = high + pad;
  const ySpan = yMax - yMin || 1;
  const xSpan = series.windowEndMs - series.windowStartMs || 1;

  const coords = series.ticks.map((tick) => ({
    x: PAD.l + ((tick.epochMs - series.windowStartMs) / xSpan) * plotW,
    y: PAD.t + ((yMax - tick.price) / ySpan) * plotH,
  }));

  const stepMs = frameWidth < 720 ? 20_000 : 10_000;
  const xLabels: PlotLayout["xLabels"] = [];
  for (let at = series.windowStartMs; at <= series.windowEndMs; at += stepMs) {
    const x = PAD.l + ((at - series.windowStartMs) / xSpan) * plotW;
    const anchor = at === series.windowStartMs ? "start" : at + stepMs > series.windowEndMs ? "end" : "middle";
    xLabels.push({ x, text: clockLabel(at), anchor });
  }

  return {
    points: coords.map((coord) => `${coord.x.toFixed(2)},${coord.y.toFixed(2)}`).join(" "),
    coords,
    yMin,
    yMax,
    yLevels: yTicks(yMin, yMax),
    xLabels,
    plotW,
    plotH,
  };
}

function TickSvg({
  series,
  plot,
  hover,
  onHover,
}: {
  series: NineFifteenMinuteTickSeries;
  plot: PlotLayout;
  hover: number | null;
  onHover: (index: number | null) => void;
}) {
  const nearest = (clientX: number, svg: SVGSVGElement) => {
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = 0;
    const matrix = svg.getScreenCTM();
    if (!matrix) return;
    const local = point.matrixTransform(matrix.inverse());
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < plot.coords.length; i += 1) {
      const dist = Math.abs(plot.coords[i].x - local.x);
      if (dist < bestDist) {
        best = i;
        bestDist = dist;
      }
    }
    onHover(best);
  };

  const active = hover != null ? series.ticks[hover] : null;
  const activeCoord = hover != null ? plot.coords[hover] : null;

  return (
    <svg
      className="nf915bt-tick-svg"
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      role="img"
      aria-label={`Nifty websocket ticks for ${series.dateIST}, ${series.tickCount} prints from ${series.firstTimeIST} to ${series.lastTimeIST}`}
      onPointerMove={(event) => nearest(event.clientX, event.currentTarget)}
      onPointerLeave={() => onHover(null)}
    >
      {plot.yLevels.map((level) => {
        const y = PAD.t + ((plot.yMax - level) / (plot.yMax - plot.yMin || 1)) * plot.plotH;
        return (
          <g key={level}>
            <line className="nf915bt-tick-grid" x1={PAD.l} x2={VB_W - PAD.r} y1={y} y2={y} />
            <text className="nf915bt-tick-label" x={PAD.l - 8} y={y + 4} textAnchor="end">
              {formatPts(level)}
            </text>
          </g>
        );
      })}
      {plot.xLabels.map((label) => (
        <text
          key={`${label.x}-${label.text}`}
          className="nf915bt-tick-label"
          x={label.x}
          y={VB_H - 18}
          textAnchor={label.anchor}
        >
          {label.text}
        </text>
      ))}
      <polyline className="nf915bt-tick-line" points={plot.points} />
      {plot.coords.map((coord, index) => (
        <circle
          key={`${series.ticks[index].epochMs}-${series.ticks[index].seq}`}
          className={index === hover ? "nf915bt-tick-dot is-active" : "nf915bt-tick-dot"}
          cx={coord.x}
          cy={coord.y}
          r={index === hover ? 5 : 2.4}
        />
      ))}
      {active && activeCoord ? (
        <g>
          <line
            className="nf915bt-tick-cross"
            x1={activeCoord.x}
            x2={activeCoord.x}
            y1={PAD.t}
            y2={PAD.t + plot.plotH}
          />
          <rect
            className="nf915bt-tick-hover-bg"
            x={activeCoord.x > VB_W - 240 ? activeCoord.x - 228 : activeCoord.x + 6}
            y={PAD.t + 2}
            width={220}
            height={20}
            rx={4}
          />
          <text
            className="nf915bt-tick-hover-label"
            x={activeCoord.x > VB_W - 240 ? activeCoord.x - 14 : activeCoord.x + 14}
            y={PAD.t + 16}
            textAnchor={activeCoord.x > VB_W - 240 ? "end" : "start"}
          >
            {active.timeIST} · {formatPts(active.price)}
          </text>
        </g>
      ) : null}
    </svg>
  );
}
