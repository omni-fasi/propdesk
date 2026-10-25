// "All accounts / one account" picker used by the calendar and the journal.

import { Check, ChevronDown, Layers } from 'lucide-react';
import clsx from 'clsx';
import type { Account } from '@shared/types';
import { useAccountList } from '@/store/hooks';
import { Badge, KindBadge, StatusBadge } from '@/components/ui/Badge';
import { MenuItem, Popover } from '@/components/ui/Popover';

function AccountMeta({ account }: { account: Account }) {
  return (
    <span className="flex items-center gap-1">
      <KindBadge kind={account.kind} phase={account.phase} phaseCount={account.phaseCount} size="xs" />
      {account.status !== 'active' && <StatusBadge status={account.status} size="xs" />}
      {account.archived && <Badge size="xs">Archived</Badge>}
    </span>
  );
}

export function AccountFilter({ value, onChange, className }: { value: string; onChange: (id: string) => void; className?: string }) {
  const accounts = useAccountList({ includeArchived: true });
  const selected = value === 'all' ? null : (accounts.find((a) => a.id === value) ?? null);
  const visible = accounts.filter((a) => !a.archived);
  const archived = accounts.filter((a) => a.archived);

  return (
    <div className={className}>
      <Popover
        align="end"
        className="w-80"
        triggerClassName="flex h-8 max-w-72 items-center gap-2 rounded-md border border-line-strong bg-panel-2 px-2.5 text-left text-[13px] text-fg transition-colors hover:border-[#3a3a3a]"
        trigger={
          <>
            {selected ? (
              <>
                <span className="min-w-0 truncate font-medium">{selected.name}</span>
                <AccountMeta account={selected} />
              </>
            ) : (
              <>
                <Layers size={14} className="text-muted" />
                <span className="font-medium">All accounts</span>
              </>
            )}
            <ChevronDown size={14} className="ml-auto shrink-0 text-faint" />
          </>
        }
      >
        {(close) => {
          const pick = (id: string) => {
            onChange(id);
            close();
          };
          const row = (a: Account) => (
            <MenuItem key={a.id} active={a.id === value} onClick={() => pick(a.id)} className={clsx('justify-between py-2', a.status !== 'active' && 'text-muted')}>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-medium">{a.name}</span>
                <AccountMeta account={a} />
              </span>
              {a.id === value && <Check size={14} className="shrink-0" />}
            </MenuItem>
          );
          return (
            <div className="max-h-[60vh] overflow-auto">
              <MenuItem active={value === 'all'} onClick={() => pick('all')} className="justify-between py-2">
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">All accounts</span>
                  <span className="text-2xs text-faint">Every account combined</span>
                </span>
                {value === 'all' && <Check size={14} className="shrink-0" />}
              </MenuItem>
              {visible.length > 0 && <div className="mx-2 my-1 h-px bg-line" />}
              {visible.map(row)}
              {archived.length > 0 && (
                <>
                  <div className="px-2.5 pb-1 pt-2 text-2xs font-medium uppercase tracking-wider text-faint">Archived</div>
                  {archived.map(row)}
                </>
              )}
              {accounts.length === 0 && <div className="px-3 py-3 text-center text-xs text-muted">No accounts yet.</div>}
            </div>
          );
        }}
      </Popover>
    </div>
  );
}

/** Resolve a URL account param against the known accounts ('all' when unknown). */
export function resolveAccountParam(raw: string | null, accounts: Record<string, Account>): string {
  if (!raw || raw === 'all') return 'all';
  return accounts[raw] ? raw : 'all';
}
