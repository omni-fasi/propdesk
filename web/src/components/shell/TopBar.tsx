import { Wallet, WifiOff } from 'lucide-react';
import clsx from 'clsx';
import { NEW_YORK } from '@shared/time';
import { useApp } from '@/store/app';
import { useNow } from '@/store/hooks';
import { fmtTime } from '@/lib/format';
import { navigate } from '@/lib/router';
import { Money } from '@/components/ui/Money';
import { Tooltip } from '@/components/ui/Popover';
import { AccountSwitcher } from './AccountSwitcher';

function FeedDots() {
  const feeds = useApp((s) => s.feeds);
  const connected = useApp((s) => s.connected);
  return (
    <div className="flex items-center gap-2">
      {feeds.map((f) => (
        <Tooltip
          key={f.provider}
          side="bottom"
          content={
            <span>
              {f.provider === 'binance' ? 'Crypto, metals & stock perps' : 'CME futures & forex'} · {f.state}
              {f.delaySec > 0 ? ` · data ${Math.round(f.delaySec / 60)} min delayed (time-shifted)` : ''}
              {f.message ? ` · ${f.message}` : ''}
            </span>
          }
        >
          <span className="flex items-center gap-1.5 text-2xs uppercase tracking-wider text-faint">
            <span
              className={clsx(
                'size-1.5 rounded-full',
                !connected ? 'bg-faint' : f.state === 'live' ? 'bg-fg' : f.state === 'degraded' || f.state === 'connecting' ? 'animate-pulse-soft bg-muted' : 'bg-loss',
              )}
            />
            {f.provider === 'binance' ? 'BNC' : 'YHO'}
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

function Clock() {
  const now = useNow(1000);
  const localTz = useApp((s) => s.localTz);
  const sameAsNy = fmtTime(now, { tz: localTz, seconds: false }) === fmtTime(now, { tz: NEW_YORK, seconds: false });
  return (
    <div className="flex items-center gap-3 text-xs text-muted">
      <span className="tnum">
        {fmtTime(now, { tz: NEW_YORK })} <span className="text-faint">ET</span>
      </span>
      {!sameAsNy && (
        <span className="tnum">
          {fmtTime(now, { tz: localTz, seconds: false })} <span className="text-faint">local</span>
        </span>
      )}
    </div>
  );
}

export function TopBar() {
  const wallet = useApp((s) => s.wallet);
  const connected = useApp((s) => s.connected);
  return (
    <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-line bg-bg px-3">
      <div className="flex min-w-0 items-center gap-3">
        <AccountSwitcher />
        {!connected && (
          <span className="flex items-center gap-1.5 rounded-md bg-loss/10 px-2 py-1 text-xs text-loss">
            <WifiOff size={13} /> Disconnected from server — reconnecting…
          </span>
        )}
      </div>
      <div className="flex items-center gap-5">
        <FeedDots />
        <Clock />
        <button
          onClick={() => navigate('wallet')}
          className="flex h-8 items-center gap-2 rounded-md border border-line px-2.5 text-xs text-muted transition-colors hover:border-line-strong hover:text-fg"
          title="Your wallet — pays challenge fees, receives payouts"
        >
          <Wallet size={14} />
          <Money value={wallet.balance} className="text-[13px] font-medium text-fg" />
        </button>
      </div>
    </header>
  );
}
