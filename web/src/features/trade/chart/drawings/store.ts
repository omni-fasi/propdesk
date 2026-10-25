// Drawing tools state: the armed tool, magnet / visibility toggles, the selection, and each symbol's drawings.
// Edits show at once and are saved to the server in the background (a failed save reloads the symbol).

import { create } from 'zustand';
import type { Drawing, DrawingKind } from '@shared/types';
import { api, errorMessage } from '@/api/client';
import { toast } from '@/components/ui/Toast';
import { readLocal, writeLocal } from '../../ticket/prefs';

export type DrawingTool = 'cursor' | DrawingKind;

export const DRAWING_LABELS: Record<DrawingKind, string> = {
  trendline: 'Trend line',
  hline: 'Horizontal line',
  hray: 'Horizontal ray',
  rect: 'Rectangle',
  long: 'Long position',
  short: 'Short position',
};

interface DrawingsState {
  tool: DrawingTool;
  /** Snap points to the bar's open / high / low / close when near one. */
  magnet: boolean;
  hidden: boolean;
  selectedId: string | null;
  bySymbol: Record<string, Drawing[]>;
  setTool(tool: DrawingTool): void;
  setMagnet(on: boolean): void;
  setHidden(on: boolean): void;
  select(id: string | null): void;
  load(symbol: string): Promise<void>;
  save(d: Drawing): void;
  remove(d: Drawing): void;
  clear(symbol: string): void;
}

const MAGNET_KEY = 'propdesk.drawings.magnet';
const HIDDEN_KEY = 'propdesk.drawings.hidden';

function put(list: Drawing[] | undefined, d: Drawing): Drawing[] {
  const cur = list ?? [];
  return cur.some((x) => x.id === d.id) ? cur.map((x) => (x.id === d.id ? d : x)) : [...cur, d];
}

export const useDrawings = create<DrawingsState>((set, get) => {
  const failed = (title: string, symbol: string) => (e: unknown) => {
    toast({ tone: 'loss', title, description: errorMessage(e) });
    void get().load(symbol);
  };

  return {
    tool: 'cursor',
    magnet: readLocal(MAGNET_KEY, true),
    hidden: readLocal(HIDDEN_KEY, false),
    selectedId: null,
    bySymbol: {},

    setTool: (tool) => set({ tool, selectedId: tool === 'cursor' ? get().selectedId : null }),
    setMagnet(on) {
      set({ magnet: on });
      writeLocal(MAGNET_KEY, on);
    },
    setHidden(on) {
      set({ hidden: on, selectedId: on ? null : get().selectedId });
      writeLocal(HIDDEN_KEY, on);
    },
    select: (id) => set({ selectedId: id }),

    async load(symbol) {
      try {
        const list = await api.drawings(symbol);
        set((s) => ({ bySymbol: { ...s.bySymbol, [symbol]: list } }));
      } catch {
        // keep what is shown; the next load retries
      }
    },

    save(d) {
      set((s) => ({ bySymbol: { ...s.bySymbol, [d.symbol]: put(s.bySymbol[d.symbol], d) } }));
      api
        .putDrawing(d.id, { symbol: d.symbol, kind: d.kind, points: d.points, tp: d.tp, sl: d.sl })
        .then((saved) => {
          // Only if nothing newer replaced it meanwhile.
          const cur = get().bySymbol[d.symbol]?.find((x) => x.id === d.id);
          if (cur === d) set((s) => ({ bySymbol: { ...s.bySymbol, [d.symbol]: put(s.bySymbol[d.symbol], saved) } }));
        })
        .catch(failed('Drawing not saved', d.symbol));
    },

    remove(d) {
      set((s) => ({
        bySymbol: { ...s.bySymbol, [d.symbol]: (s.bySymbol[d.symbol] ?? []).filter((x) => x.id !== d.id) },
        selectedId: s.selectedId === d.id ? null : s.selectedId,
      }));
      api.deleteDrawing(d.id).catch(failed('Drawing not deleted', d.symbol));
      toast({ title: `${DRAWING_LABELS[d.kind]} deleted`, duration: 5000, action: { label: 'Undo', onClick: () => get().save(d) } });
    },

    clear(symbol) {
      const removed = get().bySymbol[symbol] ?? [];
      if (!removed.length) return;
      set((s) => ({ bySymbol: { ...s.bySymbol, [symbol]: [] }, selectedId: null }));
      api.clearDrawings(symbol).catch(failed('Drawings not deleted', symbol));
      toast({
        title: `${removed.length} drawing${removed.length === 1 ? '' : 's'} deleted`,
        duration: 6000,
        action: { label: 'Undo', onClick: () => removed.forEach((d) => get().save(d)) },
      });
    },
  };
});
