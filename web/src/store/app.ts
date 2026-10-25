// Application state mirrored from the server: bootstrap once, then kept current by WebSocket messages.
//
// Selector rule (zustand 5 + React 19): never return a NEW array/object from a selector — that loops.
// Select the stable map (e.g. `s.positions`) and derive with useMemo, or use the hooks in ./hooks.ts.

import { create } from 'zustand';
import type { ServerMessage } from '@shared/api';
import type {
  Account,
  AccountEvent,
  AccountSnapshot,
  ChallengePreset,
  FeedStatus,
  Fill,
  InstrumentSpec,
  Order,
  Position,
  Settings,
  Trade,
  WalletSummary,
} from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/journal';
import { api, errorMessage } from '@/api/client';
import { useMarket } from './market';

export const positionKey = (accountId: string, symbol: string) => `${accountId}|${symbol}`;

const MAX_RECENT = 300;

interface AppState {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  connected: boolean;
  /** serverTime - Date.now() at the last sync. */
  serverOffset: number;
  version: string;
  localTz: string;
  settings: Settings;
  instruments: InstrumentSpec[];
  instrumentMap: Record<string, InstrumentSpec>;
  presets: ChallengePreset[];
  accounts: Record<string, Account>;
  snapshots: Record<string, AccountSnapshot>;
  /** Keyed by positionKey(accountId, symbol). */
  positions: Record<string, Position>;
  /** Working orders only, by id. */
  orders: Record<string, Order>;
  openTrades: Record<string, Trade>;
  /** Fills received this session + none from history (query the API for history). Newest first. */
  recentFills: Fill[];
  /** Trades closed this session. Newest first. */
  recentTrades: Trade[];
  /** Newest first. */
  events: AccountEvent[];
  wallet: WalletSummary;
  feeds: FeedStatus[];
  activeAccountId: string | null;

  bootstrap(): Promise<void>;
  apply(msg: ServerMessage): void;
  setConnected(connected: boolean): void;
  setActiveAccount(id: string | null): void;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
}

const EMPTY_WALLET: WalletSummary = { balance: 0, deposited: 0, withdrawn: 0, feesPaid: 0, payouts: 0, net: 0, monthSpent: 0, monthBudget: null };

function pickActive(accounts: Record<string, Account>, preferred: string | null): string | null {
  if (preferred && accounts[preferred] && !accounts[preferred].archived) return preferred;
  const list = Object.values(accounts).filter((a) => !a.archived);
  const active = list.filter((a) => a.status === 'active').sort((a, b) => b.createdAt - a.createdAt);
  return active[0]?.id ?? list.sort((a, b) => b.createdAt - a.createdAt)[0]?.id ?? null;
}

export const useApp = create<AppState>((set, get) => ({
  status: 'loading',
  error: null,
  connected: false,
  serverOffset: 0,
  version: '',
  localTz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  settings: DEFAULT_SETTINGS,
  instruments: [],
  instrumentMap: {},
  presets: [],
  accounts: {},
  snapshots: {},
  positions: {},
  orders: {},
  openTrades: {},
  recentFills: [],
  recentTrades: [],
  events: [],
  wallet: EMPTY_WALLET,
  feeds: [],
  activeAccountId: null,

  async bootstrap() {
    try {
      const b = await api.bootstrap();
      const accounts = Object.fromEntries(b.accounts.map((a) => [a.id, a]));
      useMarket.getState().applyQuotes(b.quotes);
      set((s) => ({
        status: 'ready',
        error: null,
        serverOffset: b.serverTime - Date.now(),
        version: b.version,
        localTz: b.localTz,
        settings: b.settings,
        instruments: b.instruments,
        instrumentMap: Object.fromEntries(b.instruments.map((i) => [i.symbol, i])),
        presets: b.presets,
        accounts,
        snapshots: Object.fromEntries(b.snapshots.map((x) => [x.accountId, x])),
        positions: Object.fromEntries(b.positions.map((p) => [positionKey(p.accountId, p.symbol), p])),
        orders: Object.fromEntries(b.orders.filter((o) => o.status === 'working').map((o) => [o.id, o])),
        openTrades: Object.fromEntries(b.openTrades.map((t) => [t.id, t])),
        events: b.events,
        wallet: b.wallet,
        feeds: b.feeds,
        activeAccountId: pickActive(accounts, s.activeAccountId ?? b.settings.activeAccountId),
      }));
    } catch (e) {
      set({ status: get().status === 'ready' ? 'ready' : 'error', error: errorMessage(e) });
      throw e;
    }
  },

  apply(msg) {
    switch (msg.type) {
      case 'hello':
      case 'pong':
        set({ serverOffset: msg.serverTime - Date.now() });
        return;
      case 'account':
        set((s) => {
          const accounts = { ...s.accounts, [msg.account.id]: msg.account };
          return { accounts, activeAccountId: s.activeAccountId && accounts[s.activeAccountId] ? s.activeAccountId : pickActive(accounts, null) };
        });
        return;
      case 'snapshot':
        set((s) => ({ snapshots: { ...s.snapshots, [msg.snapshot.accountId]: msg.snapshot } }));
        return;
      case 'order':
        set((s) => {
          const orders = { ...s.orders };
          if (msg.order.status === 'working') orders[msg.order.id] = msg.order;
          else delete orders[msg.order.id];
          return { orders };
        });
        return;
      case 'position':
        set((s) => ({ positions: { ...s.positions, [positionKey(msg.position.accountId, msg.position.symbol)]: msg.position } }));
        return;
      case 'position_closed':
        set((s) => {
          const positions = { ...s.positions };
          delete positions[positionKey(msg.accountId, msg.symbol)];
          return { positions };
        });
        return;
      case 'fill':
        set((s) => ({ recentFills: [msg.fill, ...s.recentFills.filter((f) => f.id !== msg.fill.id)].slice(0, MAX_RECENT) }));
        return;
      case 'trade':
        set((s) => {
          const openTrades = { ...s.openTrades };
          if (msg.trade.status === 'open') {
            openTrades[msg.trade.id] = msg.trade;
            return { openTrades };
          }
          delete openTrades[msg.trade.id];
          return { openTrades, recentTrades: [msg.trade, ...s.recentTrades.filter((t) => t.id !== msg.trade.id)].slice(0, MAX_RECENT) };
        });
        return;
      case 'event':
        set((s) => ({ events: [msg.event, ...s.events.filter((e) => e.id !== msg.event.id)].slice(0, MAX_RECENT) }));
        return;
      case 'wallet':
        set({ wallet: msg.wallet });
        return;
      case 'settings':
        set({ settings: msg.settings });
        return;
      case 'feeds':
        set({ feeds: msg.feeds });
        return;
      case 'quotes':
        useMarket.getState().applyQuotes(msg.quotes);
        return;
      case 'candle':
        return;
    }
  },

  setConnected(connected) {
    set({ connected });
  },

  setActiveAccount(id) {
    set({ activeAccountId: id });
    api.updateSettings({ activeAccountId: id }).catch(() => {});
  },

  async updateSettings(patch) {
    const prev = get().settings;
    set({ settings: { ...prev, ...patch, tilt: patch.tilt ? { ...prev.tilt, ...patch.tilt } : prev.tilt } });
    try {
      const settings = await api.updateSettings(patch);
      set({ settings });
      return settings;
    } catch (e) {
      set({ settings: prev });
      throw e;
    }
  },
}));

/** Current time corrected to the server clock. */
export function serverNow(): number {
  return Date.now() + useApp.getState().serverOffset;
}
