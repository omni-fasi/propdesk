import { useApp } from '@/store/app';
import { fmtMoney } from '@/lib/format';
import { CommitNumber, SettingRow, SettingsSection } from './SettingRow';
import { saveSettings } from './save';

export function BudgetSection() {
  const budget = useApp((s) => s.settings.monthlyBudget);
  const spent = useApp((s) => s.wallet.monthSpent);
  return (
    <SettingsSection id="budget" title="Budget" description="A ceiling for what you let yourself spend on challenges each calendar month.">
      <SettingRow
        title="Monthly challenge budget"
        hint={`${fmtMoney(spent)} spent this month. Purchases above the budget get flagged before you pay. Empty = no budget.`}
      >
        <CommitNumber value={budget} onCommit={(v) => saveSettings({ monthlyBudget: v != null && v > 0 ? v : null })} nullable step={50} min={0} max={100_000} precision={0} prefix="$" placeholder="No budget" className="w-40" />
      </SettingRow>
    </SettingsSection>
  );
}
