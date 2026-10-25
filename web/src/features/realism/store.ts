// UI state of the realism layer: full-screen moments (breach / pass / lock), "while you were away"
// summaries and the queue of trades waiting for a post-trade review.

import { create } from 'zustand';
import type { AccountEvent, Trade } from '@shared/types';

export type MomentType = 'breach' | 'pass' | 'lock';

export interface Moment {
  /** `${type}:${accountId}` — one moment per type and account. */
  key: string;
  type: MomentType;
  accountId: string;
  event: AccountEvent | null;
  /** Missed while the app was closed: no sound, no forced pause. */
  replay: boolean;
  openedAt: number;
}

interface RealismState {
  /** First item is on screen. */
  moments: Moment[];
  catchUps: AccountEvent[];
  /** Oldest first. */
  reviews: Trade[];
  reviewsCollapsed: boolean;
}

export const useRealism = create<RealismState>(() => ({ moments: [], catchUps: [], reviews: [], reviewsCollapsed: false }));

const PRIORITY: Record<MomentType, number> = { breach: 0, pass: 1, lock: 2 };
const MAX_REVIEWS = 12;

export function showMoment(type: MomentType, accountId: string, event: AccountEvent | null, replay = false): void {
  useRealism.setState((s) => {
    const key = `${type}:${accountId}`;
    let rest = s.moments.filter((m) => m.key !== key);
    // A breach supersedes a pending lock on the same account.
    if (type === 'breach') rest = rest.filter((m) => !(m.type === 'lock' && m.accountId === accountId));
    const moment: Moment = { key, type, accountId, event, replay, openedAt: Date.now() };
    const idx = rest.findIndex((m) => PRIORITY[m.type] > PRIORITY[type]);
    const moments = idx === -1 ? [...rest, moment] : [...rest.slice(0, idx), moment, ...rest.slice(idx)];
    return { moments };
  });
}

export function closeMoment(key: string): void {
  useRealism.setState((s) => ({ moments: s.moments.filter((m) => m.key !== key) }));
}

export function closeMomentsFor(type: MomentType, accountId: string): void {
  closeMoment(`${type}:${accountId}`);
}

export function pushCatchUp(event: AccountEvent): void {
  useRealism.setState((s) => (s.catchUps.some((e) => e.id === event.id) ? s : { catchUps: [...s.catchUps, event] }));
}

export function clearCatchUps(): void {
  useRealism.setState({ catchUps: [] });
}

export function queueReview(trade: Trade): void {
  useRealism.setState((s) => {
    const others = s.reviews.filter((t) => t.id !== trade.id);
    return { reviews: [...others, trade].slice(-MAX_REVIEWS) };
  });
}

export function dropReview(tradeId: string): void {
  useRealism.setState((s) => ({ reviews: s.reviews.filter((t) => t.id !== tradeId) }));
}

export function setReviewsCollapsed(collapsed: boolean): void {
  useRealism.setState({ reviewsCollapsed: collapsed });
}
