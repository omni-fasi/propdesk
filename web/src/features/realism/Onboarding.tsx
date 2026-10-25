import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { PRESETS } from '@shared/presets';
import { errorMessage } from '@/api/client';
import { useApp } from '@/store/app';
import { navigate } from '@/lib/router';
import { fmtMoney } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import { toast } from '@/components/ui/Toast';
import { createAccount, deposit } from '@/features/challenges/actions';
import { presetById } from '@/features/challenges/accountUtils';
import { ErrorNote } from '@/features/challenges/ErrorNote';
import { HoldButton } from './HoldButton';
import { AccountStep, DisciplineStep, NameStep, WageStep, WalletStep, WelcomeStep, type DisciplineDraft, type FirstAccount } from './OnboardingSteps';

const STEPS = ['Welcome', 'Name', 'Wallet', 'Hourly wage', 'Guard-rails', 'First account'] as const;

// What already reached the server — survives a remount (e.g. a failed settings save re-opens onboarding)
// so the deposit and the first purchase are never made twice.
const committed = { deposit: false, accountId: null as string | null };

/** First-run setup: name, wallet deposit, hourly wage, guard-rails and the first account. */
export function Onboarding() {
  const settings = useApp((s) => s.settings);
  const balance = useApp((s) => s.wallet.balance);
  const storePresets = useApp((s) => s.presets);
  const hasAccounts = useApp((s) => Object.keys(s.accounts).length > 0);
  const presets = storePresets.length > 0 ? storePresets : PRESETS;

  const [step, setStep] = useState(0);
  const [name, setName] = useState(settings.traderName ?? '');
  const [amount, setAmount] = useState<number | null>(balance > 0 ? null : 500);
  const [wage, setWage] = useState<number | null>(settings.hourlyWage);
  const [showHours, setShowHours] = useState(settings.showWorkHours);
  const [discipline, setDiscipline] = useState<DisciplineDraft>({
    tilt: settings.tilt,
    requireStopLoss: settings.requireStopLoss,
    confirmOrders: settings.confirmOrders,
    emotionCheckin: settings.emotionCheckin,
  });
  const [choice, setChoice] = useState<FirstAccount>(() => ({ kind: 'preset', id: presets.find((p) => p.id === 'fut-50k')?.id ?? presets[0]?.id ?? 'fut-50k' }));
  const [practiceSize, setPracticeSize] = useState(50_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const pendingDeposit = committed.deposit ? 0 : (amount ?? 0);
  const available = balance + pendingDeposit;
  const preset = choice.kind === 'preset' ? presetById(choice.id, presets) : null;
  const fee = preset?.fee ?? 0;
  const affordable = available + 1e-9 >= fee;
  const example = useMemo(() => presetById('fut-50k', presets), [presets]);

  const walletOk = committed.deposit || (amount != null && amount >= 1 && amount <= 100_000) || (amount == null && balance > 0);
  const canContinue = step === 2 ? walletOk : true;
  const next = () => canContinue && setStep((s) => Math.min(STEPS.length - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  const finish = async (withAccount: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (!committed.deposit && amount != null && amount > 0) {
        await deposit(Math.round(amount * 100) / 100, 'Initial prop budget');
        committed.deposit = true;
      }
      let accountName: string | null = null;
      if (withAccount && !committed.accountId) {
        const acc =
          choice.kind === 'practice'
            ? await createAccount({ kind: 'practice', startingBalance: practiceSize })
            : await createAccount({ kind: 'evaluation', presetId: choice.id });
        committed.accountId = acc.id;
        accountName = acc.name;
      }
      const trader = name.trim() || null;
      await useApp.getState().updateSettings({
        onboarded: true,
        traderName: trader,
        hourlyWage: wage != null && wage > 0 ? wage : null,
        showWorkHours: wage != null && wage > 0 ? showHours : settings.showWorkHours,
        tilt: discipline.tilt,
        requireStopLoss: discipline.requireStopLoss,
        confirmOrders: discipline.confirmOrders,
        emotionCheckin: discipline.emotionCheckin,
      });
      committed.deposit = false;
      committed.accountId = null;
      toast({
        title: trader ? `Welcome, ${trader}.` : 'Welcome to PropDesk.',
        description: accountName ? `${accountName} is ready. Trade it like it's yours.` : 'Your desk is set up.',
      });
      if (withAccount) navigate('trade');
    } catch (e) {
      setError(e);
      toast({ title: 'Setup did not finish', description: errorMessage(e), tone: 'loss' });
    } finally {
      setBusy(false);
    }
  };

  const skip = async () => {
    try {
      await useApp.getState().updateSettings({ onboarded: true });
    } catch (e) {
      toast({ title: 'Could not save', description: errorMessage(e), tone: 'loss' });
    }
  };

  const last = step === STEPS.length - 1;

  return createPortal(
    <div className="fixed inset-0 z-[80] overflow-y-auto bg-bg" role="dialog" aria-modal="true" aria-label="Set up PropDesk">
      <div aria-hidden className="pointer-events-none fixed inset-0" style={{ backgroundImage: 'radial-gradient(ellipse 60% 45% at 50% 0%, rgb(255 255 255 / 0.06), transparent 70%)' }} />
      <div className="relative mx-auto flex min-h-full w-full max-w-[640px] flex-col px-6 py-10">
        <header className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <img src="/icon.svg" alt="" className="size-7" />
            <span className="text-sm font-semibold tracking-tight text-fg">PropDesk</span>
          </div>
          <div className="text-xs text-faint">
            {step + 1} / {STEPS.length} · {STEPS[step]}
          </div>
        </header>
        <div className="mt-4 flex gap-1" aria-hidden>
          {STEPS.map((s, i) => (
            <span key={s} className={clsx('h-0.5 flex-1 rounded-full transition-colors', i <= step ? 'bg-fg' : 'bg-line-strong')} />
          ))}
        </div>

        <main key={step} className="flex-1 animate-pop-in py-10">
          {step === 0 && <WelcomeStep />}
          {step === 1 && <NameStep name={name} setName={setName} onEnter={next} />}
          {step === 2 &&
            (committed.deposit ? (
              <div className="text-sm text-muted">
                Your deposit is in. Wallet balance <Money value={balance} className="font-medium text-fg" />.
              </div>
            ) : (
              <WalletStep amount={amount} setAmount={setAmount} balance={balance} example={example} />
            ))}
          {step === 3 && <WageStep wage={wage} setWage={setWage} showHours={showHours} setShowHours={setShowHours} />}
          {step === 4 && <DisciplineStep d={discipline} set={(patch) => setDiscipline((d) => ({ ...d, ...patch }))} />}
          {step === 5 && (
            <div className="flex flex-col gap-5">
              <AccountStep presets={presets} choice={choice} setChoice={setChoice} practiceSize={practiceSize} setPracticeSize={setPracticeSize} available={available} />
              <dl className="divide-y divide-line rounded-lg border border-line bg-panel text-sm">
                {pendingDeposit > 0 && (
                  <div className="flex justify-between px-4 py-2.5">
                    <dt className="text-muted">Deposit</dt>
                    <dd className="tnum text-fg">{fmtMoney(pendingDeposit)}</dd>
                  </div>
                )}
                <div className="flex justify-between px-4 py-2.5">
                  <dt className="text-muted">{preset ? `${preset.name} fee` : 'Live account'}</dt>
                  <dd className="tnum text-fg">{preset ? fmtMoney(-fee) : 'Free'}</dd>
                </div>
                <div className="flex justify-between px-4 py-2.5">
                  <dt className="text-muted">Wallet after</dt>
                  <dd className={clsx('tnum font-semibold', affordable ? 'text-fg' : 'text-loss')}>{fmtMoney(available - fee)}</dd>
                </div>
              </dl>
              {!affordable && <div className="text-sm text-loss">Your budget doesn't cover this fee — go back and deposit more, or pick a smaller challenge.</div>}
              <ErrorNote error={error} />
            </div>
          )}
        </main>

        <footer className="flex items-center justify-between gap-3 border-t border-line pt-5">
          <div>
            {step === 0 ? (
              <Button variant="ghost" size="sm" onClick={skip}>
                Skip setup
              </Button>
            ) : (
              <Button variant="ghost" icon={<ArrowLeft size={15} />} onClick={back} disabled={busy}>
                Back
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {last && hasAccounts && (
              <Button variant="ghost" onClick={() => finish(false)} disabled={busy}>
                Keep my existing accounts
              </Button>
            )}
            {!last ? (
              <Button variant="primary" size="lg" iconRight={<ArrowRight size={16} />} onClick={next} disabled={!canContinue}>
                {step === 0 ? 'Set up my desk' : step === 3 && !wage ? 'Skip' : 'Continue'}
              </Button>
            ) : choice.kind === 'preset' && fee > 0 ? (
              <HoldButton size="lg" label={`Hold to pay ${fmtMoney(fee)} & start`} onConfirm={() => finish(true)} loading={busy} disabled={!affordable} holdMs={1400} />
            ) : (
              <Button variant="primary" size="lg" onClick={() => finish(true)} loading={busy} disabled={!affordable}>
                {choice.kind === 'practice' ? 'Create practice account & start' : 'Start'}
              </Button>
            )}
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
