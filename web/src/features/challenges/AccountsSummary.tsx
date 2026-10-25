import { useMemo } from 'react';
import type { Account } from '@shared/types';
import { useApp } from '@/store/app';
import { fmtPct } from '@/lib/format';
import { Money, Pnl } from '@/components/ui/Money';
import { Stat } from '@/components/ui/Misc';
import { isFinalPhase } from './accountUtils';

/** The real scoreboard: what challenges cost, how often they pass, what came back. */
export function AccountsSummary({ accounts }: { accounts: Account[] }) {
  const wallet = useApp((s) => s.wallet);
  const stats = useMemo(() => {
    const evals = accounts.filter((a) => a.kind === 'evaluation');
    const attempts = evals.filter((a) => a.phase <= 1).length;
    const running = evals.filter((a) => a.status === 'active').length;
    const passes = evals.filter((a) => a.status === 'passed' && isFinalPhase(a)).length;
    const fails = evals.filter((a) => a.status === 'failed').length;
    const finished = passes + fails;
    return { attempts, running, passes, fails, passRate: finished > 0 ? passes / finished : null };
  }, [accounts]);

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3 xl:grid-cols-5">
      <Stat className="bg-panel px-4 py-3" label="Spent on challenges" value={<Money value={wallet.feesPaid} />} sub="fees, resets & activations" />
      <Stat className="bg-panel px-4 py-3" label="Attempts" value={stats.attempts} sub={stats.running > 0 ? `${stats.running} in progress` : 'none in progress'} />
      <Stat
        className="bg-panel px-4 py-3"
        label="Pass rate"
        value={stats.passRate == null ? '—' : fmtPct(stats.passRate, 0)}
        sub={`${stats.passes} passed · ${stats.fails} failed`}
      />
      <Stat className="bg-panel px-4 py-3" label="Payouts received" value={<Money value={wallet.payouts} className={wallet.payouts > 0 ? 'text-profit' : undefined} />} sub="your share" />
      <Stat className="bg-panel px-4 py-3" label="Net" value={<Pnl value={wallet.payouts - wallet.feesPaid} />} sub="payouts − fees" />
    </div>
  );
}
