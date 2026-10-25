// Trade replay: plays a trade back on a chart — the price, the entry / exit fills, the stop and target as they
// were at each moment, and the P&L as it moved — at 1–120× speed, with a scrubber, entry / exit jumps and keys.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Pause, Play, RotateCcw } from 'lucide-react';
import {
  CandlestickSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { TradeReplay } from '@shared/api';
import type { Candle, Fill, InstrumentSpec, Trade } from '@shared/types';
import {
  REPLAY_RESOLUTIONS,
  REPLAY_SPEEDS,
  barTimeOf,
  bracketAt,
  defaultResolution,
  defaultSpeed,
  indexAtOrBefore,
  midOf,
  openPnlAt,
  openPnlRange,
  positionAt,
  pushSample,
  replayBars,
  replayPath,
} from '@shared/replay';
import { api, errorMessage } from '@/api/client';
import { useApp } from '@/store/app';
import { fmtDate, fmtDuration, fmtMoney, fmtPrice, fmtQty, fmtTime, pnlTone } from '@/lib/format';
import { playSound } from '@/lib/sounds';
import { Button, IconButton } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Misc';
import { Segmented } from '@/components/ui/Tabs';
import { baseChartOptions, chartPalette } from './chartTheme';

export function TradeReplayModal({ trade, onClose }: { trade: Trade; onClose: () => void }) {
  const spec = useApp((s) => s.instrumentMap[trade.symbol]);
  const account = useApp((s) => s.accounts[trade.accountId]);
  const [data, setData] = useState<TradeReplay | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .tradeReplay(trade.id)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [trade.id]);

  const closed = trade.closedAt;
  return (
    <Modal
      open
      onClose={onClose}
      size="full"
      title={
        <span className="flex items-center gap-2">
          Replay · {trade.symbol}
          <span className={clsx('text-sm font-medium', trade.direction === 'long' ? 'text-profit' : 'text-loss')}>{trade.direction === 'long' ? 'Long' : 'Short'}</span>
        </span>
      }
      description={
        <span className="tnum">
          {account ? `${account.name} · ` : ''}
          {fmtDate(trade.openedAt, { weekday: true })} · {fmtTime(trade.openedAt)}
          {closed != null && (
            <>
              {' '}
              → {fmtTime(closed)} · held {fmtDuration(closed - trade.openedAt)} · result{' '}
              <span className={pnlTone(trade.netPnl)}>{fmtMoney(trade.netPnl, { sign: true })}</span>
            </>
          )}
        </span>
      }
    >
      {error ? (
        <div className="flex h-[min(56vh,560px)] flex-col items-center justify-center gap-1 text-center">
          <div className="text-sm text-muted">Couldn’t load this replay</div>
          <div className="max-w-sm text-xs text-faint">{error}</div>
        </div>
      ) : !data || !spec ? (
        <div className="flex h-[min(56vh,560px)] flex-col items-center justify-center gap-2 text-xs text-faint">
          <Spinner size={18} />
          Loading the prices around this trade…
        </div>
      ) : (
        <ReplayPlayer data={data} spec={spec} />
      )}
    </Modal>
  );
}

interface ChartRefs {
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  markers: ISeriesMarkersPluginApi<Time>;
  lines: Partial<Record<'sl' | 'tp' | 'avg', { line: IPriceLine; price: number }>>;
}

/** What the chart currently shows. */
interface Shown {
  at: number;
  /** Last path sample applied. */
  idx: number;
  bars: Candle[];
  markers: number;
  /** The visible range has been set to the whole replay window (needs at least one bar). */
  framed: boolean;
  /** Worst / best open P&L so far. */
  worst: number;
  best: number;
}

const toBar = (c: Candle) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close });

const RES_LABEL: Record<number, string> = { 5: '5s', 15: '15s', 30: '30s', 60: '1m', 300: '5m' };

/** m:ss, or h:mm:ss from an hour. */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const SOURCE_NOTE: Record<TradeReplay['source'], string> = {
  recorded: 'Bid / ask recorded live by PropDesk while you were in the trade.',
  exchange: 'Rebuilt from the exchange’s trade history (PropDesk wasn’t recording prices yet when you took this trade).',
  bars: 'Only 1-minute bars exist for this trade, so moves inside each minute are approximate.',
};

