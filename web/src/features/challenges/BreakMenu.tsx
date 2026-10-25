import { ChevronDown, Coffee } from 'lucide-react';
import type { Account } from '@shared/types';
import { errorMessage } from '@/api/client';
import { serverNow } from '@/store/app';
import { fmtTime } from '@/lib/format';
import { MenuItem, Popover } from '@/components/ui/Popover';
import { confirm, toast } from '@/components/ui/Toast';
import { takeBreak } from './actions';

const OPTIONS = [5, 15, 30, 60];

/** "Take a break" — a voluntary lock the trader can't end early. */
export function BreakMenu({ account, disabled }: { account: Account; disabled?: boolean }) {
  const start = async (minutes: number) => {
    const until = serverNow() + minutes * 60_000;
    const ok = await confirm({
      title: `Take a ${minutes}-minute break?`,
      body: (
        <>
          New entries on <span className="text-fg">{account.name}</span> are locked until{' '}
          <span className="tnum text-fg">{fmtTime(until, { seconds: false })}</span>. You can still close positions and cancel orders. A break can't be
          ended early.
        </>
      ),
      confirmLabel: 'Start break',
    });
    if (!ok) return;
    try {
      await takeBreak(account.id, minutes);
    } catch (e) {
      toast({ title: 'Could not start the break', description: errorMessage(e), tone: 'loss' });
    }
  };

  return (
    <Popover
      disabled={disabled}
      side="top"
      triggerClassName="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong bg-panel-3 px-2.5 text-[13px] text-fg transition-colors hover:border-[#3a3a3a] hover:bg-[#222] disabled:pointer-events-none disabled:opacity-40"
      trigger={
        <>
          <Coffee size={14} /> Take a break <ChevronDown size={12} className="text-faint" />
        </>
      }
    >
      {(close) => (
        <div className="flex flex-col">
          <div className="px-2.5 pb-1 pt-1.5 text-2xs font-medium uppercase tracking-wider text-faint">Lock new entries for</div>
          {OPTIONS.map((m) => (
            <MenuItem
              key={m}
              onClick={() => {
                close();
                start(m);
              }}
            >
              {m} minutes
            </MenuItem>
          ))}
        </div>
      )}
    </Popover>
  );
}
