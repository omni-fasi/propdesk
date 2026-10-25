import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Archive, ArchiveRestore, ArrowRight, ChevronDown, Info, MoreHorizontal, RotateCcw, ShieldCheck, Wallet } from 'lucide-react';
import type { Account } from '@shared/types';
import { errorMessage } from '@/api/client';
import { useApp } from '@/store/app';
import { activeLock, useNow, useSnapshot } from '@/store/hooks';
import { navigate } from '@/lib/router';
import { rulesSummary } from '@/lib/rules';
import { fmtDate, fmtDateTime, fmtMoney, fmtPct } from '@/lib/format';
import { KindBadge, StatusBadge, Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Money, Pnl } from '@/components/ui/Money';
import { MenuItem, Popover } from '@/components/ui/Popover';
import { confirm, toast } from '@/components/ui/Toast';
import { Stat } from '@/components/ui/Misc';
import { Switch } from '@/components/ui/Input';
import { activationPrice, attemptCost, fundedOf, isFinalPhase, lifespan, nextPhaseOf, presetOf, retryOf, retryPrice } from './accountUtils';
import { setArchived, setFees } from './actions';
import { BreakMenu } from './BreakMenu';
import { InlineName } from './InlineName';
import { ActivateDialog, RetryDialog } from './LifecycleDialogs';
import { LockLine } from './LockLine';
import { PayoutDialog } from './PayoutDialog';
import { RuleMeters } from './RuleMeters';

function trade(account: Account) {
  useApp.getState().setActiveAccount(account.id);
  navigate('trade');
}

