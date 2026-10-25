// Order book heatmap state: on / off (remembered), the live book and the stored minutes of the chart
// symbol. Frames and finished minutes arrive over the socket (bus 'book' / 'bookRow'); history is fetched
// when the heatmap opens on a symbol and after a reconnect.

import { create } from 'zustand';
import type { BookFrame, BookRow } from '@shared/types';
import { api } from '@/api/client';
import { bus } from '@/api/bus';
import { serverNow } from '@/store/app';
import { readLocal, writeLocal } from '../../ticket/prefs';

const ON_KEY = 'propdesk.chart.orderBook';
/** History shown on the chart (the server keeps 24 h). */
const HISTORY_SEC = 24 * 3600;

interface BookState {
  on: boolean;
  /** Symbol the chart shows the heatmap for (null when off or not a Binance market). */
  active: string | null;
  frame: BookFrame | null;
  rows: BookRow[];
  loading: boolean;
  setOn(on: boolean): void;
  /** Start / stop following `symbol`: clears the old data and loads its history. */
  follow(symbol: string | null): void;
  reload(): Promise<void>;
}

/** Rows by minute, oldest first, without duplicates; older than the history window dropped. */
function mergeRows(a: BookRow[], b: BookRow[]): BookRow[] {
  const byT = new Map<number, BookRow>();
  for (const r of a) byT.set(r.t, r);
  for (const r of b) byT.set(r.t, r);
  const from = serverNow() / 1000 - HISTORY_SEC;
  return [...byT.values()].filter((r) => r.t >= from).sort((x, y) => x.t - y.t);
}

export const useBook = create<BookState>((set, get) => ({
  on: readLocal<boolean>(ON_KEY, false),
  active: null,
  frame: null,
  rows: [],
  loading: false,

  setOn(on) {
    writeLocal(ON_KEY, on);
    set({ on });
  },

  follow(symbol) {
    if (symbol === get().active) return;
    set({ active: symbol, frame: null, rows: [], loading: symbol != null });
    if (symbol) void get().reload();
  },

  async reload() {
    const symbol = get().active;
    if (!symbol) return;
    const to = Math.floor(serverNow() / 1000);
    try {
      const rows = await api.book(symbol, to - HISTORY_SEC, to);
      if (get().active !== symbol) return;
      set((s) => ({ rows: mergeRows(Array.isArray(rows) ? rows : [], s.rows), loading: false }));
    } catch {
      if (get().active === symbol) set({ loading: false });
    }
  },
}));

bus.on('book', (frame) => {
  if (frame.symbol === useBook.getState().active) useBook.setState({ frame });
});
bus.on('bookRow', ({ symbol, row }) => {
  if (symbol === useBook.getState().active) useBook.setState((s) => ({ rows: mergeRows(s.rows, [row]) }));
});
bus.on('resynced', () => void useBook.getState().reload());
