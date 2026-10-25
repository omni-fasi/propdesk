import { useEffect, useState } from 'react';
import { Check, Lock } from 'lucide-react';
import type { DayNote, LockReason } from '@shared/types';
import { api } from '@/api/client';
import { activeLock, useAccount, useNow, useSnapshot } from '@/store/hooks';
import { fmtCountdown, fmtTime } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { ErrorNote } from '@/features/challenges/ErrorNote';
import { LOCK_LABELS, lockEndsAt } from '@/features/challenges/accountUtils';
import { MomentShell } from './MomentShell';
import { closeMoment, type Moment } from './store';

const PROMPTS: Record<LockReason, string> = {
  tilt_cooldown: 'Several losses in a row. What were you trying to win back on the last one?',
  daily_loss: 'What happened today — and what will you do differently on the next trading day?',
  max_trades: "You reached today's trade limit. Which of those trades were actually in your plan?",
  personal_loss_limit: 'Your own daily stop fired. What were you feeling on the last trade?',
  break: "What's on your mind? Write it down before you go back to the screen.",
};

/** Appends a timestamped reflection to the account's note of the day (never overwrites what is there). */
async function appendReflection(day: string, accountId: string, label: string, text: string): Promise<DayNote> {
  const notes = await api.notes({ from: day, to: day });
  const existing = notes.find((n) => n.day === day && n.accountId === accountId);
  const entry = `[${fmtTime(Date.now(), { seconds: false })} · ${label}] ${text.trim()}`;
  const merged = existing?.text.trim() ? `${existing.text.trim()}\n\n${entry}` : entry;
  return api.putNote(day, { accountId, text: merged, mood: existing?.mood ?? null });
}

/** Amber lock screen: why, how long (live countdown), and a reflection prompt saved to the day's notes. */
export function LockOverlay({ moment }: { moment: Moment }) {
  const account = useAccount(moment.accountId);
  const snap = useSnapshot(moment.accountId);
  const now = useNow(500);
  const lock = activeLock(account, now);
  const reason: LockReason | null = account?.lock?.reason ?? null;
  const isBreak = reason === 'break';
  const [wait, setWait] = useState(moment.replay || isBreak ? 0 : 5);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const close = () => closeMoment(moment.key);
  const canClose = wait <= 0;
  const lifted = account?.lock != null && lock == null;
  const ends = account && lock ? lockEndsAt(account, now) : null;
  const label = reason ? LOCK_LABELS[reason] : 'Locked';
  const day = snap?.tradingDay ?? account?.tradingDay ?? null;

  const save = async () => {
    if (!account || !day || !text.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await appendReflection(day, account.id, label, text);
      setSaved(true);
      setText('');
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <MomentShell tone="warn" onEscape={canClose ? close : undefined} labelledBy="lock-title">
      <div className="flex flex-col items-center text-center">
        <div className="flex size-14 items-center justify-center rounded-full border border-warn/40 bg-warn/10">
          <Lock size={24} className="text-warn" />
        </div>
        {account && <div className="mt-5 text-xs font-medium uppercase tracking-[0.2em] text-muted">{account.name}</div>}
        <h1 id="lock-title" className="mt-3 text-4xl font-bold tracking-tight text-warn sm:text-5xl">
          {lifted ? 'LOCK LIFTED' : isBreak ? 'ON A BREAK' : 'TRADING LOCKED'}
        </h1>
        <p className="mt-3 text-base text-fg">{lock?.message ?? account?.lock?.message ?? moment.event?.message ?? label}</p>

        {lifted ? (
          <p className="mt-6 text-sm text-muted">You can trade again. Start smaller than you feel like.</p>
        ) : ends != null ? (
          <>
            <div className="num mt-8 text-7xl font-semibold tracking-tight text-fg sm:text-8xl" aria-live="off">
              {fmtCountdown(ends - now)}
            </div>
            <div className="mt-2 text-sm text-muted">
              {lock?.until == null ? 'until the next trading day' : 'left'} · trading resumes at <span className="tnum text-fg">{fmtTime(ends, { seconds: false })}</span>
            </div>
          </>
        ) : (
          <div className="mt-6 text-sm text-muted">{label}</div>
        )}
      </div>

      {account && !lifted && (
        <div className="mx-auto mt-10 flex max-w-xl flex-col gap-3">
          <label className="text-sm text-fg" htmlFor="lock-reflection">
            {PROMPTS[reason ?? 'tilt_cooldown']}
          </label>
          <Textarea
            id="lock-reflection"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
            placeholder="A few honest sentences. Saved to today's notes."
            rows={4}
            maxLength={2000}
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-faint">
              {saved ? (
                <span className="inline-flex items-center gap-1 text-muted">
                  <Check size={12} /> Saved to your notes for today
                </span>
              ) : (
                "The lock can't be lifted early. You can still close positions and cancel orders."
              )}
            </span>
            <Button variant="secondary" size="sm" onClick={save} loading={saving} disabled={!text.trim() || !day}>
              Save reflection
            </Button>
          </div>
          <ErrorNote error={error} />
        </div>
      )}

      <div className="mt-8 text-center">
        <Button variant="ghost" onClick={close} disabled={!canClose}>
          {canClose ? 'Close' : `Close (${wait})`}
        </Button>
      </div>
    </MomentShell>
  );
}
