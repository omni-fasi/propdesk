import { useMemo, useState, type ReactNode } from 'react';
import type { Account, DrawdownMode } from '@shared/types';
import { buildCustomRules, suggestedFee, type CustomChallengeInput } from '@shared/presets';
import { DRAWDOWN_LABELS, rulesSummary } from '@/lib/rules';
import { fmtMoney, fmtPct } from '@/lib/format';
import { Field, Input, NumberInput, Switch } from '@/components/ui/Input';
import { Segmented } from '@/components/ui/Tabs';
import { toast } from '@/components/ui/Toast';
import { HoldButton } from '@/features/realism/HoldButton';
import { shortSize } from './accountUtils';
import { createAccount } from './actions';
import { ErrorNote } from './ErrorNote';
import { FormGroup } from './FormGroup';
import { PurchaseSummary, useCanAfford } from './PurchaseSummary';

interface Draft {
  startingBalance: number | null;
  profitTarget: number | null;
  maxLoss: number | null;
  maxLossMode: DrawdownMode;
  dailyLossOn: boolean;
  dailyLoss: number | null;
  dailyLossAction: 'fail' | 'lock';
  minTradingDays: number | null;
  consistencyOn: boolean;
  /** Percent, 10–100. */
  consistencyPct: number | null;
  markets: CustomChallengeInput['markets'];
  maxContracts: number | null;
  name: string;
  fee: number | null;
  feeTouched: boolean;
}

// The trader's own example: $50,000 account, $3,000 target, $2,000 max loss trailing end-of-day.
const DEFAULTS: Draft = {
  startingBalance: 50_000,
  profitTarget: 3_000,
  maxLoss: 2_000,
  maxLossMode: 'trailing_eod',
  dailyLossOn: false,
  dailyLoss: 1_000,
  dailyLossAction: 'lock',
  minTradingDays: 1,
  consistencyOn: false,
  consistencyPct: 50,
  markets: 'futures',
  maxContracts: 5,
  name: '',
  fee: suggestedFee(50_000),
  feeTouched: false,
};

type Errors = Partial<Record<keyof Draft, string>>;

function validate(d: Draft): Errors {
  const e: Errors = {};
  const size = d.startingBalance;
  if (size == null || size < 1_000 || size > 1_000_000) e.startingBalance = 'Between $1,000 and $1,000,000';
  if (d.profitTarget == null || d.profitTarget <= 0) e.profitTarget = 'Set a profit target';
  else if (size != null && d.profitTarget > size) e.profitTarget = 'Larger than the account itself';
  if (d.maxLoss == null || d.maxLoss <= 0) e.maxLoss = 'Set a max loss';
  else if (size != null && d.maxLoss >= size) e.maxLoss = 'Must be smaller than the account';
  if (d.dailyLossOn) {
    if (d.dailyLoss == null || d.dailyLoss <= 0) e.dailyLoss = 'Set a daily loss amount';
    else if (d.maxLoss != null && d.dailyLoss > d.maxLoss) e.dailyLoss = "Can't be larger than the max loss";
  }
  if (d.minTradingDays == null || !Number.isInteger(d.minTradingDays) || d.minTradingDays < 0 || d.minTradingDays > 60) e.minTradingDays = 'Whole days, 0–60';
  if (d.consistencyOn && (d.consistencyPct == null || d.consistencyPct < 10 || d.consistencyPct > 100)) e.consistencyPct = 'Between 10% and 100%';
  if (d.markets !== 'cfd' && (d.maxContracts == null || !Number.isInteger(d.maxContracts) || d.maxContracts < 1 || d.maxContracts > 200)) e.maxContracts = 'Whole contracts, 1–200';
  if (d.fee == null || d.fee < 0 || d.fee > 100_000) e.fee = 'Between $0 and $100,000';
  return e;
}

function toInput(d: Draft): CustomChallengeInput {
  return {
    startingBalance: d.startingBalance ?? 0,
    profitTarget: d.profitTarget ?? 0,
    maxLoss: d.maxLoss ?? 0,
    maxLossMode: d.maxLossMode,
    dailyLoss: d.dailyLossOn ? d.dailyLoss : null,
    dailyLossAction: d.dailyLossAction,
    minTradingDays: d.minTradingDays ?? 0,
    consistencyPct: d.consistencyOn && d.consistencyPct != null ? d.consistencyPct / 100 : null,
    markets: d.markets,
    maxContracts: d.markets === 'cfd' ? null : d.maxContracts,
  };
}

