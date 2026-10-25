import type { Account } from '@shared/types';
import { useApp } from '@/store/app';
import { rulesSummary } from '@/lib/rules';
import { fmtMoney, fmtPct } from '@/lib/format';
import { toast } from '@/components/ui/Toast';
import { activationPrice, presetOf, retryPrice } from './accountUtils';
import { activateFunded, retryAccount } from './actions';
import { PurchaseDialog } from './PurchaseDialog';

/** Buy a new attempt of a failed preset evaluation (pays the reset fee). */
export function RetryDialog({ account, onClose, onDone }: { account: Account; onClose: () => void; onDone?: (next: Account) => void }) {
  const presets = useApp((s) => s.presets);
  const preset = presetOf(account, presets);
  const price = retryPrice(account, presets);
  if (price == null) return null;
  const discounted = preset && preset.resetFee != null && preset.resetFee < preset.fee;
  return (
    <PurchaseDialog
      open
      onClose={onClose}
      title={`New attempt · ${preset?.name ?? account.name}`}
      description="A fresh account with the same rules, starting from phase 1. The failed attempt stays in your history."
      price={price}
      priceLabel={discounted ? `Reset price (new: ${fmtMoney(preset.fee)})` : 'Price'}
      onConfirm={async () => {
        const next = await retryAccount(account.id);
        toast({ title: `${next.name} started`, description: `${fmtMoney(price)} paid from your wallet. It is now your selected account.` });
        onDone?.(next);
      }}
    />
  );
}

/** Activate the funded stage of a passed final phase (pays the activation fee). */
export function ActivateDialog({ account, onClose, onDone }: { account: Account; onClose: () => void; onDone?: (next: Account) => void }) {
  const presets = useApp((s) => s.presets);
  const preset = presetOf(account, presets);
  const price = activationPrice(account, presets);
  if (price == null) return null;
  return (
    <PurchaseDialog
      open
      onClose={onClose}
      title="Activate your funded account"
      description="Same loss rules, no profit target. Withdraw profits as payouts into your wallet."
      price={price}
      priceLabel="Activation fee"
      freeLabel="activate"
      onConfirm={async () => {
        const next = await activateFunded(account.id);
        toast({ title: `${next.name} is live`, description: 'It is now your selected account.', tone: 'profit' });
        onDone?.(next);
      }}
    >
      {preset?.funded && (
        <ul className="flex flex-col gap-1 text-xs text-muted">
          {rulesSummary(preset.funded.rules)
            .slice(0, 4)
            .map((l) => (
              <li key={l}>· {l}</li>
            ))}
          <li>
            · Payouts: {fmtPct(preset.funded.payout.profitSplit, 0)} to you after {preset.funded.payout.minWinningDays} winning days, min{' '}
            {fmtMoney(preset.funded.payout.minAmount, { whole: true })}
          </li>
        </ul>
      )}
    </PurchaseDialog>
  );
}
