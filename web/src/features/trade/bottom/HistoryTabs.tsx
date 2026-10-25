// Today's fills and closed trades, and account events.

import { useState } from 'react';
import clsx from 'clsx';
import { CircleAlert, CircleCheck, CircleX, Info, Play } from 'lucide-react';
import type { AccountEvent, ExitReason, Fill, Trade } from '@shared/types';
import { MOOD_MAP } from '@shared/journal';
import { fmtDateTime, fmtDuration, fmtMoney, fmtPrice, fmtQty, fmtTime, pnlTone } from '@/lib/format';
import { useApp } from '@/store/app';
import { IconButton } from '@/components/ui/Button';
import { TradeReplayModal } from '@/features/journal/TradeReplay';
import { useTrade } from '../store';
import { Empty, Table, Td, Th } from './table';

const ROLE_TXT: Record<Fill['role'], string> = { entry: 'Entry', exit: 'Exit', stop_loss: 'Stop-loss', take_profit: 'Take-profit', liquidation: 'Liquidation' };

const EXIT_TXT: Record<ExitReason, string> = {
  manual: 'Manual',
  stop_loss: 'Stop-loss',
  take_profit: 'Target',
  limit: 'Limit',
  reversal: 'Reversal',
  breach: 'Breach',
  daily_loss: 'Daily loss',
  auto_flatten: 'Auto-flatten',
  passed: 'Passed',
};

function SymbolLink({ symbol }: { symbol: string }) {
  const selectSymbol = useTrade((s) => s.selectSymbol);
  return (
    <button className="font-semibold text-fg hover:underline" onClick={() => selectSymbol(symbol)}>
      {symbol}
    </button>
  );
}

