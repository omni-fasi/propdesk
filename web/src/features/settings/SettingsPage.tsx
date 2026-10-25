import { Page } from '@/components/ui/Panel';
import { AboutSection } from './AboutSection';
import { BudgetSection } from './BudgetSection';
import { DisciplineSection } from './DisciplineSection';
import { FeedsSection } from './FeedsSection';
import { ProfileSection } from './ProfileSection';
import { RealismSection } from './RealismSection';
import { SaveIndicator } from './SettingRow';
import { WatchlistSection } from './WatchlistSection';

const NAV = [
  ['profile', 'Profile'],
  ['realism', 'Realism'],
  ['discipline', 'Discipline'],
  ['budget', 'Budget'],
  ['watchlist', 'Watchlist'],
  ['feeds', 'Data feeds'],
  ['about', 'About'],
] as const;

export function SettingsPage() {
  return (
    <Page title="Settings" subtitle="Changes save as you make them." actions={<SaveIndicator />}>
      <div className="flex gap-8">
        <nav className="sticky top-0 hidden w-44 shrink-0 self-start lg:block" aria-label="Settings sections">
          <ul className="flex flex-col gap-0.5">
            {NAV.map(([id, label]) => (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                  className="w-full rounded-md px-2.5 py-1.5 text-left text-[13px] text-muted transition-colors hover:bg-panel-2 hover:text-fg"
                >
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex min-w-0 max-w-3xl flex-1 flex-col gap-4">
          <ProfileSection />
          <RealismSection />
          <DisciplineSection />
          <BudgetSection />
          <WatchlistSection />
          <FeedsSection />
          <AboutSection />
        </div>
      </div>
    </Page>
  );
}
