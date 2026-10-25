// Market-session wording in Eastern Time ("Market closed · opens Sun 6:00 PM ET").

import type { SessionState } from '@shared/types';
import { NEW_YORK, calendarDayOf } from '@shared/time';

const withDay = new Intl.DateTimeFormat('en-US', { timeZone: NEW_YORK, weekday: 'short', hour: 'numeric', minute: '2-digit' });
const timeOnly = new Intl.DateTimeFormat('en-US', { timeZone: NEW_YORK, hour: 'numeric', minute: '2-digit' });

/** "6:00 PM ET" today, otherwise "Sun 6:00 PM ET". */
export function fmtEt(ts: number, now: number): string {
  const sameDay = calendarDayOf(ts, NEW_YORK) === calendarDayOf(now, NEW_YORK);
  return `${(sameDay ? timeOnly : withDay).format(ts)} ET`;
}

/** Empty string while open. */
export function sessionClosedText(s: SessionState | null, now: number): string {
  if (!s || s.open) return '';
  const head = s.label === 'Daily break' ? 'Daily break' : 'Market closed';
  return s.nextChange ? `${head} · opens ${fmtEt(s.nextChange, now)}` : head;
}
