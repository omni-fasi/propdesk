import { useEffect, useState } from 'react';
import { BellRing, Play, Volume2, VolumeX } from 'lucide-react';
import { FILL_SOUNDS, TV_SOUNDS, type FillSound } from '@shared/types';
import { useApp } from '@/store/app';
import { fmtWorkHours } from '@/lib/format';
import { SOUND_NAMES, testSound } from '@/lib/sounds';
import { Button, IconButton } from '@/components/ui/Button';
import { Select, Switch } from '@/components/ui/Input';
import { notificationPermission, notifyDesktop, requestNotificationPermission, type NotifyPermission } from '@/features/realism/notify';
import { CommitNumber, SettingRow, SettingsSection } from './SettingRow';
import { saveSettings } from './save';

function VolumeSlider({ value, disabled, sound }: { value: number; disabled: boolean; sound: FillSound }) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  const commit = () => {
    if (Math.abs(local - value) > 0.001) saveSettings({ volume: local });
    testSound(sound, local);
  };
  return (
    <div className="flex items-center gap-2.5">
      {local <= 0 ? <VolumeX size={15} className="text-faint" /> : <Volume2 size={15} className="text-muted" />}
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={local}
        disabled={disabled}
        onChange={(e) => setLocal(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={(e) => {
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) commit();
        }}
        aria-label="Volume"
        className="h-1 w-44 cursor-pointer accent-fg disabled:opacity-40"
      />
      <span className="tnum w-9 text-right text-xs text-muted">{Math.round(local * 100)}%</span>
    </div>
  );
}

/** A sound menu with a preview button; picking a sound also plays it. */
function SoundPicker<T extends FillSound | 'off'>({ value, options, onChange, disabled, label }: { value: T; options: readonly T[]; onChange: (v: T) => void; disabled: boolean; label: string }) {
  const pick = (v: T) => {
    onChange(v);
    if (v !== 'off') testSound(v as FillSound);
  };
  return (
    <div className="flex items-center gap-1.5">
      <Select
        size="sm"
        value={value}
        disabled={disabled}
        onChange={pick}
        options={options.map((o) => ({ value: o, label: o === 'off' ? 'Off' : SOUND_NAMES[o as FillSound] }))}
        aria-label={label}
        className="w-48"
      />
      <IconButton label={`Play ${label.toLowerCase()}`} icon={<Play size={12} />} disabled={disabled || value === 'off'} onClick={() => testSound(value as FillSound)} />
    </div>
  );
}

function NotificationControls() {
  const enabled = useApp((s) => s.settings.notifications);
  const [perm, setPerm] = useState<NotifyPermission>(notificationPermission);
  const ask = async () => setPerm(await requestNotificationPermission());
  const hint =
    perm === 'unsupported'
      ? 'This browser does not support desktop notifications.'
      : perm === 'denied'
        ? 'Blocked by the browser — allow notifications for this site in its site settings.'
        : perm === 'default'
          ? 'The browser needs your permission first.'
          : 'Fills, stops and targets, breaches, locks and payouts — only while this window is hidden.';
  return (
    <SettingRow title="Desktop notifications" hint={hint}>
      {perm === 'default' && (
        <Button size="sm" variant="secondary" icon={<BellRing size={13} />} onClick={ask}>
          Allow
        </Button>
      )}
      {perm === 'granted' && (
        <Button size="sm" variant="ghost" onClick={() => notifyDesktop('PropDesk', 'Notifications are working.', { force: true })}>
          Send a test
        </Button>
      )}
      <Switch
        checked={enabled}
        disabled={perm === 'unsupported'}
        onChange={async (v) => {
          if (v && perm === 'default') setPerm(await requestNotificationPermission());
          saveSettings({ notifications: v });
        }}
        label="Desktop notifications"
      />
    </SettingRow>
  );
}

export function RealismSection() {
  const s = useApp((st) => st.settings);
  const wagePreview = fmtWorkHours(500, s.hourlyWage);
  return (
    <SettingsSection id="realism" title="Realism" description="What makes the money feel like money.">
      <SettingRow title="Hourly wage" hint={wagePreview ? `A $500 loss reads “${wagePreview}”.` : 'Optional — shows amounts as hours of your work. Empty = off.'}>
        <CommitNumber value={s.hourlyWage} onCommit={(v) => saveSettings({ hourlyWage: v != null && v > 0 ? v : null })} nullable step={1} min={0} max={10_000} precision={2} prefix="$" suffix="/ h" placeholder="Off" className="w-36" />
      </SettingRow>
      <SettingRow title="Show amounts as hours of work" hint="On trade toasts, risk previews, fees and the wallet.">
        <Switch checked={s.showWorkHours} disabled={!s.hourlyWage} onChange={(v) => saveSettings({ showWorkHours: v })} label="Show amounts as hours of work" />
      </SettingRow>
      <SettingRow
        title="Sounds"
        hint="Like TradingView: a sound when an order fills, an alert sound for account alerts, and silence when you place, change or cancel orders."
        sub={<VolumeSlider value={s.volume} disabled={!s.sounds} sound={s.fillSound} />}
      >
        <Switch checked={s.sounds} onChange={(v) => saveSettings({ sounds: v })} label="Sounds" />
      </SettingRow>
      <SettingRow title="Fill sound" hint="Every fill: entries, exits, stops and targets. TradingView calls it the execution sound — Alarm Clock is its default.">
        <SoundPicker value={s.fillSound} options={FILL_SOUNDS} disabled={!s.sounds} onChange={(v) => saveSettings({ fillSound: v })} label="Fill sound" />
      </SettingRow>
      <SettingRow title="Alert sound" hint="Risk warnings, breaches, locks, passes and payouts, like a TradingView alert going off. Fired is TradingView's default.">
        <SoundPicker
          value={s.alertSound ?? 'off'}
          options={['off', ...TV_SOUNDS] as const}
          disabled={!s.sounds}
          onChange={(v) => saveSettings({ alertSound: v === 'off' ? null : v })}
          label="Alert sound"
        />
      </SettingRow>
      <NotificationControls />
    </SettingsSection>
  );
}
