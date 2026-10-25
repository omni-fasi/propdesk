import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { X } from 'lucide-react';
import { IconButton } from './Button';

// Open overlays in opening order: only the top-most one reacts to Escape (stacked drawer + modal).
const overlayStack: number[] = [];
let overlaySeq = 0;

function useEscape(open: boolean, onClose: (() => void) | undefined) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const id = ++overlaySeq;
    overlayStack.push(id);
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || overlayStack[overlayStack.length - 1] !== id) return;
      // Non-dismissible overlays still swallow Escape so the one underneath doesn't close.
      e.stopPropagation();
      onCloseRef.current?.();
    };
    window.addEventListener('keydown', h);
    return () => {
      window.removeEventListener('keydown', h);
      const i = overlayStack.indexOf(id);
      if (i !== -1) overlayStack.splice(i, 1);
    };
  }, [open]);
}

/** Focus the first focusable element inside `ref` when opened. */
function useAutoFocus(open: boolean, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const el = ref.current?.querySelector<HTMLElement>('[data-autofocus], input, select, textarea, button:not([data-close])');
    el?.focus({ preventScroll: true });
  }, [open, ref]);
}

export interface ModalProps {
  open: boolean;
  /** Omit to make the modal non-dismissible (no ✕, no Esc, no backdrop click). */
  onClose?: () => void;
  title?: ReactNode;
  description?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** Extra classes for the backdrop (e.g. a red tint for a breach). */
  backdropClassName?: string;
}

const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl', full: 'max-w-[min(1200px,95vw)]' };

export function Modal({ open, onClose, title, description, size = 'md', footer, children, className, backdropClassName }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(open, onClose);
  useAutoFocus(open, ref);
  if (!open) return null;
  return createPortal(
    <div
      className={clsx('fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-black/70 p-4 backdrop-blur-[2px]', backdropClassName)}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        className={clsx('flex max-h-[90vh] w-full animate-pop-in flex-col rounded-xl border border-line-strong bg-panel shadow-pop', widths[size], className)}
      >
        {(title || onClose) && (
          <div className="flex shrink-0 items-start justify-between gap-4 px-5 pb-2 pt-4">
            <div className="min-w-0">
              {title && <h2 className="text-base font-semibold text-fg">{title}</h2>}
              {description && <p className="mt-1 text-sm text-muted">{description}</p>}
            </div>
            {onClose && <IconButton data-close label="Close" icon={<X size={16} />} onClick={onClose} className="-mr-2 -mt-1" />}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto px-5 pb-5 pt-2">{children}</div>
        {footer && <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  width?: number;
  children?: ReactNode;
  footer?: ReactNode;
}

/** Right-side sheet for details (a day, a trade…). */
export function Drawer({ open, onClose, title, subtitle, actions, width = 560, children, footer }: DrawerProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(open, onClose);
  if (!open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-40 flex animate-fade-in justify-end bg-black/50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside ref={ref} className="flex h-full max-w-[95vw] animate-slide-in-right flex-col border-l border-line-strong bg-panel shadow-pop" style={{ width }}>
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            {title && <h2 className="truncate text-base font-semibold text-fg">{title}</h2>}
            {subtitle && <div className="mt-0.5 text-sm text-muted">{subtitle}</div>}
          </div>
          <div className="flex items-center gap-1">
            {actions}
            <IconButton data-close label="Close" icon={<X size={16} />} onClick={onClose} />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-5">{children}</div>
        {footer && <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </aside>
    </div>,
    document.body,
  );
}
