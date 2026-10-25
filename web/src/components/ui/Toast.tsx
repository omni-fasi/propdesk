import { useEffect, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import clsx from 'clsx';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';
import { Button } from './Button';
import { Modal } from './Modal';

export type ToastTone = 'neutral' | 'profit' | 'loss' | 'warn';

export interface ToastInput {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  /** ms; 0 = sticky. Default 4500. */
  duration?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

const useToasts = create<{ items: ToastItem[] }>(() => ({ items: [] }));
let nextId = 1;

export function toast(t: ToastInput): number {
  const id = nextId++;
  useToasts.setState((s) => ({ items: [...s.items.slice(-4), { ...t, id }] }));
  const duration = t.duration ?? 4500;
  if (duration > 0) setTimeout(() => dismissToast(id), duration);
  return id;
}

export function dismissToast(id: number): void {
  useToasts.setState((s) => ({ items: s.items.filter((i) => i.id !== id) }));
}

const icons: Record<ToastTone, ReactNode> = {
  neutral: <Info size={16} className="text-muted" />,
  profit: <CheckCircle2 size={16} className="text-profit" />,
  loss: <XCircle size={16} className="text-loss" />,
  warn: <AlertTriangle size={16} className="text-warn" />,
};

export function Toaster() {
  const items = useToasts((s) => s.items);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={clsx(
            'pointer-events-auto flex animate-pop-in gap-2.5 rounded-lg border bg-panel-2 px-3 py-2.5 shadow-pop',
            t.tone === 'loss' ? 'border-loss/40' : t.tone === 'profit' ? 'border-profit/40' : t.tone === 'warn' ? 'border-warn/40' : 'border-line-strong',
          )}
        >
          <div className="mt-0.5 shrink-0">{icons[t.tone ?? 'neutral']}</div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-fg">{t.title}</div>
            {t.description && <div className="mt-0.5 text-xs text-muted">{t.description}</div>}
          </div>
          <button className="-mr-1 shrink-0 self-start text-faint hover:text-fg" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ───────────── confirm() ─────────────

export interface ConfirmOptions {
  title: ReactNode;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'neutral' | 'danger' | 'buy' | 'sell';
  /** Require holding the confirm button this many ms (friction for consequential actions). */
  holdMs?: number;
}

interface ConfirmState {
  current: (ConfirmOptions & { resolve: (ok: boolean) => void }) | null;
}

const useConfirm = create<ConfirmState>(() => ({ current: null }));

/** Promise-based confirmation dialog. */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirm.getState().current?.resolve(false);
    useConfirm.setState({ current: { ...opts, resolve } });
  });
}

function HoldButton({ ms, variant, label, onDone }: { ms: number; variant: 'primary' | 'danger' | 'buy' | 'sell'; label: string; onDone: () => void }) {
  const [start, setStart] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (start == null) return;
    let raf = 0;
    const tick = () => {
      const p = Math.min(1, (performance.now() - start) / ms);
      setProgress(p);
      if (p >= 1) onDone();
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [start, ms, onDone]);
  const stop = () => {
    setStart(null);
    setProgress(0);
  };
  return (
    <Button
      variant={variant}
      className="relative overflow-hidden"
      onPointerDown={() => setStart(performance.now())}
      onPointerUp={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && start == null) setStart(performance.now());
      }}
      onKeyUp={stop}
    >
      <span className="absolute inset-y-0 left-0 bg-white/25" style={{ width: `${progress * 100}%` }} />
      <span className="relative">{progress > 0 ? 'Keep holding…' : `Hold to ${label.toLowerCase()}`}</span>
    </Button>
  );
}

export function ConfirmHost() {
  const current = useConfirm((s) => s.current);
  if (!current) return null;
  const done = (ok: boolean) => {
    current.resolve(ok);
    useConfirm.setState({ current: null });
  };
  const variant = current.tone === 'danger' ? 'danger' : current.tone === 'buy' ? 'buy' : current.tone === 'sell' ? 'sell' : 'primary';
  const label = current.confirmLabel ?? 'Confirm';
  return (
    <Modal
      open
      onClose={() => done(false)}
      title={current.title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => done(false)}>
            {current.cancelLabel ?? 'Cancel'}
          </Button>
          {current.holdMs ? (
            <HoldButton ms={current.holdMs} variant={variant} label={label} onDone={() => done(true)} />
          ) : (
            <Button variant={variant} data-autofocus onClick={() => done(true)}>
              {label}
            </Button>
          )}
        </>
      }
    >
      {current.body && <div className="text-sm text-muted">{current.body}</div>}
    </Modal>
  );
}
