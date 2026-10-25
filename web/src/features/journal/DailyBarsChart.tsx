// Net P&L per trading day as green / red columns around a zero line.

import { useEffect, useMemo, useRef, useState } from 'react';
import { HistogramSeries, LineStyle, createChart, type IChartApi, type ISeriesApi, type MouseEventParams, type Time } from 'lightweight-charts';
import { fmtDayKey } from '@/lib/format';
import { Money } from '@/components/ui/Money';
import { MONEY_PRICE_FORMAT, baseChartOptions, chartPalette, timeKey } from './chartTheme';
import type { DayNet } from './stats';

export function DailyBarsChart({ days, height = 260 }: { days: readonly DayNet[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const apiRef = useRef<{ chart: IChartApi; series: ISeriesApi<'Histogram'> } | null>(null);
  const byDay = useMemo(() => new Map(days.map((d) => [d.day, d])), [days]);
  const byDayRef = useRef(byDay);
  byDayRef.current = byDay;
  const [hover, setHover] = useState<DayNet | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const c = chartPalette();
    const base = baseChartOptions('daily');
    const chart = createChart(el, { ...base, timeScale: { ...base.timeScale, maxBarSpacing: 30, minBarSpacing: 2 } });
    const series = chart.addSeries(HistogramSeries, { base: 0, priceFormat: MONEY_PRICE_FORMAT, priceLineVisible: false, lastValueVisible: false });
    series.createPriceLine({ price: 0, color: c.zero, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: false, title: '' });
    const onMove = (p: MouseEventParams<Time>) => {
      const k = p.time != null ? timeKey(p.time) : null;
      setHover(typeof k === 'string' ? (byDayRef.current.get(k) ?? null) : null);
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
    const c = chartPalette();
    a.series.setData(days.map((d) => ({ time: d.day as Time, value: d.net, color: d.net >= 0 ? c.profit : c.loss })));
    a.chart.timeScale().fitContent();
  }, [days]);

  const green = days.filter((d) => d.net > 0.005).length;
  const red = days.filter((d) => d.net < -0.005).length;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-5 items-center gap-3 text-xs text-muted">
        {hover ? (
          <>
            <span className="text-faint">{fmtDayKey(hover.day, { year: true })}</span>
            <Money value={hover.net} sign colored className="font-medium" />
            <span className="tnum text-faint">
              {hover.trades} trade{hover.trades === 1 ? '' : 's'} · {hover.wins}W {hover.losses}L
            </span>
          </>
        ) : (
          <span className="tnum text-faint">
            {days.length} trading day{days.length === 1 ? '' : 's'} · <span className="text-profit">{green} green</span> · <span className="text-loss">{red} red</span>
          </span>
        )}
      </div>
      <div ref={ref} style={{ height }} />
    </div>
  );
}
