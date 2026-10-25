// Position / order actions shared by the ticket, the chart and the bottom panel.
// Errors become a toast (silent, like TradingView). Successful REST responses are applied to the store right away
// (only for objects the store still holds, so a late response can never resurrect a filled order).

import type { ModifyOrderRequest } from '@shared/api';
import type { Order, Position } from '@shared/types';
import { api, errorMessage } from '@/api/client';
import { useApp } from '@/store/app';
import { toast } from '@/components/ui/Toast';

export function reportError(title: string, e: unknown): void {
  toast({ tone: 'loss', title, description: errorMessage(e) });
}

function applyPosition(p: Position | null | undefined): void {
  if (!p || typeof p !== 'object' || !p.tradeId) return;
  const s = useApp.getState();
  if (s.positions[p.tradeId]) s.apply({ type: 'position', position: p });
}

function applyOrder(o: Order | null | undefined): void {
  if (!o || typeof o !== 'object' || !o.id) return;
  const s = useApp.getState();
  if (s.orders[o.id]) s.apply({ type: 'order', order: o });
}

/** Close one position (`tradeId`) or all of the symbol's positions, oldest first; `qty` = partial close. */
export async function closePosition(accountId: string, symbol: string, qty?: number, tradeId?: string): Promise<boolean> {
  try {
    await api.closePosition({ accountId, symbol, qty, tradeId });
    return true;
  } catch (e) {
    reportError(qty ? `Partial close of ${symbol} failed` : `Close ${symbol} failed`, e);
    return false;
  }
}

export async function reversePosition(accountId: string, symbol: string): Promise<boolean> {
  try {
    await api.reversePosition({ accountId, symbol });
    return true;
  } catch (e) {
    reportError(`Reverse ${symbol} failed`, e);
    return false;
  }
}

export async function flattenAccount(accountId: string): Promise<boolean> {
  try {
    await api.flattenAccount(accountId);
    return true;
  } catch (e) {
    reportError('Flatten failed', e);
    return false;
  }
}

/** Stop / target of one position (`tradeId`) or of all the symbol's positions. */
export async function setBracket(accountId: string, symbol: string, patch: { sl?: number | null; tp?: number | null }, tradeId?: string): Promise<boolean> {
  try {
    const changed = await api.setBracket({ accountId, symbol, tradeId, ...patch });
    if (Array.isArray(changed)) changed.forEach(applyPosition);
    return true;
  } catch (e) {
    reportError(patch.sl !== undefined ? 'Stop-loss not changed' : 'Take-profit not changed', e);
    return false;
  }
}

export async function modifyOrder(order: Order, patch: ModifyOrderRequest): Promise<boolean> {
  try {
    const o = await api.modifyOrder(order.id, patch);
    applyOrder(o);
    return true;
  } catch (e) {
    reportError('Order not modified', e);
    return false;
  }
}

export async function cancelOrder(order: Order): Promise<boolean> {
  try {
    const o = await api.cancelOrder(order.id);
    applyOrder(o);
    return true;
  } catch (e) {
    reportError('Cancel failed', e);
    return false;
  }
}

export async function cancelOrders(orders: Order[]): Promise<void> {
  if (!orders.length) return;
  const results = await Promise.allSettled(orders.map((o) => api.cancelOrder(o.id)));
  let firstError: unknown = null;
  results.forEach((r) => {
    if (r.status === 'fulfilled') applyOrder(r.value);
    else firstError ??= r.reason;
  });
  if (firstError) reportError(`Some orders were not cancelled`, firstError);
}
