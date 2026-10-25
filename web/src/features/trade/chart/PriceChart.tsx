// The trade chart: owns one ChartController for its lifetime (survives symbol / timeframe changes),
// loads history (and older bars on scroll), streams live 1m candles + quotes into the forming bar,
// and mounts the overlays (lines, tags, legend, "+" menu, market-closed banner) and the drawing layer.

import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Account, Fill, InstrumentSpec, Timeframe } from '@shared/types';
import { api, errorMessage } from '@/api/client';
import { useBus } from '@/api/bus';
import { socket } from '@/api/socket';
import { serverNow } from '@/store/app';
import { useNow, useSession } from '@/store/hooks';
import { useMarket } from '@/store/market';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Misc';
import { sessionClosedText } from '../session';
import { sanitize } from './barAggregator';
import { BookLayer } from './book/heatmap';
import { useBook } from './book/store';
import { ChartLegend } from './ChartLegend';
import { commitDrag, stageLimitAt } from './commitDrag';
import { ChartController } from './controller';
import { DrawingLayer } from './drawings/layer';
import { SelectionBar } from './drawings/SelectionBar';
import { useChartDrag } from './lines';
import { AccountOverlay, DraftOverlay, RuleOverlay } from './overlays';
import { PriceMenu } from './PriceMenu';

const MAX_BARS = 20_000;
const FILL_LOOKBACK_MS = 30 * 86_400_000;

type LoadState = { state: 'loading' | 'ready' | 'empty' } | { state: 'error'; error: string };

export interface PriceChartProps {
  symbol: string;
  timeframe: Timeframe;
  spec: InstrumentSpec;
  account: Account | null;
  onController?: (ctrl: ChartController | null) => void;
}

/** What the heatmap shows, under the legend while it is on. */
function BookHint({ spec }: { spec: InstrumentSpec }) {
  const on = useBook((s) => s.on);
  const minutes = useBook((s) => s.rows.length);
  const live = useBook((s) => s.frame != null);
  if (!on) return null;
  const text =
    spec.provider !== 'binance'
      ? `No order book for ${spec.symbol} (Yahoo data has none) — try a crypto, gold, oil or stock market`
      : !live
        ? 'Loading the order book…'
        : minutes < 30
          ? 'The history builds up minute by minute while PropDesk runs'
          : null;
  return (
    <div className="pointer-events-none absolute left-2 top-8 z-20 flex flex-wrap items-center gap-x-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] leading-4 text-muted">
      <span className="font-medium text-fg">Order book</span>
      <span className="flex items-center gap-1">
        <span className="size-2 rounded-sm bg-profit/70" /> buy orders waiting
      </span>
      <span className="flex items-center gap-1">
        <span className="size-2 rounded-sm bg-loss/70" /> sell orders waiting
      </span>
      <span className="text-faint">brighter = more</span>
      {text && <span className="text-faint">· {text}</span>}
    </div>
  );
}

function SessionBanner({ symbol }: { symbol: string }) {
  const session = useSession(symbol);
  const now = useNow(30_000);
  const text = sessionClosedText(session, now);
  if (!text) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-9 z-20 flex justify-center">
      <span className="rounded-md border border-line-strong bg-black/80 px-3 py-1 text-xs font-medium text-muted shadow-pop">{text}</span>
    </div>
  );
}

