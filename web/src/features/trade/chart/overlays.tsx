// Chart overlays: each one owns a group of price lines and renders the HTML tags riding on them.
// They select narrow signatures from the stores so ticking quotes only re-render the tag that shows P&L.

import { Fragment, memo, useEffect, useMemo } from 'react';
import clsx from 'clsx';
import type { Account, InstrumentSpec, Order, Position } from '@shared/types';
import { pnl, roundPrice } from '@shared/risk';
import { fmtMoney, fmtPrice, fmtQty, pnlTone } from '@/lib/format';
import { useApp } from '@/store/app';
import { combinePositions, usePositionPnl } from '@/store/hooks';
import { useQuote } from '@/store/market';
import { confirm } from '@/components/ui/Toast';
import { cancelOrder, closePosition, modifyOrder, setBracket } from '../actions';
import { useTrade } from '../store';
import { calcTicket } from '../ticket/riskMath';
import { useLiveAccount } from '../useLiveAccount';
import type { ChartController } from './controller';
import { KEY, draftLineSpecs, orderLineSpecs, positionLineSpecs, ruleLineSpecs, specsSignature, useDragPrice } from './lines';
import { LineTag, Seg } from './LineTag';

const TYPE_SHORT = { market: 'MKT', limit: 'LMT', stop: 'STP' } as const;

function positionsSig(positions: Record<string, Position>, accountId: string | null, symbol: string): string {
  let s = '';
  for (const p of Object.values(positions)) if (p.accountId === accountId && p.symbol === symbol) s += `${p.tradeId}:${p.qty}:${p.avgPrice}:${p.sl}:${p.tp}:${p.openedAt};`;
  return s;
}

function ordersSig(orders: Record<string, Order>, accountId: string | null, symbol: string): string {
  let s = '';
  for (const o of Object.values(orders)) if (o.accountId === accountId && o.symbol === symbol) s += `${o.id}:${o.side}:${o.type}:${o.qty}:${o.price}:${o.sl}:${o.tp};`;
  return s;
}

/** The account's positions in `symbol`, oldest first, re-rendering only when a size / entry / bracket changes. */
export function useChartPositions(accountId: string | null, symbol: string): Position[] {
  const sig = useApp((s) => positionsSig(s.positions, accountId, symbol));
  return useMemo(
    () =>
      Object.values(useApp.getState().positions)
        .filter((p) => p.accountId === accountId && p.symbol === symbol)
        .sort((a, b) => a.openedAt - b.openedAt),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sig, accountId, symbol],
  );
}

/** The account's positions in `symbol` as one (total size, average entry), or null when flat. */
export function useChartPosition(accountId: string | null, symbol: string): Position | null {
  const positions = useChartPositions(accountId, symbol);
  return useMemo(() => combinePositions(positions), [positions]);
}

export function useChartOrders(accountId: string | null, symbol: string): Order[] {
  const sig = useApp((s) => ordersSig(s.orders, accountId, symbol));
  return useMemo(
    () =>
      Object.values(useApp.getState().orders)
        .filter((o) => o.accountId === accountId && o.symbol === symbol)
        .sort((a, b) => a.createdAt - b.createdAt),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sig, accountId, symbol],
  );
}

// ───────────────────────────── Positions & working orders ─────────────────────────────

interface OverlayProps {
  ctrl: ChartController;
  accountId: string | null;
  symbol: string;
  spec: InstrumentSpec;
}