function pctOf(part: number | null, whole: number | null): string | undefined {
  if (part == null || whole == null || whole <= 0) return undefined;
  return `${fmtPct(part / whole, 1)} of the account`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-line bg-panel-2 p-4">
      <legend className="px-1 text-2xs font-medium uppercase tracking-wider text-faint">{title}</legend>
      {children}
    </fieldset>
  );
}

const SIZES = [25_000, 50_000, 100_000, 150_000];

/** Your own rules — and the price you decide failing should cost. */
export function CustomBuilder({ onDone, onNavigate }: { onDone: (a: Account) => void; onNavigate: () => void }) {
  const [d, setD] = useState<Draft>(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errors = useMemo(() => validate(d), [d]);
  const valid = Object.keys(errors).length === 0;
  const rules = useMemo(() => (valid ? buildCustomRules(toInput(d)) : null), [d, valid]);
  const summary = useMemo(() => (rules ? rulesSummary(rules) : []), [rules]);
  const fee = d.fee ?? 0;
  const affordable = useCanAfford(fee);
  const defaultName = `Custom ${shortSize(d.startingBalance ?? 0)}`;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));
  const setSize = (v: number | null) =>
    setD((p) => ({ ...p, startingBalance: v, fee: p.feeTouched || v == null ? p.fee : suggestedFee(v) }));

  const buy = async () => {
    if (!rules) return;
    setBusy(true);
    setError(null);
    try {
      const account = await createAccount({ kind: 'evaluation', rules, fee: Math.round(fee * 100) / 100, name: d.name.trim() || defaultName });
      toast({ title: `${account.name} is ready`, description: fee > 0 ? `${fmtMoney(fee)} paid from your wallet.` : 'Free challenge created.' });
      onDone(account);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="flex flex-col gap-4">
        <Section title="Account">
          <FormGroup label="Account size" error={errors.startingBalance}>
            <div className="flex flex-wrap gap-2">
              <NumberInput value={d.startingBalance} onChange={setSize} step={1000} min={1000} max={1_000_000} precision={0} prefix="$" className="w-40" invalid={!!errors.startingBalance} />
              <Segmented
                value={String(d.startingBalance)}
                onChange={(v) => setSize(Number(v))}
                size="md"
                options={SIZES.map((s) => ({ value: String(s), label: shortSize(s) }))}
              />
            </div>
          </FormGroup>
          <FormGroup label="Markets" hint={d.markets === 'futures' ? 'CME futures only · trading day resets 5 PM ET · flat by 4:10 PM ET · no weekend holding' : d.markets === 'cfd' ? 'Forex, crypto, metals, energy and stock perps with leverage · day resets at local midnight' : 'Every market · day resets at local midnight'}>
            <Segmented
              value={d.markets}
              onChange={(v) => set('markets', v)}
              size="md"
              options={[
                { value: 'futures', label: 'Futures' },
                { value: 'cfd', label: 'Forex & CFD' },
                { value: 'all', label: 'All markets' },
              ]}
            />
          </FormGroup>
        </Section>

        <Section title="Target & limits">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Profit target" error={errors.profitTarget} hint={pctOf(d.profitTarget, d.startingBalance)}>
              <NumberInput value={d.profitTarget} onChange={(v) => set('profitTarget', v)} step={100} min={0} precision={0} prefix="$" invalid={!!errors.profitTarget} />
            </Field>
            <Field label="Max loss" error={errors.maxLoss} hint={pctOf(d.maxLoss, d.startingBalance)}>
              <NumberInput value={d.maxLoss} onChange={(v) => set('maxLoss', v)} step={100} min={0} precision={0} prefix="$" invalid={!!errors.maxLoss} />
            </Field>
          </div>
          <FormGroup label="Max loss measured from" hint={DRAWDOWN_LABELS[d.maxLossMode].long}>
            <Segmented
              value={d.maxLossMode}
              onChange={(v) => set('maxLossMode', v)}
              size="md"
              options={[
                { value: 'static', label: 'Starting balance' },
                { value: 'trailing_eod', label: 'Best end-of-day' },
                { value: 'trailing_intraday', label: 'Peak equity' },
              ]}
            />
          </FormGroup>
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm text-fg">Daily loss limit</div>
                <div className="text-xs text-muted">Measured from the day's starting balance against live equity.</div>
              </div>
              <Switch checked={d.dailyLossOn} onChange={(v) => set('dailyLossOn', v)} label="Daily loss limit" />
            </div>
            {d.dailyLossOn && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Amount" error={errors.dailyLoss}>
                  <NumberInput value={d.dailyLoss} onChange={(v) => set('dailyLoss', v)} step={100} min={0} precision={0} prefix="$" invalid={!!errors.dailyLoss} />
                </Field>
                <FormGroup label="When hit">
                  <Segmented
                    value={d.dailyLossAction}
                    onChange={(v) => set('dailyLossAction', v)}
                    size="md"
                    options={[
                      { value: 'lock', label: 'Lock until tomorrow' },
                      { value: 'fail', label: 'Fail the account' },
                    ]}
                  />
                </FormGroup>
              </div>
            )}
          </div>
        </Section>

        <Section title="Passing">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Minimum trading days" error={errors.minTradingDays}>
              <NumberInput value={d.minTradingDays} onChange={(v) => set('minTradingDays', v)} step={1} min={0} max={60} precision={0} invalid={!!errors.minTradingDays} />
            </Field>
            {d.markets !== 'cfd' && (
              <Field label="Max position (minis)" error={errors.maxContracts} hint={d.maxContracts ? `${d.maxContracts} minis = ${d.maxContracts * 10} micros` : undefined}>
                <NumberInput value={d.maxContracts} onChange={(v) => set('maxContracts', v)} step={1} min={1} max={200} precision={0} invalid={!!errors.maxContracts} />
              </Field>
            )}
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-line pt-3">
            <div>
              <div className="text-sm text-fg">Consistency rule</div>
              <div className="text-xs text-muted">Your best day may be at most this share of total profit.</div>
            </div>
            <div className="flex items-center gap-3">
              {d.consistencyOn && (
                <NumberInput value={d.consistencyPct} onChange={(v) => set('consistencyPct', v)} step={5} min={10} max={100} precision={0} suffix="%" className="w-24" invalid={!!errors.consistencyPct} />
              )}
              <Switch checked={d.consistencyOn} onChange={(v) => set('consistencyOn', v)} label="Consistency rule" />
            </div>
          </div>
          {errors.consistencyPct && <div className="text-xs text-loss">{errors.consistencyPct}</div>}
        </Section>
      </div>

      <aside className="flex flex-col gap-4 self-start rounded-lg border border-line bg-panel-2 p-4 lg:sticky lg:top-0">
        <Field label="Name">
          <Input value={d.name} onChange={(e) => set('name', e.target.value)} placeholder={defaultName} maxLength={60} />
        </Field>
        <Field
          label="What this challenge costs you"
          error={errors.fee}
          hint={!d.feeTouched ? `Suggested for a ${shortSize(d.startingBalance ?? 0)} account` : fee === 0 ? 'A free challenge costs nothing to fail.' : undefined}
        >
          <NumberInput value={d.fee} onChange={(v) => setD((p) => ({ ...p, fee: v, feeTouched: true }))} step={1} min={0} max={100_000} precision={2} prefix="$" invalid={!!errors.fee} />
        </Field>
        <div>
          <div className="mb-1.5 text-2xs font-medium uppercase tracking-wider text-faint">Your rules</div>
          {rules ? (
            <ul className="flex flex-col gap-1 text-xs text-muted">
              {summary.map((l) => (
                <li key={l} className="flex gap-2">
                  <span className="text-faint">·</span>
                  {l}
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-xs text-faint">Fix the highlighted fields to see the rules.</div>
          )}
        </div>
        <PurchaseSummary price={fee} priceLabel="Price" onNavigate={onNavigate} />
        <ErrorNote error={error} onNavigate={onNavigate} />
        <HoldButton
          label={fee > 0 ? `Hold to pay ${fmtMoney(fee)}` : 'Hold to create'}
          onConfirm={buy}
          loading={busy}
          disabled={!valid || !affordable}
          block
          size="lg"
          holdMs={fee > 0 ? 1400 : 900}
        />
        <p className="text-center text-2xs text-faint">Custom challenges have no funded stage and can't be retried at a discount.</p>
      </aside>
    </div>
  );
}
