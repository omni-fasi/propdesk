import clsx from 'clsx';
import { ArrowRight } from 'lucide-react';
import { useApp } from '@/store/app';
import { hrefFor } from '@/lib/router';
import { fmtMoney } from '@/lib/format';
import { Money, WorkHours } from '@/components/ui/Money';

export function useCanAfford(price: number): boolean {
  const balance = useApp((s) => s.wallet.balance);
  return balance + 1e-9 >= price;
}

export function depositHref(amount?: number): string {
  return hrefFor('wallet', { deposit: 1, amount: amount && amount > 0 ? Math.ceil(amount) : undefined });
}

/** "Your wallet has $40.00 — this costs $149.00" with a link to deposit the difference. */
export function InsufficientFunds({ price, onNavigate, className }: { price: number; onNavigate?: () => void; className?: string }) {
  const balance = useApp((s) => s.wallet.balance);
  const short = Math.max(0, price - balance);
  return (
    <div className={clsx('flex flex-wrap items-center justify-between gap-2 rounded-md border border-loss/30 bg-loss/8 px-3 py-2 text-sm', className)}>
      <span className="text-fg">
        Your wallet has <Money value={balance} className="font-medium" /> — this costs <Money value={price} className="font-medium" />.
      </span>
      <a href={depositHref(short)} onClick={onNavigate} className="inline-flex items-center gap-1 text-sm font-medium text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg">
        Deposit {fmtMoney(short)} <ArrowRight size={14} />
      </a>
    </div>
  );
}

/** Price, wallet before → after, and the monthly budget impact of a purchase. */
export function PurchaseSummary({ price, priceLabel = 'Price', onNavigate, className }: { price: number; priceLabel?: string; onNavigate?: () => void; className?: string }) {
  const wallet = useApp((s) => s.wallet);
  const budget = useApp((s) => s.settings.monthlyBudget ?? s.wallet.monthBudget);
  const after = wallet.balance - price;
  const affordable = after >= -1e-9;
  const monthAfter = wallet.monthSpent + price;
  const overBudget = budget != null && price > 0 && monthAfter > budget + 1e-9;

  return (
    <div className={clsx('flex flex-col gap-2', className)}>
      <dl className="divide-y divide-line rounded-md border border-line bg-panel-2 text-sm">
        <div className="flex items-center justify-between gap-4 px-3 py-2">
          <dt className="text-muted">{priceLabel}</dt>
          <dd className="flex items-baseline gap-2">
            <WorkHours value={price > 0 ? price : null} />
            <Money value={price} className="font-semibold text-fg" />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 px-3 py-2">
          <dt className="text-muted">Wallet</dt>
          <dd className="tnum flex items-center gap-1.5">
            <Money value={wallet.balance} className="text-muted" />
            <ArrowRight size={12} className="text-faint" />
            <Money value={after} className={clsx('font-semibold', affordable ? 'text-fg' : 'text-loss')} />
          </dd>
        </div>
        {budget != null && price > 0 && (
          <div className="flex items-center justify-between gap-4 px-3 py-2">
            <dt className="text-muted">This month</dt>
            <dd className={clsx('tnum', overBudget ? 'text-warn' : 'text-muted')}>
              {fmtMoney(monthAfter)} of {fmtMoney(budget, { whole: true })} budget
            </dd>
          </div>
        )}
      </dl>
      {!affordable && <InsufficientFunds price={price} onNavigate={onNavigate} />}
      {affordable && overBudget && (
        <div className="rounded-md border border-warn/30 bg-warn/8 px-3 py-2 text-sm text-warn">
          This puts you {fmtMoney(monthAfter - (budget ?? 0))} over your monthly challenge budget.
        </div>
      )}
    </div>
  );
}
