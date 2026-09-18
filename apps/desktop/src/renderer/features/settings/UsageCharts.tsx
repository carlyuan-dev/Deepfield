import { useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { UsageServiceKind, UsageTrend, UsageTrendPoint } from "@deepfield/base/usage";

const WIDTH = 720;
const HEIGHT = 320;
const LEFT = 58;
const RIGHT = 14;
const TOP = 14;
const BOTTOM = 38;
const PLOT_WIDTH = WIDTH - LEFT - RIGHT;
const PLOT_HEIGHT = HEIGHT - TOP - BOTTOM;
const TOOLTIP_PADDING = 8;

const numberFormatter = new Intl.NumberFormat("zh-CN");
const compactFormatter = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });

type ChartKind = "requests" | "tokens" | "search";
interface TooltipState { index: number; anchorX: number; left: number }

const formatMetric = (value: number | null): string => value === null ? "未知" : numberFormatter.format(value);
const bucketTitle = (point: UsageTrendPoint, granularity: UsageTrend["granularity"], timeZone: string): string => {
  if (granularity === "day") return point.date.split("-").map((part) => Number(part)).join("-");
  const formatter = new Intl.DateTimeFormat("zh-CN", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${formatter.format(new Date(point.from))}~${formatter.format(new Date(point.to))}`;
};
const tickLabel = (point: UsageTrendPoint, granularity: UsageTrend["granularity"]): string => granularity === "hour" ? point.label.slice(0, 5) : point.label.slice(5);

function niceCeiling(value: number, integer: boolean): number {
  if (value <= 0) return 1;
  if (integer && value <= 4) return Math.max(1, Math.ceil(value));
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = [1, 2, 5, 10].find((candidate) => candidate >= normalized) ?? 10;
  return step * magnitude;
}

function yTicks(maximum: number, integer: boolean): number[] {
  const middle = integer ? Math.round(maximum / 2) : maximum / 2;
  return [...new Set([0, middle, maximum])].sort((a, b) => a - b);
}

function sparseIndices(length: number): number[] {
  if (length <= 4) return Array.from({ length }, (_, index) => index);
  return [...new Set([0, Math.round((length - 1) / 3), Math.round((length - 1) * 2 / 3), length - 1])];
}

function tokenHeight(point: UsageTrendPoint): number {
  return [point.inputCacheHitTokens, point.inputCacheMissTokens, point.inputCacheUnknownTokens, point.outputTokens]
    .reduce<number>((total, value) => total + (value ?? 0), 0);
}

function pointAvailable(point: UsageTrendPoint): boolean {
  return !point.future && point.coverage !== "untracked";
}

function requestSegments(points: UsageTrendPoint[], maximum: number): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  points.forEach((point, index) => {
    if (!pointAvailable(point)) {
      if (current.length > 0) segments.push(current.join(" "));
      current = [];
      return;
    }
    const x = LEFT + (index + 0.5) * PLOT_WIDTH / Math.max(1, points.length);
    const y = TOP + PLOT_HEIGHT - point.requests / maximum * PLOT_HEIGHT;
    current.push(`${x},${y}`);
  });
  if (current.length > 0) segments.push(current.join(" "));
  return segments;
}

function tokenTooltipRows(point: UsageTrendPoint): ReactNode {
  const rows = [
    { className: "usage-token-hit", label: "输入（命中缓存）", value: point.inputCacheHitTokens },
    { className: "usage-token-miss", label: "输入（未命中缓存）", value: point.inputCacheMissTokens },
    { className: "usage-token-output", label: "输出", value: point.outputTokens },
  ];
  if ((point.inputCacheUnknownTokens ?? 0) > 0) {
    rows.push({ className: "usage-token-unknown", label: "输入（未分类）", value: point.inputCacheUnknownTokens });
  }
  return <div className="usage-tooltip-metrics">
    {rows.map((row) => <div className="usage-tooltip-metric-row" key={row.className}>
      <i className={`usage-tooltip-swatch ${row.className}`} />
      <span className="usage-tooltip-label">{row.label}</span>
      <span className="usage-tooltip-value">{formatMetric(row.value)}</span>
    </div>)}
  </div>;
}

function tooltipBody(point: UsageTrendPoint, kind: ChartKind): ReactNode {
  if (point.future) return <span className="usage-tooltip-status">未来时段 · 尚未发生</span>;
  if (point.coverage === "untracked") return <span className="usage-tooltip-status">未统计</span>;
  if (kind !== "tokens") return <span className="usage-tooltip-request">请求 {numberFormatter.format(point.requests)}</span>;
  return tokenTooltipRows(point);
}

function accessiblePointLabel(point: UsageTrendPoint, granularity: UsageTrend["granularity"], kind: ChartKind, timeZone: string): string {
  const title = bucketTitle(point, granularity, timeZone);
  if (point.future) return `${title}：未来时段`;
  if (point.coverage === "untracked") return `${title}：未统计`;
  return kind === "tokens" ? `${title}：Token ${formatMetric(point.totalTokens)}` : `${title}：${point.requests} 次请求`;
}

function ChartCard({ trend, kind, timeZone }: { trend: UsageTrend; kind: ChartKind; timeZone: string }) {
  const [tooltip, setTooltip] = useState<TooltipState>();
  const plotRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const points = trend.points;
  const tooltipPoint = tooltip === undefined ? undefined : points[tooltip.index];
  const rawMaximum = kind === "tokens"
    ? Math.max(0, ...points.filter(pointAvailable).map(tokenHeight))
    : Math.max(0, ...points.filter(pointAvailable).map((point) => point.requests));
  const maximum = niceCeiling(rawMaximum, kind !== "tokens");
  const title = kind === "tokens" ? "Tokens" : kind === "search" ? "Search 请求次数" : "API 请求次数";
  const total = kind === "tokens" ? formatMetric(trend.summary.totalTokens) : numberFormatter.format(trend.summary.requests);
  const ariaLabel = kind === "tokens" ? "LLM Token 趋势" : kind === "search" ? "Search 请求次数趋势" : "LLM 请求次数趋势";
  const showUnknown = trend.summary.inputCacheUnknownTokens !== null || trend.summary.cacheSplitUnknownRequests > 0;
  useLayoutEffect(() => {
    if (!tooltip || !plotRef.current || !tooltipRef.current) return;
    const plotWidth = plotRef.current.getBoundingClientRect().width;
    const tooltipWidth = tooltipRef.current.getBoundingClientRect().width;
    if (plotWidth <= 0 || tooltipWidth <= 0) return;
    const maximumLeft = Math.max(TOOLTIP_PADDING, plotWidth - tooltipWidth - TOOLTIP_PADDING);
    const left = Math.min(maximumLeft, Math.max(TOOLTIP_PADDING, tooltip.anchorX - tooltipWidth / 2));
    setTooltip((current) => current && current.index === tooltip.index && current.anchorX === tooltip.anchorX && current.left !== left
      ? { ...current, left }
      : current);
  }, [tooltip?.anchorX, tooltip?.index, tooltip?.left]);
  useLayoutEffect(() => {
    if (!tooltip || !plotRef.current || !tooltipRef.current || typeof ResizeObserver === "undefined") return;
    const plot = plotRef.current;
    const tooltipElement = tooltipRef.current;
    const initialPlot = plot.getBoundingClientRect();
    const initialTooltip = tooltipElement.getBoundingClientRect();
    const observer = new ResizeObserver(() => {
      const currentPlot = plot.getBoundingClientRect();
      const currentTooltip = tooltipElement.getBoundingClientRect();
      if (currentPlot.width !== initialPlot.width || currentPlot.height !== initialPlot.height
        || currentTooltip.width !== initialTooltip.width || currentTooltip.height !== initialTooltip.height) {
        setTooltip(undefined);
      }
    });
    observer.observe(plot);
    observer.observe(tooltipElement);
    return () => observer.disconnect();
  }, [tooltip?.index]);
  const pointerTooltip = (index: number, event: PointerEvent<SVGRectElement>) => {
    const svgBounds = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    const plotBounds = plotRef.current?.getBoundingClientRect();
    const bounds = plotBounds && plotBounds.width > 0 ? plotBounds : svgBounds;
    const width = bounds?.width ?? 0;
    const ratio = width > 0 ? Math.min(1, Math.max(0, (event.clientX - (bounds?.left ?? 0)) / width)) : (index + 0.5) / Math.max(1, points.length);
    const anchorX = ratio * (width > 0 ? width : WIDTH);
    setTooltip({ index, anchorX, left: anchorX });
  };
  const focusTooltip = (index: number, _event: FocusEvent<SVGRectElement>) => {
    const ratio = (index + 0.5) / Math.max(1, points.length);
    const plotWidth = plotRef.current?.getBoundingClientRect().width ?? 0;
    const anchorX = ratio * (plotWidth > 0 ? plotWidth : WIDTH);
    setTooltip({ index, anchorX, left: anchorX });
  };
  const dismissWithEscape = (event: KeyboardEvent<SVGRectElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      setTooltip(undefined);
    }
  };

  return <section className="usage-chart-card" role="figure" aria-label={ariaLabel}>
    <div className="usage-chart-title"><h3>{title} <span>{total}</span></h3></div>
    {kind === "tokens" && <ul className="usage-token-legend" aria-label="Token 图例">
      <li><i className="usage-token-hit" />缓存命中输入</li>
      <li><i className="usage-token-miss" />未命中输入</li>
      <li><i className="usage-token-output" />输出</li>
      {showUnknown && <li><i className="usage-token-unknown" />未分类输入</li>}
    </ul>}
    <div className="usage-chart-plot" ref={plotRef}>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none">
        <g className="usage-grid-lines">
          {yTicks(maximum, kind !== "tokens").map((value) => {
            const y = TOP + PLOT_HEIGHT - value / maximum * PLOT_HEIGHT;
            return <line key={value} x1={LEFT} x2={WIDTH - RIGHT} y1={y} y2={y} />;
          })}
        </g>
        {kind === "requests" && <g className="usage-request-series" data-series="requests">
          {requestSegments(points, maximum).map((segment, index) => <polyline key={index} points={segment} />)}
          {points.map((point, index) => {
            if (!pointAvailable(point)) return null;
            const x = LEFT + (index + 0.5) * PLOT_WIDTH / Math.max(1, points.length);
            const y = TOP + PLOT_HEIGHT - point.requests / maximum * PLOT_HEIGHT;
            return <circle key={point.from} className="usage-request-marker" cx={x} cy={y} r="3" />;
          })}
        </g>}
        {kind === "search" && <g className="usage-search-series">
          {points.map((point, index) => {
            if (!pointAvailable(point)) return null;
            const columnWidth = PLOT_WIDTH / Math.max(1, points.length);
            const barWidth = Math.min(28, columnWidth * 0.62);
            const height = point.requests / maximum * PLOT_HEIGHT;
            const x = LEFT + (index + 0.5) * columnWidth - barWidth / 2;
            return <rect key={point.from} className="usage-search-fill" data-series="search" x={x} y={TOP + PLOT_HEIGHT - height} width={barWidth} height={height} rx="3" />;
          })}
        </g>}
        {kind === "tokens" && <g className="usage-token-series">
          {points.map((point, index) => {
            if (!pointAvailable(point)) return null;
            const columnWidth = PLOT_WIDTH / Math.max(1, points.length);
            const barWidth = Math.min(30, columnWidth * 0.64);
            const x = LEFT + (index + 0.5) * columnWidth - barWidth / 2;
            let bottom = TOP + PLOT_HEIGHT;
            return <g key={point.from}>{([
              ["usage-token-hit", point.inputCacheHitTokens],
              ["usage-token-miss", point.inputCacheMissTokens],
              ["usage-token-unknown", point.inputCacheUnknownTokens],
              ["usage-token-output", point.outputTokens],
            ] as const).map(([className, value]) => {
              if (value === null) return null;
              const height = value / maximum * PLOT_HEIGHT;
              bottom -= height;
              return <rect key={className} className={className} x={x} y={bottom} width={barWidth} height={height} />;
            })}</g>;
          })}
        </g>}
        <g className="usage-hit-columns">
          {points.map((point, index) => {
            const columnWidth = PLOT_WIDTH / Math.max(1, points.length);
            return <rect
              key={point.from}
              x={LEFT + index * columnWidth}
              y={TOP}
              width={columnWidth}
              height={PLOT_HEIGHT}
              tabIndex={0}
              aria-label={accessiblePointLabel(point, trend.granularity, kind, timeZone)}
              onPointerEnter={(event) => pointerTooltip(index, event)}
              onPointerMove={(event) => pointerTooltip(index, event)}
              onPointerLeave={() => setTooltip(undefined)}
              onFocus={(event) => focusTooltip(index, event)}
              onBlur={() => setTooltip(undefined)}
              onKeyDown={dismissWithEscape}
            />;
          })}
        </g>
      </svg>
      <div className="usage-y-axis-labels" aria-hidden="true">
        {yTicks(maximum, kind !== "tokens").map((value) => {
          const y = TOP + PLOT_HEIGHT - value / maximum * PLOT_HEIGHT;
          return <span key={value} className="usage-axis-label usage-y-axis-label" style={{ top: `${y / HEIGHT * 100}%`, width: `${LEFT / WIDTH * 100}%` }}>{kind === "tokens" ? compactFormatter.format(value) : value}</span>;
        })}
      </div>
      <div className="usage-x-axis-labels" aria-hidden="true">
        {sparseIndices(points.length).map((index) => {
          const point = points[index];
          if (!point) return null;
          const x = LEFT + (index + 0.5) * PLOT_WIDTH / Math.max(1, points.length);
          return <span key={point.from} className="usage-axis-label usage-x-axis-label" style={{ left: `${x / WIDTH * 100}%` }}>{tickLabel(point, trend.granularity)}</span>;
        })}
      </div>
      {tooltip && tooltipPoint && <div ref={tooltipRef} className={`usage-chart-tooltip usage-chart-tooltip-${kind}`} role="tooltip" style={{ left: `${tooltip.left}px`, top: `${TOOLTIP_PADDING}px` }}>
        <div className="usage-tooltip-header">
          <strong>{bucketTitle(tooltipPoint, trend.granularity, timeZone)}</strong>
          {kind === "tokens" && <span>总计 {formatMetric(tooltipPoint.totalTokens)}</span>}
        </div>
        {tooltipBody(tooltipPoint, kind)}
      </div>}
    </div>
  </section>;
}

export function UsageCharts({ trend, serviceKind, timeZone }: { trend: UsageTrend; serviceKind: UsageServiceKind; timeZone: string }) {
  return <section className={`usage-chart-grid ${serviceKind === "search" ? "usage-chart-grid-search" : ""}`} aria-label="所选范围趋势">
    {serviceKind === "llm" ? <>
      <ChartCard trend={trend} kind="requests" timeZone={timeZone} />
      <ChartCard trend={trend} kind="tokens" timeZone={timeZone} />
    </> : <ChartCard trend={trend} kind="search" timeZone={timeZone} />}
  </section>;
}
