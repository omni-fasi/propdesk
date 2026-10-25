import { useEffect, useState } from 'react';
import { CalendarDays, Plus, RotateCcw } from 'lucide-react';
import { tradingDayOf } from '@shared/time';
import { useApp, serverNow } from '@/store/app';
import { useAccount, useSnapshot } from '@/store/hooks';
import { navigate } from '@/lib/router';
import { fmtDayKey, fmtMoney } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Money, Pnl, WorkHours } from '@/components/ui/Money';
import { toast } from '@/components/ui/Toast';
import { attemptCost, lifespan, presetOf, retryOf, retryPrice } from '@/features/challenges/accountUtils';
import { retryAccount } from '@/features/challenges/actions';
import { ErrorNote } from '@/features/challenges/ErrorNote';
import { InsufficientFunds, useCanAfford } from '@/features/challenges/PurchaseSummary';
import { HoldButton } from './HoldButton';
import { MomentShell, MomentStat } from './MomentShell';
import { closeMoment, type Moment } from './store';
import { useDayStat } from './useDayStat';

const FORCED_PAUSE_S = 3;

/** "ACCOUNT FAILED" — what happened, what it cost, and the sober next steps. */
export function BreachModal({ moment }: { moment: Moment }) {
  const account = useAccount(moment.accountId);
  const snap = useSnapshot(moment.accountId);
  const accounts = useApp((s) => s.accounts);
  const presets = useApp((s) => s.presets);
  const [wait, setWait] = useState(moment.replay ? 0 : FORCED_PAUSE_S);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const ts = moment.event?.ts ?? account?.endedAt ?? serverNow();
  const day = account ? tradingDayOf(ts, account.rules.rollover) : null;
  const stat = useDayStat(account?.id, day, account?.balance);
  const price = account ? retryPrice(account, presets) : null;
  const affordable = useCanAfford(price ?? 0);
  const canClose = wait <= 0;
  const close = () => closeMoment(moment.key);

  if (!account) {
    return (
      <MomentShell tone="loss" onEscape={canClose ? close : undefined} pulse>
        <div className="text-center">
          <h1 className="text-5xl font-bold tracking-tight text-loss">ACCOUNT FAILED</h1>
          <p className="mt-4 text-muted">{moment.event?.message}</p>
          <Button variant="ghost" className="mt-8" onClick={close} disabled={!canClose}>
            {canClose ? 'Close' : `Close (${wait})`}
          </Button>
        </div>
      </MomentShell>
    );
  }

  const preset = presetOf(account, presets);
  const cost = attemptCost(account, accounts);
  const pnl = account.balance - account.rules.startingBalance;
  const retried = retryOf(account, accounts);
  const reason = account.endReason ?? moment.event?.title ?? 'A rule was breached';
  const detail = moment.event?.message && moment.event.message !== reason ? moment.event.message : null;
  const dayNet = stat?.netPnl ?? snap?.dayPnl ?? null;

  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await retryAccount(account.id);
      toast({ title: `${next.name} started`, description: `${fmtMoney(price ?? 0)} paid from your wallet.` });
      close();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <MomentShell tone="loss" onEscape={canClose ? close : undefined} labelledBy="breach-title" pulse={!canClose}>
      <div className="flex flex-col items-center text-center">
        <div className="text-xs font-medium uppercase tracking-[0.2em] text-muted">{account.name}</div>
        <h1 id="breach-title" className="mt-3 text-5xl font-bold tracking-tight text-loss sm:text-6xl">
          ACCOUNT FAILED
        </h1>
        <p className="mt-4 text-lg font-medium text-fg">{reason}</p>
        {detail && <p className="mt-1 max-w-xl text-sm text-muted">{detail}</p>}
      </div>

      <div className="mt-8 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line-strong bg-line sm:grid-cols-4">
        <MomentStat label="Final balance">
          <Money value={account.balance} />
        </MomentStat>
        <MomentStat label="Total P&L">
          <Pnl value={pnl} />
        </MomentStat>
        <MomentStat label={account.kind === 'funded' ? 'This account cost' : 'Fee lost'}>
          <Money value={cost > 0 ? -cost : 0} className={cost > 0 ? 'text-loss' : 'text-muted'} />
          <WorkHours value={cost > 0 ? cost : null} className="ml-2 font-normal" />
        </MomentStat>
        <MomentStat label="Lasted">{lifespan(account.createdAt, account.endedAt ?? ts)}</MomentStat>
      </div>

      {day && (
        <div className="tnum mt-3 text-center text-sm text-muted">
          {fmtDayKey(day)}: {dayNet != null ? <Pnl value={dayNet} /> : '—'}
          {stat && (
            <>
              {' '}
              · {stat.trades} trade{stat.trades === 1 ? '' : 's'} · {stat.wins} won / {stat.losses} lost · fees {fmtMoney(stat.fees)}
            </>
          )}
          {!stat && snap && <> · {snap.dayTrades} trades</>}
        </div>
      )}

      <p className="mx-auto mt-6 max-w-xl text-center text-sm text-faint">
        Positions were closed at market. This account is closed for good and stays in your graveyard. Take a break before you decide on another attempt.
      </p>

      <div className="mt-8 flex flex-col items-center gap-3">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            variant="primary"
            size="lg"
            icon={<CalendarDays size={16} />}
            disabled={!canClose}
            onClick={() => {
              close();
              navigate('calendar', { day: day ?? undefined, account: account.id });
            }}
          >
            Review today
          </Button>
          {price != null && !retried && (
            <HoldButton
              variant="outline"
              size="lg"
              icon={<RotateCcw size={15} />}
              label={`Hold to retry for ${fmtMoney(price)}`}
              onConfirm={retry}
              loading={busy}
              disabled={!canClose || !affordable}
              holdMs={1600}
            />
          )}
          {price == null && (
            <Button
              variant="outline"
              size="lg"
              icon={<Plus size={15} />}
              disabled={!canClose}
              onClick={() => {
                close();
                navigate('challenges', { new: 1, preset: preset?.id });
              }}
            >
              New challenge
            </Button>
          )}
          <Button variant="ghost" size="lg" onClick={close} disabled={!canClose}>
            {canClose ? 'Close' : `Close (${wait})`}
          </Button>
        </div>
        {price != null && !retried && canClose && !affordable && <InsufficientFunds price={price} onNavigate={close} className="max-w-lg" />}
        {price != null && preset && preset.resetFee != null && preset.resetFee < preset.fee && !retried && (
          <div className="text-xs text-faint">Reset price — a new purchase costs {fmtMoney(preset.fee)}.</div>
        )}
        <ErrorNote error={error} onNavigate={close} className="max-w-lg" />
      </div>
    </MomentShell>
  );
}
