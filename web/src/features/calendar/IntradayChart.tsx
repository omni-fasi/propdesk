// Intraday P&L of one trading day: cumulative realized net from closed trades (white step line, green/red
// fill around zero) and — for a single account — equity incl. open positions relative to the day start (gray).

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BaselineSeries,
  LineSeries,
  LineStyle,
  LineType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { EquityPoint, Trade } from '@shared/types';
import { fmtTime } from '@/lib/format';
import { Money } from '@/components/ui/Money';
import { MONEY_PRICE_FORMAT, baseChartOptions, chartPalette, withAlpha } from '../journal/chartTheme';
import { chronological, closeTime } from '../journal/stats';

type Pt = { time: UTCTimestamp; value: number };

/** Strictly increasing seconds; later values in the same second win. */
function pushPoint(out: Pt[], sec: number, value: number) {
  const last = out[out.length - 1];
  if (last && sec <= last.time) {
    if (sec === last.time) last.value = value;
    return;
  }
  out.push({ time: sec as UTCTimestamp, value });
}

export function IntradayChart({ trades, equity, startBalance, height = 190 }: { trades: Trade[]; equity: EquityPoint[] | null; startBalance: number | null; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const apiRef = useRef<{ chart: IChartApi; realized: ISeriesApi<'Baseline'>; equity: ISeriesApi<'Line'> } | null>(null);
  const [hover, setHover] = useState<{ time: number; realized?: number; equity?: number } | null>(null);

  const realized = useMemo(() => {
    const list = chronological(trades);
    const out: Pt[] = [];
    if (list.length === 0) return out;
    const firstOpen = Math.min(...list.map((t) => t.openedAt));
    const eqStart = equity?.length ? equity[0].ts : Infinity;
    pushPoint(out, Math.floor(Math.min(firstOpen, eqStart) / 1000), 0);
    let cum = 0;
    for (const t of list) {
      cum += t.netPnl;
      pushPoint(out, Math.max(Math.floor(closeTime(t) / 1000), out[out.length - 1].time + 1), Math.round(cum * 100) / 100);
    }
    return out;
  }, [trades, equity]);

  const equityLine = useMemo(() => {
    const out: Pt[] = [];
    if (!equity || startBalance == null) return out;
    for (const p of [...equity].sort((a, b) => a.ts - b.ts)) pushPoint(out, Math.floor(p.ts / 1000), Math.round((p.equity - startBalance) * 100) / 100);
    return out;
  }, [equity, startBalance]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const c = chartPalette();
    const chart = createChart(el, baseChartOptions('intraday'));
    const eq = chart.addSeries(LineSeries, {
      color: c.lineMuted,
      lineWidth: 1,
      priceFormat: MONEY_PRICE_FORMAT,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    const rz = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: 0 },
      topLineColor: c.line,
      bottomLineColor: c.line,
      topFillColor1: withAlpha(c.profit, 0.22),
      topFillColor2: withAlpha(c.profit, 0.03),
      bottomFillColor1: withAlpha(c.loss, 0.03),
      bottomFillColor2: withAlpha(c.loss, 0.22),
      lineWidth: 2,
      lineType: LineType.WithSteps,
      priceFormat: MONEY_PRICE_FORMAT,
      priceLineVisible: false,
      crosshairMarkerBorderColor: '#0b0b0b',
      crosshairMarkerBackgroundColor: c.line,
    });
    rz.createPriceLine({ price: 0, color: c.zero, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: false, title: '' });
    const onMove = (p: MouseEventParams<Time>) => {
      if (p.time == null || typeof p.time !== 'number') return setHover(null);
      const r = p.seriesData.get(rz) as { value?: number } | undefined;
      const e = p.seriesData.get(eq) as { value?: number } | undefined;
      setHover({ time: p.time, realized: r?.value, equity: e?.value });
    };
    chart.subscribeCrosshairMove(onMove);
    apiRef.current = { chart, realized: rz, equity: eq };
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      apiRef.current = null;
      chart.remove();
    };
  }, []);

  useEffect(() => {
    const a = apiRef.current;
    if (!a) return;
    a.realized.setData(realized);
    a.equity.setData(equityLine);
    a.chart.timeScale().fitContent();
  }, [realized, equityLine]);

  const hasEquity = equityLine.length > 1;
  const empty = realized.length === 0 && !hasEquity;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-4 items-center justify-between gap-3 text-2xs text-faint">
        <span className="tnum flex items-center gap-2">
          {hover ? (
            <>
              <span>{fmtTime(hover.time * 1000, { seconds: false })}</span>
              {hover.realized != null && (
                <span>
                  realized <Money value={hover.realized} sign colored />
                </span>
              )}
              {hover.equity != null && (
                <span>
                  incl. open <Money value={hover.equity} sign colored />
                </span>
              )}
            </>
          ) : (
            <span>Local time</span>
          )}
        </span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="h-0.5 w-3 bg-fg" />
            Realized (closed trades)
          </span>
          {hasEquity && (
            <span className="flex items-center gap-1">
              <span className="h-px w-3 bg-faint" />
              Incl. open positions
            </span>
          )}
        </span>
      </div>
      <div className="relative" style={{ height }}>
        <div ref={ref} className="absolute inset-0" />
        {empty && <div className="absolute inset-0 flex items-center justify-center text-xs text-faint">No closed trades this day</div>}
      </div>
    </div>
  );
}
