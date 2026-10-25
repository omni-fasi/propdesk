// Ticket submission: revenge guard → confirmation (per settings; hold-to-confirm when risky) → place.

import { createElement } from 'react';
import type { PlaceOrderRequest } from '@shared/api';
import type { Account, InstrumentSpec, Settings } from '@shared/types';
import { notional } from '@shared/risk';
import { api } from '@/api/client';
import { fmtPrice, fmtQty } from '@/lib/format';
import { serverNow, useApp } from '@/store/app';
import { confirm, toast } from '@/components/ui/Toast';
import { reportError } from '../actions';
import { lastClosedTrade } from '../dayData';
import { useTrade, type Ticket } from '../store';
import type { TicketChecks } from './checks';
import { isEntry, type TicketCalc } from './riskMath';
import { askRevengeGuard } from './RevengeGuard';
import { OrderSummary } from './OrderSummary';

const TYPE_TXT = { market: 'Market', limit: 'LMT', stop: 'STP' } as const;

export function orderLabel(spec: InstrumentSpec, ticket: Pick<Ticket, 'side' | 'type' | 'price'>, qty: number): string {
  const side = ticket.side === 'buy' ? 'Buy' : 'Sell';
  const q = qty > 0 ? `${fmtQty(spec, qty)} ` : '';
  const at = ticket.type === 'market' ? 'Market' : `${ticket.price != null ? fmtPrice(spec, ticket.price) : '…'} ${TYPE_TXT[ticket.type]}`;
  return `${side} ${q}${spec.symbol} @ ${at}`;
}

const REVENGE_WINDOW_MS = 120_000;

async function revengeCheck(account: Account, spec: InstrumentSpec, calc: TicketCalc, settings: Settings): Promise<boolean> {
  if (!settings.revengeGuard || !isEntry(calc.effect)) return true;
  const t = lastClosedTrade(account.id);
  if (!t || t.closedAt == null || !(t.netPnl < 0)) return true;
  const ago = serverNow() - t.closedAt;
  if (ago < 0 || ago > REVENGE_WINDOW_MS) return true;
  let bigger = false;
  let sizeText = '';
  if (t.symbol === spec.symbol) {
    bigger = calc.qty > t.maxQty + 1e-9;
    sizeText = `${fmtQty(spec, calc.qty)} vs ${fmtQty(spec, t.maxQty)} ${spec.unitLabel}`;
  } else {
    const prevSpec = useApp.getState().instrumentMap[t.symbol];
    const prevNotional = prevSpec ? notional(prevSpec, t.maxQty, t.avgEntry) : 0;
    bigger = prevNotional > 0 && calc.notional > prevNotional * 1.0001;
    sizeText = `${fmtQty(spec, calc.qty)} ${spec.symbol} vs ${t.maxQty} ${t.symbol} by notional`;
  }
  if (!bigger) return true;
  const choice = await askRevengeGuard(t, ago, sizeText);
  if (choice === 'place') return true;
  if (choice === 'break') {
    try {
      const acc = await api.takeBreak(account.id, { minutes: 5, message: 'Voluntary 5-minute break after a loss' });
      if (acc && acc.id) useApp.getState().apply({ type: 'account', account: acc });
      toast({ tone: 'neutral', title: 'Break started', description: 'New entries are paused for 5 minutes. You can still manage open positions.' });
    } catch (e) {
      reportError('Break not started', e);
    }
  }
  return false;
}

export interface SubmitArgs {
  account: Account;
  spec: InstrumentSpec;
  ticket: Ticket;
  calc: TicketCalc;
  checks: TicketChecks;
  settings: Settings;
}

/** Returns true when the order was accepted by the server. */
export async function submitTicket({ account, spec, ticket, calc, checks, settings }: SubmitArgs): Promise<boolean> {
  if (!(await revengeCheck(account, spec, calc, settings))) return false;

  const entry = isEntry(calc.effect);
  const needConfirm = settings.confirmOrders === 'always' || (settings.confirmOrders === 'risky' && checks.risky);
  const label = orderLabel(spec, ticket, calc.qty);
  if (needConfirm) {
    const ok = await confirm({
      title: label,
      body: createElement(OrderSummary, { spec, ticket, calc, checks }),
      confirmLabel: ticket.side === 'buy' ? 'Buy' : 'Sell',
      tone: ticket.side === 'buy' ? 'buy' : 'sell',
      holdMs: checks.risky ? 1200 : undefined,
    });
    if (!ok) return false;
  }

  const tags = entry && (ticket.mood || ticket.setup) ? { mood: ticket.mood, setup: ticket.setup } : null;
  const req: PlaceOrderRequest = {
    accountId: account.id,
    symbol: spec.symbol,
    side: ticket.side,
    type: ticket.type,
    qty: calc.qty,
    price: ticket.type === 'market' ? null : ticket.price,
    sl: calc.sl ?? undefined,
    tp: calc.tp ?? undefined,
    tags,
  };

  try {
    const order = await api.placeOrder(req);
    if (order?.status === 'rejected') {
      toast({ tone: 'loss', title: 'Order rejected', description: order.rejectReason ?? 'The server rejected the order.' });
      return false;
    }
    if (order?.status === 'working') {
      toast({ tone: 'neutral', title: 'Order working', description: label });
    }
    useTrade.getState().resetCheckin();
    return true;
  } catch (e) {
    reportError('Order rejected', e);
    return false;
  }
}
