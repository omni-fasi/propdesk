import { useApp } from '@/store/app';
import { Button } from '@/components/ui/Button';
import { confirm } from '@/components/ui/Toast';
import { SettingRow, SettingsSection } from './SettingRow';
import { saveSettings } from './save';

const RULES = [
  ['No resets', 'A failed challenge stays failed and its fee is gone. Another attempt is a new purchase.'],
  ['No deleting history', 'Trades, fills, calendar days and wallet transactions are permanent. Only journal fields — moods, notes, reviews — can be edited.'],
  ['The broker never sleeps', 'Stops, targets and rule breaches execute while this window is closed; after sleep the missed minutes are replayed.'],
  ['Locks are final', "Cooldowns, daily stops and breaks can't be lifted early — not even from here."],
] as const;

export function AboutSection() {
  const version = useApp((s) => s.version);
  const tz = useApp((s) => s.localTz);
  return (
    <SettingsSection id="about" title="About">
      <SettingRow title="Version" hint={`Time zone ${tz}`}>
        <span className="tnum text-sm text-muted">{version || '—'}</span>
      </SettingRow>
      <SettingRow title="Your data" hint="Stored only on this computer, in ~/.local/share/propdesk (propdesk.db). Nothing is sent anywhere." />
      <SettingRow
        title="Market data & charts"
        hint={
          <>
            Prices from Binance (crypto, metals, energy, stock perps) and Yahoo Finance (CME futures, forex). Charts by{' '}
            <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer" className="text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg">
              TradingView Lightweight Charts™
            </a>
            .
          </>
        }
      />
      <div className="py-3.5">
        <div className="mb-2 text-sm text-fg">The rules of this desk</div>
        <ul className="flex flex-col gap-2">
          {RULES.map(([title, text]) => (
            <li key={title} className="text-xs text-muted">
              <span className="font-medium text-fg">{title}.</span> {text}
            </li>
          ))}
        </ul>
      </div>
      <SettingRow title="Welcome tour" hint="Show the first-run setup again (it never deletes anything).">
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            if (await confirm({ title: 'Show the setup again?', body: 'You can add to your wallet and open another account from it, or skip.', confirmLabel: 'Show setup' })) saveSettings({ onboarded: false });
          }}
        >
          Show again
        </Button>
      </SettingRow>
    </SettingsSection>
  );
}
