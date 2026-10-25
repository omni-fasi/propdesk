// Engine → API notifications. They mirror the WebSocket ServerMessage shapes, except `snapshot`
// which only says "this account's live numbers changed" so the API layer can throttle and compute it.

import type { Account, AccountEvent, Fill, Order, Position, Settings, Trade, WalletSummary } from '../../../shared/types.ts';

export type EngineEvent =
  | { type: 'account'; account: Account }
  | { type: 'order'; order: Order }
  | { type: 'position'; position: Position }
  | { type: 'position_closed'; accountId: string; symbol: string; tradeId: string }
  | { type: 'fill'; fill: Fill }
  | { type: 'trade'; trade: Trade }
  | { type: 'event'; event: AccountEvent }
  | { type: 'wallet'; wallet: WalletSummary }
  | { type: 'settings'; settings: Settings }
  /** Live numbers changed. immediate = after a fill / status change (bypass throttling). */
  | { type: 'snapshot'; accountId: string; immediate: boolean };

export type EngineListener = (ev: EngineEvent) => void;

/** Minimal synchronous emitter; a throwing listener never breaks the engine. */
export class Emitter {
  private listeners = new Set<EngineListener>();
  private onError: (err: unknown) => void;

  constructor(onError: (err: unknown) => void) {
    this.onError = onError;
  }

  on(fn: EngineListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(ev: EngineEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch (err) {
        this.onError(err);
      }
    }
  }
}
