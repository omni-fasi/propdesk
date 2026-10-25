// Trade-page UI state: selected symbol & timeframe, the order-ticket draft, chart preview toggle.
// The ticket draft lives here (not in the ticket component) so the chart can draw and drag its preview lines.

import { create } from 'zustand';
import type { Mood, OrderType, Side, Timeframe } from '@shared/types';
import { TIMEFRAMES } from '@shared/types';
import { useApp } from '@/store/app';
import { getQuote } from '@/store/market';
import type { BracketInput, BracketKind, TicketDraft } from './ticket/riskMath';
import { loadPrefs, readLocal, savePrefs, writeLocal } from './ticket/prefs';

export interface Ticket extends TicketDraft {
  symbol: string;
  mood: Mood | null;
  setup: string | null;
  /** SL/TP distances still need a first-time default (waiting for a price). */
  needsDefaults: boolean;
}

interface TradeState {
  initialized: boolean;
  symbol: string;
  timeframe: Timeframe;
  ticket: Ticket;
  /** Draw the ticket's pending order / SL / TP on the chart. */
  preview: boolean;
  /** Incremented to draw the eye to the ticket (order staged from the chart). */
  attention: number;
  init(): void;
  selectSymbol(symbol: string): void;
  setTimeframe(tf: Timeframe): void;
  patchTicket(patch: Partial<Ticket>): void;
  patchBracket(kind: BracketKind, patch: Partial<BracketInput>): void;
  /** Load an order into the ticket (from the chart) without placing it. */
  stage(order: { side: Side; type: OrderType; price: number | null }): void;
  resetCheckin(): void;
  setPreview(on: boolean): void;
}

const PREVIEW_KEY = 'propdesk.trade.preview';

function blankTicket(symbol: string): Ticket {
  const spec = useApp.getState().instrumentMap[symbol];
  const prefs = spec ? loadPrefs(spec) : null;
  return {
    symbol,
    side: 'buy',
    type: 'market',
    price: null,
    sizeMode: prefs?.sizeMode ?? 'qty',
    qty: prefs?.qty ?? spec?.defaultQty ?? 1,
    value: prefs?.value ?? null,
    risk: prefs?.risk ?? null,
    sl: prefs?.sl ?? { on: true, mode: 'dist', value: null },
    tp: prefs?.tp ?? { on: true, mode: 'dist', value: null },
    mood: null,
    setup: null,
    needsDefaults: prefs?.needsDefaults ?? true,
  };
}

function validSymbol(symbol: string | null | undefined): symbol is string {
  return !!symbol && !!useApp.getState().instrumentMap[symbol];
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSettings: { lastSymbol?: string; chartTimeframe?: Timeframe } = {};
function persistSettings(patch: { lastSymbol?: string; chartTimeframe?: Timeframe }) {
  pendingSettings = { ...pendingSettings, ...patch };
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const p = pendingSettings;
    pendingSettings = {};
    useApp
      .getState()
      .updateSettings(p)
      .catch(() => {});
  }, 400);
}

let prefsTimer: ReturnType<typeof setTimeout> | null = null;
function persistPrefs(t: Ticket) {
  if (prefsTimer) clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    prefsTimer = null;
    const spec = useApp.getState().instrumentMap[t.symbol];
    if (spec) savePrefs(spec, t, getQuote(t.symbol));
  }, 300);
}

const PREF_FIELDS: Array<keyof Ticket> = ['qty', 'sizeMode', 'value', 'risk', 'sl', 'tp'];

export const useTrade = create<TradeState>((set, get) => ({
  initialized: false,
  symbol: 'MNQ',
  timeframe: '1m',
  ticket: { symbol: 'MNQ', side: 'buy', type: 'market', price: null, sizeMode: 'qty', qty: 1, value: null, risk: null, sl: { on: true, mode: 'dist', value: null }, tp: { on: true, mode: 'dist', value: null }, mood: null, setup: null, needsDefaults: true },
  preview: readLocal(PREVIEW_KEY, true),
  attention: 0,

  init() {
    const { settings, instruments } = useApp.getState();
    if (get().initialized && validSymbol(get().symbol)) return;
    const symbol = validSymbol(settings.lastSymbol)
      ? settings.lastSymbol
      : (settings.watchlist.find(validSymbol) ?? instruments[0]?.symbol ?? 'MNQ');
    const timeframe = TIMEFRAMES.includes(settings.chartTimeframe) ? settings.chartTimeframe : '1m';
    set({ initialized: true, symbol, timeframe, ticket: blankTicket(symbol) });
  },

  selectSymbol(symbol) {
    if (!validSymbol(symbol) || symbol === get().symbol) return;
    const prev = get().ticket;
    const next = blankTicket(symbol);
    // Keep how the trader is working (side, order type, check-in); size & brackets are per symbol.
    set({ symbol, ticket: { ...next, side: prev.side, type: prev.type, mood: prev.mood, setup: prev.setup } });
    persistSettings({ lastSymbol: symbol });
  },

  setTimeframe(tf) {
    if (tf === get().timeframe) return;
    set({ timeframe: tf });
    persistSettings({ chartTimeframe: tf });
  },

  patchTicket(patch) {
    const ticket = { ...get().ticket, ...patch };
    set({ ticket });
    if (PREF_FIELDS.some((k) => k in patch)) persistPrefs(ticket);
  },

  patchBracket(kind, patch) {
    const cur = get().ticket;
    const ticket = { ...cur, [kind]: { ...cur[kind], ...patch } };
    set({ ticket });
    persistPrefs(ticket);
  },

  stage({ side, type, price }) {
    set((s) => ({ ticket: { ...s.ticket, side, type, price }, attention: s.attention + 1 }));
  },

  resetCheckin() {
    set((s) => ({ ticket: { ...s.ticket, mood: null, setup: null } }));
  },

  setPreview(on) {
    set({ preview: on });
    writeLocal(PREVIEW_KEY, on);
  },
}));
