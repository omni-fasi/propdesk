// Candle chart of a trade's window with its fills as markers, the initial stop (red) and avg entry/exit lines.

import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  CrosshairMode,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type AutoscaleInfo,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle, Fill, InstrumentSpec, Timeframe, Trade } from '@shared/types';
import { TIMEFRAMES, TIMEFRAME_SECONDS } from '@shared/types';
import { fmtPrice, fmtQty } from '@/lib/format';
import { api, errorMessage } from '@/api/client';
import { Spinner } from '@/components/ui/Misc';
import { baseChartOptions, chartPalette, type ChartTimeMode } from './chartTheme';
import { closeTime } from './stats';

/** Bar size that shows the whole hold time with ~10–80 bars. */
export function pickTimeframe(holdMs: number): Timeframe {
  const min = holdMs / 60_000;
  if (min <= 45) return '1m';
  if (min <= 4 * 60) return '5m';
  if (min <= 12 * 60) return '15m';
  if (min <= 3 * 1440) return '1h';
  if (min <= 14 * 1440) return '4h';
  return '1d';
}

function windowFor(trade: Trade, tf: Timeframe) {
  const tfSec = TIMEFRAME_SECONDS[tf];
  const openSec = Math.floor(trade.openedAt / 1000);
  const closeSec = Math.ceil(closeTime(trade) / 1000);
  const holdBars = Math.max(1, Math.ceil((closeSec - openSec) / tfSec));
  const pad = Math.max(30, Math.round(holdBars * 0.6));
  const nowSec = Math.floor(Date.now() / 1000);
  return { openSec, closeSec, tfSec, end: Math.min(nowSec + tfSec, closeSec + pad * tfSec), limit: Math.min(1500, holdBars + pad * 2 + 2) };
}

/** Fetch candles around the trade; falls back to coarser bars when fine history is no longer available. */
async function loadCandles(trade: Trade): Promise<{ tf: Timeframe; candles: Candle[] }> {
  const first = pickTimeframe(closeTime(trade) - trade.openedAt);
  for (let i = TIMEFRAMES.indexOf(first), tries = 0; i < TIMEFRAMES.length && tries < 3; i++, tries++) {
    const tf = TIMEFRAMES[i];
    const w = windowFor(trade, tf);
    const raw = await api.candles(trade.symbol, tf, { end: w.end, limit: w.limit });
    const candles = [...raw].sort((a, b) => a.time - b.time).filter((c, j, arr) => j === 0 || c.time !== arr[j - 1].time);
    if (candles.some((c) => c.time <= w.closeSec && c.time + w.tfSec >= w.openSec)) return { tf, candles };
  }
  return { tf: first, candles: [] };
}

/** Open time of the bar containing `sec` (nearest bar when outside the loaded range). */
function barTimeFor(times: number[], sec: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (sec <= times[0]) return times[0];
  if (sec >= times[hi]) return times[hi];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= sec) lo = mid;
    else hi = mid - 1;
  }
  return times[lo];
}

const modeFor = (tf: Timeframe): ChartTimeMode => (tf === '1d' ? 'daily' : TIMEFRAME_SECONDS[tf] >= 3600 ? 'multiday' : 'intraday');

interface ChartApi {
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  markers: ISeriesMarkersPluginApi<Time>;
  lines: IPriceLine[];
}

export interface TradeChartProps {
  trade: Trade;
  /** The trade's fills (null while loading). */
  fills: Fill[] | null;
  spec: InstrumentSpec | undefined;
  height?: number;
}

