// Chart column: compact header (symbol, timeframe, live quote, tools) over the price chart.

import { memo, useState } from 'react';
import clsx from 'clsx';
import { Eye, EyeOff, Info, RotateCcw } from 'lucide-react';
import type { Account, InstrumentSpec, Timeframe } from '@shared/types';
import { priceSource } from '@shared/instruments';
import { ticksBetween } from '@shared/risk';
import { fmtPrice, pnlTone, fmtPct } from '@/lib/format';
import { useApp } from '@/store/app';
import { useInstrument, useSession } from '@/store/hooks';
import { useQuote, useTickDir } from '@/store/market';
import { IconButton } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Tabs';
import { Tooltip } from '@/components/ui/Popover';
import { EmptyState } from '@/components/ui/Misc';
import { useTrade } from '../store';
import { useFlash } from '../useFlash';
import { useBook } from './book/store';
import type { ChartController } from './controller';
import { DrawingToolbar } from './drawings/DrawingToolbar';
import { PriceChart } from './PriceChart';

const TF_OPTIONS: Array<{ value: Timeframe; label: string }> = [
  { value: '1m', label: '1m' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1h', label: '1h' },
  { value: '4h', label: '4h' },
  { value: '1d', label: '1D' },
];

const HeaderQuote = memo(function HeaderQuote({ spec }: { spec: InstrumentSpec }) {
  const q = useQuote(spec.symbol);
  const dir = useTickDir(spec.symbol);
  const ref = useFlash(q?.last, dir);
  if (!q) return <span className="text-xs text-faint">Waiting for price…</span>;
  const spread = ticksBetween(spec, q.ask, q.bid);
  return (
    <div className="flex items-baseline gap-3">
      <span ref={ref} className="num rounded px-1 text-[15px] font-semibold text-fg">
        {fmtPrice(spec, q.last)}
      </span>
      {q.changePct != null && <span className={clsx('tnum text-xs font-medium', pnlTone(q.changePct))}>{fmtPct(q.changePct, 2, true)}</span>}
      <span className="num hidden text-2xs text-faint xl:inline">
        <span className="text-loss">{fmtPrice(spec, q.bid)}</span>
        <span className="px-1">×</span>
        <span className="text-profit">{fmtPrice(spec, q.ask)}</span>
        <span className="pl-1.5">
          {spread} tick{spread === 1 ? '' : 's'}
        </span>
      </span>
    </div>
  );
});

/** Where the price comes from, and the same market on TradingView (prices elsewhere can differ). */
function SourceTag({ spec }: { spec: InstrumentSpec }) {
  const feedDelay = useApp((s) => s.feeds.find((f) => f.provider === spec.provider)?.delaySec ?? 0);
  const delaySec = spec.liveProxy ? 0 : feedDelay;
  const src = priceSource(spec);
  return (
    <Tooltip
      side="bottom"
      content={
        <span className="block max-w-72 leading-relaxed">
          {src.note}
          {src.tradingView && (
            <>
              {' '}
              The same market on TradingView: <span className="font-medium text-fg">{src.tradingView}</span>
            </>
          )}
        </span>
      }
    >
      <span className="hidden cursor-default truncate text-2xs text-faint underline decoration-dotted underline-offset-2 xl:inline">
        {src.label}
        {delaySec > 0 && ` · ${Math.round(delaySec / 60)} min delayed`}
      </span>
    </Tooltip>
  );
}

/** Horizontal bars of different lengths, like the depth along the chart's right edge. */
function BookIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
      <path d="M14 3H8M14 6.5H3M14 10H9.5M14 13.5H5.5" />
    </svg>
  );
}

/** Order book heatmap on / off — only Binance markets have an order book feed. */
function BookToggle({ spec }: { spec: InstrumentSpec }) {
  const on = useBook((s) => s.on);
  const available = spec.provider === 'binance';
  const label = !available
    ? `Order book: not available for ${spec.symbol} — CME futures and forex prices come from Yahoo, which has no order book`
    : on
      ? 'Hide the order book'
      : 'Order book: see where buy and sell orders are waiting';
  return <IconButton size="xs" label={label} icon={<BookIcon />} active={on && available} disabled={!available} onClick={() => useBook.getState().setOn(!on)} />;
}

function SessionTag({ symbol }: { symbol: string }) {
  const s = useSession(symbol);
  if (!s || s.open) return null;
  return <span className="rounded bg-panel-3 px-1.5 py-0.5 text-2xs font-medium text-muted">{s.label}</span>;
}

export function ChartPanel({ account }: { account: Account | null }) {
  const symbol = useTrade((s) => s.symbol);
  const timeframe = useTrade((s) => s.timeframe);
  const setTimeframe = useTrade((s) => s.setTimeframe);
  const preview = useTrade((s) => s.preview);
  const setPreview = useTrade((s) => s.setPreview);
  const spec = useInstrument(symbol);
  const [ctrl, setCtrl] = useState<ChartController | null>(null);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-line px-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-sm font-semibold tracking-tight text-fg">{symbol}</span>
          <span className="hidden truncate text-xs text-muted lg:inline">{spec?.name}</span>
          {spec && <SourceTag spec={spec} />}
        </div>
        <SessionTag symbol={symbol} />
        <Segmented size="xs" value={timeframe} onChange={setTimeframe} options={TF_OPTIONS} />
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {spec && <HeaderQuote spec={spec} />}
          <div className="ml-1 flex items-center">
            {spec && <BookToggle spec={spec} />}
            <IconButton
              size="xs"
              label={preview ? 'Hide the ticket preview on the chart' : 'Show the ticket preview on the chart'}
              icon={preview ? <Eye size={13} /> : <EyeOff size={13} />}
              active={preview}
              onClick={() => setPreview(!preview)}
            />
            <IconButton size="xs" label="Reset chart view" icon={<RotateCcw size={13} />} onClick={() => ctrl?.resetView()} />
            <Tooltip
              side="left"
              content={
                <span className="block max-w-64 leading-relaxed">
                  Drag the SL, TP and order lines to modify them (Esc cancels). Shift+click stages a limit order in the ticket. The + next to the price axis offers more. Drawing tools are on the left: pick one and click the chart (lines and boxes: click twice). Del removes the selected drawing.
                </span>
              }
            >
              <span className="flex size-6 items-center justify-center text-faint">
                <Info size={13} />
              </span>
            </Tooltip>
          </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        {spec && <DrawingToolbar symbol={symbol} />}
        <div className="min-h-0 min-w-0 flex-1">
          {spec ? (
            <PriceChart symbol={symbol} timeframe={timeframe} spec={spec} account={account} onController={setCtrl} />
          ) : (
            <EmptyState title="Unknown instrument" description={`${symbol} is not in the catalog. Pick another symbol from the watchlist.`} />
          )}
        </div>
      </div>
    </section>
  );
}
