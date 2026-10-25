// Bar over the chart for the selected drawing: what it is, "Use in order ticket" for a long / short
// position (stages its entry, stop-loss and take-profit — the ticket still checks and places it), delete.

import { SendHorizontal, Trash2 } from 'lucide-react';
import type { Drawing, OrderType } from '@shared/types';
import { isPositionKind, positionLevels } from '@shared/drawings';
import { getQuote } from '@/store/market';
import { Button, IconButton } from '@/components/ui/Button';
import { useTrade } from '../../store';
import { setTicketBracketFromPrice } from '../../ticket/ticketActions';
import { DRAWING_LABELS, useDrawings } from './store';

function stageInTicket(d: Drawing): void {
  const lv = positionLevels(d);
  if (!lv) return;
  const q = getQuote(d.symbol);
  const ref = q ? (lv.dir > 0 ? q.ask : q.bid) : null;
  // An entry better than the market waits as a limit; one the market has to reach first is a stop order.
  const type: OrderType = ref == null || (lv.entry - ref) * lv.dir < 0 ? 'limit' : 'stop';
  useTrade.getState().stage({ side: lv.dir > 0 ? 'buy' : 'sell', type, price: lv.entry });
  setTicketBracketFromPrice('sl', lv.sl);
  setTicketBracketFromPrice('tp', lv.tp);
}

export function SelectionBar({ symbol }: { symbol: string }) {
  const d = useDrawings((s) => (s.selectedId ? s.bySymbol[symbol]?.find((x) => x.id === s.selectedId) : undefined));
  if (!d) return null;
  return (
    <div data-chart-ui className="pointer-events-auto absolute left-1/2 top-2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-md border border-line-strong bg-panel/95 py-1 pl-2.5 pr-1 shadow-pop">
      <span className="mr-1 text-xs text-muted">{DRAWING_LABELS[d.kind]}</span>
      {isPositionKind(d.kind) && (
        <Button size="xs" variant="secondary" icon={<SendHorizontal size={12} />} onClick={() => stageInTicket(d)}>
          Use in order ticket
        </Button>
      )}
      <IconButton size="xs" label="Delete (Del)" icon={<Trash2 size={13} />} onClick={() => useDrawings.getState().remove(d)} />
    </div>
  );
}
