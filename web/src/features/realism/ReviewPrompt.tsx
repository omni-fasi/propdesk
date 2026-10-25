import { useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { ChevronDown, ChevronUp, NotebookPen, X } from 'lucide-react';
import type { Mood, Trade } from '@shared/types';
import { MISTAKES, MOODS } from '@shared/journal';
import { api } from '@/api/client';
import { useApp } from '@/store/app';
import { fmtDuration } from '@/lib/format';
import { Button, IconButton } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { Pnl } from '@/components/ui/Money';
import { ErrorNote } from '@/features/challenges/ErrorNote';
import { EXIT_LABELS } from '@/features/challenges/accountUtils';
import { dropReview, setReviewsCollapsed, useRealism } from './store';

function Chip({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onClick={onClick}
      className={clsx(
        'inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-2xs font-medium transition-colors',
        active ? 'border-fg bg-accent text-accent-fg' : 'border-line-strong bg-panel-2 text-muted hover:border-[#3a3a3a] hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <div className="mb-1.5 text-2xs font-medium uppercase tracking-wider text-faint">{children}</div>;
}

function ReviewCard({ trade, total }: { trade: Trade; total: number }) {
  const accountName = useApp((s) => s.accounts[trade.accountId]?.name ?? null);
  const [followedPlan, setFollowedPlan] = useState<boolean | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [mistakes, setMistakes] = useState<string[]>([]);
  const [moodAfter, setMoodAfter] = useState<Mood | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const toggleMistake = (m: string) => setMistakes((list) => (list.includes(m) ? list.filter((x) => x !== m) : [...list, m]));
  const touched = followedPlan != null || rating != null || mistakes.length > 0 || moodAfter != null || note.trim() !== '';

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.updateTrade(trade.id, { review: { followedPlan, rating, mistakes, moodAfter, note: note.trim() || null } });
      dropReview(trade.id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex max-h-[min(640px,calc(100vh-6rem))] w-[372px] animate-pop-in flex-col overflow-hidden rounded-lg border border-line-strong bg-panel shadow-pop">
      <div className="flex items-start justify-between gap-2 border-b border-line px-3.5 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-faint">
            <NotebookPen size={12} /> Post-trade review{total > 1 ? ` · 1 of ${total}` : ''}
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-sm font-semibold text-fg">
              {trade.symbol} {trade.direction}
            </span>
            <Pnl value={trade.netPnl} className="text-sm font-semibold" />
          </div>
          <div className="truncate text-2xs text-muted">
            {[trade.exitReason ? EXIT_LABELS[trade.exitReason] : null, trade.closedAt ? `held ${fmtDuration(trade.closedAt - trade.openedAt)}` : null, accountName].filter(Boolean).join(' · ')}
          </div>
        </div>
        <div className="flex shrink-0 items-center">
          <IconButton label="Minimize" icon={<ChevronDown size={14} />} size="xs" onClick={() => setReviewsCollapsed(true)} />
          <IconButton label="Skip this review" icon={<X size={14} />} size="xs" onClick={() => dropReview(trade.id)} />
        </div>
      </div>

      <div className="flex min-h-0 flex-col gap-3.5 overflow-y-auto px-3.5 py-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] text-fg">Did you follow your plan?</span>
          <div className="flex gap-1">
            <Chip active={followedPlan === true} onClick={() => setFollowedPlan(followedPlan === true ? null : true)}>
              Yes
            </Chip>
            <Chip active={followedPlan === false} onClick={() => setFollowedPlan(followedPlan === false ? null : false)}>
              No
            </Chip>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] text-fg">Execution</span>
          <div className="flex gap-1" role="radiogroup" aria-label="Execution rating">
            {[1, 2, 3, 4, 5].map((n) => (
              <Chip key={n} active={rating === n} onClick={() => setRating(rating === n ? null : n)} title={n === 1 ? 'Poor' : n === 5 ? 'Flawless' : undefined}>
                <span className="tnum w-3 text-center">{n}</span>
              </Chip>
            ))}
          </div>
        </div>

        <div>
          <Label>Mistakes</Label>
          <div className="flex flex-wrap gap-1">
            {MISTAKES.map((m) => (
              <Chip key={m} active={mistakes.includes(m)} onClick={() => toggleMistake(m)}>
                {m}
              </Chip>
            ))}
          </div>
        </div>

        <div>
          <Label>How do you feel now?</Label>
          <div className="flex flex-wrap gap-1">
            {MOODS.map((m) => (
              <Chip key={m.id} active={moodAfter === m.id} onClick={() => setMoodAfter(moodAfter === m.id ? null : m.id)}>
                <span className="grayscale">{m.emoji}</span> {m.label}
              </Chip>
            ))}
          </div>
        </div>

        <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="One thing to remember about this trade…" rows={2} className="min-h-14" maxLength={2000} />
        <ErrorNote error={error} />
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-line px-3.5 py-2.5">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => dropReview(trade.id)} disabled={busy}>
            Skip
          </Button>
          {total > 1 && (
            <Button variant="ghost" size="sm" onClick={() => useRealism.setState({ reviews: [] })} disabled={busy}>
              Skip all
            </Button>
          )}
        </div>
        <Button variant="primary" size="sm" onClick={save} loading={busy} disabled={!touched}>
          Save review
        </Button>
      </div>
    </div>
  );
}

/** Non-blocking queue of closed trades waiting for a review (bottom-left). */
export function ReviewQueue() {
  const enabled = useApp((s) => s.settings.postTradeReview);
  const reviews = useRealism((s) => s.reviews);
  const userCollapsed = useRealism((s) => s.reviewsCollapsed);
  // Stay out of the way while the trader is still managing a position in that account; open once flat.
  const reviewAccount = reviews[0]?.accountId;
  const inPosition = useApp((s) => (reviewAccount ? Object.values(s.positions).some((p) => p.accountId === reviewAccount) : false));
  const collapsed = userCollapsed || inPosition;
  if (!enabled || reviews.length === 0) return null;
  return (
    <div className="fixed bottom-4 left-[84px] z-[45]">
      {collapsed ? (
        <button
          type="button"
          onClick={() => setReviewsCollapsed(false)}
          className="flex h-9 animate-pop-in items-center gap-2 rounded-full border border-line-strong bg-panel px-3.5 text-xs text-fg shadow-pop transition-colors hover:bg-panel-2"
        >
          <NotebookPen size={13} />
          {reviews.length} trade{reviews.length === 1 ? '' : 's'} to review
          <ChevronUp size={13} className="text-faint" />
        </button>
      ) : (
        <ReviewCard key={reviews[0].id} trade={reviews[0]} total={reviews.length} />
      )}
    </div>
  );
}
