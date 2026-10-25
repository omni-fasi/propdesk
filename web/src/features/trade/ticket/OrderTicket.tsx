// Order ticket (right column): side, type, price, size or size-by-risk, SL/TP, live risk box, warnings,
// check-in, one big submit button, and position actions for the selected symbol.

import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import type { Account, InstrumentSpec, OrderType, Side } from '@shared/types';
import { NO_COMMISSION, roundPrice } from '@shared/risk';
import { fmtMoney } from '@/lib/format';
import { navigate } from '@/lib/router';
import { useApp } from '@/store/app';
import { activeLock, combinePositions, useAccountPositions, useActiveAccount, useInstrument, useNow, useSession } from '@/store/hooks';
import { useQuote } from '@/store/market';
import { Button } from '@/components/ui/Button';
import { NumberInput } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/Misc';
import { Segmented } from '@/components/ui/Tabs';
import { sessionClosedText } from '../session';
import { useTrade } from '../store';
import { useLiveAccount } from '../useLiveAccount';
import { runChecks } from './checks';
import { BracketField, Chip, Label, SideTiles, SizeField } from './fields';
import { CheckIn, PositionActions, RiskBox, Warnings } from './panels';
import { defaultDistances } from './prefs';
import { bracketPrice, bracketValueFromPrice, calcTicket, defaultOrderPrice, entryRef, isEntry, priceNote, type SizeMode } from './riskMath';
import { orderLabel, submitTicket } from './submit';

const TYPE_OPTIONS: Array<{ value: OrderType; label: string }> = [
  { value: 'market', label: 'Market' },
  { value: 'limit', label: 'Limit' },
  { value: 'stop', label: 'Stop' },
];

export function OrderTicket() {
  const symbol = useTrade((s) => s.symbol);
  const spec = useInstrument(symbol);
  const account = useActiveAccount();
  return (
    <aside className="flex w-[320px] shrink-0 flex-col border-l border-line bg-panel">
      {spec ? <TicketBody spec={spec} account={account} /> : <EmptyState compact title="Unknown instrument" description="Pick a symbol from the watchlist." />}
    </aside>
  );
}

