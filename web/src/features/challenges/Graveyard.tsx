import { useState } from 'react';
import clsx from 'clsx';
import { ArchiveRestore, RotateCcw } from 'lucide-react';
import type { Account } from '@shared/types';
import { errorMessage } from '@/api/client';
import { useApp } from '@/store/app';
import { fmtDateTime, fmtMoney } from '@/lib/format';
import { KindBadge, Badge } from '@/components/ui/Badge';
import { Button, IconButton } from '@/components/ui/Button';
import { Money, Pnl, WorkHours } from '@/components/ui/Money';
import { toast } from '@/components/ui/Toast';
import { attemptCost, lifespan, retryOf, retryPrice } from './accountUtils';
import { setArchived } from './actions';
import { RetryDialog } from './LifecycleDialogs';

function Row({ account, accounts }: { account: Account; accounts: Record<string, Account> }) {
  const presets = useApp((s) => s.presets);
  const [retrying, setRetrying] = useState(false);
  const cost = attemptCost(account, accounts);
  const price = retryPrice(account, presets);
  const retried = retryOf(account, accounts);
  const pnl = account.balance - account.rules.startingBalance;

  const unarchive = async () => {
    try {
      await setArchived(account.id, false);
    } catch (e) {
      toast({ title: 'Could not unarchive', description: errorMessage(e), tone: 'loss' });
    }
  };

  return (
    <tr className={clsx('border-t border-line align-top', account.archived && 'opacity-60')}>
      <td className="py-3 pl-4 pr-3">
        <div className="font-medium text-fg">{account.name}</div>
        <div className="mt-1 flex items-center gap-1.5">
          <KindBadge kind={account.kind} phase={account.phase} phaseCount={account.phaseCount} size="xs" />
          {account.archived && <Badge size="xs">Archived</Badge>}
        </div>
      </td>
      <td className="tnum px-3 py-3 text-muted">
        <div>{account.endedAt ? fmtDateTime(account.endedAt) : '—'}</div>
        <div className="text-2xs text-faint">lasted {lifespan(account.createdAt, account.endedAt ?? account.createdAt)}</div>
      </td>
      <td className="px-3 py-3 text-loss">{account.endReason ?? 'Failed'}</td>
      <td className="tnum px-3 py-3 text-right">
        <Money value={account.balance} className="text-fg" />
        <div className="text-2xs">
          <Pnl value={pnl} />
        </div>
      </td>
      <td className="tnum px-3 py-3 text-right">
        <Money value={cost > 0 ? -cost : 0} className={cost > 0 ? 'text-loss' : 'text-faint'} />
        <div>
          <WorkHours value={cost > 0 ? cost : null} className="text-2xs" />
        </div>
      </td>
      <td className="py-3 pl-3 pr-4 text-right">
        <div className="flex items-center justify-end gap-1">
          {price != null && !retried && (
            <Button size="xs" variant="outline" icon={<RotateCcw size={12} />} onClick={() => setRetrying(true)}>
              Retry {fmtMoney(price)}
            </Button>
          )}
          {retried && <span className="text-2xs text-faint">Retried → {retried.name}</span>}
          {account.archived && <IconButton label="Unarchive" icon={<ArchiveRestore size={13} />} size="xs" onClick={unarchive} />}
        </div>
        {retrying && <RetryDialog account={account} onClose={() => setRetrying(false)} />}
      </td>
    </tr>
  );
}

/** Failed attempts, newest first: when, how, and what each one cost. Nothing here can be deleted. */
export function Graveyard({ failed, accounts }: { failed: Account[]; accounts: Record<string, Account> }) {
  const lost = failed.reduce((sum, a) => sum + attemptCost(a, accounts), 0);
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
        <p className="text-sm text-muted">
          {failed.length} failed attempt{failed.length === 1 ? '' : 's'} · <Money value={-lost} className="text-loss" /> in fees you won't get back.
        </p>
        <p className="text-xs text-faint">Failed accounts can't be reset or deleted.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className="text-left text-2xs uppercase tracking-wider text-faint">
              <th className="py-2 pl-4 pr-3 font-medium">Attempt</th>
              <th className="px-3 py-2 font-medium">Failed</th>
              <th className="px-3 py-2 font-medium">How</th>
              <th className="px-3 py-2 text-right font-medium">Final balance</th>
              <th className="px-3 py-2 text-right font-medium">Fee lost</th>
              <th className="py-2 pl-3 pr-4" />
            </tr>
          </thead>
          <tbody>
            {failed.map((a) => (
              <Row key={a.id} account={a} accounts={accounts} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
