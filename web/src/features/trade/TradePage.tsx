// Trade page: account strip · watchlist | chart + bottom panel | order ticket. Full height, no page scroll.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuoteSubscription } from '@/api/socket';
import { useApp } from '@/store/app';
import { useActiveAccount } from '@/store/hooks';
import { Spinner } from '@/components/ui/Misc';
import { AccountStrip } from './AccountStrip';
import { BottomPanel } from './bottom/BottomPanel';
import { ChartPanel } from './chart/ChartPanel';
import { useDayDataLoader } from './dayData';
import { useTrade } from './store';
import { OrderTicket } from './ticket/OrderTicket';
import { readLocal, writeLocal } from './ticket/prefs';
import { RevengeGuardHost } from './ticket/RevengeGuard';
import { Watchlist } from './Watchlist';

const BOTTOM_KEY = 'propdesk.trade.bottomHeight';
const MIN_BOTTOM = 120;
const MIN_CHART = 220;

/** Quotes for every symbol the active account holds or has orders in (P&L and order lines need them). */
function useAccountQuoteSubscription(): void {
  const key = useApp((s) => {
    const id = s.activeAccountId;
    if (!id) return '';
    const set = new Set<string>();
    for (const p of Object.values(s.positions)) if (p.accountId === id) set.add(p.symbol);
    for (const o of Object.values(s.orders)) if (o.accountId === id) set.add(o.symbol);
    return [...set].sort().join(',');
  });
  const symbols = useMemo(() => (key ? key.split(',') : []), [key]);
  useQuoteSubscription('trade-account', symbols);
}

function Splitter({ onResize, onDone }: { onResize: (dy: number) => void; onDone: () => void }) {
  const start = useRef<number | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the bottom panel"
      onPointerDown={(e) => {
        e.preventDefault();
        start.current = e.clientY;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (start.current == null) return;
        onResize(start.current - e.clientY);
        start.current = e.clientY;
      }}
      onPointerUp={(e) => {
        if (start.current == null) return;
        start.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        onDone();
      }}
      className="group relative z-10 h-1 shrink-0 cursor-row-resize bg-line transition-colors hover:bg-line-strong"
    >
      <div className="absolute inset-x-0 -bottom-1 -top-1" />
    </div>
  );
}

export function TradePage() {
  const initialized = useTrade((s) => s.initialized);
  const symbol = useTrade((s) => s.symbol);
  const account = useActiveAccount();
  const centerRef = useRef<HTMLDivElement>(null);
  const [bottomH, setBottomH] = useState(() => readLocal<number>(BOTTOM_KEY, 240));

  useEffect(() => {
    useTrade.getState().init();
  }, []);

  // Switching to an account whose rules exclude the charted market (e.g. futures on a crypto-only challenge)
  // moves the chart to the first allowed watchlist symbol. Browsing other markets afterwards stays possible.
  const allowedKey = account?.rules.allowedClasses?.join(',') ?? '';
  useEffect(() => {
    if (!initialized || !allowedKey) return;
    const allowed = allowedKey.split(',');
    const { instrumentMap, settings, instruments } = useApp.getState();
    const current = instrumentMap[useTrade.getState().symbol];
    if (current && allowed.includes(current.assetClass)) return;
    const next =
      settings.watchlist.find((s) => instrumentMap[s] && allowed.includes(instrumentMap[s].assetClass)) ??
      instruments.find((i) => allowed.includes(i.assetClass))?.symbol;
    if (next) useTrade.getState().selectSymbol(next);
  }, [account?.id, allowedKey, initialized]);

  useDayDataLoader(account);
  useAccountQuoteSubscription();
  useQuoteSubscription('trade-selected', [symbol]);

  const clamp = useCallback((h: number) => {
    const total = centerRef.current?.clientHeight ?? 800;
    return Math.round(Math.max(MIN_BOTTOM, Math.min(h, total - MIN_CHART)));
  }, []);

  // Keep the panel inside the window after resizes.
  useEffect(() => {
    const onResize = () => setBottomH((h) => clamp(h));
    window.addEventListener('resize', onResize);
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, [clamp, initialized]);

  if (!initialized) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={16} className="text-muted" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <AccountStrip />
      <div className="flex min-h-0 flex-1">
        <Watchlist />
        <div ref={centerRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ChartPanel account={account} />
          <Splitter onResize={(dy) => setBottomH((h) => clamp(h + dy))} onDone={() => setBottomH((h) => (writeLocal(BOTTOM_KEY, h), h))} />
          <div className="shrink-0" style={{ height: bottomH }}>
            <BottomPanel account={account} />
          </div>
        </div>
        <OrderTicket />
      </div>
      <RevengeGuardHost />
    </div>
  );
}
