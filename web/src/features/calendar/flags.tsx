// Day flags (breach, locks, breaks, pass, payout…) → icon, color and wording. They record what happened that
// day — a lock flag stays on the day after the lock is over.

import { Banknote, Coffee, Flame, Lock, ShieldX, Trophy } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import clsx from 'clsx';
import type { Account } from '@shared/types';
import { Tooltip } from '@/components/ui/Popover';
import type { DayAgg, DayFlag } from './calendarMath';

export interface FlagInfo {
  label: string;
  description: string;
  icon: LucideIcon;
  tone: 'loss' | 'warn' | 'profit' | 'neutral';
}

export const FLAG_INFO: Record<DayFlag, FlagInfo> = {
  breach: { label: 'Max loss breached', description: 'The account hit its max-loss limit and failed.', icon: ShieldX, tone: 'loss' },
  daily_loss: { label: 'Daily loss limit hit', description: 'Positions were closed and trading was locked for the rest of the day.', icon: Lock, tone: 'warn' },
  locked: {
    label: 'Trading was locked',
    description: 'A discipline limit (max trades per day or your personal daily stop) blocked new trades for the rest of the day.',
    icon: Lock,
    tone: 'warn',
  },
  break: { label: 'Took a break', description: 'You paused trading yourself — new trades were blocked until the break was over.', icon: Coffee, tone: 'neutral' },
  tilt: { label: 'Tilt guard', description: 'Losses in a row triggered a cooldown.', icon: Flame, tone: 'warn' },
  passed: { label: 'Challenge passed', description: 'The profit target was reached and the phase passed.', icon: Trophy, tone: 'profit' },
  payout: { label: 'Payout', description: 'Profit was withdrawn from the funded account.', icon: Banknote, tone: 'profit' },
};

export const FLAG_ORDER: DayFlag[] = ['breach', 'daily_loss', 'tilt', 'locked', 'break', 'passed', 'payout'];

export const FLAG_TONE_CLASS: Record<FlagInfo['tone'], string> = { loss: 'text-loss', warn: 'text-warn', profit: 'text-profit', neutral: 'text-muted' };

export function sortedFlags(flags: readonly DayFlag[]): DayFlag[] {
  return FLAG_ORDER.filter((f) => flags.includes(f));
}

/** Account names that carry `flag` on this day (for 'all accounts' tooltips). */
export function flagAccounts(day: DayAgg, flag: DayFlag, accounts: Record<string, Account>): string[] {
  return day.rows.filter((r) => r.flags?.includes(flag)).map((r) => accounts[r.accountId]?.name ?? 'Unknown account');
}

export function FlagIcons({ day, accounts, size = 13, showNames }: { day: DayAgg; accounts: Record<string, Account>; size?: number; showNames?: boolean }) {
  const flags = sortedFlags(day.flags);
  if (flags.length === 0) return null;
  return (
    <span className="flex items-center gap-1">
      {flags.map((f) => {
        const info = FLAG_INFO[f];
        const Icon = info.icon;
        const names = showNames ? flagAccounts(day, f, accounts) : [];
        return (
          <Tooltip
            key={f}
            side="bottom"
            content={
              <span>
                <span className="font-medium">{info.label}</span>
                {names.length > 0 && <span className="text-muted"> · {names.join(', ')}</span>}
              </span>
            }
          >
            <Icon size={size} strokeWidth={2} className={clsx(FLAG_TONE_CLASS[info.tone])} aria-label={info.label} />
          </Tooltip>
        );
      })}
    </span>
  );
}
