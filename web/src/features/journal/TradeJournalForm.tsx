// Journal fields of a trade — the only editable part of a trade (tags before entry, review after).

import type { ReactNode } from 'react';
import type { UpdateTradeRequest } from '@shared/api';
import type { Mood, Trade } from '@shared/types';
import { MISTAKES, SETUP_GRADES } from '@shared/journal';
import { fmtDateTime } from '@/lib/format';
import { Input, Textarea } from '@/components/ui/Input';
import { Chip, MoodPicker, ScalePicker } from './Pickers';

export interface JournalDraft {
  mood: Mood | null;
  setup: string | null;
  confidence: number | null;
  plan: string;
  followedPlan: boolean | null;
  rating: number | null;
  mistakes: string[];
  moodAfter: Mood | null;
  note: string;
}

export function draftFrom(t: Trade): JournalDraft {
  return {
    mood: t.tags?.mood ?? null,
    setup: t.tags?.setup?.trim() || null,
    confidence: t.tags?.confidence ?? null,
    plan: t.tags?.plan ?? '',
    followedPlan: t.review?.followedPlan ?? null,
    rating: t.review?.rating ?? null,
    mistakes: t.review?.mistakes ? [...t.review.mistakes] : [],
    moodAfter: t.review?.moodAfter ?? null,
    note: t.review?.note ?? '',
  };
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
const textOrNull = (s: string) => (s.trim() ? s.trim() : null);

function reviewEmpty(d: JournalDraft): boolean {
  return d.followedPlan == null && d.rating == null && d.mistakes.length === 0 && d.moodAfter == null && !d.note.trim();
}

/** PATCH body for what changed, or null when nothing did. */
export function draftPatch(d: JournalDraft, t: Trade): UpdateTradeRequest | null {
  const o = draftFrom(t);
  const body: UpdateTradeRequest = {};
  if (d.mood !== o.mood || (d.setup?.trim() || null) !== o.setup || d.confidence !== o.confidence || textOrNull(d.plan) !== textOrNull(o.plan)) {
    body.tags = { mood: d.mood, setup: d.setup?.trim() || null, confidence: d.confidence, plan: textOrNull(d.plan) };
  }
  const reviewChanged =
    d.followedPlan !== o.followedPlan || d.rating !== o.rating || !sameSet(d.mistakes, o.mistakes) || d.moodAfter !== o.moodAfter || textOrNull(d.note) !== textOrNull(o.note);
  if (reviewChanged) {
    body.review = reviewEmpty(d) ? null : { followedPlan: d.followedPlan, rating: d.rating, mistakes: d.mistakes, moodAfter: d.moodAfter, note: textOrNull(d.note) };
  }
  return body.tags || body.review !== undefined ? body : null;
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[132px_minmax(0,1fr)] items-start gap-3 py-1.5">
      <div className="pt-1.5">
        <div className="text-xs font-medium text-muted">{label}</div>
        {hint && <div className="mt-0.5 text-2xs text-faint">{hint}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-panel-2/40 px-4 py-3">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

const GRADES: readonly string[] = SETUP_GRADES;

export function TradeJournalForm({ trade, draft, onChange }: { trade: Trade; draft: JournalDraft; onChange: (patch: Partial<JournalDraft>) => void }) {
  const customSetup = draft.setup && !GRADES.includes(draft.setup) ? draft.setup : '';
  return (
    <div className="flex flex-col gap-3">
      <Section title="Before the trade">
        <Row label="Mood at entry">
          <MoodPicker value={draft.mood} onChange={(mood) => onChange({ mood })} />
        </Row>
        <Row label="Setup" hint="Quality grade, or name it">
          <div className="flex flex-wrap items-center gap-1.5">
            {SETUP_GRADES.map((g) => (
              <Chip key={g} active={draft.setup === g} onClick={() => onChange({ setup: draft.setup === g ? null : g })}>
                {g}
              </Chip>
            ))}
            <Input size="sm" className="w-44" placeholder="Custom, e.g. ORB" value={customSetup} maxLength={40} onChange={(e) => onChange({ setup: e.target.value || null })} />
          </div>
        </Row>
        <Row label="Confidence">
          <ScalePicker value={draft.confidence} onChange={(confidence) => onChange({ confidence })} lowLabel="Unsure" highLabel="Certain" />
        </Row>
        <Row label="Plan / thesis">
          <Textarea
            rows={2}
            className="min-h-14"
            placeholder="Why this trade? Where is the stop, where is the target, what invalidates it?"
            value={draft.plan}
            onChange={(e) => onChange({ plan: e.target.value })}
          />
        </Row>
      </Section>

      <Section title="Review" aside={trade.review ? <span className="text-2xs text-faint">Reviewed {fmtDateTime(trade.review.reviewedAt)}</span> : <span className="text-2xs text-faint">Not reviewed yet</span>}>
        <Row label="Followed my plan?">
          <div className="flex gap-1.5">
            <Chip active={draft.followedPlan === true} onClick={() => onChange({ followedPlan: draft.followedPlan === true ? null : true })}>
              Yes
            </Chip>
            <Chip active={draft.followedPlan === false} onClick={() => onChange({ followedPlan: draft.followedPlan === false ? null : false })}>
              No
            </Chip>
          </div>
        </Row>
        <Row label="Execution">
          <ScalePicker value={draft.rating} onChange={(rating) => onChange({ rating })} lowLabel="Poor" highLabel="Flawless" />
        </Row>
        <Row label="Mistakes">
          <div className="flex flex-wrap gap-1.5">
            {MISTAKES.map((m) => {
              const on = draft.mistakes.includes(m);
              return (
                <Chip key={m} active={on} onClick={() => onChange({ mistakes: on ? draft.mistakes.filter((x) => x !== m) : [...draft.mistakes, m] })}>
                  {m}
                </Chip>
              );
            })}
          </div>
        </Row>
        <Row label="Mood after">
          <MoodPicker value={draft.moodAfter} onChange={(moodAfter) => onChange({ moodAfter })} />
        </Row>
        <Row label="Lesson">
          <Textarea
            rows={3}
            placeholder="What did you feel during the trade? What would you do differently next time?"
            value={draft.note}
            onChange={(e) => onChange({ note: e.target.value })}
          />
        </Row>
      </Section>
    </div>
  );
}
