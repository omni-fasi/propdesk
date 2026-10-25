import type { TiltSettings } from '@shared/types';
import { useApp } from '@/store/app';
import { Switch } from '@/components/ui/Input';
import { Segmented } from '@/components/ui/Tabs';
import { confirm } from '@/components/ui/Toast';
import { CommitNumber, SettingRow, SettingsSection } from './SettingRow';
import { saveSettings } from './save';

/** Turning a guard-rail off takes a deliberate hold — decide it outside the heat of a session. */
function loosen(title: string): Promise<boolean> {
  return confirm({
    title,
    body: 'Guard-rails work because you set them while calm. If you are turning this off mid-session, that is usually the moment you need it most.',
    confirmLabel: 'Turn off',
    tone: 'danger',
    holdMs: 1500,
  });
}

export function DisciplineSection() {
  const s = useApp((st) => st.settings);
  const tilt = s.tilt;
  const saveTilt = (patch: Partial<TiltSettings>) => saveSettings({ tilt: { ...tilt, ...patch } });

  return (
    <SettingsSection id="discipline" title="Discipline" description="Enforced by the server on every active account. Locks can't be lifted early.">
      <SettingRow
        title="Confirm orders"
        hint={s.confirmOrders === 'risky' ? 'Orders without a stop-loss, or risking a large share of your max-loss buffer.' : s.confirmOrders === 'always' ? 'Every order asks first.' : 'Orders go out immediately.'}
        sub={
          s.confirmOrders === 'risky' ? (
            <div className="flex items-center gap-2 text-xs text-muted">
              Risky = risking at least
              <CommitNumber
                value={Math.round(s.riskyPct * 100)}
                onCommit={(v) => v != null && saveSettings({ riskyPct: Math.min(100, Math.max(1, v)) / 100 })}
                step={5}
                min={1}
                max={100}
                precision={0}
                suffix="%"
                size="sm"
                className="w-20"
              />
              of the max-loss buffer
            </div>
          ) : undefined
        }
      >
        <Segmented
          value={s.confirmOrders}
          onChange={(v) => saveSettings({ confirmOrders: v })}
          options={[
            { value: 'always', label: 'Always' },
            { value: 'risky', label: 'Risky only' },
            { value: 'never', label: 'Never' },
          ]}
        />
      </SettingRow>

      <SettingRow title="Require a stop-loss" hint="The server rejects entries without one.">
        <Switch
          checked={s.requireStopLoss}
          onChange={async (v) => {
            if (!v && !(await loosen('Allow entries without a stop-loss?'))) return;
            saveSettings({ requireStopLoss: v });
          }}
          label="Require a stop-loss"
        />
      </SettingRow>

      <SettingRow title="Emotion check-in" hint="Name your state (and setup) before each entry.">
        <Segmented
          value={s.emotionCheckin}
          onChange={(v) => saveSettings({ emotionCheckin: v })}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'optional', label: 'Optional' },
            { value: 'required', label: 'Required' },
          ]}
        />
      </SettingRow>

      <SettingRow title="Post-trade review" hint="After each closed trade: followed plan, execution, mistakes, mood.">
        <Switch checked={s.postTradeReview} onChange={(v) => saveSettings({ postTradeReview: v })} label="Post-trade review" />
      </SettingRow>

      <SettingRow title="Revenge guard" hint="Warns before an entry within 2 minutes of a loss with a bigger size.">
        <Switch
          checked={s.revengeGuard}
          onChange={async (v) => {
            if (!v && !(await loosen('Turn off the revenge guard?'))) return;
            saveSettings({ revengeGuard: v });
          }}
          label="Revenge guard"
        />
      </SettingRow>

      <SettingRow
        title="Tilt guard"
        hint="Automatic locks for losing streaks, overtrading and your own daily stop."
        sub={
          tilt.enabled ? (
            <div className="grid gap-x-6 gap-y-3 rounded-md border border-line bg-panel-2 p-3 text-xs text-muted sm:grid-cols-2">
              <label className="flex items-center justify-between gap-3">
                <span>Losses in a row before a cooldown</span>
                <CommitNumber value={tilt.maxConsecutiveLosses} onCommit={(v) => saveTilt({ maxConsecutiveLosses: Math.max(0, Math.round(v ?? 0)) })} step={1} min={0} max={20} precision={0} size="sm" className="w-20" placeholder="Off" />
              </label>
              <label className="flex items-center justify-between gap-3">
                <span>Cooldown</span>
                <CommitNumber value={tilt.cooldownMinutes} onCommit={(v) => saveTilt({ cooldownMinutes: Math.max(1, Math.round(v ?? 15)) })} step={5} min={1} max={240} precision={0} suffix="min" size="sm" className="w-24" />
              </label>
              <label className="flex items-center justify-between gap-3">
                <span>Max trades per day</span>
                <CommitNumber value={tilt.maxTradesPerDay} onCommit={(v) => saveTilt({ maxTradesPerDay: v != null && v > 0 ? Math.round(v) : null })} nullable step={1} min={1} max={200} precision={0} size="sm" className="w-20" placeholder="Off" />
              </label>
              <label className="flex items-center justify-between gap-3">
                <span>Personal daily stop</span>
                <CommitNumber value={tilt.personalDailyLoss} onCommit={(v) => saveTilt({ personalDailyLoss: v != null && v > 0 ? v : null })} nullable step={50} min={1} max={1_000_000} precision={0} prefix="$" size="sm" className="w-28" placeholder="Off" />
              </label>
              <p className="text-2xs text-faint sm:col-span-2">0 or empty = off. The daily stop flattens your positions and locks trading until the next trading day.</p>
            </div>
          ) : undefined
        }
      >
        <Switch
          checked={tilt.enabled}
          onChange={async (v) => {
            if (!v && !(await loosen('Turn off the tilt guard?'))) return;
            saveTilt({ enabled: v });
          }}
          label="Tilt guard"
        />
      </SettingRow>
    </SettingsSection>
  );
}
