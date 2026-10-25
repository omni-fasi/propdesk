// Working orders of the active account: inline price / qty modify, attached bracket, cancel.

import clsx from 'clsx';
import { X } from 'lucide-react';
import type { InstrumentSpec, Order } from '@shared/types';
import { validateBracket } from '@shared/risk';
import { fmtPrice, fmtQty, fmtTime } from '@/lib/format';
import { useApp } from '@/store/app';
import { useAccountOrders } from '@/store/hooks';
import { getQuote } from '@/store/market';
import { IconButton } from '@/components/ui/Button';
import { confirm, toast } from '@/components/ui/Toast';
import { cancelOrder, modifyOrder } from '../actions';
import { useTrade } from '../store';
import { Empty, InlineNumber, Table, Td, Th } from './table';

const TYPE_TXT = { market: 'MKT', limit: 'LMT', stop: 'STP' } as const;

async function changePrice(order: Order, spec: InstrumentSpec, price: number): Promise<boolean> {
  const q = getQuote(order.symbol);
  if (q) {
    const crosses = order.type === 'limit' ? (order.side === 'buy' ? price >= q.ask : price <= q.bid) : order.side === 'buy' ? price <= q.ask : price >= q.bid;
    if (crosses) {
      const ok = await confirm({
        title: 'This price is through the market',
        body: `At ${fmtPrice(spec, price)} the order ${order.type === 'limit' ? 'fills immediately' : 'triggers immediately'}.`,
        confirmLabel: 'Change it',
        tone: order.side === 'buy' ? 'buy' : 'sell',
      });
      if (!ok) return false;
    }
  }
  return modifyOrder(order, { price });
}

async function changeBracket(order: Order, spec: InstrumentSpec, kind: 'sl' | 'tp', v: number): Promise<boolean> {
  const dir = order.side === 'buy' ? 1 : -1;
  if (order.price != null) {
    const err = validateBracket(dir, order.price, kind === 'sl' ? v : undefined, kind === 'tp' ? v : undefined);
    if (err) {
      toast({ tone: 'warn', title: 'Not changed', description: `${err} (order at ${fmtPrice(spec, order.price)}).` });
      return false;
    }
  }
  return modifyOrder(order, kind === 'sl' ? { sl: v } : { tp: v });
}

function OrderRow({ order, spec }: { order: Order; spec: InstrumentSpec }) {
  const selectSymbol = useTrade((s) => s.selectSymbol);
  const bracket = (kind: 'sl' | 'tp') => {
    const v = kind === 'sl' ? order.sl : order.tp;
    return (
      <InlineNumber
        value={v}
        display={v != null ? fmtPrice(spec, v) : <span className="text-faint">+ add</span>}
        step={spec.tickSize}
        precision={spec.pricePrecision}
        min={0}
        onCommit={(x) => changeBracket(order, spec, kind, x)}
        onClear={() => void modifyOrder(order, kind === 'sl' ? { sl: null } : { tp: null })}
        clearLabel={kind === 'sl' ? 'Remove stop-loss' : 'Remove take-profit'}
      />
    );
  };
  return (
    <tr className="hover:bg-panel-2">
      <Td>
        <button className="font-semibold text-fg hover:underline" onClick={() => selectSymbol(order.symbol)}>
          {order.symbol}
        </button>
      </Td>
      <Td>
        <span className={clsx('text-xs font-semibold', order.side === 'buy' ? 'text-profit' : 'text-loss')}>{order.side === 'buy' ? 'BUY' : 'SELL'}</span>
      </Td>
      <Td className="text-xs text-muted">
        {TYPE_TXT[order.type]}
        {order.reduceOnly && <span className="ml-1 text-faint">RO</span>}
      </Td>
      <Td right>
        <InlineNumber
          value={order.qty}
          display={fmtQty(spec, order.qty)}
          step={spec.qtyStep}
          precision={spec.qtyPrecision}
          min={spec.minQty}
          onCommit={(q) => modifyOrder(order, { qty: q })}
        />
      </Td>
      <Td right>
        {order.price != null ? (
          <InlineNumber value={order.price} display={fmtPrice(spec, order.price)} step={spec.tickSize} precision={spec.pricePrecision} min={0} onCommit={(p) => changePrice(order, spec, p)} />
        ) : (
          <span className="text-faint">—</span>
        )}
      </Td>
      <Td>{bracket('sl')}</Td>
      <Td>{bracket('tp')}</Td>
      <Td className="tnum text-muted">{fmtTime(order.createdAt)}</Td>
      <Td right>
        <IconButton size="xs" label="Cancel order" icon={<X size={13} />} onClick={() => void cancelOrder(order)} />
      </Td>
    </tr>
  );
}

export function OrdersTab({ accountId }: { accountId: string | null }) {
  const orders = useAccountOrders(accountId);
  const instrumentMap = useApp((s) => s.instrumentMap);
  if (!accountId) return <Empty>Select or create an account to see orders.</Empty>;
  if (!orders.length) return <Empty>No working orders. Limit and stop orders rest here until they fill.</Empty>;
  return (
    <Table>
      <thead>
        <tr>
          <Th>Symbol</Th>
          <Th>Side</Th>
          <Th>Type</Th>
          <Th right>Qty</Th>
          <Th right>Price</Th>
          <Th>SL on fill</Th>
          <Th>TP on fill</Th>
          <Th>Placed</Th>
          <Th right />
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => {
          const spec = instrumentMap[o.symbol];
          return spec ? <OrderRow key={o.id} order={o} spec={spec} /> : null;
        })}
      </tbody>
    </Table>
  );
}
