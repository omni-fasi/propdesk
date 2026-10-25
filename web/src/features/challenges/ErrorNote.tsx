import clsx from 'clsx';
import { ArrowRight } from 'lucide-react';
import { errorMessage } from '@/api/client';
import { depositHref } from './PurchaseSummary';
import { isInsufficientFunds } from './actions';

/** Inline error from an API call; insufficient funds get a deposit link. */
export function ErrorNote({ error, onNavigate, className }: { error: unknown; onNavigate?: () => void; className?: string }) {
  if (error == null) return null;
  return (
    <div className={clsx('flex flex-wrap items-center justify-between gap-2 rounded-md border border-loss/30 bg-loss/8 px-3 py-2 text-sm text-loss', className)}>
      <span>{errorMessage(error)}</span>
      {isInsufficientFunds(error) && (
        <a href={depositHref()} onClick={onNavigate} className="inline-flex items-center gap-1 font-medium text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg">
          Deposit funds <ArrowRight size={14} />
        </a>
      )}
    </div>
  );
}
