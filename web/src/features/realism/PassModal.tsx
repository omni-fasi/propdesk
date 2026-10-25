import { useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import type { Account } from '@shared/types';
import { useApp } from '@/store/app';
import { useAccount, useSnapshot } from '@/store/hooks';
import { navigate } from '@/lib/router';
import { fmtMoney, fmtPct } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Misc';
import { Money, Pnl } from '@/components/ui/Money';
import { activationPrice, fundedOf, isFinalPhase, lifespan, nextPhaseOf, presetOf } from '@/features/challenges/accountUtils';
import { activateFunded } from '@/features/challenges/actions';
import { ErrorNote } from '@/features/challenges/ErrorNote';
import { PurchaseSummary, useCanAfford } from '@/features/challenges/PurchaseSummary';
import { Confetti } from './Confetti';
import { HoldButton } from './HoldButton';
import { MomentShell, MomentStat } from './MomentShell';
import { closeMoment, type Moment } from './store';

function goTrade(account: Account) {
  useApp.getState().setActiveAccount(account.id);
  navigate('trade');
}

/** Celebration + the next step: activate funded (paid, hold to confirm) or continue in the next phase (free). */
export function PassModal({ moment }: { moment: Moment }) {
  const account = useAccount(moment.accountId);
  const snap = useSnapshot(moment.accountId);
  const accounts = useApp((s) => s.accounts);
  const presets = useApp((s) => s.presets);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [activated, setActivated] = useState<Account | null>(null);
  const price = account ? activationPrice(account, presets) : null;
  const affordable = useCanAfford(price ?? 0);
  const close = () => closeMoment(moment.key);

  const final = account ? isFinalPhase(account) : moment.event?.kind === 'passed';
  const preset = presetOf(account, presets);
  const phaseName = account && preset ? (preset.phases[account.phase - 1]?.name ?? `Phase ${account.phase}`) : account ? `Phase ${account.phase}` : 'Phase';
  const funded = activated ?? (account && final ? fundedOf(account, accounts) : null);
  const next = account && !final ? nextPhaseOf(account, accounts) : null;
  const profit = account ? account.balance - account.rules.startingBalance : 0;
  const nextTarget = next?.rules.profitTarget ?? (preset && account ? preset.phases[account.phase]?.profitTarget : null) ?? null;

  const activate = async () => {
    if (!account) return;
    setBusy(true);
    setError(null);
    try {
      setActivated(await activateFunded(account.id));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const title = final ? 'CHALLENGE PASSED' : `${phaseName.toUpperCase()} PASSED`;

  return (
    <MomentShell tone="profit" onEscape={close} labelledBy="pass-title" underlay={moment.replay ? null : <Confetti />}>
      <div className="flex flex-col items-center text-center">
        <div className="flex size-14 items-center justify-center rounded-full border border-profit/40 bg-profit/10">
          <Check size={28} className="text-profit" strokeWidth={2.5} />
        </div>
        {account && <div className="mt-5 text-xs font-medium uppercase tracking-[0.2em] text-muted">{account.name}</div>}
        <h1 id="pass-title" className="mt-3 text-5xl font-bold tracking-tight text-fg sm:text-6xl">
          {title}
        </h1>
        {account && (
          <p className="mt-4 text-lg text-muted">
            <Pnl value={profit} className="font-semibold" /> in {account.tradingDays} trading day{account.tradingDays === 1 ? '' : 's'}
            {moment.event?.message && <span className="block text-sm text-faint">{moment.event.message}</span>}
          </p>
        )}
      </div>

      {account && (
        <div className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line-strong bg-line sm:grid-cols-4">
          <MomentStat label="Balance">
            <Money value={account.balance} />
          </MomentStat>
          <MomentStat label="Profit">
            <Pnl value={profit} />
          </MomentStat>
          <MomentStat label="Best day">
            <Money value={snap?.bestDay ?? null} />
          </MomentStat>
          <MomentStat label="Took">{lifespan(account.createdAt, account.endedAt ?? Date.now())}</MomentStat>
        </div>
      )}

      <div className="mx-auto mt-8 flex max-w-lg flex-col gap-4 rounded-lg border border-line-strong bg-panel/90 p-5">
        {!account ? (
          <div className="text-sm text-muted">{moment.event?.message}</div>
        ) : final && funded ? (
          <>
            <div>
              <div className="text-base font-semibold text-fg">Your funded account is live</div>
              <p className="mt-1 text-sm text-muted">
                {funded.name}. Same loss rules, no target — withdraw profits as payouts{funded.payout ? ` (you keep ${fmtPct(funded.payout.profitSplit, 0)})` : ''}.
              </p>
            </div>
            <Button
              variant="primary"
              size="lg"
              iconRight={<ArrowRight size={16} />}
              onClick={() => {
                close();
                goTrade(funded);
              }}
              disabled={funded.status !== 'active'}
            >
              Start trading it
            </Button>
          </>
        ) : final && price != null ? (
          <>
            <div>
              <div className="text-base font-semibold text-fg">Next: activate your funded account</div>
              <p className="mt-1 text-sm text-muted">
                Same loss rules, no profit target.
                {preset?.funded && ` You keep ${fmtPct(preset.funded.payout.profitSplit, 0)} of every payout after ${preset.funded.payout.minWinningDays} winning days.`}
              </p>
            </div>
            <PurchaseSummary price={price} priceLabel="Activation fee" onNavigate={close} />
            <ErrorNote error={error} onNavigate={close} />
            <HoldButton
              size="lg"
              block
              label={price > 0 ? `Hold to pay ${fmtMoney(price)} & activate` : 'Hold to activate'}
              onConfirm={activate}
              loading={busy}
              disabled={!affordable}
              holdMs={price > 0 ? 1400 : 900}
            />
          </>
        ) : final ? (
          <div>
            <div className="text-base font-semibold text-fg">Challenge complete</div>
            <p className="mt-1 text-sm text-muted">This challenge has no funded stage. The result stays in your history.</p>
          </div>
        ) : next ? (
          <>
            <div>
              <div className="text-base font-semibold text-fg">{next.name} is ready — free</div>
              <p className="mt-1 text-sm text-muted">
                {nextTarget != null ? `Target +${fmtMoney(nextTarget, { whole: true })} · ` : ''}same loss rules, a fresh start from {fmtMoney(next.rules.startingBalance, { whole: true })}.
              </p>
            </div>
            <Button
              variant="primary"
              size="lg"
              iconRight={<ArrowRight size={16} />}
              onClick={() => {
                close();
                goTrade(next);
              }}
            >
              Go to {preset?.phases[next.phase - 1]?.name ?? `Phase ${next.phase}`}
            </Button>
          </>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> Setting up the next phase…
          </div>
        )}
      </div>

      <div className="mt-4 text-center">
        <Button variant="ghost" onClick={close} disabled={busy}>
          {funded || !final ? 'Close' : 'Later'}
        </Button>
      </div>
    </MomentShell>
  );
}