export function PriceChart({ symbol, timeframe, spec, account, onController }: PriceChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [ctrl, setCtrl] = useState<ChartController | null>(null);
  const [load, setLoad] = useState<LoadState>({ state: 'loading' });
  const [reload, setReload] = useState(0);
  const loadRef = useRef<LoadState['state']>('loading');
  loadRef.current = load.state;
  const hist = useRef({ seq: 0, olderLoading: false, exhausted: false, retryAt: 0 });
  const accountId = account?.id ?? null;
  const onControllerRef = useRef(onController);
  onControllerRef.current = onController;

  // Create once; StrictMode's double mount creates and disposes a first instance cleanly.
  useEffect(() => {
    if (!hostRef.current || !wrapRef.current) return;
    const c = new ChartController(hostRef.current, wrapRef.current);
    setCtrl(c);
    onControllerRef.current?.(c);
    return () => {
      onControllerRef.current?.(null);
      c.destroy();
      setCtrl(null);
    };
  }, []);

  // Drawing tools (trend lines, levels, boxes, position tools).
  const [layer, setLayer] = useState<DrawingLayer | null>(null);
  useEffect(() => {
    if (!ctrl) return;
    const l = new DrawingLayer(ctrl);
    setLayer(l);
    return () => {
      l.destroy();
      setLayer(null);
    };
  }, [ctrl]);
  useEffect(() => {
    layer?.setSymbol(symbol, spec);
  }, [layer, symbol, spec]);

  // Order book heatmap (Binance markets): live book over the socket, stored minutes from the API.
  const [bookLayer, setBookLayer] = useState<BookLayer | null>(null);
  useEffect(() => {
    if (!ctrl) return;
    const l = new BookLayer(ctrl);
    setBookLayer(l);
    return () => {
      l.destroy();
      setBookLayer(null);
    };
  }, [ctrl]);
  useEffect(() => {
    bookLayer?.setSpec(spec);
  }, [bookLayer, spec]);
  const bookOn = useBook((s) => s.on);
  const bookSymbol = bookOn && spec.provider === 'binance' ? symbol : null;
  useEffect(() => {
    socket.setBookSymbol(bookSymbol);
    useBook.getState().follow(bookSymbol);
    return () => {
      socket.setBookSymbol(null);
      useBook.getState().follow(null);
    };
  }, [bookSymbol]);
  // Live 1m candles for this symbol.
  useEffect(() => {
    socket.setChartSymbol(symbol);
    return () => socket.setChartSymbol(null);
  }, [symbol]);

  // History.
  useEffect(() => {
    if (!ctrl) return;
    const h = hist.current;
    const seq = ++h.seq;
    h.olderLoading = false;
    h.exhausted = false;
    h.retryAt = 0;
    ctrl.setInstrument(spec, timeframe);
    ctrl.clearBars();
    setLoad({ state: 'loading' });
    api
      .candles(symbol, timeframe, { limit: 1000 })
      .then((candles) => {
        if (seq !== h.seq) return;
        const bars = sanitize(Array.isArray(candles) ? candles : []);
        ctrl.setBars(bars, serverNow() / 1000 + 2);
        setLoad({ state: bars.length ? 'ready' : 'empty' });
      })
      .catch((e) => {
        if (seq === h.seq) setLoad({ state: 'error', error: errorMessage(e) });
      });
  }, [ctrl, symbol, timeframe, spec, reload]);

  // Older history when scrolling near the left edge.
  useEffect(() => {
    if (!ctrl) return;
    ctrl.cb.onNeedOlder = () => {
      const h = hist.current;
      if (h.olderLoading || h.exhausted || Date.now() < h.retryAt) return;
      const first = ctrl.bars[0];
      if (!first) return;
      if (ctrl.bars.length >= MAX_BARS) {
        h.exhausted = true;
        return;
      }
      h.olderLoading = true;
      const seq = h.seq;
      api
        .candles(symbol, timeframe, { end: first.time, limit: 1000 })
        .then((c) => {
          if (seq !== h.seq) return;
          if (ctrl.prependBars(sanitize(Array.isArray(c) ? c : [])) === 0) h.exhausted = true;
        })
        .catch(() => {
          if (seq === h.seq) h.retryAt = Date.now() + 5000;
        })
        .finally(() => {
          if (seq === h.seq) h.olderLoading = false;
        });
    };
    return () => {
      ctrl.cb.onNeedOlder = undefined;
    };
  }, [ctrl, symbol, timeframe]);

  // Live candles + quote nudges into the forming bar.
  useBus('candle', (m) => {
    if (!ctrl || m.symbol !== symbol) return;
    ctrl.applyMinute(m.candle);
    if (loadRef.current === 'empty' && ctrl.bars.length) setLoad({ state: 'ready' });
  });
  useEffect(() => {
    if (!ctrl) return;
    let last = useMarket.getState().quotes[symbol];
    return useMarket.subscribe((s) => {
      const q = s.quotes[symbol];
      if (!q || q === last) return;
      last = q;
      ctrl.applyPrice(q.last, q.ts);
    });
  }, [ctrl, symbol]);
  useBus('resynced', () => setReload((n) => n + 1));

  // Fill markers of the active account.
  const [fills, setFills] = useState<Fill[]>([]);
  useEffect(() => {
    setFills([]);
    if (!accountId) return;
    let alive = true;
    api
      .fills({ accountId, from: Date.now() - FILL_LOOKBACK_MS, limit: 2000 })
      .then((f) => {
        if (alive && Array.isArray(f)) setFills(f.filter((x) => x.symbol === symbol));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [accountId, symbol, reload]);
  useBus('fill', (f) => {
    if (f.accountId !== accountId || f.symbol !== symbol) return;
    setFills((prev) => (prev.some((x) => x.id === f.id) ? prev : [f, ...prev]));
  });
  useEffect(() => {
    ctrl?.setFills(fills);
  }, [ctrl, fills]);

  // Dragging lines & shift+click.
  useEffect(() => {
    if (!ctrl) return;
    ctrl.cb.onDragStart = (s, price) => useChartDrag.setState({ key: s.key, price });
    ctrl.cb.onDragMove = (s, price) => useChartDrag.setState({ key: s.key, price });
    ctrl.cb.onDragEnd = (s, price) => {
      useChartDrag.setState({ key: null, price: null });
      if (price != null) void commitDrag(ctrl, s, price, accountId, symbol, spec);
    };
    ctrl.cb.onShiftClick = (price) => stageLimitAt(symbol, price);
    return () => {
      ctrl.cb.onDragStart = ctrl.cb.onDragMove = undefined;
      ctrl.cb.onDragEnd = undefined;
      ctrl.cb.onShiftClick = undefined;
    };
  }, [ctrl, accountId, symbol, spec]);

  return (
    <div ref={wrapRef} className="relative h-full min-h-0 w-full overflow-hidden bg-bg">
      <div ref={hostRef} className="absolute inset-0" />
      <div className="pointer-events-none absolute inset-0">
        {ctrl && (
          <>
            <ChartLegend ctrl={ctrl} spec={spec} timeframe={timeframe} />
            <BookHint spec={spec} />
            <RuleOverlay ctrl={ctrl} account={account} symbol={symbol} spec={spec} />
            <DraftOverlay ctrl={ctrl} accountId={accountId} symbol={symbol} spec={spec} />
            <AccountOverlay ctrl={ctrl} accountId={accountId} symbol={symbol} spec={spec} />
            <PriceMenu ctrl={ctrl} accountId={accountId} symbol={symbol} spec={spec} />
            <SelectionBar symbol={symbol} />
          </>
        )}
        <SessionBanner symbol={symbol} />
        {load.state === 'loading' && (
          <div className="absolute inset-0 z-30 flex items-center justify-center">
            <span className="flex items-center gap-2 rounded-md bg-black/70 px-3 py-1.5 text-xs text-muted">
              <Spinner size={13} /> Loading {symbol}…
            </span>
          </div>
        )}
        {load.state === 'empty' && (
          <div className="absolute inset-0 z-30 flex items-center justify-center">
            <span className="rounded-md bg-black/70 px-3 py-1.5 text-xs text-muted">No price history for this timeframe yet — live bars will appear here.</span>
          </div>
        )}
        {load.state === 'error' && (
          <div className="absolute inset-0 z-30 flex items-center justify-center">
            <div data-chart-ui className="pointer-events-auto flex flex-col items-center gap-2 rounded-lg border border-line-strong bg-panel px-5 py-4 text-center shadow-pop">
              <div className="text-sm font-medium text-fg">Couldn’t load the chart</div>
              <div className="max-w-xs text-xs text-muted">{load.error}</div>
              <Button size="sm" variant="secondary" icon={<RefreshCw size={13} />} onClick={() => setReload((n) => n + 1)}>
                Retry
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
