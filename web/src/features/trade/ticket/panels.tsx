// Ticket panels: live risk box, warnings, mood / setup check-in, position actions for the symbol.

import { memo, type ReactNode } from 'react';
import clsx from 'clsx';
import { ArrowLeftRight, CircleAlert, Info, TriangleAlert, X } from 'lucide-react';
import type { Account, InstrumentSpec, Mood, Position, Settings } from '@shared/types';
import { ASSET_CLASS_LABELS } from '@shared/instruments';
import { MOODS, SETUP_GRADES } from '@shared/journal';
import { fmtLeverage, fmtMoney, fmtPct, fmtPrice, fmtQty, pnlTone } from '@/lib/format';
import { useAccountOrders, useAccountPositions, usePositionPnl } from '@/store/hooks';
import { Button } from '@/components/ui/Button';
import { Meter } from '@/components/ui/Meter';
import { Popover } from '@/components/ui/Popover';
import { WorkHours } from '@/components/ui/Money';
import { confirm } from '@/components/ui/Toast';
import { cancelOrders, closePosition, flattenAccount, reversePosition } from '../actions';
import type { MarginInfo, TicketChecks, TicketWarning } from './checks';
import type { TicketCalc } from './riskMath';
import { Chip } from './fields';

function Row({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]" title={hint}>
      <span className="text-xs text-muted">{label}</span>
      <span className="tnum text-right text-xs text-fg">{children}</span>
    </div>
  );
}

function ShareMeter({ pct, risky }: { pct: number; risky: number }) {
  const tone = pct >= 1 ? 'loss' : pct >= risky ? 'warn' : 'neutral';
  return <Meter value={pct} tone={tone} height={3} className="mt-0.5" marker={risky} />;
}

/** Margin in plain words: a deposit held while the position is open — not a fee, not the risk. */
function MarginRow({ spec, calc, margin }: { spec: InstrumentSpec; calc: TicketCalc; margin: MarginInfo }) {
  const lev = fmtLeverage(margin.leverage);
  const whole = { whole: true };
  return (
    <div className="py-[3px]">
      <div className="flex items-baseline justify-between gap-3">
        <Popover
          trigger={
            <span className="inline-flex items-center gap-1">
              Margin held <Info size={11} />
            </span>
          }
          triggerClassName="text-xs text-muted transition-colors hover:text-fg"
          className="w-[272px] p-2.5"
        >
          {() => (
            <div className="flex flex-col gap-1.5 text-xs leading-snug text-muted">
              <div className="font-semibold text-fg">Margin is a deposit, not a cost</div>
              <p>
                This account gives {lev} leverage on {ASSET_CLASS_LABELS[spec.assetClass]}: each $1 of your account can hold ${Number(margin.leverage.toFixed(2))} of position. So this{' '}
                {fmtMoney(calc.notional, whole)} position sets aside <span className="text-fg">{fmtMoney(margin.held, whole)}</span>
                {margin.equity != null && <> of your {fmtMoney(margin.equity, whole)}</>} while it's open. You get it back when you close.
              </p>
              <p>
                It isn't what you can lose —{' '}
                {calc.risk != null ? (
                  <>
                    your stop decides that: <span className="text-loss">{fmtMoney(-calc.risk)}</span>.
                  </>
                ) : (
                  'with no stop-loss that is open-ended.'
                )}
              </p>
              {margin.maxValue != null && (
                <p>
                  Biggest {spec.symbol} position you can hold right now: <span className="text-fg">{fmtMoney(margin.maxValue, whole)}</span>
                  {margin.others > 0 && <> (your other positions hold {fmtMoney(margin.others, whole)} of margin)</>}. A stop doesn't raise that: in a fast move or a
                  gap a stop can fill far past its price, so brokers cap size with leverage.
                </p>
              )}
            </div>
          )}
        </Popover>
        <span className="tnum text-right text-xs text-fg">
          {fmtMoney(margin.held, whole)} <span className="text-faint">· {lev}</span>
        </span>
      </div>
      <div className="text-2xs text-faint">Held while open, back when you close — not a fee.</div>
    </div>
  );
}

