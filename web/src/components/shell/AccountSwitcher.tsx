import { ChevronDown, Plus, Settings2 } from 'lucide-react';
import clsx from 'clsx';
import { useApp } from '@/store/app';
import { useAccountList, useActiveAccount, useActiveSnapshot } from '@/store/hooks';
import { navigate } from '@/lib/router';
import { KindBadge, StatusBadge } from '@/components/ui/Badge';
import { Money, Pnl } from '@/components/ui/Money';
import { MenuItem, Popover } from '@/components/ui/Popover';

export function AccountSwitcher() {
  const account = useActiveAccount();
  const snap = useActiveSnapshot();
  const accounts = useAccountList();
  const snapshots = useApp((s) => s.snapshots);
  const activeId = useApp((s) => s.activeAccountId);
  const setActive = useApp((s) => s.setActiveAccount);

  return (
    <Popover
      triggerClassName="flex h-9 items-center gap-3 rounded-md border border-line bg-panel px-3 text-left transition-colors hover:border-line-strong hover:bg-panel-2"
      className="w-[420px]"
      trigger={
        account ? (
          <>
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="max-w-56 truncate text-[13px] font-semibold text-fg">{account.name}</span>
              <span className="flex items-center gap-1.5">
                <KindBadge kind={account.kind} phase={account.phase} phaseCount={account.phaseCount} size="xs" />
                {account.status !== 'active' && <StatusBadge status={account.status} size="xs" />}
              </span>
            </div>
            <div className="flex flex-col items-end leading-tight">
              <Money value={snap?.equity ?? account.balance} className="text-[13px] font-semibold text-fg" />
              <span className="text-2xs text-faint">
                <Pnl value={snap?.dayPnl ?? 0} className="text-2xs" /> today
              </span>
            </div>
            <ChevronDown size={14} className="text-faint" />
          </>
        ) : (
          <>
            <span className="text-[13px] text-muted">No account yet</span>
            <ChevronDown size={14} className="text-faint" />
          </>
        )
      }
    >
      {(close) => (
        <div className="flex flex-col">
          <div className="max-h-[60vh] overflow-auto">
            {accounts.length === 0 && <div className="px-3 py-4 text-center text-sm text-muted">Create a challenge or a live account to start trading.</div>}
            {accounts.map((a) => {
              const s = snapshots[a.id];
              return (
                <MenuItem
                  key={a.id}
                  active={a.id === activeId}
                  onClick={() => {
                    setActive(a.id);
                    close();
                  }}
                  className={clsx('justify-between py-2', a.status !== 'active' && 'opacity-70')}
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate font-medium">{a.name}</span>
                    <span className="flex items-center gap-1.5">
                      <KindBadge kind={a.kind} phase={a.phase} phaseCount={a.phaseCount} size="xs" />
                      <StatusBadge status={a.status} size="xs" />
                    </span>
                  </span>
                  <span className="flex flex-col items-end gap-0.5">
                    <Money value={s?.equity ?? a.balance} className="text-[13px]" />
                    <Pnl value={(s?.equity ?? a.balance) - a.rules.startingBalance} className="text-2xs" />
                  </span>
                </MenuItem>
              );
            })}
          </div>
          <div className="mt-1 flex gap-1 border-t border-line pt-1">
            <MenuItem
              onClick={() => {
                navigate('challenges', { new: 1 });
                close();
              }}
            >
              <Plus size={14} /> New challenge
            </MenuItem>
            <MenuItem
              onClick={() => {
                navigate('challenges');
                close();
              }}
            >
              <Settings2 size={14} /> Manage accounts
            </MenuItem>
          </div>
        </div>
      )}
    </Popover>
  );
}
