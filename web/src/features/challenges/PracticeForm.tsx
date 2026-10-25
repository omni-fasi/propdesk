import { useState } from 'react';
import type { Account } from '@shared/types';
import { practiceRules } from '@shared/presets';
import { rulesSummary } from '@/lib/rules';
import { Button } from '@/components/ui/Button';
import { Field, Input, NumberInput, Switch } from '@/components/ui/Input';
import { Segmented } from '@/components/ui/Tabs';
import { toast } from '@/components/ui/Toast';
import { shortSize } from './accountUtils';
import { createAccount } from './actions';
import { ErrorNote } from './ErrorNote';
import { FormGroup } from './FormGroup';

const SIZES = ['25000', '50000', '100000', 'custom'] as const;
type SizeChoice = (typeof SIZES)[number];

/** A free account with no challenge limits. */
export function PracticeForm({ onDone }: { onDone: (a: Account) => void }) {
  const [choice, setChoice] = useState<SizeChoice>('50000');
  const [custom, setCustom] = useState<number | null>(10_000);
  const [name, setName] = useState('');
  const [fees, setFees] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const size = choice === 'custom' ? custom : Number(choice);
  const valid = size != null && size >= 1_000 && size <= 10_000_000;
  const defaultName = `Live ${shortSize(size ?? 0)}`;

  const create = async () => {
    if (!valid || size == null) return;
    setBusy(true);
    setError(null);
    try {
      const account = await createAccount({ kind: 'practice', startingBalance: Math.round(size), fees: fees ? 'real' : 'off', name: name.trim() || defaultName });
      toast({ title: `${account.name} created`, description: 'Free. It is now your selected account.' });
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
        <div className="rounded-lg border border-line bg-panel-2 p-4">
          <FormGroup label="Starting balance" error={choice === 'custom' && !valid ? 'Between $1,000 and $10,000,000' : undefined}>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                value={choice}
                onChange={setChoice}
                size="md"
                options={SIZES.map((s) => ({ value: s, label: s === 'custom' ? 'Custom' : shortSize(Number(s)) }))}
              />
              {choice === 'custom' && <NumberInput value={custom} onChange={setCustom} step={1000} min={1000} max={10_000_000} precision={0} prefix="$" className="w-40" invalid={!valid} />}
            </div>
          </FormGroup>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-line bg-panel-2 p-4">
          <div>
            <div className="text-sm font-medium text-fg">Trading fees</div>
            <div className="mt-0.5 text-xs text-muted">
              {fees
                ? 'Real exchange fees on every fill: 0.02–0.05% of the position on crypto, per contract on futures.'
                : 'Off: fills are free, so results show your trading only. You can change this later on the account card.'}
            </div>
          </div>
          <Switch checked={fees} onChange={setFees} label="Trading fees" />
        </div>
        <div className="rounded-lg border border-line bg-panel-2 p-4">
          <div className="mb-2 text-2xs font-medium uppercase tracking-wider text-faint">Rules</div>
          <ul className="flex flex-col gap-1 text-xs text-muted">
            {rulesSummary({ ...practiceRules(valid && size != null ? size : 50_000), fees: fees ? 'real' : 'off' }).map((l) => (
              <li key={l} className="flex gap-2">
                <span className="text-faint">·</span>
                {l}
              </li>
            ))}
            <li className="flex gap-2">
              <span className="text-faint">·</span>
              No max loss, no target — your discipline guard-rails (tilt guard, daily stop) still apply
            </li>
          </ul>
        </div>
      </div>
      <aside className="flex flex-col gap-4 self-start rounded-lg border border-line bg-panel-2 p-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultName} maxLength={60} />
        </Field>
        <p className="text-xs text-muted">
          A live account has no challenge rules and no fee — just your balance, your trades and the market.
        </p>
        <ErrorNote error={error} />
        <Button variant="primary" size="lg" block onClick={create} loading={busy} disabled={!valid}>
          Create live account
        </Button>
      </aside>
    </div>
  );
}
