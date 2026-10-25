// Monochrome lightweight-charts theme shared by the journal and calendar charts.
// Black surface, gray grid/axes, white/gray lines. Green/red only where the sign of P&L is shown.
// Candle/series times are UTC seconds; every label is formatted in the viewer's local time zone.

import {
  ColorType,
  CrosshairMode,
  LineStyle,
  TickMarkType,
  type BarPrice,
  type ChartOptions,
  type DeepPartial,
  type PriceFormatCustom,
  type Time,
} from 'lightweight-charts';
import { fmtMoney } from '@/lib/format';

function cssColor(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : fallback;
}

export interface ChartPalette {
  text: string;
  grid: string;
  border: string;
  crosshair: string;
  label: string;
  line: string;
  lineMuted: string;
  zero: string;
  profit: string;
  loss: string;
}

export function chartPalette(): ChartPalette {
  return {
    text: '#7a7a7a',
    grid: '#141414',
    border: cssColor('--color-line', '#1f1f1f'),
    crosshair: '#4d4d4d',
    label: '#262626',
    line: '#ececec',
    lineMuted: '#6b6b6b',
    zero: '#3a3a3a',
    profit: cssColor('--color-profit', '#1fc773'),
    loss: cssColor('--color-loss', '#f23645'),
  };
}

/** '#1fc773' + 0.2 → 'rgba(31, 199, 115, 0.2)' */
export function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number) => String(n).padStart(2, '0');

/** Calendar parts of a business-day time ('YYYY-MM-DD' or {year, month, day}); null for timestamps. */
function businessParts(time: Time): { y: number; m: number; d: number } | null {
  if (typeof time === 'number') return null;
  if (typeof time === 'string') {
    const [y, m, d] = time.split('-').map(Number);
    return { y, m: m - 1, d };
  }
  return { y: time.year, m: time.month - 1, d: time.day };
}

/** Normalizes any chart time to a stable key: seconds for timestamps, 'YYYY-MM-DD' for business days. */
export function timeKey(time: Time): number | string {
  if (typeof time === 'number') return time;
  const p = businessParts(time)!;
  return `${p.y}-${pad(p.m + 1)}-${pad(p.d)}`;
}

/**
 * intraday: time-of-day labels (local).
 * multiday: local dates (equity curves, 1h/4h candles).
 * daily:    calendar dates of daily bars (UTC date of the bar / business day).
 */
export type ChartTimeMode = 'intraday' | 'multiday' | 'daily';

function tickFormatter(mode: ChartTimeMode) {
  return (time: Time, type: TickMarkType): string | null => {
    const biz = businessParts(time);
    let y: number, m: number, d: number, hh = 0, mm = 0, ss = 0;
    if (biz) {
      ({ y, m, d } = biz);
    } else {
      const date = new Date((time as number) * 1000);
      if (mode === 'daily') {
        y = date.getUTCFullYear();
        m = date.getUTCMonth();
        d = date.getUTCDate();
      } else {
        y = date.getFullYear();
        m = date.getMonth();
        d = date.getDate();
        hh = date.getHours();
        mm = date.getMinutes();
        ss = date.getSeconds();
      }
    }
    const hm = `${pad(hh)}:${pad(mm)}`;
    const dateLevel = type === TickMarkType.Year || type === TickMarkType.Month || type === TickMarkType.DayOfMonth;
    // Tick weights are computed on UTC boundaries; in intraday mode a "new day" tick that is not at local
    // midnight is still labelled with its local time so the axis never lies.
    if (mode === 'intraday' && dateLevel && !biz && (hh !== 0 || mm !== 0)) return hm;
    switch (type) {
      case TickMarkType.Year:
        return String(y);
      case TickMarkType.Month:
        return MONTHS[m];
      case TickMarkType.DayOfMonth:
        return `${MONTHS[m]} ${d}`;
      case TickMarkType.Time:
        return mode === 'daily' ? `${MONTHS[m]} ${d}` : hm;
      case TickMarkType.TimeWithSeconds:
        return mode === 'daily' ? `${MONTHS[m]} ${d}` : `${hm}:${pad(ss)}`;
      default:
        return null;
    }
  };
}

function crosshairTimeFormatter(mode: ChartTimeMode) {
  return (time: Time): string => {
    const biz = businessParts(time);
    if (biz) return `${WEEKDAYS[new Date(Date.UTC(biz.y, biz.m, biz.d)).getUTCDay()]} ${MONTHS[biz.m]} ${biz.d}, ${biz.y}`;
    const date = new Date((time as number) * 1000);
    if (mode === 'daily') return `${WEEKDAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return `${WEEKDAYS[date.getDay()]} ${MONTHS[date.getMonth()]} ${date.getDate()}${sameYear ? '' : `, ${date.getFullYear()}`}  ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
}

/** Base options for every chart in these pages. Mouse-wheel zoom/scroll is off so the page keeps scrolling. */
export function baseChartOptions(mode: ChartTimeMode): DeepPartial<ChartOptions> {
  const c = chartPalette();
  return {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: 'rgba(0,0,0,0)' },
      textColor: c.text,
      fontFamily: "'Inter Variable', ui-sans-serif, system-ui, sans-serif",
      fontSize: 11,
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: c.grid, style: LineStyle.Solid },
      horzLines: { color: c.grid, style: LineStyle.Solid },
    },
    rightPriceScale: { borderColor: c.border, scaleMargins: { top: 0.12, bottom: 0.1 } },
    timeScale: {
      borderColor: c.border,
      timeVisible: mode !== 'daily',
      secondsVisible: false,
      allowBoldLabels: false,
      tickMarkFormatter: tickFormatter(mode),
    },
    localization: { locale: 'en-CA', timeFormatter: crosshairTimeFormatter(mode) },
    crosshair: {
      mode: CrosshairMode.Magnet,
      vertLine: { color: c.crosshair, width: 1, style: LineStyle.Solid, labelBackgroundColor: c.label },
      horzLine: { color: c.crosshair, width: 1, style: LineStyle.Solid, labelBackgroundColor: c.label },
    },
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
  };
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Axis tick label for money: $0 · $250 · −$1.5K · $12K · $1.2M */
export function compactMoney(p: number): string {
  const a = Math.abs(p);
  const sign = p < 0 && a >= 0.005 ? '−' : '';
  if (a >= 1e6) return `${sign}$${trimZeros((a / 1e6).toFixed(2))}M`;
  if (a >= 1e3) return `${sign}$${trimZeros((a / 1e3).toFixed(a >= 1e4 ? 1 : 2))}K`;
  return `${sign}$${trimZeros(a.toFixed(a >= 100 ? 0 : 2))}`;
}

/** Money axis: exact signed dollars on the crosshair, compact ticks on the scale. */
export const MONEY_PRICE_FORMAT: PriceFormatCustom = {
  type: 'custom',
  minMove: 0.01,
  formatter: (p: BarPrice) => fmtMoney(p, { sign: true }),
  tickmarksFormatter: (ps: BarPrice[]) => ps.map((p) => compactMoney(p)),
};
