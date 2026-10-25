// What happens when a dragged chart line is released: validate, then modify the position bracket /
// working order through the API (or update the ticket for preview lines). Reverts the line on failure.

import type { InstrumentSpec } from '@shared/types';
import { validateBracket } from '@shared/risk';
import { fmtPrice } from '@/lib/format';
import { useApp } from '@/store/app';
import { getQuote } from '@/store/market';
import { confirm, toast } from '@/components/ui/Toast';
import { modifyOrder, setBracket } from '../actions';
import { useTrade } from '../store';
import { setTicketBracketFromPrice, setTicketPrice } from '../ticket/ticketActions';
import type { ChartController, LineSpec } from './controller';

function refuse(ctrl: ChartController, key: string, description: string) {
  toast({ tone: 'warn', title: 'Line not moved', description });
  ctrl.settle(key, null);
}

export async function commitDrag(ctrl: ChartController, line: LineSpec, price: number, accountId: string | null, symbol: string, spec: InstrumentSpec): Promise<void> {
  const t = line.drag;
  if (!t) return ctrl.settle(line.key, null);

  if (t.kind === 'draft') {
    if (t.field === 'price') setTicketPrice(price);
    else setTicketBracketFromPrice(t.field, price);
    ctrl.settle(line.key, price);
    return;
  }
  if (!accountId) return ctrl.settle(line.key, null);
  const q = getQuote(symbol);

  if (t.kind === 'sl' || t.kind === 'tp') {
    const pos = useApp.getState().positions[t.tradeId];
    if (!pos) return ctrl.settle(line.key, null);
    const dir = pos.qty > 0 ? 1 : -1;
    const mark = q ? (dir > 0 ? q.bid : q.ask) : pos.markPrice;
    const err = validateBracket(dir, mark, t.kind === 'sl' ? price : undefined, t.kind === 'tp' ? price : undefined);
    if (err) return refuse(ctrl, line.key, `${err} (${dir > 0 ? 'bid' : 'ask'} ${fmtPrice(spec, mark)}).`);
    const ok = await setBracket(accountId, symbol, t.kind === 'sl' ? { sl: price } : { tp: price }, t.tradeId);
    ctrl.settle(line.key, ok ? price : null);
    return;
  }

  if (t.kind !== 'order') return ctrl.settle(line.key, null);
  const order = useApp.getState().orders[t.orderId];
  if (!order) return ctrl.settle(line.key, null);

  if (t.field === 'price') {
    if (q) {
      const crosses =
        order.type === 'limit' ? (order.side === 'buy' ? price >= q.ask : price <= q.bid) : order.side === 'buy' ? price <= q.ask : price >= q.bid;
      if (crosses) {
        const ok = await confirm({
          title: `Move the ${order.side} ${order.type} through the market?`,
          body: `At ${fmtPrice(spec, price)} this order ${order.type === 'limit' ? 'is marketable and fills immediately' : 'triggers immediately'} at the current ${
            order.side === 'buy' ? 'ask' : 'bid'
          }.`,
          confirmLabel: 'Move it',
          tone: order.side === 'buy' ? 'buy' : 'sell',
        });
        if (!ok) return ctrl.settle(line.key, null);
      }
    }
    const ok = await modifyOrder(order, { price });
    ctrl.settle(line.key, ok ? price : null);
    return;
  }

  const dir = order.side === 'buy' ? 1 : -1;
  const ref = order.price ?? (q ? (dir > 0 ? q.ask : q.bid) : price);
  const err = validateBracket(dir, ref, t.field === 'sl' ? price : undefined, t.field === 'tp' ? price : undefined);
  if (err) return refuse(ctrl, line.key, `${err} (order at ${fmtPrice(spec, ref)}).`);
  const ok = await modifyOrder(order, t.field === 'sl' ? { sl: price } : { tp: price });
  ctrl.settle(line.key, ok ? price : null);
}

/** Shift+click on the chart: stage a passive limit order at that price in the ticket. */
export function stageLimitAt(symbol: string, price: number): void {
  const q = getQuote(symbol);
  if (!q) return;
  if (price < q.bid) useTrade.getState().stage({ side: 'buy', type: 'limit', price });
  else if (price > q.ask) useTrade.getState().stage({ side: 'sell', type: 'limit', price });
}
