import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import type { WalletTx } from '@shared/types';
import { api } from '@/api/client';
import { useBus } from '@/api/bus';
import { useApp } from '@/store/app';
import { navigate, setParams, useRoute } from '@/lib/router';
import { fmtMoney } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Stat } from '@/components/ui/Misc';
import { Money, Pnl, WorkHours } from '@/components/ui/Money';
import { Page } from '@/components/ui/Panel';
import { BudgetPanel } from './BudgetPanel';
import { DepositModal } from './DepositModal';
import { Ledger } from './Ledger';

function useLedger() {
  const wallet = useApp((s) => s.wallet);
  const [txs, setTxs] = useState<WalletTx[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const res = await api.wallet();
      if (id !== seq.current) return;
      setTxs(res.transactions);
      setError(null);
    } catch (e) {
      if (id === seq.current) setError(e);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  // Refetch whenever the live wallet summary changes (fees, deposits, payouts), and after a resync.
  useEffect(() => {
    load();
  }, [wallet, load]);
  useBus('resynced', () => {
    load();
  });

  return { txs, loading, error, reload: load };
}

export function WalletPage() {
  const { params } = useRoute();
  const wallet = useApp((s) => s.wallet);
  const ledger = useLedger();
  const depositOpen = params.get('deposit') === '1';
  const amountParam = Number(params.get('amount'));
  const initialAmount = Number.isFinite(amountParam) && amountParam > 0 ? amountParam : null;

  return (
    <Page
      title="Wallet"
      subtitle="Your prop budget. Challenge fees come out of it, payouts go into it."
      actions={
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => navigate('wallet', { deposit: 1 })}>
          Deposit
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 lg:grid-cols-[minmax(300px,1fr)_2fr]">
          <section className="flex flex-col justify-between gap-4 rounded-lg border border-line bg-panel p-5">
            <div>
              <div className="text-2xs font-medium uppercase tracking-wider text-faint">Balance</div>
              <div className="tnum mt-1 text-4xl font-semibold tracking-tight text-fg">
                <Money value={wallet.balance} />
              </div>
              <WorkHours value={wallet.balance > 0 ? wallet.balance : null} className="mt-1 block" />
            </div>
            <p className="text-xs text-faint">The only money that counts here. Spend it like it's real — it is the point.</p>
          </section>

          <section className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-4">
            <Stat className="bg-panel p-5" size="lg" label="Deposited" value={<Money value={wallet.deposited} />} sub={wallet.withdrawn > 0 ? `${fmtMoney(wallet.withdrawn)} withdrawn` : 'into the wallet'} />
            <Stat className="bg-panel p-5" size="lg" label="Fees paid" value={<Money value={wallet.feesPaid > 0 ? -wallet.feesPaid : 0} className={wallet.feesPaid > 0 ? 'text-loss' : undefined} />} sub="challenges, resets, activations" />
            <Stat className="bg-panel p-5" size="lg" label="Payouts received" value={<Money value={wallet.payouts} className={wallet.payouts > 0 ? 'text-profit' : undefined} />} sub="your share" />
            <Stat className="bg-panel p-5" size="lg" label="Net" value={<Pnl value={wallet.payouts - wallet.feesPaid} />} sub="payouts − fees" />
          </section>
        </div>

        <BudgetPanel />

        <Ledger transactions={ledger.txs} loading={ledger.loading} error={ledger.error} onRetry={ledger.reload} />
      </div>

      {depositOpen && <DepositModal initialAmount={initialAmount} onClose={() => setParams({ deposit: null, amount: null })} />}
    </Page>
  );
}
