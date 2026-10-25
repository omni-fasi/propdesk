// Open positions of the active account, one row each (several can share a symbol): live mark & P&L,
// inline SL/TP, close / partial close of that position, reverse of the whole symbol.

import { memo, useState } from 'react';
import clsx from 'clsx';
import { ArrowLeftRight } from 'lucide-react';
import type { InstrumentSpec, Position } from '@shared/types';
import { pnl, roundQty, validateBracket } from '@shared/risk';
import { sessionState } from '@shared/time';
import { fmtDuration, fmtMoney, fmtPrice, fmtQty, fmtTime, pnlTone } from '@/lib/format';
import { useApp } from '@/store/app';
import { useAccountPositions, useNow, usePositionPnl } from '@/store/hooks';
import { Button } from '@/components/ui/Button';
import { NumberInput } from '@/components/ui/Input';
import { Popover } from '@/components/ui/Popover';
import { confirm, toast } from '@/components/ui/Toast';
import { closePosition, reversePosition, setBracket } from '../actions';
import { useTrade } from '../store';
import { Empty, InlineNumber, Table, Td, Th } from './table';

function PartialClose({ position, spec }: { position: Position; spec: InstrumentSpec }) {
  const abs = Math.abs(position.qty);
  const [qty, setQty] = useState<number | null>(() => roundQty(spec, abs / 2) || spec.minQty);
  const valid = qty != null && qty >= spec.minQty && qty < abs;
  return (
    <Popover
      align="end"
      side="top"
      className="w-56 p-2"
      disabled={abs <= spec.minQty}
      triggerClassName="h-6 rounded border border-line-strong px-2 text-xs text-muted transition-colors hover:border-[#4a4a4a] hover:text-fg disabled:opacity-40"
      trigger="Partial"
    >
      {(close) => (
        <div className="flex flex-col gap-2 p-1">
          <div className="text-2xs font-medium uppercase tracking-wider text-faint">Close part of {fmtQty(spec, position.qty)}</div>
          <NumberInput size="sm" value={qty} onChange={setQty} step={spec.qtyStep} min={spec.minQty} precision={spec.qtyPrecision} className="num" autoFocus />
          <div className="flex gap-1">
            {[0.25, 0.5, 0.75].map((f) => {
              const v = roundQty(spec, abs * f);
              return (
                <button key={f} disabled={v < spec.minQty || v >= abs} onClick={() => setQty(v)} className="h-6 flex-1 rounded border border-line-strong text-2xs text-muted hover:text-fg disabled:opacity-30">
                  {f * 100}%
                </button>
              );
            })}
          </div>
          <Button
            size="sm"
            variant="primary"
            disabled={!valid}
            onClick={() => {
              if (qty == null) return;
              close();
              void closePosition(position.accountId, position.symbol, qty, position.tradeId);
            }}
          >
            Close {qty != null ? fmtQty(spec, qty) : ''} at market
          </Button>
        </div>
      )}
    </Popover>
  );
}

