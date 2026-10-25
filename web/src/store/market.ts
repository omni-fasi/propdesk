// Live quotes, kept in their own store so ticking prices only re-render components that read them.

import { create } from 'zustand';
import type { Quote } from '@shared/types';

interface MarketState {
  quotes: Record<string, Quote>;
  /** Direction of the last change of `last` per symbol: 1 up, -1 down, 0 unchanged. */
  dir: Record<string, 1 | -1 | 0>;
  applyQuotes(quotes: Quote[]): void;
}

export const useMarket = create<MarketState>((set) => ({
  quotes: {},
  dir: {},
  applyQuotes(incoming) {
    if (incoming.length === 0) return;
    set((s) => {
      const quotes = { ...s.quotes };
      const dir = { ...s.dir };
      for (const q of incoming) {
        const prev = quotes[q.symbol];
        if (prev && q.ts < prev.ts) continue;
        dir[q.symbol] = !prev || q.last === prev.last ? (dir[q.symbol] ?? 0) : q.last > prev.last ? 1 : -1;
        quotes[q.symbol] = q;
      }
      return { quotes, dir };
    });
  },
}));

export function useQuote(symbol: string | null | undefined): Quote | undefined {
  return useMarket((s) => (symbol ? s.quotes[symbol] : undefined));
}

export function useTickDir(symbol: string): 1 | -1 | 0 {
  return useMarket((s) => s.dir[symbol] ?? 0);
}

export function getQuote(symbol: string): Quote | undefined {
  return useMarket.getState().quotes[symbol];
}
