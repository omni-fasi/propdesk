import type { FeedProvider, FeedStatus } from '@shared/types';
import { useApp } from '@/store/app';
import { useNow } from '@/store/hooks';
import { fmtDuration } from '@/lib/format';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { SettingRow, SettingsSection } from './SettingRow';

const PROVIDERS: Record<FeedProvider, { name: string; covers: string }> = {
  binance: { name: 'Binance USDⓈ-M futures', covers: 'Crypto, metals, energy and stock perpetuals · real order book' },
  yahoo: { name: 'Yahoo Finance', covers: 'CME futures and forex · top of book synthesized from trades' },
};

const STATE: Record<FeedStatus['state'], { label: string; tone: BadgeTone }> = {
  live: { label: 'Live', tone: 'outline' },
  connecting: { label: 'Connecting', tone: 'neutral' },
  degraded: { label: 'Degraded', tone: 'warn' },
  down: { label: 'Down', tone: 'loss' },
};

export function FeedsSection() {
  const feeds = useApp((s) => s.feeds);
  const connected = useApp((s) => s.connected);
  const now = useNow(1000);
  return (
    <SettingsSection id="feeds" title="Data feeds" description="Live market data used for quotes, fills and rule checks.">
      <SettingRow title="PropDesk server" hint="The local trading server (runs in the background, even when this window is closed).">
        <Badge tone={connected ? 'outline' : 'loss'} dot={connected}>
          {connected ? 'Connected' : 'Disconnected'}
        </Badge>
      </SettingRow>
      {feeds.length === 0 && <div className="py-4 text-sm text-muted">No feed status received yet.</div>}
      {feeds.map((f) => {
        const p = PROVIDERS[f.provider] ?? { name: f.provider, covers: '' };
        const st = STATE[f.state] ?? { label: f.state, tone: 'neutral' as const };
        const age = f.lastMessageAt != null ? Math.max(0, now - f.lastMessageAt) : null;
        return (
          <SettingRow
            key={f.provider}
            title={p.name}
            hint={
              <>
                {p.covers}
                <span className="mt-1 block text-faint">
                  {f.delaySec > 0 ? `Source delayed ${Math.round(f.delaySec / 60)} min — time-shifted to play as live` : 'Real time'}
                  {' · '}
                  {age == null ? 'no messages yet' : `last message ${age < 1500 ? 'just now' : `${fmtDuration(age)} ago`}`}
                  {f.message ? ` · ${f.message}` : ''}
                </span>
              </>
            }
          >
            <Badge tone={st.tone} dot={f.state === 'live'}>
              {st.label}
            </Badge>
          </SettingRow>
        );
      })}
    </SettingsSection>
  );
}
