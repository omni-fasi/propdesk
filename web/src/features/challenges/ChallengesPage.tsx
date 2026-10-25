import { useMemo, useState, type ReactNode } from 'react';
import { Plus, Trophy } from 'lucide-react';
import type { Account } from '@shared/types';
import { useApp } from '@/store/app';
import { useAccountList } from '@/store/hooks';
import { navigate, setParams, useRoute } from '@/lib/router';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/Misc';
import { Page } from '@/components/ui/Panel';
import { AccountCard } from './AccountCard';
import { AccountsSummary } from './AccountsSummary';
import { Graveyard } from './Graveyard';
import { isNewTab, NewChallenge } from './NewChallenge';

function Section({ title, count, description, children }: { title: string; count: number; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
          {title} <span className="tnum text-faint">{count}</span>
        </h2>
        {description && <p className="text-xs text-faint">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function CardGrid({ accounts }: { accounts: Account[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(400px,1fr))] gap-3">
      {accounts.map((a) => (
        <AccountCard key={a.id} account={a} />
      ))}
    </div>
  );
}

const byNewest = (a: Account, b: Account) => b.createdAt - a.createdAt;
const byEnded = (a: Account, b: Account) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt);

export function ChallengesPage() {
  const { params } = useRoute();
  const accountsMap = useApp((s) => s.accounts);
  const all = useAccountList({ includeArchived: true });
  const [showArchived, setShowArchived] = useState(false);

  const groups = useMemo(() => {
    const visible = all.filter((a) => showArchived || !a.archived);
    return {
      active: visible.filter((a) => a.status === 'active' && a.kind !== 'funded').sort(byNewest),
      funded: visible.filter((a) => a.status === 'active' && a.kind === 'funded').sort(byNewest),
      passed: visible.filter((a) => a.status === 'passed').sort(byEnded),
      failed: visible.filter((a) => a.status === 'failed').sort(byEnded),
      closed: visible.filter((a) => a.status === 'closed').sort(byEnded),
    };
  }, [all, showArchived]);
  const archivedCount = useMemo(() => all.filter((a) => a.archived).length, [all]);

  const newOpen = params.get('new') === '1';
  const tabParam = params.get('tab');
  const openNew = () => navigate('challenges', { new: 1 });
  const closeNew = () => setParams({ new: null, tab: null, preset: null });

  return (
    <Page
      title="Accounts"
      subtitle="Challenges, funded accounts and what every attempt cost."
      actions={
        <>
          {archivedCount > 0 && <Checkbox checked={showArchived} onChange={setShowArchived} label={<span className="text-xs text-muted">Show archived ({archivedCount})</span>} />}
          <Button variant="primary" icon={<Plus size={15} />} onClick={openNew}>
            New challenge
          </Button>
        </>
      }
    >
      {all.length === 0 ? (
        <EmptyState
          icon={<Trophy />}
          title="No accounts yet"
          description="Buy a challenge with your wallet, build one with your own rules, or open a live account."
          action={
            <Button variant="primary" icon={<Plus size={15} />} onClick={openNew}>
              New challenge
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-8">
          <AccountsSummary accounts={all} />

          {groups.active.length > 0 ? (
            <Section title="Active" count={groups.active.length}>
              <CardGrid accounts={groups.active} />
            </Section>
          ) : (
            <Section title="Active" count={0}>
              <div className="flex items-center justify-between gap-4 rounded-lg border border-dashed border-line-strong px-4 py-5 text-sm text-muted">
                No evaluation or live account running.
                <Button variant="secondary" size="sm" icon={<Plus size={14} />} onClick={openNew}>
                  New challenge
                </Button>
              </div>
            </Section>
          )}

          {groups.funded.length > 0 && (
            <Section title="Funded" count={groups.funded.length} description="Same loss rules, no target. Profits come out as payouts.">
              <CardGrid accounts={groups.funded} />
            </Section>
          )}

          {groups.passed.length > 0 && (
            <Section title="Passed" count={groups.passed.length}>
              <CardGrid accounts={groups.passed} />
            </Section>
          )}

          {groups.failed.length > 0 && (
            <Section title="Graveyard" count={groups.failed.length} description="Every failed attempt stays here.">
              <Graveyard failed={groups.failed} accounts={accountsMap} />
            </Section>
          )}

          {groups.closed.length > 0 && (
            <Section title="Closed" count={groups.closed.length}>
              <CardGrid accounts={groups.closed} />
            </Section>
          )}
        </div>
      )}

      {newOpen && <NewChallenge onClose={closeNew} initialTab={isNewTab(tabParam) ? tabParam : 'presets'} initialPreset={params.get('preset')} />}
    </Page>
  );
}
