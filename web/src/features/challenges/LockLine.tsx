import clsx from 'clsx';
import { Lock } from 'lucide-react';
import type { Account } from '@shared/types';
import { activeLock, useNow } from '@/store/hooks';
import { fmtCountdown, fmtTime } from '@/lib/format';
import { showMoment } from '@/features/realism/store';
import { LOCK_LABELS, lockEndsAt } from './accountUtils';

/** Amber "Locked · Tilt cooldown · 12:34 left" line; ticks every second. Click opens the lock screen. */
export function LockLine({ account, className }: { account: Account; className?: string }) {
  const now = useNow(1000);
  const lock = activeLock(account, now);
  if (!lock) return null;
  const ends = lockEndsAt(account, now);
  return (
    <button
      type="button"
      onClick={() => showMoment('lock', account.id, null)}
      className={clsx('flex w-full items-center gap-2 rounded-md border border-warn/30 bg-warn/8 px-3 py-2 text-left text-xs text-warn transition-colors hover:bg-warn/12', className)}
    >
      <Lock size={13} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-semibold">Locked · {LOCK_LABELS[lock.reason]}</span>
        <span className="text-warn/80"> — {lock.message}</span>
      </span>
      {ends != null && (
        <span className="tnum shrink-0 font-semibold" title={`Until ${fmtTime(ends, { seconds: false })}`}>
          {fmtCountdown(ends - now)}
        </span>
      )}
    </button>
  );
}
