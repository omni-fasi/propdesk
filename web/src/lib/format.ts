// UI formatting helpers. Re-exports the shared formatters so features import from one place.

export * from '@shared/format';

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
function dtf(key: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = dateTimeFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', opts);
    dateTimeFormatters.set(key, f);
  }
  return f;
}

/** 14:05:09 (local, or in `tz`). */
export function fmtTime(ts: number, opts: { seconds?: boolean; tz?: string } = {}): string {
  const key = `t|${opts.seconds ?? true}|${opts.tz ?? ''}`;
  return dtf(key, { hour: '2-digit', minute: '2-digit', second: opts.seconds === false ? undefined : '2-digit', hour12: false, timeZone: opts.tz }).format(ts);
}

/** Oct 24 · Oct 24, 2025 (other year). */
export function fmtDate(ts: number, opts: { year?: boolean; weekday?: boolean; tz?: string } = {}): string {
  const showYear = opts.year ?? new Date(ts).getFullYear() !== new Date().getFullYear();
  const key = `d|${showYear}|${opts.weekday ?? false}|${opts.tz ?? ''}`;
  return dtf(key, { month: 'short', day: 'numeric', year: showYear ? 'numeric' : undefined, weekday: opts.weekday ? 'short' : undefined, timeZone: opts.tz }).format(ts);
}

/** Oct 24, 14:05 */
export function fmtDateTime(ts: number, opts: { seconds?: boolean; tz?: string } = {}): string {
  return `${fmtDate(ts, { tz: opts.tz })}, ${fmtTime(ts, { seconds: opts.seconds ?? false, tz: opts.tz })}`;
}

/** 'YYYY-MM-DD' → "Fri, Oct 24" */
export function fmtDayKey(key: string, opts: { year?: boolean; weekday?: boolean } = {}): string {
  const [y, m, d] = key.split('-').map(Number);
  const ts = Date.UTC(y, m - 1, d, 12);
  const showYear = opts.year ?? false;
  const k = `k|${showYear}|${opts.weekday ?? true}`;
  return dtf(k, { month: 'short', day: 'numeric', weekday: opts.weekday === false ? undefined : 'short', year: showYear ? 'numeric' : undefined, timeZone: 'UTC' }).format(ts);
}

/** 'YYYY-MM' → "October 2026" */
export function fmtMonthKey(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return dtf('mk', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(y, m - 1, 15));
}

/** "just now", "5m ago", "3h ago", "Oct 2" */
export function fmtRelative(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000);
  if (s < 0) return 'soon';
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  if (s < 7 * 86_400) return `${Math.round(s / 86_400)}d ago`;
  return fmtDate(ts);
}

/** Tailwind text color class for a P&L-like value. */
export function pnlTone(n: number | null | undefined, neutralClass = 'text-muted'): string {
  if (n == null || !Number.isFinite(n) || Math.abs(n) < 0.005) return neutralClass;
  return n > 0 ? 'text-profit' : 'text-loss';
}
