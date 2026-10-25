import type { ReactNode } from 'react';
import { CalendarDays, CandlestickChart, NotebookPen, Settings, Trophy, Wallet } from 'lucide-react';
import clsx from 'clsx';
import { hrefFor, type Page } from '@/lib/router';

const ITEMS: Array<{ page: Page; label: string; icon: ReactNode }> = [
  { page: 'trade', label: 'Trade', icon: <CandlestickChart size={19} strokeWidth={1.75} /> },
  { page: 'calendar', label: 'Calendar', icon: <CalendarDays size={19} strokeWidth={1.75} /> },
  { page: 'journal', label: 'Journal', icon: <NotebookPen size={19} strokeWidth={1.75} /> },
  { page: 'challenges', label: 'Accounts', icon: <Trophy size={19} strokeWidth={1.75} /> },
  { page: 'wallet', label: 'Wallet', icon: <Wallet size={19} strokeWidth={1.75} /> },
];

function Item({ page, label, icon, active }: { page: Page; label: string; icon: ReactNode; active: boolean }) {
  return (
    <a
      href={hrefFor(page)}
      className={clsx(
        'relative flex w-full flex-col items-center gap-1 py-2.5 text-[10px] font-medium tracking-wide transition-colors',
        active ? 'text-fg' : 'text-faint hover:text-muted',
      )}
    >
      {active && <span className="absolute inset-y-2 left-0 w-0.5 rounded-r bg-fg" />}
      {icon}
      {label}
    </a>
  );
}

export function NavRail({ page }: { page: Page }) {
  return (
    <nav className="flex w-[68px] shrink-0 flex-col items-center border-r border-line bg-bg">
      <a href={hrefFor('trade')} className="flex h-12 w-full items-center justify-center border-b border-line" title="PropDesk">
        <img src="/icon.svg" alt="PropDesk" className="size-7" />
      </a>
      <div className="flex w-full flex-1 flex-col pt-1">
        {ITEMS.map((it) => (
          <Item key={it.page} {...it} active={page === it.page} />
        ))}
      </div>
      <div className="w-full pb-2">
        <Item page="settings" label="Settings" icon={<Settings size={19} strokeWidth={1.75} />} active={page === 'settings'} />
      </div>
    </nav>
  );
}
