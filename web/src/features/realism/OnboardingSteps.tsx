import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Gauge, Lock, Wallet } from 'lucide-react';
import type { ChallengePreset, Settings, TiltSettings } from '@shared/types';
import { fmtMoney, fmtWorkHours } from '@/lib/format';
import { Input, NumberInput, Switch } from '@/components/ui/Input';
import { Segmented } from '@/components/ui/Tabs';
import { AmountPicker } from '@/features/wallet/AmountPicker';
import { shortSize } from '@/features/challenges/accountUtils';

export function StepTitle({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-6">
      <h2 className="text-2xl font-semibold tracking-tight text-fg">{title}</h2>
      {children && <p className="mt-2 text-[15px] leading-relaxed text-muted">{children}</p>}
    </div>
  );
}

function Principle({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3.5 rounded-lg border border-line bg-panel px-4 py-3.5">
      <div className="mt-0.5 text-muted">{icon}</div>
      <div>
        <div className="text-sm font-semibold text-fg">{title}</div>
        <div className="mt-0.5 text-sm text-muted">{children}</div>
      </div>
    </div>
  );
}

export function WelcomeStep() {
  return (
    <>
      <StepTitle title="Trade like the money is real.">
        PropDesk is a prop-firm style trading desk on your own machine: live prices, real spreads and commissions, and challenge rules that are enforced even when this window is
        closed. The money is simulated — the consequences are not.
      </StepTitle>
      <div className="flex flex-col gap-2.5">
        <Principle icon={<Wallet size={18} />} title="A real budget">
          Challenge fees come out of a wallet you fund with what you would actually spend. Payouts go back into it.
        </Principle>
        <Principle icon={<Lock size={18} />} title="Permanent consequences">
          No undo, no resets, no deleted trades. A failed challenge stays failed and its fee is gone.
        </Principle>
        <Principle icon={<Gauge size={18} />} title="Guard-rails you set while calm">
          Cooldowns, daily stops and trade limits that can't be bypassed in the heat of the moment.
        </Principle>
      </div>
    </>
  );
}

export function NameStep({ name, setName, onEnter }: { name: string; setName: (v: string) => void; onEnter: () => void }) {
  return (
    <>
      <StepTitle title="What should we call you?">Your name appears on your desk. That's all it's used for — everything stays on this computer.</StepTitle>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onEnter()}
        placeholder="Your name"
        maxLength={40}
        autoFocus
        className="[&_input]:h-11 [&_input]:text-base"
      />
    </>
  );
}

export function WalletStep({ amount, setAmount, balance, example }: { amount: number | null; setAmount: (v: number | null) => void; balance: number; example: ChallengePreset | null }) {
  return (
    <>
      <StepTitle title="Fund your prop budget">
        This is the money you would really spend on challenges. Fees come out of it, payouts go into it. Pick an amount you would genuinely miss — that's what makes it
        work.
      </StepTitle>
      <AmountPicker value={amount} onChange={setAmount} picks={[300, 500, 1000]} min={1} max={100_000} />
      <div className="mt-4 flex flex-col gap-1 text-sm text-muted">
        {example && (
          <span>
            For scale: a {example.name} evaluation costs {fmtMoney(example.fee)}
            {example.resetFee != null ? `, another attempt after failing ${fmtMoney(example.resetFee)}` : ''}.
          </span>
        )}
        {balance > 0 && <span>Your wallet already holds {fmtMoney(balance)} — this adds to it.</span>}
        <span className="text-faint">There is no withdraw button. Money leaves only as fees and comes back only as payouts.</span>
      </div>
    </>
  );
}

export function WageStep({ wage, setWage, showHours, setShowHours }: { wage: number | null; setWage: (v: number | null) => void; showHours: boolean; setShowHours: (v: boolean) => void }) {
  const preview = fmtWorkHours(240, wage);
  return (
    <>
      <StepTitle title="What is an hour of your work worth?">
        Optional. PropDesk can show money as hours of your life: a losing trade reads differently when it says “≈ 8 h of work”.
      </StepTitle>
      <div className="flex items-center gap-3">
        <NumberInput value={wage} onChange={setWage} step={1} min={0} max={10_000} precision={0} prefix="$" suffix="/ hour" placeholder="e.g. 30" className="w-48 [&_input]:h-11 [&_input]:text-base" autoFocus />
        <span className="text-sm text-muted">{preview ? `A $240 loss would read: ${preview}` : 'Leave empty to skip.'}</span>
      </div>
      <div className="mt-6 flex items-center justify-between gap-4 rounded-lg border border-line bg-panel px-4 py-3">
        <div>
          <div className="text-sm text-fg">Show amounts as hours of work</div>
          <div className="text-xs text-muted">On P&L toasts, risk previews and fees.</div>
        </div>
        <Switch checked={showHours} onChange={setShowHours} disabled={!wage} label="Show amounts as hours of work" />
      </div>
    </>
  );
}

