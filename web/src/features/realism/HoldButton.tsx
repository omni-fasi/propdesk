import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Button, type ButtonSize, type ButtonVariant } from '@/components/ui/Button';

export interface HoldButtonProps {
  /** e.g. "Hold to pay $149.00" */
  label: ReactNode;
  onConfirm: () => void;
  holdMs?: number;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  block?: boolean;
  icon?: ReactNode;
  className?: string;
}

/**
 * Press and hold (pointer, Enter or Space) to confirm a consequential action. Releasing early cancels.
 * The fill sweeps across the button while holding.
 */
export function HoldButton({ label, onConfirm, holdMs = 1200, variant = 'primary', size = 'md', disabled, loading, block, icon, className }: HoldButtonProps) {
  const [progress, setProgress] = useState(0);
  const start = useRef<number | null>(null);
  const raf = useRef(0);
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;

  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    start.current = null;
    setProgress(0);
  }, []);

  const begin = useCallback(() => {
    if (disabled || loading || start.current != null) return;
    start.current = performance.now();
    const tick = () => {
      if (start.current == null) return;
      const p = Math.min(1, (performance.now() - start.current) / holdMs);
      setProgress(p);
      if (p >= 1) {
        start.current = null;
        setProgress(0);
        confirmRef.current();
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, [disabled, loading, holdMs]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  useEffect(() => {
    if (disabled || loading) stop();
  }, [disabled, loading, stop]);

  const holding = progress > 0;
  return (
    <Button
      variant={variant}
      size={size}
      block={block}
      disabled={disabled}
      loading={loading}
      icon={icon}
      className={clsx('relative touch-none overflow-hidden', className)}
      onPointerDown={(e) => {
        if (e.button === 0) begin();
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
          e.preventDefault();
          begin();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === 'Enter' || e.key === ' ') stop();
      }}
      onBlur={stop}
    >
      <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 bg-current opacity-25" style={{ width: `${progress * 100}%` }} />
      <span className="relative">{holding ? 'Keep holding…' : label}</span>
    </Button>
  );
}