export function FillsTab({ fills, loading }: { fills: Fill[]; loading: boolean }) {
  const instrumentMap = useApp((s) => s.instrumentMap);
  if (!fills.length) return <Empty>{loading ? 'Loading today’s fills…' : 'No fills this trading day.'}</Empty>;
  return (
    <Table>
      <thead>
        <tr>
          <Th>Time</Th>
          <Th>Symbol</Th>
          <Th>Side</Th>
          <Th right>Qty</Th>
          <Th right>Price</Th>
          <Th>Role</Th>
          <Th>Liquidity</Th>
          <Th right>Fee</Th>
          <Th right>Realized</Th>
        </tr>
      </thead>
      <tbody>
        {fills.map((f) => {
          const spec = instrumentMap[f.symbol];
          return (
            <tr key={f.id} className="hover:bg-panel-2">
              <Td className="tnum text-muted">{fmtTime(f.ts)}</Td>
              <Td>
                <SymbolLink symbol={f.symbol} />
              </Td>
              <Td>
                <span className={clsx('text-xs font-semibold', f.side === 'buy' ? 'text-profit' : 'text-loss')}>{f.side === 'buy' ? 'BUY' : 'SELL'}</span>
              </Td>
              <Td right className="tnum">
                {spec ? fmtQty(spec, f.qty) : f.qty}
              </Td>
              <Td right className="num">
                {spec ? fmtPrice(spec, f.price) : f.price}
              </Td>
              <Td className={clsx('text-xs', f.role === 'liquidation' ? 'text-loss' : 'text-muted')}>{ROLE_TXT[f.role] ?? f.role}</Td>
              <Td className="text-xs text-faint">{f.liquidity}</Td>
              <Td right className="tnum text-muted">
                {fmtMoney(-f.fee)}
              </Td>
              <Td right className={clsx('tnum', pnlTone(f.realizedPnl, 'text-faint'))}>
                {f.realizedPnl ? fmtMoney(f.realizedPnl, { sign: true }) : '—'}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

export function TradesTab({ trades, loading }: { trades: Trade[]; loading: boolean }) {
  const instrumentMap = useApp((s) => s.instrumentMap);
  const [replay, setReplay] = useState<Trade | null>(null);
  if (!trades.length) return <Empty>{loading ? 'Loading today’s trades…' : 'No closed trades this trading day.'}</Empty>;
  const net = trades.reduce((s, t) => s + t.netPnl, 0);
  const wins = trades.filter((t) => t.netPnl > 0).length;
  return (
    <Table>
      <thead>
        <tr>
          <Th>Closed</Th>
          <Th>Symbol</Th>
          <Th>Dir</Th>
          <Th right>Size</Th>
          <Th right>Entry</Th>
          <Th right>Exit</Th>
          <Th right>Net P&L</Th>
          <Th right>R</Th>
          <Th>Held</Th>
          <Th>Exit</Th>
          <Th>Mood</Th>
          <Th />
        </tr>
      </thead>
      <tbody>
        {trades.map((t) => {
          const spec = instrumentMap[t.symbol];
          const mood = t.tags?.mood ? MOOD_MAP[t.tags.mood] : null;
          return (
            <tr key={t.id} className="hover:bg-panel-2">
              <Td className="tnum text-muted">{t.closedAt ? fmtTime(t.closedAt) : '—'}</Td>
              <Td>
                <SymbolLink symbol={t.symbol} />
              </Td>
              <Td>
                <span className={clsx('text-xs font-semibold', t.direction === 'long' ? 'text-profit' : 'text-loss')}>{t.direction === 'long' ? 'LONG' : 'SHORT'}</span>
              </Td>
              <Td right className="tnum">
                {spec ? fmtQty(spec, t.maxQty) : t.maxQty}
              </Td>
              <Td right className="num">
                {spec ? fmtPrice(spec, t.avgEntry) : t.avgEntry}
              </Td>
              <Td right className="num">
                {spec ? fmtPrice(spec, t.avgExit) : (t.avgExit ?? '—')}
              </Td>
              <Td right className={clsx('tnum font-semibold', pnlTone(t.netPnl))}>
                {fmtMoney(t.netPnl, { sign: true })}
              </Td>
              <Td right className={clsx('tnum', pnlTone(t.rMultiple, 'text-faint'))}>
                {t.rMultiple != null ? `${t.rMultiple > 0 ? '+' : ''}${t.rMultiple.toFixed(2)}R` : '—'}
              </Td>
              <Td className="tnum text-muted">{t.closedAt ? fmtDuration(t.closedAt - t.openedAt) : '—'}</Td>
              <Td className={clsx('text-xs', t.exitReason === 'breach' || t.exitReason === 'daily_loss' ? 'text-loss' : 'text-muted')}>{t.exitReason ? EXIT_TXT[t.exitReason] : '—'}</Td>
              <Td title={mood?.label}>{mood ? <span aria-label={mood.label}>{mood.emoji}</span> : <span className="text-faint">—</span>}</Td>
              <Td right>
                <IconButton size="xs" label="Replay this trade" icon={<Play size={12} />} onClick={() => setReplay(t)} />
              </Td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <Td colSpan={6} className="text-xs text-muted">
            {trades.length} trade{trades.length === 1 ? '' : 's'} · {wins} win{wins === 1 ? '' : 's'}
          </Td>
          <Td right className={clsx('tnum font-semibold', pnlTone(net))}>
            {fmtMoney(net, { sign: true })}
          </Td>
          <Td colSpan={5} />
        </tr>
      </tfoot>
      {replay && <TradeReplayModal trade={replay} onClose={() => setReplay(null)} />}
    </Table>
  );
}

const SEV = {
  info: { Icon: Info, cls: 'text-muted' },
  success: { Icon: CircleCheck, cls: 'text-profit' },
  warning: { Icon: CircleAlert, cls: 'text-warn' },
  danger: { Icon: CircleX, cls: 'text-loss' },
} as const;

export function EventsTab({ events, loading }: { events: AccountEvent[]; loading: boolean }) {
  if (!events.length) return <Empty>{loading ? 'Loading events…' : 'No account events yet.'}</Empty>;
  return (
    <Table>
      <thead>
        <tr>
          <Th className="w-32">Time</Th>
          <Th>Event</Th>
        </tr>
      </thead>
      <tbody>
        {events.map((e) => {
          const s = SEV[e.severity] ?? SEV.info;
          return (
            <tr key={e.id} className="hover:bg-panel-2">
              <Td className="tnum align-top text-muted">{fmtDateTime(e.ts)}</Td>
              <Td className="whitespace-normal py-1.5">
                <span className="flex items-start gap-2">
                  <s.Icon size={14} className={clsx('mt-0.5 shrink-0', s.cls)} />
                  <span>
                    <span className="font-medium text-fg">{e.title}</span>
                    {e.message && <span className="ml-2 text-xs text-muted">{e.message}</span>}
                  </span>
                </span>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
