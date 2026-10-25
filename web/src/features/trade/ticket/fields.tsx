// Order-ticket inputs: side tiles (live bid/ask), size (qty or $ risk), SL/TP (price / distance / $).

import { memo, type ReactNode } from 'react';
import clsx from 'clsx';
import { Minus, Plus } from 'lucide-react';
import type { InstrumentSpec, Side } from '@shared/types';
import { roundQty, ticksBetween, tickValue } from '@shared/risk';
import { fmtMoney, fmtPrice, fmtQty } from '@/lib/format';
import { useQuote, useTickDir } from '@/store/market';
import { NumberInput } from '@/components/ui/Input';
import { Segmented } from '@/components/ui/Tabs';
import { useFlash } from '../useFlash';
import { bracketPrice, bracketValueFromPrice, distUnit, ticksToUnits, type BracketInput, type BracketKind, type BracketMode, type SizeMode } from './riskMath';

export function Label({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-1 flex items-center justify-between gap-2">
      <span className="text-2xs font-medium uppercase tracking-wider text-faint">{children}</span>
      {right}
    </div>
  );
}

export function Chip({ active, onClick, children, title, className }: { active?: boolean; onClick: () => void; children: ReactNode; title?: string; className?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={clsx(
        'inline-flex h-6 items-center justify-center gap-1 whitespace-nowrap rounded border px-1.5 text-2xs font-medium transition-colors',
        active ? 'border-fg bg-fg text-bg' : 'border-line-strong text-muted hover:border-[#4a4a4a] hover:text-fg',
        className,
      )}
    >
      {children}
    </button>
  );
}

// ───────────────────────────── Side tiles ─────────────────────────────

function Tile({ spec, side, active, onClick }: { spec: InstrumentSpec; side: Side; active: boolean; onClick: () => void }) {
  const q = useQuote(spec.symbol);
  const dir = useTickDir(spec.symbol);
  const price = q ? (side === 'buy' ? q.ask : q.bid) : undefined;
  const flash = useFlash(price, dir);
  const buy = side === 'buy';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'flex min-w-0 flex-col rounded-md border px-2.5 py-1.5 text-left transition-colors',
        buy ? 'items-end' : 'items-start',
        active ? (buy ? 'border-profit/80 bg-profit/12' : 'border-loss/80 bg-loss/12') : 'border-line-strong hover:border-[#4a4a4a] hover:bg-panel-2',
      )}
    >
      <span className={clsx('text-2xs font-semibold uppercase tracking-wider', active ? (buy ? 'text-profit' : 'text-loss') : 'text-muted')}>
        {buy ? 'Buy · ask' : 'Sell · bid'}
      </span>
      <span ref={flash} className={clsx('num -mx-1 rounded px-1 text-[15px] font-semibold', buy ? 'text-profit' : 'text-loss')}>
        {price != null ? fmtPrice(spec, price) : '—'}
      </span>
    </button>
  );
}

export const SideTiles = memo(function SideTiles({ spec, side, onSide }: { spec: InstrumentSpec; side: Side; onSide: (s: Side) => void }) {
  const q = useQuote(spec.symbol);
  const spread = q ? ticksBetween(spec, q.ask, q.bid) : null;
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-1">
      <Tile spec={spec} side="sell" active={side === 'sell'} onClick={() => onSide('sell')} />
      <div className="flex flex-col items-center justify-center px-0.5 text-center text-[10px] leading-tight text-faint" title="Spread in ticks">
        <span className="num text-xs text-muted">{spread ?? '—'}</span>
        spread
      </div>
      <Tile spec={spec} side="buy" active={side === 'buy'} onClick={() => onSide('buy')} />
    </div>
  );
});

// ───────────────────────────── Size ─────────────────────────────

function qtyChips(spec: InstrumentSpec): number[] {
  if (spec.assetClass === 'futures') return [1, 2, 3, 5, 10];
  const base = spec.defaultQty;
  return [1, 2, 5, 10].map((m) => roundQty(spec, base * m)).filter((v, i, a) => v > 0 && a.indexOf(v) === i);
}

