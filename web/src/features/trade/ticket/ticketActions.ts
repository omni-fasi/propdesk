// Ticket mutations triggered from outside the ticket (chart drags, chart menu).

import { useApp } from '@/store/app';
import { getQuote } from '@/store/market';
import { useTrade } from '../store';
import { bracketValueFromPrice, entryRef, type BracketKind, type BracketMode } from './riskMath';

/** Put a SL/TP of the ticket at `price`, keeping the field's mode when it can express that price. */
export function setTicketBracketFromPrice(kind: BracketKind, price: number): void {
  const { ticket, patchBracket } = useTrade.getState();
  const spec = useApp.getState().instrumentMap[ticket.symbol];
  if (!spec) return;
  const entry = entryRef(ticket.type, ticket.side, ticket.price, getQuote(ticket.symbol));
  const dir = ticket.side === 'buy' ? 1 : -1;
  // Relative modes can only express the correct side; a level on the wrong side stays absolute so the
  // ticket shows the problem instead of silently mirroring it.
  const wrongSide = entry != null && (kind === 'sl' ? (price - entry) * dir >= 0 : (price - entry) * dir <= 0);
  let mode: BracketMode = ticket[kind].mode;
  if (wrongSide) mode = 'price';
  if (mode === 'usd' && kind === 'sl' && ticket.sizeMode === 'risk') mode = 'dist';
  const value = bracketValueFromPrice(spec, mode, price, entry, ticket.qty ?? spec.minQty);
  if (value == null) return;
  patchBracket(kind, { on: true, mode, value });
}

export function setTicketPrice(price: number): void {
  const { ticket, patchTicket } = useTrade.getState();
  if (ticket.type === 'market') return;
  patchTicket({ price });
}