function TicketBody({ spec, account }: { spec: InstrumentSpec; account: Account | null }) {
  const ticket = useTrade((s) => s.ticket);
  const attention = useTrade((s) => s.attention);
  const patchTicket = useTrade((s) => s.patchTicket);
  const patchBracket = useTrade((s) => s.patchBracket);
  const quote = useQuote(spec.symbol);
  const settings = useApp((s) => s.settings);
  const connected = useApp((s) => s.connected);
  const instrumentMap = useApp((s) => s.instrumentMap);
  const positions = useAccountPositions(account?.id);
  // This symbol's positions taken together: what an order does to them (add / reduce / close / flip).
  const position = useMemo(() => combinePositions(positions.filter((p) => p.symbol === spec.symbol)), [positions, spec.symbol]);
  const live = useLiveAccount(account);
  const session = useSession(spec.symbol);
  const now = useNow(5000);
  const lock = activeLock(account, now);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(false);
  const hasQuote = !!quote && quote.bid > 0 && quote.ask > 0;
  const synced = ticket.symbol === spec.symbol;

  // First-time SL/TP distances once a price is known.
  useEffect(() => {
    if (!synced || !ticket.needsDefaults || !quote) return;
    const d = defaultDistances(spec, quote.last || quote.bid);
    patchTicket({
      needsDefaults: false,
      sl: ticket.sl.value == null ? { ...ticket.sl, mode: 'dist', value: d.sl } : ticket.sl,
      tp: ticket.tp.value == null ? { ...ticket.tp, mode: 'dist', value: d.tp } : ticket.tp,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synced, ticket.needsDefaults, hasQuote, spec]);

  // Limit / stop price prefilled from the book.
  useEffect(() => {
    if (!synced || ticket.type === 'market' || ticket.price != null || !quote) return;
    patchTicket({ price: defaultOrderPrice(spec, ticket.type, ticket.side, quote) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synced, ticket.type, ticket.price == null, hasQuote, spec]);

  useEffect(() => {
    if (!attention) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 900);
    return () => clearTimeout(t);
  }, [attention]);

  // Practice accounts can switch trading fees off: the ticket then shows fee-free figures, like the engine fills.
  const feesOff = account?.rules.fees === 'off';
  const feeSpec = useMemo(() => (feesOff ? { ...spec, commission: NO_COMMISSION } : spec), [spec, feesOff]);
  const calc = useMemo(() => calcTicket(ticket, feeSpec, quote, position), [ticket, feeSpec, quote, position]);
  const checkinMissing = settings.emotionCheckin === 'required' && (!ticket.mood || !ticket.setup);
  const sessionText = sessionClosedText(session, now);
  const checks = runChecks({
    account,
    spec,
    calc,
    type: ticket.type,
    price: ticket.price,
    position,
    positions,
    instrumentMap,
    equity: live?.figures.equity ?? null,
    dayPnl: live?.figures.dayPnl ?? null,
    maxLossBuffer: live?.figures.maxLossBuffer ?? null,
    dailyLossBuffer: live?.figures.dailyLossBuffer ?? null,
    settings,
    session,
    sessionText,
    connected,
    hasQuote,
    lock,
    checkinMissing,
    sizeMode: ticket.sizeMode,
    riskInput: ticket.risk,
    valueInput: ticket.value,
    slSet: ticket.sl.on && ticket.sl.value != null && ticket.sl.value > 0,
  });
  const entryKind = isEntry(calc.effect) || calc.qty === 0;

  const setSide = (side: Side) => {
    if (side === ticket.side) return;
    patchTicket({ side, price: ticket.type === 'market' ? ticket.price : defaultOrderPrice(spec, ticket.type, side, quote) });
  };
  const setType = (type: OrderType) => {
    if (type === ticket.type) return;
    patchTicket({ type, price: type === 'market' ? null : defaultOrderPrice(spec, type, ticket.side, quote) });
  };
  const setSizeMode = (mode: SizeMode) => {
    if (mode === ticket.sizeMode) return;
    if (mode === 'risk') {
      const entry = entryRef(ticket.type, ticket.side, ticket.price, quote);
      const sl = ticket.sl.mode === 'usd' ? { ...ticket.sl, mode: 'dist' as const, value: null as number | null } : ticket.sl;
      if (ticket.sl.mode === 'usd') {
        const p = bracketPrice(spec, 'sl', ticket.sl, ticket.side, entry, ticket.qty ?? spec.minQty);
        sl.value = p != null ? bracketValueFromPrice(spec, 'dist', p, entry, ticket.qty ?? spec.minQty) : null;
      }
      patchTicket({ sizeMode: 'risk', sl: { ...sl, on: true }, risk: ticket.risk ?? (calc.risk != null && calc.risk > 0 ? Math.round(calc.risk) : null) });
    } else if (mode === 'value') {
      patchTicket({ sizeMode: 'value', value: calc.notional > 0 ? Math.round(calc.notional) : ticket.value });
    } else patchTicket({ sizeMode: 'qty', qty: calc.qty > 0 ? calc.qty : ticket.qty });
  };

  const buffer = live?.figures.maxLossBuffer ?? null;
  const riskPresets = useMemo(() => {
    if (buffer != null && buffer > 0) return [0.05, 0.1, 0.2].map((f) => ({ amount: Math.max(5, Math.round((buffer * f) / 5) * 5), label: `${f * 100}% buffer` }));
    const bal = live?.figures.balance ?? 50_000;
    return [0.0025, 0.005, 0.01].map((f) => ({ amount: Math.max(5, Math.round((bal * f) / 5) * 5), label: `${f * 100}% bal.` }));
  }, [buffer, live?.figures.balance]);

  const note = priceNote(spec, ticket.type, ticket.side, ticket.price, quote);
  const blocked = !!checks.block || busy || !synced;
  const buy = ticket.side === 'buy';

  const submit = async () => {
    if (blocked || !account) return;
    setBusy(true);
    try {
      await submitTicket({ account, spec, ticket, calc, checks, settings });
    } finally {
      setBusy(false);
    }
  };

  // Bracket fields show the price move at the level; the risk box and footer show the net figures (fees included).
  const slAmount = calc.sl != null && calc.entry != null && calc.qty > 0 ? -(calc.grossRisk ?? 0) : null;
  const tpAmount = calc.tp != null && calc.entry != null && calc.qty > 0 ? (calc.grossReward ?? 0) : null;

  return (
    <>
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">Order ticket</span>
        <span className="truncate text-2xs text-faint" title={spec.description}>
          {spec.symbol} · {spec.name}
        </span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        <SideTiles spec={spec} side={ticket.side} onSide={setSide} />
        <Segmented block size="sm" value={ticket.type} onChange={setType} options={TYPE_OPTIONS} />

        {ticket.type !== 'market' && (
          <div>
            <Label
              right={
                <span className="flex gap-1">
                  <Chip onClick={() => quote && patchTicket({ price: quote.bid })}>Bid</Chip>
                  <Chip onClick={() => quote && patchTicket({ price: roundPrice(spec, (quote.bid + quote.ask) / 2) })}>Mid</Chip>
                  <Chip onClick={() => quote && patchTicket({ price: quote.ask })}>Ask</Chip>
                </span>
              }
            >
              {ticket.type === 'limit' ? 'Limit price' : 'Stop trigger'}
            </Label>
            <NumberInput
              value={ticket.price}
              onChange={(v) => patchTicket({ price: v })}
              onBlur={() => ticket.price != null && patchTicket({ price: roundPrice(spec, ticket.price) })}
              step={spec.tickSize}
              min={0}
              precision={spec.pricePrecision}
              className="num [&_input]:text-[15px] [&_input]:font-semibold"
              aria-label={ticket.type === 'limit' ? 'Limit price' : 'Stop price'}
            />
            {note && <div className={clsx('mt-1 text-2xs', note.tone === 'warn' ? 'text-warn' : 'text-faint')}>{note.text}</div>}
          </div>
        )}

        <SizeField
          spec={spec}
          sizeMode={ticket.sizeMode}
          qty={ticket.qty}
          risk={ticket.risk}
          value={ticket.value}
          calcQty={calc.qty}
          calcRisk={calc.risk}
          calcValue={calc.notional}
          riskPresets={riskPresets}
          onMode={setSizeMode}
          onQty={(qty) => patchTicket({ qty })}
          onRisk={(risk) => patchTicket({ risk })}
          onValue={(value) => patchTicket({ value })}
        />

        {entryKind ? (
          <>
            <BracketField
              spec={spec}
              kind="sl"
              input={ticket.sl}
              side={ticket.side}
              entry={calc.entry}
              qty={calc.qty || ticket.qty || spec.minQty}
              price={calc.sl}
              amount={slAmount}
              disableUsd={ticket.sizeMode === 'risk'}
              onChange={(p) => patchBracket('sl', p)}
            />
            <BracketField
              spec={spec}
              kind="tp"
              input={ticket.tp}
              side={ticket.side}
              entry={calc.entry}
              qty={calc.qty || ticket.qty || spec.minQty}
              price={calc.tp}
              amount={tpAmount}
              onChange={(p) => patchBracket('tp', p)}
            />
          </>
        ) : (
          <div className="rounded-md bg-panel-2 px-2.5 py-2 text-xs text-muted">This order closes part of your position (oldest first) — stops and targets stay as they are.</div>
        )}

        <RiskBox spec={spec} calc={calc} checks={checks} settings={settings} entryKind={entryKind} feesOff={feesOff} />
        <Warnings items={checks.warnings} />
        <CheckIn
          mode={settings.emotionCheckin}
          mood={ticket.mood}
          setup={ticket.setup}
          highlight={checkinMissing}
          onMood={(mood) => patchTicket({ mood })}
          onSetup={(setup) => patchTicket({ setup })}
        />
      </div>

      <footer className="flex shrink-0 flex-col gap-2 border-t border-line p-3">
        <Button
          variant={buy ? 'buy' : 'sell'}
          size="lg"
          block
          loading={busy}
          disabled={blocked}
          onClick={() => void submit()}
          className={clsx('h-11 text-[15px] transition-shadow', flash && 'ring-2 ring-fg/70 ring-offset-2 ring-offset-panel')}
        >
          {orderLabel(spec, ticket, calc.qty)}
        </Button>
        {checks.block ? (
          <div className={clsx('flex items-center justify-between gap-2 text-xs leading-snug', checks.block.tone === 'loss' ? 'text-loss' : checks.block.tone === 'warn' ? 'text-warn' : 'text-muted')}>
            <span>{checks.block.text}</span>
            {checks.block.action === 'accounts' && (
              <button className="shrink-0 font-medium text-fg hover:underline" onClick={() => navigate('challenges', account ? undefined : { new: 1 })}>
                Accounts →
              </button>
            )}
          </div>
        ) : (
          <div className="tnum flex justify-between text-2xs text-faint">
            <span>
              Risk <span className="text-loss">{calc.risk != null ? fmtMoney(-calc.risk) : '∞'}</span>
            </span>
            <span>
              Reward <span className="text-profit">{calc.reward != null ? fmtMoney(calc.reward, { sign: true }) : '—'}</span>
            </span>
            <span>{calc.rr != null ? `1 : ${calc.rr.toFixed(2)}` : 'R:R —'}</span>
          </div>
        )}
        {account && <PositionActions account={account} spec={spec} position={position} marketOpen={session?.open ?? true} />}
      </footer>
    </>
  );
}
