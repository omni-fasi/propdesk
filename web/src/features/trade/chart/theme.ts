// Chart look: black background, gray grid/axes/crosshair. Green/red only for candles, volume, fills,
// TP/SL and P&L. Amber only for rule levels. Times are shown in the viewer's local time zone.

import { ColorType, CrosshairMode, LineStyle, TickMarkType, type DeepPartial, type ChartOptions, type Time } from 'lightweight-charts';

export const C = {
  bg: '#000000',
  grid: '#101010',
  axis: '#1f1f1f',
  text: '#8a8a8a',
  crosshair: '#5a5a5a',
  crosshairLabel: '#262626',
  up: '#1fc773',
  down: '#f23645',
  upVol: 'rgba(31, 199, 115, 0.32)',
  downVol: 'rgba(242, 54, 69, 0.32)',
  entry: '#e5e5e5',
  order: '#8f8f8f',
  orderLabel: '#2e2e2e',
  draft: '#7a7a7a',
  draftLabel: '#3a3a3a',
  sl: '#f23645',
  slDraft: '#a8303b',
  slLabelDraft: '#5c1a20',
  tp: '#1fc773',
  tpDraft: '#1c8a53',
  tpLabelDraft: '#0f4a2c',
  rule: '#f5a524',
  ruleLabel: '#6b4a10',
} as const;

export const FONT = "'JetBrains Mono Variable', ui-monospace, SFMono-Regular, monospace";

export function baseChartOptions(): DeepPartial<ChartOptions> {
  return {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: C.bg },
      textColor: C.text,
      fontFamily: FONT,
      fontSize: 11,
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: C.grid, style: LineStyle.Solid },
      horzLines: { color: C.grid, style: LineStyle.Solid },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: C.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: C.crosshairLabel },
      horzLine: { color: C.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: C.crosshairLabel },
    },
    rightPriceScale: {
      borderColor: C.axis,
      scaleMargins: { top: 0.08, bottom: 0.22 },
      minimumWidth: 72,
    },
    timeScale: {
      borderColor: C.axis,
      rightOffset: 6,
      barSpacing: 7,
      minBarSpacing: 1.5,
      timeVisible: true,
      secondsVisible: false,
      lockVisibleTimeRangeOnResize: true,
    },
    kineticScroll: { mouse: false, touch: true },
    handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
  };
}

// ───────────────────────────── Time formatting (local zone; daily bars by their UTC date) ─────────────────────────────

const LOCALE = 'en-CA';

function dtf(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(LOCALE, opts);
}

const local = {
  hm: dtf({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
  hms: dtf({ hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }),
  day: dtf({ day: 'numeric' }),
  monthDay: dtf({ month: 'short', day: 'numeric' }),
  month: dtf({ month: 'short' }),
  year: dtf({ year: 'numeric' }),
  full: dtf({ weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
};

const utc = {
  day: dtf({ day: 'numeric', timeZone: 'UTC' }),
  month: dtf({ month: 'short', timeZone: 'UTC' }),
  year: dtf({ year: 'numeric', timeZone: 'UTC' }),
  full: dtf({ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }),
};

function toMs(time: Time): number | null {
  if (typeof time === 'number') return time * 1000;
  if (typeof time === 'string') {
    const t = Date.parse(time);
    return Number.isFinite(t) ? t : null;
  }
  return Date.UTC(time.year, time.month - 1, time.day);
}

export function timeFormatters(daily: boolean) {
  return {
    timeFormatter: (time: Time): string => {
      const ms = toMs(time);
      if (ms == null) return '';
      return daily ? utc.full.format(ms) : local.full.format(ms);
    },
    tickMarkFormatter: (time: Time, type: TickMarkType): string | null => {
      const ms = toMs(time);
      if (ms == null) return null;
      const f = daily ? utc : local;
      switch (type) {
        case TickMarkType.Year:
          return f.year.format(ms);
        case TickMarkType.Month:
          return f.month.format(ms);
        case TickMarkType.DayOfMonth:
          return daily ? utc.day.format(ms) : local.monthDay.format(ms);
        case TickMarkType.Time:
          return local.hm.format(ms);
        case TickMarkType.TimeWithSeconds:
          return local.hms.format(ms);
      }
      return null;
    },
  };
}
