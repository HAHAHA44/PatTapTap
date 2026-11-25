import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import { JudgeWindows, TraceHit } from "../core/types";

const MIN_SPAN = 1000; // ms: the most you can zoom in on the time axis

/**
 * Timing offset over the session. One series (hits) in the accent color; misses
 * are a separate red lane with an × marker and strays a gray lane, so grade is
 * never carried by color alone (the shaded bands + y-position carry it).
 * Time axis zooms with the wheel / buttons and pans by dragging.
 */
export default function OffsetChart({
  trace,
  movingAvg,
  windows,
  labels,
  strict,
}: {
  strict: boolean;
  trace: TraceHit[];
  movingAvg: [number, number][];
  windows: JudgeWindows;
  labels: string[];
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(560);
  const [hover, setHover] = useState<TraceHit | null>(null);

  const H = 260;
  const M = { l: 44, r: 64, t: 26, b: 34 };
  const LANE = 14; // miss lane above, stray lane below the plot
  const plotTop = M.t + LANE;
  const plotBot = H - M.b - LANE;
  const plotW = width - M.l - M.r;
  const tMax = Math.max(1000, ...trace.map((x) => x.t));

  const [dom, setDom] = useState<[number, number]>([0, tMax]);
  const domRef = useRef(dom);
  domRef.current = dom;
  useEffect(() => setDom([0, tMax]), [tMax]);
  const zoomed = dom[0] > 0 || dom[1] < tMax;

  /** Clamp a domain into [0, tMax] keeping its span within [MIN_SPAN, tMax]. */
  const clampDom = (a: number, b: number): [number, number] => {
    const full = tMax;
    let span = Math.min(full, Math.max(Math.min(MIN_SPAN, full), b - a));
    let s = a;
    if (s < 0) s = 0;
    if (s + span > full) s = full - span;
    return [s, s + span];
  };
  const zoomAround = (centerT: number, factor: number) => {
    const [a, b] = domRef.current;
    const span = (b - a) * factor;
    const k = (centerT - a) / (b - a);
    setDom(clampDom(centerT - k * span, centerT - k * span + span));
  };

  const x = (t: number) => M.l + ((t - dom[0]) / (dom[1] - dom[0])) * plotW;
  const y = (off: number) => {
    const c = Math.max(-windows.good, Math.min(windows.good, off));
    return plotTop + ((windows.good - c) / (2 * windows.good)) * (plotBot - plotTop);
  };
  const missY = M.t + LANE / 2;
  const strayY = H - M.b - LANE / 2;
  const yOf = (h: TraceHit) => (h.g === "stray" ? strayY : h.off === null ? missY : y(h.off));

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Wheel zoom needs a non-passive native listener to stop the page from scrolling.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left;
      if (px < M.l || px > width - M.r) return;
      e.preventDefault();
      const [a, b] = domRef.current;
      const t = a + ((px - M.l) / plotW) * (b - a);
      zoomAround(t, Math.exp(e.deltaY * 0.002));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  // Drag to pan.
  const drag = useRef<{ px: number; dom: [number, number] } | null>(null);
  const [dragging, setDragging] = useState(false);
  const onDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0 || !zoomed) return;
    drag.current = { px: e.clientX, dom: dom };
    setDragging(true);
  };
  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const dt = ((e.clientX - d.px) / plotW) * (d.dom[1] - d.dom[0]);
      setDom(clampDom(d.dom[0] - dt, d.dom[1] - dt));
    };
    const up = () => {
      drag.current = null;
      setDragging(false);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [dragging, plotW]);

  const xTicks = useMemo(() => {
    const span = (dom[1] - dom[0]) / 1000;
    const step = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => span / s <= 6) ?? 1200;
    const out: number[] = [];
    for (let s = Math.ceil(dom[0] / 1000 / step) * step; s <= dom[1] / 1000 + 1e-9; s += step) out.push(+s.toFixed(2));
    return out;
  }, [dom]);

  const inView = (t: number) => t >= dom[0] && t <= dom[1];
  const visible = trace.filter((h) => inView(h.t));
  const hits = visible.filter((h) => h.off !== null);
  // include one point beyond each edge so the line runs to the clip edge
  const maPts = movingAvg.filter(([t], i, arr) => inView(t) || (arr[i + 1] && inView(arr[i + 1][0])) || (arr[i - 1] && inView(arr[i - 1][0])));
  const maPath = maPts.map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join("");

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (dragging) return setHover(null);
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    let best: TraceHit | null = null;
    let bd = 400; // px², hit target larger than the mark
    for (const h of visible) {
      const d = (x(h.t) - px) ** 2 + (yOf(h) - py) ** 2;
      if (d < bd) {
        bd = d;
        best = h;
      }
    }
    setHover(best);
  };

  const gradeName: Record<string, string> = { perfect: "Perfect", great: "Great", good: "Good", miss: "Miss", stray: t("grade.stray") };
  const hx = hover ? x(hover.t) : 0;
  const hy = hover ? yOf(hover) : 0;
  const fmtS = (ms: number) => (ms / 1000).toFixed(ms < 10000 ? 1 : 0);
  const clipId = "plot-clip";

  return (
    <div className="chart" ref={wrap}>
      <div className="chart-bar">
        <div className="chart-legend">
          <span><i className="lg-dot" /> {t("chart.legendHit")}</span>
          <span><i className="lg-line" /> {t("chart.legendMa")}</span>
          <span><i className="lg-x">×</i> Miss</span>
          <span><i className="lg-tick" /> {t("grade.stray")}</span>
        </div>
        <div className="zoom-ctl">
          <button title={t("chart.zoomIn")} onClick={() => zoomAround((dom[0] + dom[1]) / 2, 0.5)} disabled={dom[1] - dom[0] <= Math.min(MIN_SPAN, tMax) + 1}>
            ＋
          </button>
          <button title={t("chart.zoomOut")} onClick={() => zoomAround((dom[0] + dom[1]) / 2, 2)} disabled={!zoomed}>
            －
          </button>
          <button onClick={() => setDom([0, tMax])} disabled={!zoomed}>
            {t("chart.reset")}
          </button>
        </div>
      </div>
      <svg
        ref={svgRef}
        width={width}
        height={H}
        className={zoomed ? (dragging ? "grabbing" : "grab") : ""}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onDoubleClick={() => setDom([0, tMax])}
        role="img"
        aria-label={t("detail.chartTitle")}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={M.l} y={M.t - 6} width={plotW} height={H - M.t - M.b + 12} />
          </clipPath>
        </defs>
        {/* judge bands, widest first */}
        {(["good", "great", "perfect"] as const).map((k) => (
          <rect key={k} className={`band ${k}`} x={M.l} width={plotW} y={y(windows[k])} height={y(-windows[k]) - y(windows[k])} />
        ))}
        {(["perfect", "great", "good"] as const).map((k) => (
          <text key={k} className="band-label" x={width - M.r + 6} y={y(windows[k]) + 4}>
            {gradeName[k]} ±{windows[k]}
          </text>
        ))}
        <line className="zero" x1={M.l} x2={width - M.r} y1={y(0)} y2={y(0)} />
        {[-windows.good, -windows.good / 2, 0, windows.good / 2, windows.good].map((v) => (
          <text key={v} className="axis" x={M.l - 6} y={y(v) + 4} textAnchor="end">
            {v > 0 ? "+" : ""}
            {Math.round(v)}
          </text>
        ))}
        <text className="axis" x={M.l - 6} y={missY + 4} textAnchor="end">Miss</text>
        <text className="axis" x={M.l - 6} y={strayY + 4} textAnchor="end">{t("grade.stray")}</text>
        <text className="axis" x={M.l} y={14}>{t("chart.late")}</text>
        <text className="axis" x={M.l} y={H - 4}>{t("chart.early")}</text>
        <text className="axis" x={width - M.r} y={H - 4} textAnchor="end">
          {zoomed ? t("chart.range", { a: fmtS(dom[0]), b: fmtS(dom[1]) }) : ""}
        </text>
        {xTicks.map((s) => (
          <text key={s} className="axis" x={x(s * 1000)} y={H - M.b + 14} textAnchor="middle">
            {s}
          </text>
        ))}

        <g clipPath={`url(#${clipId})`}>
          {hits.map((h, i) => (
            <circle key={i} className="pt" cx={x(h.t)} cy={y(h.off!)} r={zoomed ? 3.5 : 2.5} />
          ))}
          {maPath && <path className="ma" d={maPath} />}
          {visible
            .filter((h) => h.g === "miss")
            .map((h, i) => (
              <text key={i} className="miss-x" x={x(h.t)} y={missY + 4} textAnchor="middle">
                ×
              </text>
            ))}
          {visible
            .filter((h) => h.g === "stray")
            .map((h, i) => (
              <line key={i} className="stray" x1={x(h.t)} x2={x(h.t)} y1={strayY - 4} y2={strayY + 4} />
            ))}
          {hover && (
            <>
              <line className="crosshair" x1={hx} x2={hx} y1={M.t} y2={H - M.b} />
              <circle className="hover-ring" cx={hx} cy={hy} r={5} />
            </>
          )}
        </g>
      </svg>
      {hover && (
        <div className="tooltip" style={{ left: Math.min(hx + 12, width - 170), top: Math.max(30, hy + 20) }}>
          <div>
            <b>{gradeName[hover.g]}</b>
            {hover.wrong ? t("chart.wrongKey") : ""}
          </div>
          <div>{t("chart.sec", { s: (hover.t / 1000).toFixed(2) })}</div>
          {hover.off !== null && (
            <div>
              {hover.off > 0
                ? t("chart.lateBy", { ms: hover.off })
                : hover.off < 0
                  ? t("chart.earlyBy", { ms: -hover.off })
                  : t("chart.exact", { ms: 0 })}
            </div>
          )}
          {hover.n >= 0 && <div>{labels[hover.n]}</div>}
          {hover.k !== undefined && <div>{t("chart.pressed", { key: hover.k === 0 ? t("key.1") : t("key.2") })}</div>}
          {strict && hover.h !== undefined && (hover.wrong || hover.g === "miss") && <div>{t("chart.expected", { key: hover.h === 0 ? t("key.1") : t("key.2") })}</div>}
        </div>
      )}
    </div>
  );
}
