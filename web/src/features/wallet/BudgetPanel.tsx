import { useState } from 'react';
import clsx from 'clsx';
import { Pencil } from 'lucide-react';
import { useApp } from '@/store/app';
import { fmtMoney, fmtPct } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { NumberInput } from '@/components/ui/Input';
import { Meter } from '@/components/ui/Meter';
import { Money } from '@/components/ui/Money';
import { saveSettings } from '@/features/settings/save';

function monthName(): string {
  return new Date().toLocaleString('en-CA', { month: 'long' });
}

/** Fees paid this calendar month against the trader's own monthly challenge budget (editable). */
export function BudgetPanel() {
  const spent = useApp((s) => s.wallet.monthSpent);
  const budget = useApp((s) => s.settings.monthlyBudget ?? s.wallet.monthBudget);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<number | null>(budget);
  const [busy, setBusy] = useState(false);

  const save = async (value: number | null) => {
    setBusy(true);
    const ok = await saveSettings({ monthlyBudget: value != null && value > 0 ? Math.round(value * 100) / 100 : null });
    setBusy(false);
    if (ok) setEditing(false);
  };

  const ratio = budget && budget > 0 ? spent / budget : 0;
  const tone = ratio >= 1 ? 'loss' : ratio >= 0.75 ? 'warn' : 'neutral';

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted">Challenge budget · {monthName()}</div>
        {!editing && (
          <Button
            variant="ghost"
            size="xs"
            icon={<Pencil size={12} />}
            onClick={() => {
              setDraft(budget);
              setEditing(true);
            }}
          >
            {budget == null ? 'Set budget' : 'Edit'}
          </Button>
        )}
      </div>

      {editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <NumberInput
            value={draft}
            onChange={setDraft}
            step={50}
            min={0}
            max={100_000}
            precision={0}
            prefix="$"
            suffix="/ month"
            className="w-48"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') save(draft);
              if (e.key === 'Escape') setEditing(false);
            }}
          />
          <Button variant="primary" size="md" onClick={() => save(draft)} loading={busy}>
            Save
          </Button>
          {budget != null && (
            <Button variant="ghost" size="md" onClick={() => save(null)} disabled={busy}>
              Remove budget
            </Button>
          )}
          <Button variant="ghost" size="md" onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </Button>
        </div>
      ) : budget == null ? (
        <p className="text-sm text-muted">
          <Money value={spent} className="font-medium text-fg" /> spent on challenges this month. Set a monthly budget and every purchase above it gets flagged.
        </p>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-3">
            <div className="tnum text-sm text-muted">
              <Money value={spent} className="text-lg font-semibold text-fg" /> of {fmtMoney(budget, { whole: true })}
            </div>
            <div className={clsx('tnum text-sm', tone === 'loss' ? 'text-loss' : tone === 'warn' ? 'text-warn' : 'text-muted')}>
              {spent > budget ? `${fmtMoney(spent - budget)} over budget` : `${fmtMoney(budget - spent)} left · ${fmtPct(Math.min(1, ratio), 0)} used`}
            </div>
          </div>
          <Meter value={ratio} tone={tone} height={8} label="Monthly challenge budget used" />
        </>
      )}
    </section>
  );
}