function RulesDisclosure({ account }: { account: Account }) {
  const [open, setOpen] = useState(false);
  const lines = useMemo(() => rulesSummary(account.rules), [account.rules]);
  return (
    <div>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-xs text-muted transition-colors hover:text-fg" aria-expanded={open}>
        <ChevronDown size={13} className={clsx('transition-transform', !open && '-rotate-90')} />
        Rules
      </button>
      {open && (
        <ul className="mt-2 flex flex-col gap-1 border-l border-line pl-3 text-xs text-muted">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
          {account.payout && (
            <li>
              Payouts: {fmtPct(account.payout.profitSplit, 0)} split · {account.payout.minWinningDays} winning days of {fmtMoney(account.payout.minDayProfit, { whole: true })}+ · min{' '}
              {fmtMoney(account.payout.minAmount, { whole: true })} · up to {fmtPct(account.payout.maxPctOfProfit, 0)} of profit
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function MoreMenu({ account }: { account: Account }) {
  const archive = async () => {
    if (!account.archived) {
      const ok = await confirm({
        title: 'Archive this account?',
        body: 'It leaves the account switcher and these lists. Its trades, calendar days and wallet history stay — nothing is deleted.',
        confirmLabel: 'Archive',
      });
      if (!ok) return;
    }
    try {
      await setArchived(account.id, !account.archived);
    } catch (e) {
      toast({ title: 'Could not update the account', description: errorMessage(e), tone: 'loss' });
    }
  };
  return (
    <Popover
      align="end"
      triggerClassName="inline-flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-panel-3 hover:text-fg"
      trigger={<MoreHorizontal size={15} aria-label="More actions" />}
    >
      {(close) => (
        <MenuItem
          onClick={() => {
            close();
            archive();
          }}
        >
          {account.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          {account.archived ? 'Unarchive' : 'Archive'}
        </MenuItem>
      )}
    </Popover>
  );
}

/** Practice accounts only: trade with or without real exchange fees. Applies to fills from now on. */
function FeesSwitch({ account }: { account: Account }) {
  const [busy, setBusy] = useState(false);
  const on = account.rules.fees !== 'off';
  const change = async (next: boolean) => {
    setBusy(true);
    try {
      await setFees(account.id, next ? 'real' : 'off');
      toast({ title: next ? 'Trading fees on' : 'Trading fees off', description: next ? 'Fills pay real exchange fees again.' : 'Fills on this account are free from now on.' });
    } catch (e) {
      toast({ title: 'Could not update the account', description: errorMessage(e), tone: 'loss' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-panel-2 px-3 py-2">
      <div className="min-w-0">
        <div className="text-xs font-medium text-fg">Trading fees</div>
        <div className="text-2xs text-faint">
          {on ? 'Real exchange fees on every fill: 0.02–0.05% of the position on crypto, per contract on futures.' : 'Off: fills on this account are free. Challenges always charge real fees.'}
        </div>
      </div>
      <Switch checked={on} onChange={(v) => void change(v)} disabled={busy} label="Trading fees" />
    </div>
  );
}

/** One account with its numbers, rule progress, lock state and lifecycle actions. */
export function AccountCard({ account }: { account: Account }) {
  const snap = useSnapshot(account.id);
  const accounts = useApp((s) => s.accounts);
  const presets = useApp((s) => s.presets);
  const isActiveAccount = useApp((s) => s.activeAccountId === account.id);
  const now = useNow(30_000);
  const [dialog, setDialog] = useState<'retry' | 'activate' | 'payout' | null>(null);

  const preset = presetOf(account, presets);
  const live = account.status === 'active';
  const balance = snap?.balance ?? account.balance;
  const equity = live ? (snap?.equity ?? balance) : balance;
  const totalPnl = equity - account.rules.startingBalance;
  const locked = activeLock(account, now) != null;
  const cost = attemptCost(account, accounts);

  const retryFee = retryPrice(account, presets);
  const retried = retryOf(account, accounts);
  const activationFee = activationPrice(account, presets);
  const funded = account.status === 'passed' ? fundedOf(account, accounts) : null;
  const nextPhase = account.status === 'passed' && !isFinalPhase(account) ? nextPhaseOf(account, accounts) : null;
  const blockers = live ? (snap?.passBlockers ?? []) : [];

  return (
    <article
      className={clsx(
        'flex flex-col gap-4 rounded-lg border bg-panel p-4 transition-colors',
        isActiveAccount ? 'border-line-strong' : 'border-line',
        account.archived && 'opacity-60',
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <InlineName account={account} />
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <KindBadge kind={account.kind} phase={account.phase} phaseCount={account.phaseCount} />
            <StatusBadge status={account.status} />
            {isActiveAccount && <Badge tone="outline">Selected</Badge>}
            {account.archived && <Badge>Archived</Badge>}
            <span className="truncate text-2xs text-faint">
              {preset ? preset.name : account.kind === 'practice' ? 'Live account' : 'Custom rules'} · opened {fmtDate(account.createdAt)}
              {cost > 0 && <> · cost {fmtMoney(cost)}</>}
            </span>
          </div>
        </div>
        {!live && <MoreMenu account={account} />}
      </header>

      <div className="grid grid-cols-4 gap-3">
        <Stat label="Balance" value={<Money value={balance} />} />
        <Stat label="Equity" value={<Money value={equity} />} />
        <Stat label="Total P&L" value={<Pnl value={totalPnl} />} />
        {live ? (
          <Stat label="Today" value={<Pnl value={snap?.dayPnl ?? 0} />} />
        ) : (
          <Stat label={account.status === 'failed' ? 'Failed' : 'Ended'} value={<span className="text-sm font-medium">{account.endedAt ? fmtDate(account.endedAt) : '—'}</span>} />
        )}
      </div>

      {account.kind !== 'practice' && <RuleMeters account={account} snapshot={snap} />}

      {account.kind === 'practice' && live && <FeesSwitch account={account} />}

      {account.kind === 'funded' && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-panel-2 px-3 py-2 text-xs">
          <span className="text-muted">
            Payouts received <Money value={account.totalPayouts} className="font-medium text-fg" />
            {account.lastPayoutAt && <span className="text-faint"> · last {fmtDate(account.lastPayoutAt)}</span>}
          </span>
          {account.payout && <span className="text-faint">{fmtPct(account.payout.profitSplit, 0)} profit split</span>}
        </div>
      )}

      {live && <LockLine account={account} />}

      {blockers.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-md border border-line bg-panel-2 px-3 py-2">
          {blockers.map((b) => (
            <li key={b} className="flex items-start gap-2 text-xs text-muted">
              <Info size={13} className="mt-px shrink-0 text-faint" />
              {b}
            </li>
          ))}
        </ul>
      )}

      {!live && account.endReason && (
        <div className={clsx('text-xs', account.status === 'failed' ? 'text-loss' : account.status === 'passed' ? 'text-profit' : 'text-muted')}>
          {account.endReason}
          {account.endedAt && (
            <span className="text-faint">
              {' '}
              · {fmtDateTime(account.endedAt)} · after {lifespan(account.createdAt, account.endedAt)}
            </span>
          )}
        </div>
      )}

      <RulesDisclosure account={account} />

      <footer className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        {live && (
          <>
            <Button variant="primary" size="sm" iconRight={<ArrowRight size={14} />} onClick={() => trade(account)}>
              Trade
            </Button>
            <BreakMenu account={account} disabled={locked} />
            {account.kind === 'funded' && (
              <Button variant="secondary" size="sm" icon={<Wallet size={14} />} onClick={() => setDialog('payout')}>
                Request payout
              </Button>
            )}
          </>
        )}

        {account.status === 'failed' && retryFee != null && !retried && (
          <Button variant="secondary" size="sm" icon={<RotateCcw size={14} />} onClick={() => setDialog('retry')}>
            Retry · {fmtMoney(retryFee)}
          </Button>
        )}
        {retried && (
          <Button variant="ghost" size="sm" iconRight={<ArrowRight size={14} />} onClick={() => trade(retried)} disabled={retried.status !== 'active'}>
            Retried as {retried.name}
          </Button>
        )}

        {account.status === 'passed' && activationFee != null && !funded && (
          <Button variant="primary" size="sm" icon={<ShieldCheck size={14} />} onClick={() => setDialog('activate')}>
            Activate funded · {activationFee > 0 ? fmtMoney(activationFee) : 'free'}
          </Button>
        )}
        {funded && (
          <Button variant="ghost" size="sm" iconRight={<ArrowRight size={14} />} onClick={() => trade(funded)} disabled={funded.status !== 'active'}>
            Funded: {funded.name}
          </Button>
        )}
        {nextPhase && (
          <Button variant="ghost" size="sm" iconRight={<ArrowRight size={14} />} onClick={() => trade(nextPhase)} disabled={nextPhase.status !== 'active'}>
            Continue in {nextPhase.name}
          </Button>
        )}
      </footer>

      {dialog === 'retry' && <RetryDialog account={account} onClose={() => setDialog(null)} />}
      {dialog === 'activate' && <ActivateDialog account={account} onClose={() => setDialog(null)} />}
      {dialog === 'payout' && <PayoutDialog account={account} open onClose={() => setDialog(null)} />}
    </article>
  );
}
