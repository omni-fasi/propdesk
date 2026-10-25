import { useCallback, useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { CircleCheck, CircleX } from 'lucide-react';
import type { PayoutEligibility, PayoutResponse } from '@shared/api';
import type { Account } from '@shared/types';
import { api } from '@/api/client';
import { useApp } from '@/store/app';
import { fmtMoney, fmtPct } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Field, NumberInput } from '@/components/ui/Input';
import { Meter } from '@/components/ui/Meter';
import { Spinner } from '@/components/ui/Misc';
import { Modal } from '@/components/ui/Modal';
import { Money, WorkHours } from '@/components/ui/Money';
import { HoldButton } from '@/features/realism/HoldButton';
import { ErrorNote } from './ErrorNote';
import { requestPayout } from './actions';

const round2 = (x: number) => Math.round(x * 100) / 100;

function Line({ label, children, strong }: { label: ReactNode; children: ReactNode; strong?: boolean }) {
  return (
    <div className={clsx('flex items-center justify-between gap-4 px-3 py-2 text-sm', strong && 'bg-panel-3/60')}>
      <span className="text-muted">{label}</span>
      <span className="tnum">{children}</span>
    </div>
  );
}

/** Funded payout: eligibility → amount between min and max → split breakdown → hold to withdraw. */
export function PayoutDialog({ account, open, onClose }: { account: Account; open: boolean; onClose: () => void }) {
  const walletBalance = useApp((s) => s.wallet.balance);
  const [elig, setElig] = useState<PayoutEligibility | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<PayoutResponse | null>(null);

  const load = useCallback(async () => {
    setElig(null);
    setLoadError(null);
    try {
      const e = await api.payoutEligibility(account.id);
      setElig(e);
      setAmount(e.eligible ? round2(e.maxAmount) : null);
    } catch (err) {
      setLoadError(err);
    }
  }, [account.id]);

  useEffect(() => {
    if (!open) return;
    setDone(null);
    setError(null);
    load();
  }, [open, load]);

  const valid = elig?.eligible && amount != null && amount >= elig.minAmount - 1e-9 && amount <= elig.maxAmount + 1e-9;
  const received = elig && amount != null ? round2(amount * elig.profitSplit) : 0;

  const submit = async () => {
    if (!valid || amount == null) return;
    setBusy(true);
    setError(null);
    try {
      setDone(await requestPayout(account.id, round2(amount)));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  let body: ReactNode;
  let footer: ReactNode = (
    <Button variant="ghost" onClick={onClose}>
      Close
    </Button>
  );

  if (done) {
    body = (
      <div className="flex flex-col items-center gap-2 py-6 text-center">
        <CircleCheck size={28} className="text-profit" />
        <div className="text-3xl font-semibold tracking-tight">
          <Money value={done.received} sign className="text-profit" />
        </div>
        <div className="text-sm text-muted">landed in your wallet. New wallet balance <Money value={done.wallet.balance} className="text-fg" />.</div>
        <WorkHours value={done.received} />
      </div>
    );
    footer = (
      <Button variant="primary" onClick={onClose}>
        Done
      </Button>
    );
  } else if (loadError) {
    body = (
      <div className="flex flex-col gap-3">
        <ErrorNote error={loadError} />
        <Button variant="secondary" onClick={load} className="self-start">
          Try again
        </Button>
      </div>
    );
  } else if (!elig) {
    body = (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
        <Spinner /> Checking eligibility…
      </div>
    );
  } else if (!elig.eligible) {
    body = (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-muted">Winning days since {account.lastPayoutAt ? 'your last payout' : 'activation'}</span>
            <span className="tnum text-fg">
              {elig.winningDays} / {elig.requiredWinningDays}
            </span>
          </div>
          <Meter value={elig.requiredWinningDays > 0 ? elig.winningDays / elig.requiredWinningDays : 1} tone="neutral" />
        </div>
        <ul className="flex flex-col gap-2">
          {elig.reasons.map((r) => (
            <li key={r} className="flex items-start gap-2 text-sm text-fg">
              <CircleX size={15} className="mt-0.5 shrink-0 text-faint" />
              {r}
            </li>
          ))}
        </ul>
        <p className="text-xs text-faint">
          Payouts need {elig.requiredWinningDays} winning days, a profit, and no open positions. You keep {fmtPct(elig.profitSplit, 0)} of what you withdraw.
        </p>
      </div>
    );
  } else {
    const fundedAfter = account.balance - (amount ?? 0);
    body = (
      <div className="flex flex-col gap-4">
        <Field
          label="Amount to withdraw"
          error={amount != null && !valid ? `Between ${fmtMoney(elig.minAmount)} and ${fmtMoney(elig.maxAmount)}` : undefined}
          hint={`Between ${fmtMoney(elig.minAmount)} and ${fmtMoney(elig.maxAmount)}`}
        >
          <div className="flex gap-2">
            <NumberInput value={amount} onChange={setAmount} step={0.01} min={elig.minAmount} max={elig.maxAmount} prefix="$" className="flex-1" invalid={amount != null && !valid} />
            <Button variant="outline" size="md" onClick={() => setAmount(round2(elig.minAmount))}>
              Min
            </Button>
            <Button variant="outline" size="md" onClick={() => setAmount(round2(elig.maxAmount))}>
              Max
            </Button>
          </div>
        </Field>
        <div className="divide-y divide-line rounded-md border border-line bg-panel-2">
          <Line label={`Withdrawn from ${account.name}`}>
            <Money value={-(amount ?? 0)} />
          </Line>
          <Line label={`Firm's share (${fmtPct(1 - elig.profitSplit, 0)})`}>
            <Money value={(amount ?? 0) - received} className="text-muted" />
          </Line>
          <Line label={`Your share (${fmtPct(elig.profitSplit, 0)}) → wallet`} strong>
            <Money value={received} sign className="font-semibold text-profit" />
          </Line>
          <Line label="Wallet after">
            <Money value={walletBalance + received} className="text-fg" />
          </Line>
          <Line label="Funded balance after">
            <Money value={fundedAfter} className="text-fg" />
          </Line>
        </div>
        <p className="text-xs text-faint">A payout isn't trading P&L — your daily loss limit is unaffected. The winning-day count starts again after it.</p>
        <ErrorNote error={error} />
      </div>
    );
    footer = (
      <>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <HoldButton label={`Hold to withdraw ${fmtMoney(amount ?? 0)}`} onConfirm={submit} disabled={!valid} loading={busy} holdMs={1400} />
      </>
    );
  }

  return (
    <Modal open={open} onClose={busy ? undefined : onClose} title="Request a payout" description={done ? undefined : account.name} size="md" footer={footer}>
      {body}
    </Modal>
  );
}