export const AccountOverlay = memo(function AccountOverlay({ ctrl, accountId, symbol, spec }: OverlayProps) {
  const positions = useChartPositions(accountId, symbol);
  const orders = useChartOrders(accountId, symbol);
  const specs = useMemo(() => [...positionLineSpecs(positions), ...orderLineSpecs(orders)], [positions, orders]);
  const sig = specsSignature(specs);
  useEffect(() => {
    ctrl.setGroup('account', specs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctrl, sig]);
  useEffect(() => () => ctrl.setGroup('account', []), [ctrl]);

  if (!accountId) return null;
  return (
    <>
      {positions.map((p) => (
        <Fragment key={p.tradeId}>
          <PositionTag ctrl={ctrl} position={p} spec={spec} />
          {p.sl != null && <BracketTag ctrl={ctrl} kind="sl" position={p} spec={spec} />}
          {p.tp != null && <BracketTag ctrl={ctrl} kind="tp" position={p} spec={spec} />}
        </Fragment>
      ))}
      {orders.map((o) => (
        <OrderTags key={o.id} ctrl={ctrl} order={o} spec={spec} />
      ))}
    </>
  );
});

function PositionTag({ ctrl, position, spec }: { ctrl: ChartController; position: Position; spec: InstrumentSpec }) {
  const { openPnl } = usePositionPnl(position);
  const long = position.qty > 0;
  return (
    <LineTag
      ctrl={ctrl}
      lineKey={KEY.pos(position.tradeId)}
      tone="entry"
      onClose={() => void closePosition(position.accountId, position.symbol, undefined, position.tradeId)}
      closeLabel="Close this position at market"
      title={`${long ? 'Long' : 'Short'} ${fmtQty(spec, position.qty)} @ ${fmtPrice(spec, position.avgPrice)}`}
    >
      <Seg className={clsx('font-semibold', long ? 'bg-profit/15 text-profit' : 'bg-loss/15 text-loss')}>
        {long ? 'LONG' : 'SHORT'} {fmtQty(spec, position.qty)}
      </Seg>
      <Seg className="text-muted">@ {fmtPrice(spec, position.avgPrice)}</Seg>
      <Seg className={clsx('font-semibold', pnlTone(openPnl))}>{fmtMoney(openPnl, { sign: true })}</Seg>
    </LineTag>
  );
}

function BracketTag({ ctrl, kind, position, spec }: { ctrl: ChartController; kind: 'sl' | 'tp'; position: Position; spec: InstrumentSpec }) {
  const key = kind === 'sl' ? KEY.posSl(position.tradeId) : KEY.posTp(position.tradeId);
  const level = (kind === 'sl' ? position.sl : position.tp) ?? position.avgPrice;
  const dragPrice = useDragPrice(key);
  const at = dragPrice ?? level;
  const value = pnl(spec, position.qty > 0 ? 1 : -1, Math.abs(position.qty), position.avgPrice, at);
  const remove = async () => {
    if (kind === 'sl') {
      const ok = await confirm({
        title: 'Remove your stop-loss?',
        body: 'The position will have no protection — a fast move could take a large part of your buffer.',
        confirmLabel: 'Remove stop',
        tone: 'danger',
      });
      if (!ok) return;
      await setBracket(position.accountId, position.symbol, { sl: null }, position.tradeId);
    } else await setBracket(position.accountId, position.symbol, { tp: null }, position.tradeId);
  };
  return (
    <LineTag
      ctrl={ctrl}
      lineKey={key}
      tone={kind}
      draggable
      onClose={() => void remove()}
      closeLabel={kind === 'sl' ? 'Remove stop-loss' : 'Remove take-profit'}
      title={`${kind === 'sl' ? 'Stop-loss' : 'Take-profit'} ${fmtPrice(spec, level)} — drag to move`}
    >
      <Seg className={clsx('font-semibold', kind === 'sl' ? 'bg-loss text-white' : 'bg-profit text-black')}>{kind === 'sl' ? 'SL' : 'TP'}</Seg>
      {dragPrice != null && <Seg className="text-fg">{fmtPrice(spec, dragPrice)}</Seg>}
      <Seg className={clsx('font-medium', pnlTone(value))}>{fmtMoney(value, { sign: true })}</Seg>
    </LineTag>
  );
}

function OrderTags({ ctrl, order, spec }: { ctrl: ChartController; order: Order; spec: InstrumentSpec }) {
  const key = KEY.order(order.id);
  const dragPrice = useDragPrice(key);
  const slDrag = useDragPrice(KEY.orderSl(order.id));
  const tpDrag = useDragPrice(KEY.orderTp(order.id));
  const dir = order.side === 'buy' ? 1 : -1;
  const ref = order.price ?? 0;
  const at = (lvl: number) => pnl(spec, dir, order.qty, dragPrice ?? ref, lvl);
  return (
    <>
      <LineTag ctrl={ctrl} lineKey={key} tone="order" draggable onClose={() => void cancelOrder(order)} closeLabel="Cancel order" title="Working order — drag to move">
        <Seg className={clsx('font-semibold', order.side === 'buy' ? 'text-profit' : 'text-loss')}>
          {order.side === 'buy' ? 'BUY' : 'SELL'} {TYPE_SHORT[order.type]} {fmtQty(spec, order.qty)}
        </Seg>
        {dragPrice != null && <Seg className="text-fg">{fmtPrice(spec, dragPrice)}</Seg>}
      </LineTag>
      {order.sl != null && (
        <LineTag ctrl={ctrl} lineKey={KEY.orderSl(order.id)} tone="draft" draggable onClose={() => void modifyOrder(order, { sl: null })} closeLabel="Remove the order's stop-loss">
          <Seg className="text-loss">{TYPE_SHORT[order.type]} SL</Seg>
          <Seg className={pnlTone(at(slDrag ?? order.sl))}>{fmtMoney(at(slDrag ?? order.sl), { sign: true })}</Seg>
        </LineTag>
      )}
      {order.tp != null && (
        <LineTag ctrl={ctrl} lineKey={KEY.orderTp(order.id)} tone="draft" draggable onClose={() => void modifyOrder(order, { tp: null })} closeLabel="Remove the order's take-profit">
          <Seg className="text-profit">{TYPE_SHORT[order.type]} TP</Seg>
          <Seg className={pnlTone(at(tpDrag ?? order.tp))}>{fmtMoney(at(tpDrag ?? order.tp), { sign: true })}</Seg>
        </LineTag>
      )}
    </>
  );
}

// ───────────────────────────── Ticket preview ─────────────────────────────

export const DraftOverlay = memo(function DraftOverlay({ ctrl, accountId, symbol, spec }: OverlayProps) {
  const ticket = useTrade((s) => s.ticket);
  const preview = useTrade((s) => s.preview);
  const quote = useQuote(symbol);
  const positions = useChartPositions(accountId, symbol);
  const position = useMemo(() => combinePositions(positions), [positions]);
  const active = preview && ticket.symbol === symbol;
  const calc = useMemo(() => (active ? calcTicket(ticket, spec, quote, position) : null), [active, ticket, spec, quote, position]);

  // A preview level identical to an open position's bracket is already drawn by that position's line.
  const same = (a: number | null | undefined, b: number | null | undefined) => a != null && b != null && Math.abs(a - b) < spec.tickSize / 2;
  const levels = {
    price: calc && ticket.type !== 'market' && ticket.price != null && ticket.price > 0 ? roundPrice(spec, ticket.price) : null,
    sl: calc?.sl != null && !positions.some((p) => same(calc.sl, p.sl)) ? calc.sl : null,
    tp: calc?.tp != null && !positions.some((p) => same(calc.tp, p.tp)) ? calc.tp : null,
  };
  const specs = draftLineSpecs(levels);
  const sig = specsSignature(specs);
  useEffect(() => {
    ctrl.setGroup('draft', specs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctrl, sig]);
  useEffect(() => () => ctrl.setGroup('draft', []), [ctrl]);

  if (!calc) return null;
  const sideTxt = ticket.side === 'buy' ? 'BUY' : 'SELL';
  return (
    <>
      {levels.price != null && (
        <DraftPriceTag ctrl={ctrl} spec={spec} label={`${sideTxt} ${TYPE_SHORT[ticket.type]} ${calc.qty > 0 ? fmtQty(spec, calc.qty) : ''}`} buy={ticket.side === 'buy'} />
      )}
      {levels.sl != null && <DraftBracketTag ctrl={ctrl} spec={spec} kind="sl" value={calc.risk != null ? -calc.risk : null} entry={calc.entry} qty={calc.qty} buy={ticket.side === 'buy'} />}
      {levels.tp != null && <DraftBracketTag ctrl={ctrl} spec={spec} kind="tp" value={calc.reward} entry={calc.entry} qty={calc.qty} buy={ticket.side === 'buy'} />}
    </>
  );
});

function DraftPriceTag({ ctrl, spec, label, buy }: { ctrl: ChartController; spec: InstrumentSpec; label: string; buy: boolean }) {
  const dragPrice = useDragPrice(KEY.draftPrice);
  return (
    <LineTag ctrl={ctrl} lineKey={KEY.draftPrice} tone="draft" draggable title="Ticket order (not placed) — drag to set the price">
      <Seg className="text-faint">TICKET</Seg>
      <Seg className={buy ? 'text-profit' : 'text-loss'}>{label.trim()}</Seg>
      {dragPrice != null && <Seg className="text-fg">{fmtPrice(spec, dragPrice)}</Seg>}
    </LineTag>
  );
}

function DraftBracketTag({
  ctrl,
  spec,
  kind,
  value,
  entry,
  qty,
  buy,
}: {
  ctrl: ChartController;
  spec: InstrumentSpec;
  kind: 'sl' | 'tp';
  value: number | null;
  entry: number | null;
  qty: number;
  buy: boolean;
}) {
  const key = kind === 'sl' ? KEY.draftSl : KEY.draftTp;
  const dragPrice = useDragPrice(key);
  const shown = dragPrice != null && entry != null && qty > 0 ? pnl(spec, buy ? 1 : -1, qty, entry, dragPrice) : value;
  return (
    <LineTag
      ctrl={ctrl}
      lineKey={key}
      tone="draft"
      draggable
      onClose={() => useTrade.getState().patchBracket(kind, { on: false })}
      closeLabel={kind === 'sl' ? 'Turn off the ticket stop-loss' : 'Turn off the ticket take-profit'}
      title={`Ticket ${kind === 'sl' ? 'stop-loss' : 'take-profit'} (not placed) — drag to adjust`}
    >
      <Seg className={kind === 'sl' ? 'text-loss' : 'text-profit'}>TICKET {kind === 'sl' ? 'SL' : 'TP'}</Seg>
      {dragPrice != null && <Seg className="text-fg">{fmtPrice(spec, dragPrice)}</Seg>}
      {shown != null && <Seg className={pnlTone(shown)}>{fmtMoney(shown, { sign: true })}</Seg>}
    </LineTag>
  );
}

// ───────────────────────────── Rule levels (where the account would breach) ─────────────────────────────

export const RuleOverlay = memo(function RuleOverlay({ ctrl, account, symbol, spec }: { ctrl: ChartController; account: Account | null; symbol: string; spec: InstrumentSpec }) {
  const position = useChartPosition(account?.id ?? null, symbol);
  const live = useLiveAccount(position ? account : null);
  const quote = useQuote(position ? symbol : null);

  const levels = useMemo(() => {
    const none = { maxLoss: null, dailyLoss: null, maxBuf: null, dailyBuf: null };
    if (!position || !live || !quote || account?.status !== 'active') return none;
    const long = position.qty > 0;
    const mark = long ? quote.bid : quote.ask;
    const perPoint = Math.abs(position.qty) * spec.multiplier;
    const at = (buffer: number | null) => {
      if (buffer == null || !(buffer > 0) || !(perPoint > 0)) return null;
      const lvl = long ? mark - buffer / perPoint : mark + buffer / perPoint;
      return lvl > 0 ? roundPrice(spec, lvl) : null;
    };
    // Coarse rounding keeps the line from re-rendering on every tick.
    const maxBuf = live.figures.maxLossBuffer;
    const dailyBuf = live.figures.dailyLossBuffer;
    return { maxLoss: at(maxBuf), dailyLoss: at(dailyBuf), maxBuf, dailyBuf };
  }, [position, live, quote, spec, account?.status]);

  const specs = ruleLineSpecs({ maxLoss: levels.maxLoss, dailyLoss: levels.dailyLoss });
  const sig = specsSignature(specs);
  useEffect(() => {
    ctrl.setGroup('rules', specs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctrl, sig]);
  useEffect(() => () => ctrl.setGroup('rules', []), [ctrl]);

  // Positions in other symbols (this symbol's positions all move with the price and are counted above).
  const multi = useApp((s) => {
    if (!account) return false;
    for (const p of Object.values(s.positions)) if (p.accountId === account.id && p.symbol !== symbol) return true;
    return false;
  });
  const note = multi ? ' Assumes your other positions stay where they are.' : '';
  return (
    <>
      {levels.maxLoss != null && (
        <LineTag
          ctrl={ctrl}
          lineKey={KEY.maxLoss}
          tone="rule"
          title={`If ${symbol} trades at ${fmtPrice(spec, levels.maxLoss)} your equity reaches the max-loss limit and the account fails.${note}`}
        >
          <Seg className="font-semibold">MAX LOSS</Seg>
          <Seg>≈ {fmtMoney(-(levels.maxBuf ?? 0))}</Seg>
        </LineTag>
      )}
      {levels.dailyLoss != null && (
        <LineTag
          ctrl={ctrl}
          lineKey={KEY.dailyLoss}
          tone="rule"
          title={`If ${symbol} trades at ${fmtPrice(spec, levels.dailyLoss)} you hit today's loss limit.${note}`}
        >
          <Seg className="font-semibold">DAILY LIMIT</Seg>
          <Seg>≈ {fmtMoney(-(levels.dailyBuf ?? 0))}</Seg>
        </LineTag>
      )}
    </>
  );
});