export interface SizeFieldProps {
  spec: InstrumentSpec;
  sizeMode: SizeMode;
  qty: number | null;
  risk: number | null;
  value: number | null;
  /** Computed qty (size-by-risk / -value), the net $ at risk and the position value with it. */
  calcQty: number;
  calcRisk: number | null;
  calcValue: number;
  riskPresets: Array<{ amount: number; label: string }>;
  onMode: (m: SizeMode) => void;
  onQty: (q: number | null) => void;
  onRisk: (r: number | null) => void;
  onValue: (v: number | null) => void;
}

function valueChips(spec: InstrumentSpec): number[] {
  return spec.assetClass === 'crypto' ? [1_000, 5_000, 10_000, 25_000] : [2_500, 5_000, 10_000, 20_000];
}

export function SizeField({ spec, sizeMode, qty, risk, value, calcQty, calcRisk, calcValue, riskPresets, onMode, onQty, onRisk, onValue }: SizeFieldProps) {
  const unit = spec.unitLabel.charAt(0).toUpperCase() + spec.unitLabel.slice(1);
  const step = (d: 1 | -1) => onQty(Math.max(spec.minQty, roundQty(spec, (qty ?? 0) + d * spec.qtyStep) || spec.minQty));
  return (
    <div>
      <Label
        right={
          <Segmented<SizeMode>
            size="xs"
            value={sizeMode}
            onChange={onMode}
            options={[
              { value: 'qty', label: unit, title: `Size in ${spec.unitLabel}` },
              { value: 'value', label: '$ Value', title: 'Size by the dollar value of the position' },
              { value: 'risk', label: 'Risk', title: 'Size by what you lose if your stop is hit (fees included)' },
            ]}
          />
        }
      >
        Size
      </Label>
      {sizeMode === 'qty' ? (
        <>
          <div className="flex items-center gap-1">
            <button type="button" aria-label="Decrease size" onClick={() => step(-1)} className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line-strong text-muted hover:border-[#4a4a4a] hover:text-fg">
              <Minus size={14} />
            </button>
            <NumberInput value={qty} onChange={onQty} step={spec.qtyStep} min={spec.minQty} precision={spec.qtyPrecision} className="num flex-1 [&_input]:text-center [&_input]:text-[15px] [&_input]:font-semibold" suffix={spec.assetClass === 'futures' ? undefined : spec.unitLabel} aria-label="Quantity" />
            <button type="button" aria-label="Increase size" onClick={() => step(1)} className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line-strong text-muted hover:border-[#4a4a4a] hover:text-fg">
              <Plus size={14} />
            </button>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {qtyChips(spec).map((v) => (
              <Chip key={v} active={qty === v} onClick={() => onQty(v)}>
                {fmtQty(spec, v)}
              </Chip>
            ))}
            <span className="tnum ml-auto self-center text-2xs text-faint">{fmtMoney(tickValue(spec, qty || spec.minQty))}/tick</span>
          </div>
        </>
      ) : sizeMode === 'value' ? (
        <>
          <NumberInput value={value} onChange={onValue} step={500} min={0} precision={0} prefix="$" className="num [&_input]:text-[15px] [&_input]:font-semibold" aria-label="Position value in dollars" />
          <div className="mt-1.5 flex flex-wrap gap-1">
            {valueChips(spec).map((v) => (
              <Chip key={v} active={value === v} onClick={() => onValue(v)}>
                {fmtMoney(v, { whole: true, compact: v >= 10_000 })}
              </Chip>
            ))}
          </div>
          <div className="tnum mt-1.5 text-xs text-muted">
            {calcQty > 0 ? (
              <>
                → <span className="font-semibold text-fg">{fmtQty(spec, calcQty)}</span> {spec.unitLabel}
                <span className="text-faint"> · position worth {fmtMoney(calcValue, { whole: true })}</span>
              </>
            ) : (
              <span className="text-faint">The dollar value of the position — not what you risk.</span>
            )}
          </div>
        </>
      ) : (
        <>
          <NumberInput value={risk} onChange={onRisk} step={5} min={0} precision={2} prefix="$" className="num [&_input]:text-[15px] [&_input]:font-semibold" aria-label="Risk in dollars" />
          <div className="mt-1.5 flex flex-wrap gap-1">
            {riskPresets.map((p) => (
              <Chip key={p.label} active={risk === p.amount} onClick={() => onRisk(p.amount)} title={`Risk ${fmtMoney(p.amount)}`}>
                {p.label}
              </Chip>
            ))}
          </div>
          <div className="tnum mt-1.5 text-xs text-muted">
            {calcQty > 0 ? (
              <>
                → <span className="font-semibold text-fg">{fmtQty(spec, calcQty)}</span> {spec.unitLabel}
                <span className="text-faint">
                  {' '}
                  · worth {fmtMoney(calcValue, { whole: true })}
                  {calcRisk != null && <> · lose {fmtMoney(calcRisk)} at the stop incl. fees</>}
                </span>
              </>
            ) : (
              <span className="text-faint">What you lose if the stop is hit (fees included). Size is computed from your stop.</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ───────────────────────────── SL / TP ─────────────────────────────

export interface BracketFieldProps {
  spec: InstrumentSpec;
  kind: BracketKind;
  input: BracketInput;
  side: Side;
  entry: number | null;
  qty: number;
  /** Resulting level (null when off / invalid). */
  price: number | null;
  /** $ at the level for the order (signed: SL negative). */
  amount: number | null;
  disableUsd?: boolean;
  onChange: (patch: Partial<BracketInput>) => void;
}

export function BracketField({ spec, kind, input, side, entry, qty, price, amount, disableUsd, onChange }: BracketFieldProps) {
  const unit = distUnit(spec);
  const isSl = kind === 'sl';
  const switchMode = (mode: BracketMode) => {
    if (mode === input.mode) return;
    const cur = bracketPrice(spec, kind, { ...input, on: true }, side, entry, qty);
    const value = cur != null ? bracketValueFromPrice(spec, mode, cur, entry, qty) : null;
    onChange({ mode, value });
  };
  const ticks = price != null && entry != null ? ticksBetween(spec, price, entry) : null;
  const stepFor = input.mode === 'price' ? spec.tickSize : input.mode === 'dist' ? unit.step : 1;
  const precision = input.mode === 'price' ? spec.pricePrecision : input.mode === 'dist' ? unit.precision : 2;
  return (
    <div className={clsx(!input.on && 'opacity-60')}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="flex cursor-pointer select-none items-center gap-1.5">
          <input type="checkbox" checked={input.on} onChange={(e) => onChange({ on: e.target.checked })} className="size-3.5 cursor-pointer accent-white" />
          <span className={clsx('text-2xs font-semibold uppercase tracking-wider', isSl ? 'text-loss' : 'text-profit')}>{isSl ? 'Stop loss' : 'Take profit'}</span>
        </label>
        <Segmented<BracketMode>
          size="xs"
          value={input.mode}
          onChange={switchMode}
          options={[
            { value: 'price', label: 'Price' },
            { value: 'dist', label: unit.label },
            { value: 'usd', label: '$', disabled: disableUsd, title: disableUsd ? 'Not available while sizing by risk' : 'Distance as $ for this size' },
          ]}
        />
      </div>
      <NumberInput
        size="sm"
        value={input.value}
        onChange={(v) => onChange({ value: v, on: true })}
        step={stepFor}
        min={0}
        precision={precision}
        prefix={input.mode === 'usd' ? '$' : undefined}
        suffix={input.mode === 'dist' ? unit.label.toLowerCase() : undefined}
        disabled={!input.on}
        className="num"
        aria-label={isSl ? 'Stop-loss' : 'Take-profit'}
      />
      <div className="tnum mt-1 flex min-h-4 items-center gap-1.5 text-2xs text-faint">
        {input.on && price != null ? (
          <>
            <span className="num text-muted">{fmtPrice(spec, price)}</span>
            {ticks != null && (
              <span>
                · {unit.ticks === 1 ? ticks : ticksToUnits(spec, ticks)} {unit.label.toLowerCase()}
              </span>
            )}
            {amount != null && <span className={clsx('ml-auto font-medium', amount < 0 ? 'text-loss' : amount > 0 ? 'text-profit' : 'text-muted')}>{fmtMoney(amount, { sign: true })}</span>}
          </>
        ) : input.on ? (
          <span>Enter a {input.mode === 'price' ? 'price' : input.mode === 'dist' ? 'distance' : '$ amount'}</span>
        ) : (
          <span>Off</span>
        )}
      </div>
    </div>
  );
}
