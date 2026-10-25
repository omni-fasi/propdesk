import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { Account, ChallengePreset } from '@shared/types';
import { fmtMoney } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { toast } from '@/components/ui/Toast';
import { HoldButton } from '@/features/realism/HoldButton';
import { createAccount } from './actions';
import { ErrorNote } from './ErrorNote';
import { FullRules, PhaseTargets } from './PresetCard';
import { PurchaseSummary, useCanAfford } from './PurchaseSummary';

/** Buying a preset: full rules on the left, wallet impact and "hold to pay" on the right. */
export function PresetCheckout({ preset, onBack, onDone, onNavigate }: { preset: ChallengePreset; onBack: () => void; onDone: (a: Account) => void; onNavigate: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const affordable = useCanAfford(preset.fee);

  const buy = async () => {
    setBusy(true);
    setError(null);
    try {
      const account = await createAccount({ kind: 'evaluation', presetId: preset.id, name: name.trim() || undefined });
      toast({ title: `${account.name} is ready`, description: `${fmtMoney(preset.fee)} paid from your wallet. It is now your selected account.` });
      onDone(account);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={onBack} className="flex items-center gap-1.5 self-start text-xs text-muted transition-colors hover:text-fg">
        <ArrowLeft size={13} /> All challenges
      </button>
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <section className="flex flex-col gap-4">
          <div>
            <h3 className="text-lg font-semibold tracking-tight text-fg">{preset.name}</h3>
            <p className="text-sm text-muted">{preset.tagline}</p>
          </div>
          <div className="rounded-lg border border-line bg-panel-2 p-4">
            <div className="mb-2 text-2xs font-medium uppercase tracking-wider text-faint">Phases</div>
            <PhaseTargets preset={preset} />
          </div>
          <div className="rounded-lg border border-line bg-panel-2 p-4">
            <div className="mb-2 text-2xs font-medium uppercase tracking-wider text-faint">Rules</div>
            <FullRules preset={preset} />
          </div>
          <p className="text-xs text-faint">
            Fail a rule and the account is closed for good — the fee is gone.{' '}
            {preset.resetFee != null ? `A new attempt costs ${fmtMoney(preset.resetFee)}.` : `A new attempt costs ${fmtMoney(preset.fee)}.`}
            {preset.funded && ` Passing unlocks a funded account (${preset.activationFee > 0 ? `${fmtMoney(preset.activationFee)} activation` : 'free activation'}).`}
          </p>
        </section>

        <aside className="flex flex-col gap-4 rounded-lg border border-line bg-panel-2 p-4">
          <div className="text-sm font-medium text-fg">Checkout</div>
          <Field label="Account name" hint="Optional">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={preset.name} maxLength={60} />
          </Field>
          <PurchaseSummary price={preset.fee} priceLabel="Evaluation fee" onNavigate={onNavigate} />
          <ErrorNote error={error} onNavigate={onNavigate} />
          <HoldButton label={`Hold to pay ${fmtMoney(preset.fee)}`} onConfirm={buy} loading={busy} disabled={!affordable} block size="lg" holdMs={1400} />
          <p className="text-center text-2xs text-faint">Paid from your wallet. No refunds.</p>
          <Button variant="ghost" size="sm" onClick={onBack} disabled={busy}>
            Back
          </Button>
        </aside>
      </div>
    </div>
  );
}
