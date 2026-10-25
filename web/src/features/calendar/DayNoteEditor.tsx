// Day journal note: free text + mood, autosaved (debounced) with PUT /notes/:day.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import clsx from 'clsx';
import type { DayNote, Mood } from '@shared/types';
import { api, errorMessage } from '@/api/client';
import { fmtTime } from '@/lib/format';
import { Textarea } from '@/components/ui/Input';
import { MoodPicker } from '../journal/Pickers';

const PROMPTS = ['What went well today?', 'What did I feel when I took the loss?', 'Did I follow my plan? Where did I deviate?', 'What will I do differently tomorrow?'];

type Status = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export interface DayNoteEditorProps {
  day: string;
  /** null = the global note for the day (all accounts). */
  accountId: string | null;
  initial: DayNote | null;
  onSaved?: (note: DayNote) => void;
}

export function DayNoteEditor({ day, accountId, initial, onSaved }: DayNoteEditorProps) {
  const [text, setText] = useState(initial?.text ?? '');
  const [mood, setMood] = useState<Mood | null>(initial?.mood ?? null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(initial?.updatedAt ?? null);

  const latest = useRef({ text, mood });
  latest.current = { text, mood };
  const saved = useRef({ text: initial?.text ?? '', mood: initial?.mood ?? null });
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const mounted = useRef(true);

  const save: () => Promise<void> = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const { text: t, mood: m } = latest.current;
    if (t === saved.current.text && m === saved.current.mood) return;
    if (inFlight.current) return;
    inFlight.current = true;
    if (mounted.current) setStatus('saving');
    try {
      const note = await api.putNote(day, { accountId, text: t, mood: m });
      saved.current = { text: t, mood: m };
      onSavedRef.current?.(note);
      if (mounted.current) {
        setSavedAt(note.updatedAt ?? Date.now());
        setError(null);
        const now = latest.current;
        setStatus(now.text === t && now.mood === m ? 'saved' : 'dirty');
      }
    } catch (e) {
      if (mounted.current) {
        setStatus('error');
        setError(errorMessage(e));
      }
    } finally {
      inFlight.current = false;
    }
    // Edits made while saving → save again.
    const now = latest.current;
    if (mounted.current && (now.text !== saved.current.text || now.mood !== saved.current.mood) && !timer.current) {
      timer.current = setTimeout(() => void save(), 600);
    }
  }, [day, accountId]);

  const schedule = useCallback(() => {
    setStatus('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 900);
  }, [save]);

  // Flush pending edits when the drawer closes / the day changes.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const { text: t, mood: m } = latest.current;
      if (t !== saved.current.text || m !== saved.current.mood) {
        api
          .putNote(day, { accountId, text: t, mood: m })
          .then((note) => onSavedRef.current?.(note))
          .catch(() => {});
      }
    };
  }, [day, accountId]);

  const addPrompt = (p: string) => {
    const next = text.trim() ? `${text.replace(/\s+$/, '')}\n\n${p}\n` : `${p}\n`;
    setText(next);
    schedule();
    requestAnimationFrame(() => {
      const el = textRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next.length, next.length);
      }
    });
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted">How did today feel?</span>
        <MoodPicker
          value={mood}
          onChange={(m) => {
            setMood(m);
            latest.current = { text, mood: m };
            schedule();
          }}
        />
      </div>
      <Textarea
        ref={textRef}
        rows={6}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          schedule();
        }}
        onBlur={() => void save()}
        placeholder="What went well? What did you feel when you took the loss? What will you do differently tomorrow?"
        className="min-h-32"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {PROMPTS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => addPrompt(p)}
              className="rounded border border-line px-1.5 py-0.5 text-2xs text-faint transition-colors hover:border-line-strong hover:text-muted"
            >
              + {p}
            </button>
          ))}
        </div>
        <span className={clsx('flex items-center gap-1 text-2xs', status === 'error' ? 'text-loss' : 'text-faint')}>
          {status === 'saving' && 'Saving…'}
          {status === 'dirty' && 'Unsaved'}
          {status === 'error' && (
            <button type="button" onClick={() => void save()} className="underline" title={error ?? undefined}>
              Not saved — retry
            </button>
          )}
          {(status === 'saved' || status === 'idle') && savedAt != null && (
            <>
              <Check size={11} /> Saved {fmtTime(savedAt, { seconds: false })}
            </>
          )}
        </span>
      </div>
    </div>
  );
}
