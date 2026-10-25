// Remembers the newest account event this browser has reacted to, so moments that happened while the
// app was closed (breach overnight, catch-up after sleep) can be shown when it opens again.

const KEY = 'propdesk.realism.lastEventTs';
const handled = new Set<string>();

export function getLastSeen(): number | null {
  try {
    const raw = localStorage.getItem(KEY);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function markSeen(ts: number): void {
  if (!Number.isFinite(ts)) return;
  const prev = getLastSeen();
  if (prev != null && prev >= ts) return;
  try {
    localStorage.setItem(KEY, String(ts));
  } catch {
    // storage unavailable: replays are best-effort
  }
}

/** True the first time an event id is seen in this page session. */
export function firstTime(eventId: string): boolean {
  if (handled.has(eventId)) return false;
  handled.add(eventId);
  if (handled.size > 2000) {
    const first = handled.values().next().value;
    if (first !== undefined) handled.delete(first);
  }
  return true;
}
