// Drawing tools column left of the chart, like TradingView's: cursor, trend line, horizontal line / ray,
// rectangle, long / short position, then magnet, show / hide and delete all.

import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Eye, EyeOff, Magnet, Minus, MousePointer2, MoveRight, Slash, Square, Trash2 } from 'lucide-react';
import { IconButton } from '@/components/ui/Button';
import { DRAWING_LABELS, useDrawings, type DrawingTool } from './store';

/** A box split at the entry, arrow toward the target. */
function PositionIcon({ long }: { long: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="2" width="12" height="12" rx="1.5" />
      <path d={long ? 'M2 10h12' : 'M2 6h12'} />
      <path d={long ? 'M8 8V4.5M6.2 6.2 8 4.4l1.8 1.8' : 'M8 8v3.5M6.2 9.8 8 11.6l1.8-1.8'} />
    </svg>
  );
}

const TOOLS: Array<{ tool: DrawingTool; label: string; icon: ReactNode }> = [
  { tool: 'cursor', label: 'Cursor (Esc)', icon: <MousePointer2 size={15} /> },
  { tool: 'trendline', label: `${DRAWING_LABELS.trendline} (Alt+T)`, icon: <Slash size={15} /> },
  { tool: 'hline', label: `${DRAWING_LABELS.hline} (Alt+H)`, icon: <Minus size={15} /> },
  { tool: 'hray', label: `${DRAWING_LABELS.hray} (Alt+J)`, icon: <MoveRight size={15} /> },
  { tool: 'rect', label: `${DRAWING_LABELS.rect} (Alt+Shift+R)`, icon: <Square size={14} /> },
  { tool: 'long', label: `${DRAWING_LABELS.long}: entry, stop-loss and take-profit`, icon: <PositionIcon long /> },
  { tool: 'short', label: `${DRAWING_LABELS.short}: entry, stop-loss and take-profit`, icon: <PositionIcon long={false} /> },
];

export function DrawingToolbar({ symbol }: { symbol: string }) {
  const tool = useDrawings((s) => s.tool);
  const magnet = useDrawings((s) => s.magnet);
  const hidden = useDrawings((s) => s.hidden);
  const count = useDrawings((s) => s.bySymbol[symbol]?.length ?? 0);

  const pick = (t: DrawingTool) => {
    const st = useDrawings.getState();
    if (t !== 'cursor' && st.hidden) st.setHidden(false);
    st.setTool(t !== 'cursor' && st.tool === t ? 'cursor' : t);
  };

  return (
    <div className="flex w-10 shrink-0 flex-col items-center gap-0.5 border-r border-line bg-bg py-1.5">
      {TOOLS.map((t) => (
        <IconButton
          key={t.tool}
          label={t.label}
          icon={t.icon}
          onClick={() => pick(t.tool)}
          aria-pressed={tool === t.tool}
          className={clsx(tool === t.tool && (t.tool === 'cursor' ? 'bg-panel-3 text-fg' : 'bg-fg text-bg hover:bg-fg hover:text-bg'))}
        />
      ))}
      <div className="my-1 h-px w-5 bg-line" />
      <IconButton
        label={magnet ? 'Magnet on: points snap to the candle’s open, high, low or close' : 'Magnet off'}
        icon={<Magnet size={15} />}
        active={magnet}
        aria-pressed={magnet}
        onClick={() => useDrawings.getState().setMagnet(!magnet)}
      />
      <IconButton
        label={hidden ? 'Show drawings' : 'Hide drawings'}
        icon={hidden ? <EyeOff size={15} /> : <Eye size={15} />}
        active={hidden}
        onClick={() => useDrawings.getState().setHidden(!hidden)}
      />
      <IconButton label={`Delete all drawings on ${symbol}`} icon={<Trash2 size={15} />} disabled={!count} onClick={() => useDrawings.getState().clear(symbol)} />
    </div>
  );
}
