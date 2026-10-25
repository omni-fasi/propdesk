// Tiny typed event bus for real-time moments (fills, closed trades, rule events, live candles…).
// The store holds state; the bus is for reacting to *changes* (sounds, flashes, modals, chart updates).

import { useEffect, useRef } from 'react';
import type { AccountEvent, AccountSnapshot, Candle, Fill, Order, Position, Trade } from '@shared/types';

export interface BusEvents {
  fill: Fill;
  /** Every trade message (opened, updated, closed). */
  trade: Trade;
  /** A trade that just closed (also emitted as `trade`). */
  tradeClosed: Trade;
  order: Order;
  /** Rule / account events: breach, passed, locked, warning, stop_hit, catch_up … */
  event: AccountEvent;
  /** Live 1m candle for the chart symbol. */
  candle: { symbol: string; candle: Candle };
  position: Position;
  positionClosed: { accountId: string; symbol: string };
  snapshot: AccountSnapshot;
  connection: { connected: boolean };
  /** State was re-bootstrapped after a reconnect. */
  resynced: undefined;
}

type Handler<T> = (payload: T) => void;
const handlers = new Map<keyof BusEvents, Set<Handler<never>>>();

export const bus = {
  on<K extends keyof BusEvents>(type: K, fn: Handler<BusEvents[K]>): () => void {
    let set = handlers.get(type);
    if (!set) handlers.set(type, (set = new Set()));
    set.add(fn as Handler<never>);
    return () => set.delete(fn as Handler<never>);
  },
  emit<K extends keyof BusEvents>(type: K, payload: BusEvents[K]): void {
    const set = handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as Handler<BusEvents[K]>)(payload);
      } catch (e) {
        console.error(`bus handler for ${String(type)} failed`, e);
      }
    }
  },
};

/** Subscribe to a bus event for the component's lifetime. The latest `fn` is always called. */
export function useBus<K extends keyof BusEvents>(type: K, fn: Handler<BusEvents[K]>): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => bus.on(type, (p) => ref.current(p)), [type]);
}
