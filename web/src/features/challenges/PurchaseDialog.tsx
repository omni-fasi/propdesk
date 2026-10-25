import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { fmtMoney } from '@/lib/format';
import { HoldButton } from '@/features/realism/HoldButton';
import { ErrorNote } from './ErrorNote';
import { PurchaseSummary, useCanAfford } from './PurchaseSummary';

export interface PurchaseDialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  price: number;
  priceLabel?: string;
  /** Verb for the hold button: "pay" → "Hold to pay $99.00". Free actions read "Hold to <freeLabel>". */
  freeLabel?: string;
  onConfirm: () => Promise<unknown>;
  children?: ReactNode;
}

/** Confirmation for anything paid from the wallet: details, wallet before/after, hold to pay. */
export function PurchaseDialog({ open, onClose, title, description, price, priceLabel, freeLabel = 'confirm', onConfirm, children }: PurchaseDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const affordable = useCanAfford(price);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      title={title}
      description={description}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <HoldButton
            label={price > 0 ? `Hold to pay ${fmtMoney(price)}` : `Hold to ${freeLabel}`}
            onConfirm={run}
            loading={busy}
            disabled={!affordable}
            holdMs={price > 0 ? 1400 : 900}
          />
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {children}
        <PurchaseSummary price={price} priceLabel={priceLabel} onNavigate={onClose} />
        <ErrorNote error={error} onNavigate={onClose} />
      </div>
    </Modal>
  );
}
