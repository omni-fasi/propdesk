import { createPortal } from 'react-dom';
import { Lock } from 'lucide-react';
import type { Account } from '@shared/types';
import { activeLock, useActiveAccount, useNow } from '@/store/hooks';
import { fmtCountdown } from '@/lib/format';
import { LOCK_LABELS, lockEndsAt } from '@/features/challenges/accountUtils';
import { showMoment, useRealism } from './store';

function Banner({ account }: { account: Account }) {
  const now = useNow(1000);
  const overlayOpen = useRealism((s) => s.moments[0]?.key === `lock:${account.id}`);
  const lock = activeLock(account, now);
  if (!lock || overlayOpen) return null;
  const ends = lockEndsAt(account, now);
  return createPortal(
    <button
      type="button"
      onClick={() => showMoment('lock', account.id, null)}
      className="fixed left-1/2 top-2 z-[45] flex h-8 -translate-x-1/2 animate-fade-in items-center gap-2 rounded-full border border-warn/40 bg-[#1a1306] px-3.5 text-xs text-warn shadow-pop transition-colors hover:bg-[#241a08]"
      title={lock.message}
    >
      <Lock size={13} />
      <span className="font-semibold">{LOCK_LABELS[lock.reason]}</span>
      {ends != null && (
        <>
          <span className="text-warn/50">·</span>
          <span className="tnum font-semibold">{fmtCountdown(ends - now)}</span>
          <span className="text-warn/70">{lock.until == null ? 'until the next trading day' : 'left'}</span>
        </>
      )}
    </button>,
    document.body,
  );
}

/** Slim, persistent banner while the selected account is locked. Click to open the lock screen. */
export function LockBanner() {
  const account = useActiveAccount();
  if (!account?.lock) return null;
  return <Banner account={account} />;
}