export const RiskBox = memo(function RiskBox({
  spec,
  calc,
  checks,
  settings,
  entryKind,
  feesOff,
}: {
  spec: InstrumentSpec;
  calc: TicketCalc;
  checks: TicketChecks;
  settings: Settings;
  entryKind: boolean;
  /** Live (practice-kind) account with trading fees switched off. */
  feesOff: boolean;
}) {
  const feesOffRow = (
    <Row label="Fees" hint="Switched off for this account (Accounts page)">
      <span className="text-faint">Off on this account</span>
    </Row>
  );
  if (!entryKind) {
    return (
      <div className="rounded-md border border-line bg-panel-2 px-2.5 py-2">
        {feesOff ? feesOffRow : <Row label="Fees (estimated)">{fmtMoney(calc.fees / 2)}</Row>}
      </div>
    );
  }
  return (
    <div className="rounded-md border border-line bg-panel-2 px-2.5 py-2">
      <Row label="Position value" hint="What the position is worth — commissions are a % of this on perps">
        {calc.notional > 0 ? fmtMoney(calc.notional, { whole: true }) : <span className="text-faint">—</span>}
      </Row>
      {checks.margin != null && <MarginRow spec={spec} calc={calc} margin={checks.margin} />}
      <Row label="Loss at stop" hint="Price move to your stop + entry and exit commissions">
        {calc.risk != null ? (
          <>
            <span className="font-semibold text-loss">{fmtMoney(-calc.risk)}</span>
            {calc.feesAtStop != null && calc.feesAtStop > 0 && <span className="text-faint"> incl. {fmtMoney(calc.feesAtStop)} fees</span>}
          </>
        ) : (
          <span className="font-medium text-warn">No stop — open-ended</span>
        )}
      </Row>
      {checks.pctMaxLoss != null && (
        <div className="py-[3px]">
          <Row label="of max-loss buffer">
            <span className={clsx(checks.pctMaxLoss >= 1 ? 'text-loss' : checks.pctMaxLoss >= settings.riskyPct ? 'text-warn' : 'text-fg')}>{fmtPct(checks.pctMaxLoss, 1)}</span>
          </Row>
          <ShareMeter pct={checks.pctMaxLoss} risky={settings.riskyPct} />
        </div>
      )}
      {checks.pctDaily != null && (
        <div className="py-[3px]">
          <Row label="of daily-loss buffer">
            <span className={clsx(checks.pctDaily >= 1 ? 'text-loss' : checks.pctDaily >= 0.5 ? 'text-warn' : 'text-fg')}>{fmtPct(checks.pctDaily, 1)}</span>
          </Row>
          <ShareMeter pct={checks.pctDaily} risky={0.5} />
        </div>
      )}
      <Row label="Profit at target" hint="Price move to your target − entry and exit commissions">
        {calc.reward != null ? (
          <>
            <span className={clsx('font-semibold', pnlTone(calc.reward))}>{fmtMoney(calc.reward, { sign: true })}</span>
            {calc.feesAtTarget != null && calc.feesAtTarget > 0 && <span className="text-faint"> after {fmtMoney(calc.feesAtTarget)} fees</span>}
          </>
        ) : (
          <span className="text-faint">—</span>
        )}
      </Row>
      <Row label="Risk : reward" hint="Net of fees">
        {calc.rr != null ? <span className={clsx(calc.rr < 1 && 'text-warn')}>1 : {calc.rr.toFixed(2)}</span> : <span className="text-faint">—</span>}
      </Row>
      {feesOff
        ? feesOffRow
        : calc.risk == null &&
          calc.reward == null && (
            <Row label="Fees (round trip)" hint="Estimated commission to enter and exit at market">
              {fmtMoney(calc.fees)}
            </Row>
          )}
      {calc.risk != null && calc.risk > 0 && (
        <div className="pt-0.5 text-right">
          <WorkHours value={calc.risk} className="text-2xs" />
        </div>
      )}
    </div>
  );
});

const WARN_ICON = { info: Info, warn: TriangleAlert, loss: CircleAlert } as const;

export function Warnings({ items }: { items: TicketWarning[] }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-1">
      {items.map((w) => {
        const Icon = WARN_ICON[w.tone];
        return (
          <div
            key={w.text}
            className={clsx(
              'flex gap-1.5 rounded-md px-2 py-1.5 text-xs leading-snug',
              w.tone === 'loss' ? 'bg-loss/10 text-loss' : w.tone === 'warn' ? 'bg-warn/10 text-warn' : 'bg-panel-2 text-muted',
            )}
          >
            <Icon size={13} className="mt-px shrink-0" />
            <span>{w.text}</span>
          </div>
        );
      })}
    </div>
  );
}

