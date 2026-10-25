// Per-symbol order-ticket preferences in localStorage (size, size mode, SL/TP distances).
// Absolute bracket prices go stale, so they are stored as tick distances and restored in distance mode.

import type { InstrumentSpec, Quote } from '@shared/types';
import { roundQty } from '@shared/risk';
import { bracketPrice, bracketTicks, entryRef, ticksToUnits, type BracketInput, type BracketMode, type SizeMode, type TicketDraft } from './riskMath';

// v2: sizing by $ value became the default for perps — older per-symbol prefs are ignored.
const KEY = (symbol: string) => `propdesk.ticket.v2.${symbol}`;

interface StoredBracket {
  on: boolean;
  mode: BracketMode;
  ticks: number | null;
  usd: number | null;
}

interface StoredPrefs {
  qty: number | null;
  sizeMode: SizeMode;
  value?: number | null;
  risk: number | null;
  sl: StoredBracket;
  tp: StoredBracket;
}

export interface LoadedPrefs {
  qty: number | null;
  sizeMode: SizeMode;
  value: number | null;
  risk: number | null;
  sl: BracketInput;
  tp: BracketInput;
  /** No stored distances: fill sensible SL/TP distances once a price is known. */
  needsDefaults: boolean;
}

function read(symbol: string): StoredPrefs | null {
  try {
    const raw = localStorage.getItem(KEY(symbol));
    if (!raw) return null;
    const p = JSON.parse(raw) as StoredPrefs;
    return p && typeof p === 'object' && p.sl && p.tp ? p : null;
  } catch {
    return null;
  }
}

function restore(spec: InstrumentSpec, b: StoredBracket | undefined, fallbackOn: boolean): BracketInput {
  if (!b) return { on: fallbackOn, mode: 'dist', value: null };
  if (b.mode === 'usd' && b.usd != null) return { on: b.on, mode: 'usd', value: b.usd };
  return { on: b.on, mode: 'dist', value: b.ticks != null ? ticksToUnits(spec, b.ticks) : null };
}

export function loadPrefs(spec: InstrumentSpec): LoadedPrefs {
  const p = read(spec.symbol);
  if (!p) {
    // Futures and forex are traded in contracts / lots; everything else is easiest to size in dollars.
    const byValue = spec.assetClass !== 'futures' && spec.assetClass !== 'forex';
    return {
      qty: spec.defaultQty,
      sizeMode: byValue ? 'value' : 'qty',
      value: byValue ? 5_000 : null,
      risk: null,
      sl: { on: true, mode: 'dist', value: null },
      tp: { on: true, mode: 'dist', value: null },
      needsDefaults: true,
    };
  }
  const sl = restore(spec, p.sl, true);
  const tp = restore(spec, p.tp, true);
  return {
    qty: p.qty != null && p.qty > 0 ? roundQty(spec, p.qty) || spec.minQty : spec.defaultQty,
    sizeMode: p.sizeMode === 'risk' || p.sizeMode === 'value' ? p.sizeMode : 'qty',
    value: p.value != null && p.value > 0 ? p.value : null,
    risk: p.risk != null && p.risk > 0 ? p.risk : null,
    sl: p.sizeMode === 'risk' && sl.mode === 'usd' ? { ...sl, mode: 'dist', value: null } : sl,
    tp,
    needsDefaults: sl.value == null && tp.value == null,
  };
}

function toStored(spec: InstrumentSpec, kind: 'sl' | 'tp', t: TicketDraft, quote: Quote | undefined, prev: StoredBracket | undefined): StoredBracket {
  const input = kind === 'sl' ? t.sl : t.tp;
  if (input.mode === 'usd') return { on: input.on, mode: 'usd', ticks: prev?.ticks ?? null, usd: input.value };
  const entry = entryRef(t.type, t.side, t.price, quote);
  const price = bracketPrice(spec, kind, { ...input, on: true }, t.side, entry, t.qty ?? spec.minQty);
  const ticks = bracketTicks(spec, price, entry);
  return { on: input.on, mode: 'dist', ticks: ticks ?? prev?.ticks ?? null, usd: prev?.usd ?? null };
}

export function savePrefs(spec: InstrumentSpec, t: TicketDraft, quote: Quote | undefined): void {
  try {
    const prev = read(spec.symbol);
    const stored: StoredPrefs = {
      qty: t.qty,
      sizeMode: t.sizeMode,
      value: t.value,
      risk: t.risk,
      sl: toStored(spec, 'sl', t, quote, prev?.sl),
      tp: toStored(spec, 'tp', t, quote, prev?.tp),
    };
    localStorage.setItem(KEY(spec.symbol), JSON.stringify(stored));
  } catch {
    // Storage unavailable (private mode, quota): preferences are a convenience only.
  }
}

/**
 * First-time SL/TP distances (1 : 2 on the tick grid): ~0.1 % of price for futures / forex (cheap per-contract
 * fees), ~0.5 % for perps — they pay 0.05 % of the position value per side, so tighter levels barely cover fees.
 */
export function defaultDistances(spec: InstrumentSpec, price: number): { sl: number; tp: number } {
  const pct = spec.commission.kind === 'percent' ? 0.005 : 0.001;
  const slTicks = Math.max(4, Math.round((price * pct) / spec.tickSize));
  return { sl: ticksToUnits(spec, slTicks), tp: ticksToUnits(spec, slTicks * 2) };
}

// Small typed localStorage helpers for UI conveniences (panel sizes, toggles).
export function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}
