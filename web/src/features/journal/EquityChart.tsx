// Cumulative net P&L by close time: white line, zero baseline, green fill above / red fill below zero.

import { useEffect, useMemo, useRef, useState } from 'react';
import { BaselineSeries, LineStyle, createChart, type IChartApi, type ISeriesApi, type MouseEventParams, type Time, type UTCTimestamp } from 'lightweight-charts';
import { fmtDateTime, fmtMoney } from '@/lib/format';
import { Money } from '@/components/ui/Money';
import { MONEY_PRICE_FORMAT, baseChartOptions, chartPalette, withAlpha } from './chartTheme';
import { directionLabel } from './labels';
import type { CurvePoint } from './stats';

interface Prepared {
  data: Array<{ time: UTCTimestamp; value: number }>;
  /** null = the zero origin point. */
  byTime: Map<number, CurvePoint | null>;
}

/** Series data with strictly increasing seconds: an origin at 0, trades closing in the same second merged. */
function prepare(points: readonly CurvePoint[]): Prepared {
  const data: Prepared['data'] = [];
  const byTime: Prepared['byTime'] = new Map();
  if (points.length === 0) return { data, byTime };
  const firstSec = Math.floor(points[0].ts / 1000);
  const origin = Math.min(Math.floor(points[0].trade.openedAt / 1000), firstSec - 1);
  data.push({ time: origin as UTCTimestamp, value: 0 });
  byTime.set(origin, null);
  let last = origin;
  for (const p of points) {
    let sec = Math.floor(p.ts / 1000);
    if (sec === last && data.length > 1) {
      data[data.length - 1] = { time: last as UTCTimestamp, value: p.cum };
      byTime.set(last, p);
      continue;
    }
    if (sec <= last) sec = last + 1;
    data.push({ time: sec as UTCTimestamp, value: p.cum });
    byTime.set(sec, p);
    last = sec;
  }
  return { data, byTime };
}

export function EquityChart({ points, maxDrawdown, height = 260 }: { points: readonly CurvePoint[]; maxDrawdown: number; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const apiRef = useRef<{ chart: IChartApi; series: ISeriesApi<'Baseline'> } | null>(null);
  const prepared = useMemo(() => prepare(points), [points]);
  const byTimeRef = useRef(prepared.byTime);
  byTimeRef.current = prepared.byTime;
  const [hover, setHover] = useState<CurvePoint | null | undefined>(undefined);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const c = chartPalette();
    const chart = createChart(el, baseChartOptions('multiday'));
    const series = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: 0 },
      topLineColor: c.line,
      bottomLineColor: c.line,
      topFillColor1: withAlpha(c.profit, 0.22),
      topFillColor2: withAlpha(c.profit, 0.03),
      bottomFillColor1: withAlpha(c.loss, 0.03),
      bottomFillColor2: withAlpha(c.loss, 0.22),
      lineWidth: 2,
      priceFormat: MONEY_PRICE_FORMAT,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: '#0b0b0b',
      crosshairMarkerBackgroundColor: c.line,
    });
    series.createPriceLine({ price: 0, color: c.zero, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: false, title: '' });
    const onMove = (p: MouseEventParams<Time>) => {
      setHover(p.time != null && typeof p.time === 'number' ? byTimeRef.current.get(p.time) : undefined);
    };
    chart.subscribeCrosshairMove(onMove);
    apiRef.current = { chart, series };
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      apiRef.current = null;
      chart.remove();
    };
  }, []);

  useEffect(() => {
    const a = apiRef.current;
    if (!a) return;
    a.series.setData(prepared.data);
    a.chart.timeScale().fitContent();
  }, [prepared]);

  const last = points[points.length - 1];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-5 items-center gap-3 text-xs text-muted">
        {hover ? (
          <>
            <span className="tnum text-faint">{fmtDateTime(hover.ts)}</span>
            <span className="font-medium text-fg">
              {hover.trade.symbol} {directionLabel(hover.trade)}
            </span>
            <Money value={hover.trade.netPnl} sign colored />
            <span className="text-faint">cumulative</span>
            <Money value={hover.cum} sign colored className="font-medium" />
            {hover.drawdown > 0.005 && <span className="tnum text-faint">{fmtMoney(-hover.drawdown)} from peak</span>}
          </>
        ) : hover === null ? (
          <span className="text-faint">Start of period · $0.00</span>
        ) : last ? (
          <>
            <span className="text-faint">After {points.length} trades</span>
            <Money value={last.cum} sign colored className="font-medium" />
            <span className="text-faint">· max drawdown</span>
            <span className="tnum text-fg">{fmtMoney(-maxDrawdown)}</span>
          </>
        ) : null}
      </div>
      <div ref={ref} style={{ height }} />
    </div>
  );
}