const PositionRow = memo(function PositionRow({ position, spec, marketOpen, siblings }: { position: Position; spec: InstrumentSpec; marketOpen: boolean; siblings: number }) {
  const { mark, openPnl } = usePositionPnl(position);
  const now = useNow(1000);
  const selectSymbol = useTrade((s) => s.selectSymbol);
  const long = position.qty > 0;
  const dir = long ? 1 : -1;
  const abs = Math.abs(position.qty);

  const commitBracket = async (kind: 'sl' | 'tp', v: number) => {
    const err = validateBracket(dir, mark, kind === 'sl' ? v : undefined, kind === 'tp' ? v : undefined);
    if (err) {
      toast({ tone: 'warn', title: 'Not changed', description: `${err} (${long ? 'bid' : 'ask'} ${fmtPrice(spec, mark)}).` });
      return false;
    }
    return setBracket(position.accountId, position.symbol, kind === 'sl' ? { sl: v } : { tp: v }, position.tradeId);
  };
  const bracketCell = (kind: 'sl' | 'tp') => {
    const level = kind === 'sl' ? position.sl : position.tp;
    const at = level != null ? pnl(spec, dir, abs, position.avgPrice, level) : null;
    return (
      <InlineNumber
        value={level}
        display={
          level != null ? (
            <>
              {fmtPrice(spec, level)} <span className={clsx('text-2xs', pnlTone(at))}>{fmtMoney(at ?? 0, { sign: true })}</span>
            </>
          ) : (
            <span className="text-faint">+ add</span>
          )
        }
        step={spec.tickSize}
        precision={spec.pricePrecision}
        min={0}
        onCommit={(v) => commitBracket(kind, v)}
        clearLabel={kind === 'sl' ? 'Remove stop-loss' : 'Remove take-profit'}
        onClear={async () => {
          if (kind === 'sl') {
            const ok = await confirm({ title: 'Remove your stop-loss?', body: 'The position will have no protection.', confirmLabel: 'Remove stop', tone: 'danger' });
            if (!ok) return;
          }
          await setBracket(position.accountId, position.symbol, kind === 'sl' ? { sl: null } : { tp: null }, position.tradeId);
        }}
      />
    );
  };

  return (
    <tr className="hover:bg-panel-2">
      <Td>
        <button className="font-semibold text-fg hover:underline" onClick={() => selectSymbol(position.symbol)}>
          {position.symbol}
        </button>
      </Td>
      <Td>
        <span className={clsx('text-xs font-semibold', long ? 'text-profit' : 'text-loss')}>{long ? 'LONG' : 'SHORT'}</span>
      </Td>
      <Td right className="tnum">
        {fmtQty(spec, position.qty)}
      </Td>
      <Td right className="num">
        {fmtPrice(spec, position.avgPrice)}
      </Td>
      <Td right className="num text-muted">
        {fmtPrice(spec, mark)}
      </Td>
      <Td right className={clsx('tnum font-semibold', pnlTone(openPnl))}>
        {fmtMoney(openPnl, { sign: true })}
      </Td>
      <Td>{bracketCell('sl')}</Td>
      <Td>{bracketCell('tp')}</Td>
      <Td className="tnum text-muted">{fmtTime(position.openedAt, { seconds: false })}</Td>
      <Td className="tnum text-muted">{fmtDuration(now - position.openedAt)}</Td>
      <Td right>
        <span className="inline-flex items-center gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={!marketOpen}
            title={marketOpen ? 'Close this position at market' : 'Market closed'}
            onClick={() => void closePosition(position.accountId, position.symbol, undefined, position.tradeId)}
          >
            Close
          </Button>
          <PartialClose position={position} spec={spec} />
          <Button
            size="xs"
            variant="ghost"
            disabled={!marketOpen}
            title={siblings > 1 ? `Reverse all ${siblings} ${position.symbol} positions` : 'Reverse (flip to the other side)'}
            icon={<ArrowLeftRight size={12} />}
            onClick={async () => {
              const same = Object.values(useApp.getState().positions).filter((p) => p.accountId === position.accountId && p.symbol === position.symbol);
              const total = Math.abs(same.reduce((s, p) => s + p.qty, 0));
              const ok = await confirm({
                title: `Reverse ${position.symbol}?`,
                body:
                  siblings > 1
                    ? `One market order of ${fmtQty(spec, total * 2)} closes your ${siblings} ${long ? 'longs' : 'shorts'} (${fmtQty(spec, total)}) and opens one ${long ? 'short' : 'long'} of the same size.`
                    : `One market order of ${fmtQty(spec, abs * 2)} flips your ${long ? 'long' : 'short'} into a ${long ? 'short' : 'long'} of the same size.`,
                confirmLabel: 'Reverse',
                tone: long ? 'sell' : 'buy',
              });
              if (ok) await reversePosition(position.accountId, position.symbol);
            }}
          />
        </span>
      </Td>
    </tr>
  );
});

export function PositionsTab({ accountId }: { accountId: string | null }) {
  const positions = useAccountPositions(accountId);
  const instrumentMap = useApp((s) => s.instrumentMap);
  const now = useNow(30_000);
  if (!accountId) return <Empty>Select or create an account to see positions.</Empty>;
  if (!positions.length) return <Empty>No open positions. Flat is a position too.</Empty>;
  return (
    <Table>
      <thead>
        <tr>
          <Th>Symbol</Th>
          <Th>Side</Th>
          <Th right>Qty</Th>
          <Th right>Avg</Th>
          <Th right>Mark</Th>
          <Th right>Open P&L</Th>
          <Th>Stop-loss</Th>
          <Th>Take-profit</Th>
          <Th>Opened</Th>
          <Th>Held</Th>
          <Th right />
        </tr>
      </thead>
      <tbody>
        {positions.map((p) => {
          const spec = instrumentMap[p.symbol];
          if (!spec) return null;
          const siblings = positions.filter((x) => x.symbol === p.symbol).length;
          return <PositionRow key={p.tradeId} position={p} spec={spec} marketOpen={isOpen(spec, now)} siblings={siblings} />;
        })}
      </tbody>
    </Table>
  );
}

function isOpen(spec: InstrumentSpec, now: number): boolean {
  return sessionState(spec.session, now).open;
}