function ReplayPlayer({ data, spec }: { data: TradeReplay; spec: InstrumentSpec }) {
  const { trade, fills, brackets, from, to } = data;
  const path = useMemo(() => replayPath(data.ticks, data.bars, from, to, fills.map((f) => f.ts)), [data.ticks, data.bars, from, to, fills]);
  const barsOnly = data.source === 'bars';
  const [res, setRes] = useState(() => defaultResolution(to - from, barsOnly));
  const [speed, setSpeed] = useState(() => defaultSpeed(to - from));
  const [playing, setPlaying] = useState(false);
  const [cursor, setCursor] = useState(from);
  const cursorRef = useRef(from);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ChartRefs | null>(null);
  const shown = useRef<Shown>({ at: -Infinity, idx: -1, bars: [], markers: -1, framed: false, worst: 0, best: 0 });
  const lastView = useRef(0);

  // Fixed price scale over everything the replay will show, so it doesn't jump while playing.
  const range = useRef<{ minValue: number; maxValue: number } | null>(null);
  range.current = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of path) {
      lo = Math.min(lo, midOf(s));
      hi = Math.max(hi, midOf(s));
    }
    for (const f of fills) {
      lo = Math.min(lo, f.price);
      hi = Math.max(hi, f.price);
    }
    for (const b of brackets)
      for (const p of [b.sl, b.tp])
        if (p != null) {
          lo = Math.min(lo, p);
          hi = Math.max(hi, p);
        }
    if (!Number.isFinite(lo)) return null;
    const pad = Math.max((hi - lo) * 0.06, spec.tickSize * 4);
    return { minValue: lo - pad, maxValue: hi + pad };
  }, [path, fills, brackets, spec.tickSize]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const p = chartPalette();
    const base = baseChartOptions('intraday');
    const chart = createChart(el, {
      ...base,
      timeScale: { ...base.timeScale, secondsVisible: true, shiftVisibleRangeOnNewBar: false, rightOffset: 2 },
      localization: { ...base.localization, timeFormatter: (t: Time) => fmtTime((t as number) * 1000) },
      // Unlike the journal charts, the player is the whole view: the wheel zooms and scrolls it.
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: p.profit,
      downColor: p.loss,
      wickUpColor: p.profit,
      wickDownColor: p.loss,
      borderVisible: false,
      priceFormat: { type: 'price', precision: spec.pricePrecision, minMove: spec.tickSize },
      autoscaleInfoProvider: () => (range.current ? { priceRange: range.current } : null),
    });
    chartRef.current = { chart, series, markers: createSeriesMarkers(series, []), lines: {} };
    shown.current.at = -Infinity;
    return () => {
      chartRef.current = null;
      chart.remove();
    };
  }, [spec]);

  /** Draw the replay at time t: incrementally when moving forward, rebuilt when going back or asked to. */
  const render = useCallback(
    (t: number, rebuild: boolean) => {
      const c = chartRef.current;
      if (!c) return;
      const s = shown.current;
      if (rebuild || t < s.at) {
        s.bars = replayBars(path, res, t);
        s.idx = indexAtOrBefore(path, t);
        c.series.setData(s.bars.map(toBar));
        ({ worst: s.worst, best: s.best } = openPnlRange(path, fills, spec, t));
        s.markers = -1;
        s.framed = false;
      } else {
        const touched: Candle[] = [];
        let i = s.idx + 1;
        for (; i < path.length && path[i][0] <= t; i++) {
          const bar = pushSample(s.bars, path[i], res);
          if (touched[touched.length - 1] !== bar) touched.push(bar);
          const pos = positionAt(fills, path[i][0]);
          if (pos.qty !== 0) {
            const pnl = openPnlAt(spec, pos, path[i]);
            s.worst = Math.min(s.worst, pnl);
            s.best = Math.max(s.best, pnl);
          }
        }
        s.idx = i - 1;
        for (const b of touched) c.series.update(toBar(b));
      }
      s.at = t;
      // Show the whole window from the start: bars fill it from left to right as the replay plays.
      if (!s.framed && s.bars.length) {
        c.chart.timeScale().setVisibleLogicalRange({ from: -1, to: Math.ceil((to - from) / 1000 / res) + 2 });
        s.framed = true;
      }

      const pal = chartPalette();
      const pos = positionAt(fills, t);
      if (pos.fills !== s.markers) {
        s.markers = pos.fills;
        c.markers.setMarkers(
          fills.slice(0, pos.fills).map((f): SeriesMarker<Time> => {
            const buy = f.side === 'buy';
            return {
              time: barTimeOf(f.ts, res) as UTCTimestamp,
              position: buy ? 'atPriceBottom' : 'atPriceTop',
              price: f.price,
              shape: buy ? 'arrowUp' : 'arrowDown',
              color: buy ? pal.profit : pal.loss,
              text: `${buy ? 'Buy' : 'Sell'} ${fmtQty(spec, f.qty)} @ ${fmtPrice(spec, f.price)}`,
            };
          }),
        );
      }
      const b = pos.qty !== 0 ? bracketAt(brackets, t) : null;
      const setLine = (key: 'sl' | 'tp' | 'avg', price: number | null, color: string, title: string, style: LineStyle) => {
        const cur = c.lines[key];
        if (price == null) {
          if (cur) c.series.removePriceLine(cur.line);
          delete c.lines[key];
        } else if (!cur) {
          c.lines[key] = { line: c.series.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }), price };
        } else if (cur.price !== price) {
          cur.line.applyOptions({ price });
          cur.price = price;
        }
      };
      setLine('avg', pos.qty !== 0 ? pos.avg : null, pal.line, 'Entry', LineStyle.Dashed);
      setLine('sl', b?.sl ?? null, pal.loss, 'Stop', LineStyle.Solid);
      setLine('tp', b?.tp ?? null, pal.profit, 'Target', LineStyle.Solid);
    },
    [path, res, fills, brackets, spec, from, to],
  );

  // Bar size or data changed: redraw at the current position.
  useEffect(() => render(cursorRef.current, true), [render]);

  /** Move the replay to t. While playing, fills passed on the way play their sound. */
  const step = useCallback(
    (t: number, live: boolean) => {
      const prev = cursorRef.current;
      const next = Math.max(from, Math.min(to, t));
      render(next, false);
      if (live) {
        if (fills.some((f) => f.ts > prev && f.ts <= next)) playSound('fill');
      }
      cursorRef.current = next;
      const now = performance.now();
      if (!live || next >= to || now - lastView.current > 66) {
        lastView.current = now;
        setCursor(next);
      }
    },
    [render, fills, from, to],
  );

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(now - last, 250);
      last = now;
      step(cursorRef.current + dt * speed, true);
      if (cursorRef.current >= to) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, step, to]);

  const toggle = useCallback(() => {
    if (!playing && cursorRef.current >= to) step(from, false);
    setPlaying((p) => !p);
  }, [playing, step, from, to]);

  // Start playing as soon as it opens.
  useEffect(() => setPlaying(true), []);

  useEffect(() => {
    // Capture phase + stopPropagation: these keys belong to the player while it is open.
    const onKey = (e: KeyboardEvent) => {
      const down = e.type === 'keydown';
      if (e.key === ' ') {
        if (down && !e.repeat) toggle();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (down) step(cursorRef.current + (e.shiftKey ? 60_000 : 10_000) * (e.key === 'ArrowLeft' ? -1 : 1), false);
      } else if (e.key === 'Home' || e.key === 'End') {
        if (down) step(e.key === 'Home' ? from : to, false);
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
    };
  }, [toggle, step, from, to]);

  // ── what happens at the cursor ──
  const pos = positionAt(fills, cursor);
  const si = indexAtOrBefore(path, cursor);
  const open = si >= 0 ? openPnlAt(spec, pos, path[si]) : 0;
  const gross = pos.realized + open;
  const net = gross - pos.fees;
  const entryAt = fills[0]?.ts ?? trade.openedAt;
  const exitAt = trade.closedAt ?? to;
  const inTrade = pos.qty !== 0;
  const phase = cursor < entryAt ? `Entry in ${clock(entryAt - cursor)}` : inTrade || cursor < exitAt ? `In the trade · ${clock(cursor - entryAt)}` : `Closed ${clock(cursor - exitAt)} ago`;
  const span = to - from;
  const jump = (t: number) => step(Math.max(from, t - Math.min(15_000, span / 20)), false);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[auto_1fr_auto] items-end gap-6 rounded-lg border border-line bg-panel-2 px-4 py-2.5">
        <div>
          <div className="tnum text-xl font-semibold tracking-tight text-fg">{fmtTime(cursor)}</div>
          <div className="tnum text-xs text-muted">{phase}</div>
        </div>
        <div className="min-w-0 text-sm">
          {inTrade ? (
            <span className="tnum">
              <span className={clsx('font-semibold', pos.qty > 0 ? 'text-profit' : 'text-loss')}>{pos.qty > 0 ? 'LONG' : 'SHORT'}</span> {fmtQty(spec, Math.abs(pos.qty))} {spec.unitLabel} @{' '}
              {fmtPrice(spec, pos.avg)}
            </span>
          ) : (
            <span className="text-muted">{pos.fills ? 'Flat — trade closed' : 'Flat — waiting for the entry'}</span>
          )}
          <div className="tnum text-xs text-faint">
            Worst <span className={shown.current.worst < 0 ? 'text-loss' : undefined}>{fmtMoney(shown.current.worst)}</span> · Best{' '}
            <span className={shown.current.best > 0 ? 'text-profit' : undefined}>{fmtMoney(shown.current.best, { sign: shown.current.best > 0 })}</span>
          </div>
        </div>
        <div className="text-right">
          <div className={clsx('tnum text-2xl font-semibold tracking-tight', pos.fills ? pnlTone(net) : 'text-faint')}>{fmtMoney(net, { sign: true })}</div>
          <div className="tnum text-xs text-faint">
            {pos.fees > 0.005 ? `${fmtMoney(gross, { sign: true })} − ${fmtMoney(pos.fees)} fees` : inTrade ? 'open P&L' : 'P&L'}
          </div>
        </div>
      </div>

      <div className="relative h-[min(52vh,520px)] rounded-md border border-line bg-bg">
        <div ref={containerRef} className="absolute inset-0" />
      </div>

      <div className="flex flex-col gap-2">
        <div className="relative px-1.5">
          <input
            type="range"
            aria-label="Replay position"
            min={from}
            max={to}
            step={250}
            value={cursor}
            onChange={(e) => step(Number(e.target.value), false)}
            onKeyDown={(e) => e.preventDefault()}
            className="w-full cursor-pointer"
            style={{ accentColor: 'var(--color-fg)' }}
          />
          {fills.map((f) => (
            <span
              key={f.id}
              title={`${f.side === 'buy' ? 'Buy' : 'Sell'} ${fmtTime(f.ts)}`}
              className={clsx('pointer-events-none absolute -top-0.5 h-1.5 w-0.5 rounded-full', f.side === 'buy' ? 'bg-profit' : 'bg-loss')}
              style={{ left: `calc(6px + (100% - 12px) * ${(f.ts - from) / span})` }}
            />
          ))}
          <div className="tnum flex justify-between text-2xs text-faint">
            <span>{fmtTime(from)}</span>
            <span>{fmtTime(to)}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <IconButton label="Restart (Home)" icon={<RotateCcw size={15} />} onClick={() => step(from, false)} />
          <Button variant="primary" size="sm" className="w-24" icon={playing ? <Pause size={14} /> : <Play size={14} />} onClick={toggle} title="Play / pause (Space)">
            {playing ? 'Pause' : cursor >= to ? 'Replay' : 'Play'}
          </Button>
          <Segmented
            value={String(speed)}
            onChange={(v) => setSpeed(Number(v))}
            options={REPLAY_SPEEDS.map((s) => ({ value: String(s), label: `${s}×` }))}
          />
          <span className="mx-1 h-5 w-px bg-line" />
          <Button size="sm" variant="ghost" onClick={() => jump(entryAt)}>
            Entry
          </Button>
          <Button size="sm" variant="ghost" onClick={() => jump(exitAt)} disabled={trade.closedAt == null}>
            Exit
          </Button>
          <span className="ml-auto text-2xs text-faint">Bars</span>
          <Segmented
            value={String(res)}
            onChange={(v) => setRes(Number(v))}
            options={REPLAY_RESOLUTIONS.map((r) => ({
              value: String(r),
              label: RES_LABEL[r],
              disabled: barsOnly && r < 60,
              title: barsOnly && r < 60 ? 'Only 1-minute bars exist for this trade' : undefined,
            }))}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-2xs text-faint">
          <span>
            {SOURCE_NOTE[data.source]}
            {!data.bracketsRecorded && ' Stop / target moves weren’t recorded back then — showing the stop and target you started with.'}
          </span>
          <span>Space play / pause · ← → 10 s · Shift 1 min</span>
        </div>
      </div>
    </div>
  );
}
