// Bottom panel: Positions · Working · Fills · Trades · Events (today), with counts and tab actions.

import { useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import type { Account } from '@shared/types';
import { useAccountOrders, useAccountPositions } from '@/store/hooks';
import { Button, IconButton } from '@/components/ui/Button';
import { Tabs } from '@/components/ui/Tabs';
import { confirm } from '@/components/ui/Toast';
import { Pnl } from '@/components/ui/Money';
import { cancelOrders, flattenAccount } from '../actions';
import { useAccountEvents, useDay, useTodayFills, useTodayTrades } from '../dayData';
import { useLiveOpenPnl } from '../useLiveAccount';
import { readLocal, writeLocal } from '../ticket/prefs';
import { EventsTab, FillsTab, TradesTab } from './HistoryTabs';
import { OrdersTab } from './OrdersTab';
import { PositionsTab } from './PositionsTab';

type Tab = 'positions' | 'orders' | 'fills' | 'trades' | 'events';
const TAB_KEY = 'propdesk.trade.bottomTab';

function OpenPnl({ accountId }: { accountId: string }) {
  const v = useLiveOpenPnl(accountId);
  return <Pnl value={v} className="text-xs font-semibold" />;
}

export function BottomPanel({ account }: { account: Account | null }) {
  const accountId = account?.id ?? null;
  const [tab, setTabState] = useState<Tab>(() => readLocal<Tab>(TAB_KEY, 'positions'));
  const setTab = (t: Tab) => {
    setTabState(t);
    writeLocal(TAB_KEY, t);
  };
  const positions = useAccountPositions(accountId);
  const orders = useAccountOrders(accountId);
  const fills = useTodayFills(accountId);
  const trades = useTodayTrades(accountId);
  const events = useAccountEvents(accountId);
  const dayStatus = useDay((s) => s.status);
  const dayError = useDay((s) => s.error);
  const loading = dayStatus === 'loading';

  const flattenAll = async () => {
    if (!account) return;
    const ok = await confirm({
      title: 'Flatten everything?',
      body: `Closes ${positions.length} position${positions.length === 1 ? '' : 's'} at market and cancels ${orders.length} working order${orders.length === 1 ? '' : 's'}.`,
      confirmLabel: 'Flatten all',
      tone: 'danger',
    });
    if (ok) await flattenAccount(account.id);
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-line px-3">
        <Tabs<Tab>
          size="sm"
          value={tab}
          onChange={setTab}
          className="h-full"
          items={[
            { id: 'positions', label: 'Positions', count: positions.length },
            { id: 'orders', label: 'Working', count: orders.length },
            { id: 'fills', label: 'Fills', count: fills.length },
            { id: 'trades', label: 'Trades', count: trades.length },
            { id: 'events', label: 'Events' },
          ]}
        />
        <div className="flex items-center gap-2">
          {tab === 'positions' && accountId && positions.length > 0 && (
            <>
              <span className="text-2xs uppercase tracking-wider text-faint">Open</span>
              <OpenPnl accountId={accountId} />
              <Button size="xs" variant="danger" onClick={() => void flattenAll()}>
                Flatten all
              </Button>
            </>
          )}
          {tab === 'orders' && orders.length > 0 && (
            <Button size="xs" variant="outline" icon={<X size={12} />} onClick={() => void cancelOrders(orders)}>
              Cancel all
            </Button>
          )}
          {(tab === 'fills' || tab === 'trades' || tab === 'events') && account && (
            <>
              {dayStatus === 'error' && <span className="max-w-64 truncate text-2xs text-loss" title={dayError ?? undefined}>Couldn’t load history</span>}
              <IconButton size="xs" label="Reload" icon={<RefreshCw size={12} className={loading ? 'animate-spin' : undefined} />} onClick={() => void useDay.getState().load(account, true)} />
            </>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'positions' && <PositionsTab accountId={accountId} />}
        {tab === 'orders' && <OrdersTab accountId={accountId} />}
        {tab === 'fills' && <FillsTab fills={fills} loading={loading} />}
        {tab === 'trades' && <TradesTab trades={trades} loading={loading} />}
        {tab === 'events' && <EventsTab events={events} loading={loading} />}
      </div>
    </section>
  );
}
