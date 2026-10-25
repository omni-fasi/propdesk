import { useApp } from '@/store/app';
import { CommitText, SettingRow, SettingsSection } from './SettingRow';
import { saveSettings } from './save';

export function ProfileSection() {
  const name = useApp((s) => s.settings.traderName);
  return (
    <SettingsSection id="profile" title="Profile">
      <SettingRow title="Your name" hint="Shown on your desk. Everything stays on this computer.">
        <CommitText value={name ?? ''} onCommit={(v) => saveSettings({ traderName: v || null })} placeholder="Your name" maxLength={40} className="w-60" />
      </SettingRow>
    </SettingsSection>
  );
}
