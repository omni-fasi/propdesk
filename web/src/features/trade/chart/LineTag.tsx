// HTML label that rides on a chart price line (the controller positions it every frame).
// Draggable tags start a line drag; the × button acts on the line (close / cancel / remove).

import { useCallback, type ReactNode } from 'react';
import clsx from 'clsx';
import { GripVertical, X } from 'lucide-react';
import type { ChartController } from './controller';

export type TagTone = 'entry' | 'sl' | 'tp' | 'order' | 'draft' | 'rule';

const toneCls: Record<TagTone, string> = {
  entry: 'border-[#d4d4d4]/70 bg-black/85 text-fg',
  sl: 'border-loss/70 bg-black/85 text-fg',
  tp: 'border-profit/70 bg-black/85 text-fg',
  order: 'border-dashed border-[#8f8f8f] bg-black/85 text-fg',
  draft: 'border-dotted border-[#7a7a7a] bg-black/70 text-muted',
  rule: 'border-dashed border-warn/60 bg-black/85 text-warn',
};

export function Seg({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={clsx('num flex items-center whitespace-nowrap px-1.5', className)}>{children}</span>;
}

export interface LineTagProps {
  ctrl: ChartController;
  lineKey: string;
  tone: TagTone;
  draggable?: boolean;
  onClose?: () => void;
  closeLabel?: string;
  title?: string;
  children: ReactNode;
}

export function LineTag({ ctrl, lineKey, tone, draggable, onClose, closeLabel, title, children }: LineTagProps) {
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) return ctrl.registerTag(lineKey, el);
    },
    [ctrl, lineKey],
  );
  return (
    <div
      ref={ref}
      data-chart-ui
      title={title}
      onPointerDown={
        draggable
          ? (e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              ctrl.startDrag(lineKey, e.nativeEvent);
            }
          : undefined
      }
      className={clsx(
        'pointer-events-auto absolute left-2 top-0 z-10 flex h-5 select-none items-stretch overflow-hidden rounded-[3px] border text-[11px] leading-none shadow-[0_2px_8px_rgba(0,0,0,0.7)]',
        toneCls[tone],
        draggable && 'cursor-ns-resize',
      )}
    >
      {draggable && (
        <span className="flex items-center pl-0.5 text-faint">
          <GripVertical size={10} />
        </span>
      )}
      {children}
      {onClose && (
        <button
          type="button"
          data-chart-ui
          aria-label={closeLabel}
          title={closeLabel}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className="flex w-5 cursor-pointer items-center justify-center border-l border-white/10 text-faint transition-colors hover:bg-white/10 hover:text-fg"
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
}
