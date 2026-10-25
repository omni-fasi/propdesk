// OHLC + volume legend (top-left). Updated imperatively from crosshair moves and live bars.

import { useEffect, useRef } from 'react';
import type { InstrumentSpec, Timeframe } from '@shared/types';
import { fmtPct, fmtPrice } from '@/lib/format';
import type { ChartController } from './controller';

const TF_LABEL: Record<Timeframe, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1D' };
const volFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

export function ChartLegend({ ctrl, spec, timeframe }: { ctrl: ChartController; spec: InstrumentSpec; timeframe: Timeframe }) {
  const o = useRef<HTMLSpanElement>(null);
  const h = useRef<HTMLSpanElement>(null);
  const l = useRef<HTMLSpanElement>(null);
  const c = useRef<HTMLSpanElement>(null);
  const chg = useRef<HTMLSpanElement>(null);
  const v = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const set = (r: React.RefObject<HTMLSpanElement | null>, text: string, cls?: string) => {
      if (!r.current) return;
      if (r.current.textContent !== text) r.current.textContent = text;
      if (cls != null && r.current.className !== cls) r.current.className = cls;
    };
    ctrl.cb.onLegend = (info) => {
      if (!info) {
        for (const r of [o, h, l, c, chg, v]) set(r, '—');
        return;
      }
      const { bar, prevClose } = info;
      const tone = bar.close >= bar.open ? 'text-profit' : 'text-loss';
      set(o, fmtPrice(spec, bar.open), tone);
      set(h, fmtPrice(spec, bar.high), tone);
      set(l, fmtPrice(spec, bar.low), tone);
      set(c, fmtPrice(spec, bar.close), tone);
      const base = prevClose ?? bar.open;
      const d = bar.close - base;
      const sign = d > 0 ? '+' : d < 0 ? '−' : '';
      set(chg, `${sign}${fmtPrice(spec, Math.abs(d))} (${fmtPct(base ? d / base : 0, 2, true)})`, d > 0 ? 'text-profit' : d < 0 ? 'text-loss' : 'text-muted');
      set(v, bar.volume > 0 ? volFmt.format(bar.volume) : '—');
    };
    ctrl.refreshLegend();
    return () => {
      ctrl.cb.onLegend = undefined;
    };
  }, [ctrl, spec]);

  return (
    <div className="num pointer-events-none absolute left-2 top-1.5 z-20 flex max-w-[calc(100%-110px)] flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded bg-black/60 px-1.5 py-0.5 text-[11px] leading-4">
      <span className="font-sans text-xs font-semibold text-fg">{spec.symbol}</span>
      <span className="text-faint">{TF_LABEL[timeframe]}</span>
      <span className="text-faint">
        O <span ref={o}>—</span>
      </span>
      <span className="text-faint">
        H <span ref={h}>—</span>
      </span>
      <span className="text-faint">
        L <span ref={l}>—</span>
      </span>
      <span className="text-faint">
        C <span ref={c}>—</span>
      </span>
      <span ref={chg} className="text-muted">
        —
      </span>
      <span className="text-faint">
        Vol <span ref={v} className="text-muted">—</span>
      </span>
    </div>
  );
}
