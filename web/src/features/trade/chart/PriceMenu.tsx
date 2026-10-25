// "+" handle that follows the crosshair next to the price axis. Clicking it opens a small menu for that
// price: stage a limit/stop order in the ticket (never placed directly — the ticket's check-in, risk box
// and confirmation still apply), or move the open positions' stop / target there.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Plus } from 'lucide-react';
import type { InstrumentSpec } from '@shared/types';
import { ticksBetween } from '@shared/risk';
import { distUnit, ticksToUnits } from '../ticket/riskMath';
import { fmtPrice } from '@/lib/format';
import { getQuote } from '@/store/market';
import { setBracket } from '../actions';
import { useTrade } from '../store';
import { setTicketBracketFromPrice } from '../ticket/ticketActions';
import type { ChartController } from './controller';
import { useChartPositions } from './overlays';

interface MenuState {
  price: number;
  y: number;
  right: number;
}

function Item({ onClick, children, disabled, hint }: { onClick: () => void; children: ReactNode; disabled?: boolean; hint?: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={hint}
      className="flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-[13px] text-fg transition-colors hover:bg-panel-3 disabled:pointer-events-none disabled:opacity-35"
    >
      {children}
    </button>
  );
}

export function PriceMenu({ ctrl, accountId, symbol, spec }: { ctrl: ChartController; accountId: string | null; symbol: string; spec: InstrumentSpec }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const positions = useChartPositions(accountId, symbol);
  const position = positions[0] ?? null;
  const many = positions.length > 1;

  const handleRef = useCallback(
    (el: HTMLButtonElement | null) => {
      if (el) return ctrl.setPlusHandle(el);
    },
    [ctrl],
  );

  useEffect(() => {
    if (!menu) return;
    const down = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setMenu(null);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(null);
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [menu]);

  useEffect(() => setMenu(null), [symbol]);

  const open = () => {
    const price = ctrl.plusPrice;
    const y = ctrl.plusY;
    if (price != null && y != null && price > 0) setMenu({ price, y, right: ctrl.priceScaleWidth() + 28 });
  };

  let content: ReactNode = null;
  if (menu) {
    const q = getQuote(symbol);
    const p = menu.price;
    const px = fmtPrice(spec, p);
    const stage = (side: 'buy' | 'sell', type: 'limit' | 'stop') => {
      useTrade.getState().stage({ side, type, price: p });
      setMenu(null);
    };
    const buyType = q && p >= q.ask ? 'stop' : 'limit';
    const sellType = q && p <= q.bid ? 'stop' : 'limit';
    const ref = q ? (p >= q.ask ? q.ask : p <= q.bid ? q.bid : null) : null;
    const unit = distUnit(spec);
    const dist =
      q && ref != null
        ? `${ticksToUnits(spec, ticksBetween(spec, p, ref))} ${unit.label.toLowerCase()} ${p > ref ? 'above the ask' : 'below the bid'}`
        : q
          ? 'inside the spread'
          : '';
    const long = position ? position.qty > 0 : null;
    const mark = position && q ? (long ? q.bid : q.ask) : null;
    const slOk = position && mark != null ? (long ? p < mark : p > mark) : false;
    const tpOk = position && mark != null ? (long ? p > mark : p < mark) : false;
    const ticketSide = useTrade.getState().ticket.side;
    content = (
      <div
        ref={boxRef}
        data-chart-ui
        className="pointer-events-auto absolute z-40 w-60 animate-pop-in rounded-lg border border-line-strong bg-panel-2 p-1 shadow-pop"
        style={{ right: menu.right, top: Math.max(4, menu.y - 16) }}
      >
        <div className="flex items-baseline justify-between px-2 pb-1 pt-1">
          <span className="num text-[13px] font-semibold text-fg">{px}</span>
          <span className="text-2xs text-faint">{dist}</span>
        </div>
        <div className="my-1 h-px bg-line" />
        <Item onClick={() => stage('buy', buyType)} hint="Loads the order into the ticket — review and place it there">
          <span>
            <span className="text-profit">Buy {buyType}</span> @ {px}
          </span>
          <span className="text-2xs text-faint">ticket</span>
        </Item>
        <Item onClick={() => stage('sell', sellType)} hint="Loads the order into the ticket — review and place it there">
          <span>
            <span className="text-loss">Sell {sellType}</span> @ {px}
          </span>
          <span className="text-2xs text-faint">ticket</span>
        </Item>
        <div className="my-1 h-px bg-line" />
        {position && accountId ? (
          <>
            <Item
              disabled={!slOk}
              hint={slOk ? undefined : 'A stop must be on the losing side of the current price'}
              onClick={() => {
                setMenu(null);
                void setBracket(accountId, symbol, { sl: p });
              }}
            >
              <span>{many ? 'Move all stop-losses here' : 'Move stop-loss here'}</span>
              {many && <span className="text-2xs text-faint">{positions.length} positions</span>}
            </Item>
            <Item
              disabled={!tpOk}
              hint={tpOk ? undefined : 'A target must be on the winning side of the current price'}
              onClick={() => {
                setMenu(null);
                void setBracket(accountId, symbol, { tp: p });
              }}
            >
              <span>{many ? 'Move all take-profits here' : 'Move take-profit here'}</span>
              {many && <span className="text-2xs text-faint">{positions.length} positions</span>}
            </Item>
          </>
        ) : (
          <>
            <Item
              onClick={() => {
                setMenu(null);
                setTicketBracketFromPrice('sl', p);
              }}
            >
              <span>Ticket stop-loss here</span>
              <span className="text-2xs text-faint">{ticketSide}</span>
            </Item>
            <Item
              onClick={() => {
                setMenu(null);
                setTicketBracketFromPrice('tp', p);
              }}
            >
              <span>Ticket take-profit here</span>
              <span className="text-2xs text-faint">{ticketSide}</span>
            </Item>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <button
        ref={handleRef}
        type="button"
        data-chart-ui
        aria-label="Order at this price"
        title="Order at this price"
        onPointerEnter={() => ctrl.setPlusHovered(true)}
        onPointerLeave={() => ctrl.setPlusHovered(false)}
        onClick={open}
        className={clsx(
          'pointer-events-auto absolute left-0 top-0 z-30 flex size-[18px] items-center justify-center rounded-sm border border-line-strong bg-panel-3 text-muted transition-colors hover:border-fg hover:bg-fg hover:text-bg',
        )}
      >
        <Plus size={12} strokeWidth={2.5} />
      </button>
      {content}
    </>
  );
}