function Row({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-t border-line py-3.5 first:border-t-0 first:pt-0">
      <div className="min-w-0">
        <div className="text-sm text-fg">{title}</div>
        <div className="mt-0.5 text-xs text-muted">{hint}</div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export interface DisciplineDraft {
  tilt: TiltSettings;
  requireStopLoss: boolean;
  confirmOrders: Settings['confirmOrders'];
  emotionCheckin: Settings['emotionCheckin'];
}

export function DisciplineStep({ d, set }: { d: DisciplineDraft; set: (patch: Partial<DisciplineDraft>) => void }) {
  return (
    <>
      <StepTitle title="Set your guard-rails now, while you're calm.">
        The server enforces them — you won't be able to talk yourself out of them mid-session. You can change them later in Settings.
      </StepTitle>
      <div className="rounded-lg border border-line bg-panel px-4 py-3.5">
        <Row title="Tilt guard" hint={d.tilt.enabled ? `Lock trading after ${d.tilt.maxConsecutiveLosses} losses in a row` : 'Off — nothing stops a losing streak'}>
          <Switch checked={d.tilt.enabled} onChange={(v) => set({ tilt: { ...d.tilt, enabled: v } })} label="Tilt guard" />
        </Row>
        {d.tilt.enabled && (
          <div className="-mt-1 flex flex-wrap items-center gap-2 pb-3.5 text-sm text-muted">
            Lock for
            <NumberInput value={d.tilt.cooldownMinutes} onChange={(v) => set({ tilt: { ...d.tilt, cooldownMinutes: Math.max(1, Math.round(v ?? 15)) } })} step={5} min={1} max={240} precision={0} size="sm" className="w-16" />
            minutes after
            <NumberInput value={d.tilt.maxConsecutiveLosses} onChange={(v) => set({ tilt: { ...d.tilt, maxConsecutiveLosses: Math.max(1, Math.round(v ?? 3)) } })} step={1} min={1} max={20} precision={0} size="sm" className="w-14" />
            losses in a row.
          </div>
        )}
        <Row title="Require a stop-loss" hint="Entries without a stop are rejected">
          <Switch checked={d.requireStopLoss} onChange={(v) => set({ requireStopLoss: v })} label="Require a stop-loss" />
        </Row>
        <Row title="Confirm orders" hint="A confirmation step before an order is sent">
          <Segmented
            value={d.confirmOrders}
            onChange={(v) => set({ confirmOrders: v })}
            options={[
              { value: 'always', label: 'Always' },
              { value: 'risky', label: 'Risky only' },
              { value: 'never', label: 'Never' },
            ]}
          />
        </Row>
        <Row title="Emotion check-in" hint="Name your state before each entry">
          <Segmented
            value={d.emotionCheckin}
            onChange={(v) => set({ emotionCheckin: v })}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'optional', label: 'Optional' },
              { value: 'required', label: 'Required' },
            ]}
          />
        </Row>
      </div>
    </>
  );
}

export type FirstAccount = { kind: 'preset'; id: string } | { kind: 'practice' };

export function AccountStep({
  presets,
  choice,
  setChoice,
  practiceSize,
  setPracticeSize,
  available,
}: {
  presets: ChallengePreset[];
  choice: FirstAccount;
  setChoice: (c: FirstAccount) => void;
  practiceSize: number;
  setPracticeSize: (n: number) => void;
  available: number;
}) {
  return (
    <>
      <StepTitle title="Choose your first account">A challenge is where discipline is tested: real rules, a real fee. A live account has no challenge rules and no fee.</StepTitle>
      <div className="flex flex-col gap-2" role="radiogroup">
        {presets.map((p) => {
          const active = choice.kind === 'preset' && choice.id === p.id;
          const short = p.fee > available + 1e-9;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setChoice({ kind: 'preset', id: p.id })}
              className={clsx(
                'flex items-center justify-between gap-4 rounded-lg border px-4 py-3 text-left transition-colors',
                active ? 'border-fg bg-panel-2' : 'border-line bg-panel hover:border-line-strong',
              )}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className={clsx('flex size-4 shrink-0 items-center justify-center rounded-full border', active ? 'border-fg' : 'border-line-strong')}>
                  {active && <span className="size-2 rounded-full bg-fg" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-fg">{p.name}</span>
                  <span className="tnum block truncate text-xs text-muted">
                    {fmtMoney(p.rules.startingBalance, { whole: true })}
                    {p.rules.profitTarget != null && ` · target +${fmtMoney(p.rules.profitTarget, { whole: true })}`}
                    {p.rules.maxLoss && ` · max loss ${fmtMoney(p.rules.maxLoss.amount, { whole: true })}`}
                    {p.phases.length > 1 && ` · ${p.phases.length} phases`}
                  </span>
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="tnum block text-sm font-semibold text-fg">{fmtMoney(p.fee)}</span>
                {short && <span className="block text-2xs text-loss">over your budget</span>}
              </span>
            </button>
          );
        })}
        <div
          className={clsx(
            'flex items-center justify-between gap-4 rounded-lg border px-4 py-3 transition-colors',
            choice.kind === 'practice' ? 'border-fg bg-panel-2' : 'border-line bg-panel hover:border-line-strong',
          )}
        >
          <button type="button" role="radio" aria-checked={choice.kind === 'practice'} onClick={() => setChoice({ kind: 'practice' })} className="flex min-w-0 flex-1 items-center gap-3 text-left">
            <span className={clsx('flex size-4 shrink-0 items-center justify-center rounded-full border', choice.kind === 'practice' ? 'border-fg' : 'border-line-strong')}>
              {choice.kind === 'practice' && <span className="size-2 rounded-full bg-fg" />}
            </span>
            <span>
              <span className="block text-sm font-semibold text-fg">Live account</span>
              <span className="block text-xs text-muted">No challenge rules, no fee</span>
            </span>
          </button>
          <Segmented
            value={String(practiceSize)}
            onChange={(v) => {
              setPracticeSize(Number(v));
              setChoice({ kind: 'practice' });
            }}
            options={[25_000, 50_000, 100_000].map((n) => ({ value: String(n), label: shortSize(n) }))}
          />
        </div>
      </div>
    </>
  );
}