export function TradeChart({ trade, fills, spec, height = 300 }: TradeChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<ChartApi | null>(null);
  const extraPrices = useRef<number[]>([]);
  const [data, setData] = useState<{ tf: Timeframe; candles: Candle[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<CandlestickData<Time> | null>(null);

  // Chart instance: created once per mount, disposed on unmount (StrictMode-safe).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const p = chartPalette();
    const base = baseChartOptions('intraday');
    const chart = createChart(el, { ...base, crosshair: { ...base.crosshair, mode: CrosshairMode.Normal } });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: p.profit,
      downColor: p.loss,
      wickUpColor: p.profit,
      wickDownColor: p.loss,
      borderVisible: false,
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: (baseImpl: () => AutoscaleInfo | null): AutoscaleInfo | null => {
        const r = baseImpl();
        const extra = extraPrices.current;
        if (!r || !r.priceRange || extra.length === 0) return r;
        return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...extra), maxValue: Math.max(r.priceRange.maxValue, ...extra) } };
      },
    });
    const markers = createSeriesMarkers(series, [], { autoScale: true });
    const onMove = (param: MouseEventParams<Time>) => {
      const bar = param.seriesData.get(series) as CandlestickData<Time> | undefined;
      setHover(bar && 'open' in bar ? bar : null);
    };
    chart.subscribeCrosshairMove(onMove);
    apiRef.current = { chart, series, markers, lines: [] };
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      apiRef.current = null;
      chart.remove();
    };
  }, []);

  // Candles for this trade.
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    loadCandles(trade)
      .then((r) => !cancelled && setData(r))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trade.id, trade.symbol, trade.openedAt, trade.closedAt]);

  // Push candles, lines and markers into the chart.
  useEffect(() => {
    const a = apiRef.current;
    if (!a || !data) return;
    const p = chartPalette();
    const base = baseChartOptions(modeFor(data.tf));
    a.chart.applyOptions({ timeScale: base.timeScale, localization: base.localization });
    if (spec) a.series.applyOptions({ priceFormat: { type: 'price', precision: spec.pricePrecision, minMove: spec.tickSize } });
    a.series.setData(data.candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));

    for (const l of a.lines) a.series.removePriceLine(l);
    a.lines = [];
    const line = (price: number | null, color: string, style: LineStyle, title: string) => {
      if (price == null || !Number.isFinite(price)) return;
      a.lines.push(a.series.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    };
    line(trade.initialStop, p.loss, LineStyle.Solid, 'Initial stop');
    line(trade.avgExit, p.lineMuted, LineStyle.Dashed, 'Avg exit');
    line(trade.avgEntry, p.line, LineStyle.Dashed, 'Avg entry');
    extraPrices.current = [trade.avgEntry, trade.avgExit, trade.initialStop].filter((x): x is number => x != null && Number.isFinite(x));

    const times = data.candles.map((c) => c.time);
    const ms: SeriesMarker<Time>[] =
      times.length && fills
        ? [...fills]
            .sort((x, y) => x.ts - y.ts)
            .map((f): SeriesMarker<Time> => {
              const buy = f.side === 'buy';
              return {
                time: barTimeFor(times, Math.floor(f.ts / 1000)) as UTCTimestamp,
                position: buy ? 'atPriceBottom' : 'atPriceTop',
                price: f.price,
                shape: buy ? 'arrowUp' : 'arrowDown',
                color: buy ? p.profit : p.loss,
                text: `${buy ? 'B' : 'S'} ${spec ? fmtQty(spec, f.qty) : f.qty}`,
              };
            })
            .sort((x, y) => (x.time as number) - (y.time as number))
        : [];
    a.markers.setMarkers(ms);
    a.chart.timeScale().fitContent();
  }, [data, fills, spec, trade]);

  const empty = data != null && data.candles.length === 0;
  const fmt = (v: number) => (spec ? fmtPrice(spec, v) : v.toFixed(2));

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-4 items-center justify-between gap-3 text-2xs text-faint">
        <span className="tnum">
          {hover ? (
            <>
              O <span className="text-muted">{fmt(hover.open)}</span> H <span className="text-muted">{fmt(hover.high)}</span> L <span className="text-muted">{fmt(hover.low)}</span> C{' '}
              <span className="text-muted">{fmt(hover.close)}</span>
            </>
          ) : (
            <>{trade.symbol} · {data ? `${data.tf} bars · local time` : 'loading bars…'}</>
          )}
        </span>
        <span className="flex items-center gap-3">
          <Key color="bg-fg" dashed label="Avg entry" />
          {trade.initialStop != null && <Key color="bg-loss" label="Initial stop" />}
          <span className="flex items-center gap-1">
            <span className="text-profit">▲</span>buy <span className="text-loss">▼</span>sell
          </span>
        </span>
      </div>
      <div className="relative rounded-md border border-line bg-bg" style={{ height }}>
        <div ref={containerRef} className="absolute inset-0" />
        {!data && !error && (
          <div className="absolute inset-0 flex items-center justify-center text-faint">
            <Spinner size={16} />
          </div>
        )}
        {(error || empty) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-bg/80 text-center">
            <div className="text-sm text-muted">{error ? 'Couldn’t load the price history' : 'No price history for this period'}</div>
            <div className="max-w-xs text-xs text-faint">{error ?? 'The data provider no longer serves bars this old at this resolution.'}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function Key({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1">
      <span className={dashed ? 'flex w-3 justify-between' : 'w-3'}>
        {dashed ? (
          <>
            <span className={`h-px w-1 ${color}`} />
            <span className={`h-px w-1 ${color}`} />
          </>
        ) : (
          <span className={`block h-px w-3 ${color}`} />
        )}
      </span>
      {label}
    </span>
  );
}