export const CheckIn = memo(function CheckIn({
  mode,
  mood,
  setup,
  highlight,
  onMood,
  onSetup,
}: {
  mode: Settings['emotionCheckin'];
  mood: Mood | null;
  setup: string | null;
  highlight: boolean;
  onMood: (m: Mood | null) => void;
  onSetup: (s: string | null) => void;
}) {
  if (mode === 'off') return null;
  const info = MOODS.find((m) => m.id === mood);
  return (
    <div className={clsx('rounded-md border p-2 transition-colors', highlight ? 'border-warn/50' : 'border-line')}>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-2xs font-medium uppercase tracking-wider text-faint">How are you feeling?</span>
        {mode === 'required' && <span className={clsx('text-2xs', mood ? 'text-faint' : 'text-warn')}>required</span>}
      </div>
      <div className="flex flex-wrap gap-1">
        {MOODS.map((m) => (
          <Chip key={m.id} active={mood === m.id} onClick={() => onMood(mood === m.id ? null : m.id)} title={m.label}>
            <span aria-hidden>{m.emoji}</span>
            {m.label}
          </Chip>
        ))}
      </div>
      {info?.tone === 'bad' && (
        <div className="mt-1.5 text-2xs leading-snug text-warn">Trading while {info.label.toLowerCase()} rarely ends well. Is this trade in your plan?</div>
      )}
      <div className="mb-1 mt-2 text-2xs font-medium uppercase tracking-wider text-faint">Setup quality</div>
      <div className="flex flex-wrap gap-1">
        {SETUP_GRADES.map((g) => (
          <Chip key={g} active={setup === g} onClick={() => onSetup(setup === g ? null : g)}>
            {g}
          </Chip>
        ))}
      </div>
    </div>
  );
});

function PositionLine({ position, spec, count }: { position: Position; spec: InstrumentSpec; count: number }) {
  const { openPnl } = usePositionPnl(position);
  const long = position.qty > 0;
  return (
    <div className="flex flex-col gap-0.5 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <span className="tnum">
          <span className={clsx('font-semibold', long ? 'text-profit' : 'text-loss')}>{long ? 'LONG' : 'SHORT'}</span> {fmtQty(spec, position.qty)} @{' '}
          <span className="num">{fmtPrice(spec, position.avgPrice)}</span>
        </span>
        <span className={clsx('tnum font-semibold', pnlTone(openPnl))}>{fmtMoney(openPnl, { sign: true })}</span>
      </div>
      {count > 1 && <div className="text-2xs text-faint">{count} positions together · average entry</div>}
    </div>
  );
}

/** Flatten / reverse / cancel for the selected symbol (`position` = its positions together), and flatten-all for the account. */
export function PositionActions({ account, spec, position, marketOpen }: { account: Account; spec: InstrumentSpec; position: Position | null; marketOpen: boolean }) {
  const orders = useAccountOrders(account.id);
  const positions = useAccountPositions(account.id);
  const symOrders = orders.filter((o) => o.symbol === spec.symbol);
  const count = positions.filter((p) => p.symbol === spec.symbol).length;
  const closedTip = marketOpen ? undefined : 'Market closed';
  if (!position && !symOrders.length && !positions.length && !orders.length) return null;

  const flattenAll = async () => {
    const ok = await confirm({
      title: 'Flatten everything?',
      body: `Closes ${positions.length} position${positions.length === 1 ? '' : 's'} at market and cancels ${orders.length} working order${orders.length === 1 ? '' : 's'} on ${account.name}.`,
      confirmLabel: 'Flatten all',
      tone: 'danger',
    });
    if (ok) await flattenAccount(account.id);
  };
  const reverse = async () => {
    if (!position) return;
    const ok = await confirm({
      title: `Reverse ${spec.symbol}?`,
      body: `Sends one market order for ${fmtQty(spec, Math.abs(position.qty) * 2)} ${spec.unitLabel} to flip your ${count > 1 ? `${count} ` : ''}${position.qty > 0 ? 'long' : 'short'}${
        count > 1 ? 's' : ''
      } into one ${position.qty > 0 ? 'short' : 'long'} of the same size. Stops and targets are cleared.`,
      confirmLabel: 'Reverse',
      tone: position.qty > 0 ? 'sell' : 'buy',
    });
    if (ok) await reversePosition(account.id, spec.symbol);
  };

  return (
    <div className="flex flex-col gap-1.5 border-t border-line pt-2">
      {position && <PositionLine position={position} spec={spec} count={count} />}
      <div className="flex gap-1">
        {position && (
          <>
            <Button
              size="xs"
              variant="outline"
              className="flex-1"
              disabled={!marketOpen}
              title={closedTip ?? (count > 1 ? `Close all ${count} ${spec.symbol} positions at market` : 'Close the whole position at market')}
              onClick={() => void closePosition(account.id, spec.symbol)}
            >
              Flatten
            </Button>
            <Button size="xs" variant="outline" className="flex-1" disabled={!marketOpen} title={closedTip ?? 'Flip to the opposite side'} icon={<ArrowLeftRight size={12} />} onClick={() => void reverse()}>
              Reverse
            </Button>
          </>
        )}
        {symOrders.length > 0 && (
          <Button size="xs" variant="outline" className="flex-1" icon={<X size={12} />} onClick={() => void cancelOrders(symOrders)}>
            Cancel {symOrders.length}
          </Button>
        )}
      </div>
      {(positions.length > 0 || orders.length > 0) && (
        <Button size="xs" variant="danger" block onClick={() => void flattenAll()} title="Close every position and cancel every order on this account">
          Flatten all · {positions.length} pos · {orders.length} ord
        </Button>
      )}
    </div>
  );
}
