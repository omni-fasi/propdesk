import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { useApp } from '@/store/app';
import { fmtMoney } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Money, WorkHours } from '@/components/ui/Money';
import { toast } from '@/components/ui/Toast';
import { deposit } from '@/features/challenges/actions';
import { ErrorNote } from '@/features/challenges/ErrorNote';
import { AmountPicker } from './AmountPicker';

export const DEPOSIT_PICKS = [100, 250, 500, 1000];
export const MAX_DEPOSIT = 100_000;

export function DepositModal({ onClose, initialAmount }: { onClose: () => void; initialAmount?: number | null }) {
  const balance = useApp((s) => s.wallet.balance);
  const [amount, setAmount] = useState<number | null>(initialAmount ?? null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const valid = amount != null && amount >= 1 && amount <= MAX_DEPOSIT;

  const submit = async () => {
    if (!valid || amount == null) return;
    setBusy(true);
    setError(null);
    try {
      const amt = Math.round(amount * 100) / 100;
      const summary = await deposit(amt, note);
      toast({ title: `Deposited ${fmtMoney(amt)}`, description: `Wallet balance ${fmtMoney(summary.balance)}.` });
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      title="Deposit to your wallet"
      description="Would you really move this money? Deposit what you would actually spend on challenges — that's what makes losing one sting."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!valid} loading={busy}>
            {valid ? `Deposit ${fmtMoney(amount ?? 0)}` : 'Deposit'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <AmountPicker value={amount} onChange={setAmount} picks={DEPOSIT_PICKS} min={1} max={MAX_DEPOSIT} autoFocusCustom={initialAmount != null} />
        <Field label="Note" hint="Optional — e.g. “October budget”">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={120} placeholder="What is this money for?" />
        </Field>
        <div className="flex items-center justify-between rounded-md border border-line bg-panel-2 px-3 py-2 text-sm">
          <span className="text-muted">Wallet</span>
          <span className="tnum flex items-center gap-1.5">
            <Money value={balance} className="text-muted" />
            <ArrowRight size={12} className="text-faint" />
            <Money value={balance + (valid ? (amount ?? 0) : 0)} className="font-semibold text-fg" />
          </span>
        </div>
        {valid && <WorkHours value={amount} className="-mt-2 block text-right" />}
        <p className="text-xs text-faint">Money leaves the wallet only as challenge fees, and comes back only as payouts.</p>
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}
