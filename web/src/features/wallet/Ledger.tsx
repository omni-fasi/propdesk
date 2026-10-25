import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { ReceiptText, RefreshCw } from 'lucide-react';
import type { WalletTx, WalletTxKind } from '@shared/types';
import { errorMessage } from '@/api/client';
import { useApp } from '@/store/app';
import { fmtDateTime, fmtMoney } from '@/lib/format';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState, Skeleton } from '@/components/ui/Misc';
import { Money } from '@/components/ui/Money';
import { Segmented } from '@/components/ui/Tabs';

export const TX_LABELS: Record<WalletTxKind, { label: string; tone: BadgeTone }> = {
  deposit: { label: 'Deposit', tone: 'neutral' },
  withdrawal: { label: 'Withdrawal', tone: 'neutral' },
  challenge_fee: { label: 'Challenge fee', tone: 'loss' },
  reset_fee: { label: 'Reset fee', tone: 'loss' },
  activation_fee: { label: 'Activation fee', tone: 'loss' },
  payout: { label: 'Payout', tone: 'profit' },
};

type Filter = 'all' | 'deposits' | 'fees' | 'payouts';

const MATCH: Record<Filter, (k: WalletTxKind) => boolean> = {
  all: () => true,
  deposits: (k) => k === 'deposit' || k === 'withdrawal',
  fees: (k) => k === 'challenge_fee' || k === 'reset_fee' || k === 'activation_fee',
  payouts: (k) => k === 'payout',
};

function amountClass(tx: WalletTx): string {
  if (tx.kind === 'payout') return 'text-profit';
  if (tx.kind === 'deposit') return 'text-fg';
  if (tx.kind === 'withdrawal') return 'text-muted';
  return 'text-loss';
}

const PAGE = 100;

/** Every wallet movement, newest first. */
export function Ledger({ transactions, loading, error, onRetry }: { transactions: WalletTx[] | null; loading: boolean; error: unknown; onRetry: () => void }) {
  const accounts = useApp((s) => s.accounts);
  const [filter, setFilter] = useState<Filter>('all');
  const [limit, setLimit] = useState(PAGE);
  const rows = useMemo(() => (transactions ?? []).filter((t) => MATCH[filter](t.kind)), [transactions, filter]);

  return (
    <section className="flex flex-col overflow-hidden rounded-lg border border-line bg-panel">
      <header className="flex h-11 items-center justify-between gap-3 border-b border-line px-4">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted">Ledger</div>
        <div className="flex items-center gap-2">
          <Segmented
            value={filter}
            onChange={(f) => {
              setFilter(f);
              setLimit(PAGE);
            }}
            options={[
              { value: 'all', label: 'All' },
              { value: 'deposits', label: 'Deposits' },
              { value: 'fees', label: 'Fees' },
              { value: 'payouts', label: 'Payouts' },
            ]}
          />
        </div>
      </header>

      {error != null && transactions == null ? (
        <div className="flex flex-col items-center gap-3 py-10 text-sm text-muted">
          <span>Couldn't load the ledger: {errorMessage(error)}</span>
          <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : transactions == null && loading ? (
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState compact icon={<ReceiptText />} title={filter === 'all' ? 'No transactions yet' : 'Nothing here yet'} description={filter === 'all' ? 'Deposits, fees and payouts will be listed here.' : undefined} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="text-left text-2xs uppercase tracking-wider text-faint">
                <th className="py-2 pl-4 pr-3 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Account</th>
                <th className="px-3 py-2 font-medium">Note</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="py-2 pl-3 pr-4 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, limit).map((tx) => {
                const t = TX_LABELS[tx.kind] ?? { label: tx.kind, tone: 'neutral' as const };
                const account = tx.accountId ? accounts[tx.accountId] : null;
                return (
                  <tr key={tx.id} className="border-t border-line hover:bg-panel-2/60">
                    <td className="tnum whitespace-nowrap py-2 pl-4 pr-3 text-muted">{fmtDateTime(tx.ts)}</td>
                    <td className="px-3 py-2">
                      <Badge tone={t.tone}>{t.label}</Badge>
                    </td>
                    <td className="max-w-56 truncate px-3 py-2 text-fg">{account ? account.name : tx.accountId ? <span className="text-faint">Unknown account</span> : <span className="text-faint">—</span>}</td>
                    <td className="max-w-72 truncate px-3 py-2 text-muted" title={tx.note ?? undefined}>
                      {tx.note ?? <span className="text-faint">—</span>}
                    </td>
                    <td className={clsx('tnum whitespace-nowrap px-3 py-2 text-right font-medium', amountClass(tx))}>{fmtMoney(tx.amount, { sign: true })}</td>
                    <td className="tnum whitespace-nowrap py-2 pl-3 pr-4 text-right text-muted">
                      <Money value={tx.balanceAfter} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > limit && (
            <div className="border-t border-line p-2 text-center">
              <Button variant="ghost" size="sm" onClick={() => setLimit((l) => l + PAGE)}>
                Show {Math.min(PAGE, rows.length - limit)} more
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
