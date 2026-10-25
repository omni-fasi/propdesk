// Test harness: fake market hub + controllable clock + in-memory (or file) store + engine.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountEvent, AccountRules, Order, Settings } from '../../shared/types.ts';
import type { PlaceOrderRequest } from '../../shared/api.ts';
import { INSTRUMENTS } from '../../shared/instruments.ts';
import { zonedTimeToUtc } from '../../shared/time.ts';
import { createFakeMarketHub, type FakeMarketHub } from '../src/market/fake.ts';
import { Store } from '../src/store.ts';
import { Engine } from '../src/engine/engine.ts';
import type { EngineEvent } from '../src/engine/events.ts';
import { EngineError } from '../src/engine/errors.ts';

export const NY = 'America/New_York';
export const ny = (y: number, mo: number, d: number, h: number, mi = 0) => zonedTimeToUtc(y, mo, d, h, mi, NY);
/** Wednesday 2026-10-21 10:00 ET: CME open, trading day '2026-10-21' with the 17:00 NY rollover. */
export const WED_10 = ny(2026, 10, 21, 10);
export const MIN = 60_000;
export const HOUR = 3_600_000;

/** Custom evaluation rules with sane defaults (static $2,000 max loss, NY 17:00 rollover, no other rules). */
export function rules(over: Partial<AccountRules> = {}): AccountRules {
  return {
    startingBalance: 50_000,
    profitTarget: 3_000,
    maxLoss: { amount: 2_000, mode: 'static', lockAt: null },
    dailyLoss: null,
    minTradingDays: 0,
    maxCalendarDays: null,
    consistencyPct: null,
    maxContracts: null,
    leverage: null,
    allowedClasses: null,
    flatBy: null,
    noWeekendHolding: false,
    rollover: { hour: 17, minute: 0, tz: NY },
    ...over,
  };
}

export interface Harness {
  clock: { t: number };
  market: FakeMarketHub;
  store: Store;
  engine: Engine;
  /** Every engine notification since setup (or the last clear). */
  seen: EngineEvent[];
  events(kind?: AccountEvent['kind']): AccountEvent[];
  /** Push a quote (last defaults to the bid) at the current clock. */
  quote(symbol: string, bid: number, ask: number, last?: number): void;
  /** Move the clock forward and run one scheduler tick. */
  advance(ms: number): void;
  /** Jump the clock to `t` and tick. */
  at(t: number): void;
  practice(balance?: number): string;
  custom(r?: Partial<AccountRules>, fee?: number): string;
  order(accountId: string, req: Partial<PlaceOrderRequest> & Pick<PlaceOrderRequest, 'symbol' | 'side'>): Order;
  close(): void;
}

export interface SetupOptions {
  t?: number;
  /** File database path (persistence tests); default in-memory. */
  dbPath?: string;
  /** Initial wallet deposit (default 10,000). */
  wallet?: number;
  /** Settings overrides. The tilt guard is OFF by default in tests unless set here. */
  settings?: Partial<Settings>;
  localTz?: string;
  market?: FakeMarketHub;
  clock?: { t: number };
}

export async function setup(o: SetupOptions = {}): Promise<Harness> {
  const clock = o.clock ?? { t: o.t ?? WED_10 };
  const now = () => clock.t;
  const market = o.market ?? createFakeMarketHub({ instruments: INSTRUMENTS, now });
  const store = new Store(o.dbPath ?? ':memory:');
  const engine = new Engine({ store, market, now, localTz: o.localTz ?? 'America/Toronto' });
  await engine.start({ scheduler: false });
  const seen: EngineEvent[] = [];
  engine.on((ev) => seen.push(ev));
  const fresh = !store.getMeta('test_initialized');
  if (fresh) {
    store.setMeta('test_initialized', '1');
    engine.updateSettings({ tilt: { enabled: false }, ...o.settings });
    if ((o.wallet ?? 10_000) > 0) engine.deposit({ amount: o.wallet ?? 10_000 });
  } else if (o.settings) {
    engine.updateSettings(o.settings);
  }

  const h: Harness = {
    clock,
    market,
    store,
    engine,
    seen,
    events: (kind) =>
      seen.flatMap((ev) => (ev.type === 'event' && (!kind || ev.event.kind === kind) ? [ev.event] : [])),
    quote(symbol, bid, ask, last) {
      market.push(symbol, { bid, ask, last: last ?? bid, ts: clock.t });
    },
    advance(ms) {
      clock.t += ms;
      engine.tick();
    },
    at(t) {
      clock.t = t;
      engine.tick();
    },
    practice(balance = 50_000) {
      return engine.createAccount({ kind: 'practice', startingBalance: balance }).id;
    },
    custom(r = {}, fee = 0) {
      return engine.createAccount({ kind: 'evaluation', rules: rules(r), fee }).id;
    },
    order(accountId, req) {
      return engine.placeOrder({ accountId, type: 'market', qty: 1, ...req } as PlaceOrderRequest);
    },
    close() {
      engine.stop();
      store.close();
    },
  };
  return h;
}

/** Assert that fn throws an EngineError with `code` (and optionally a message matching `re`). */
export function expectCode(fn: () => unknown, code: string, re?: RegExp): EngineError {
  try {
    fn();
  } catch (err) {
    if (!(err instanceof EngineError)) throw err;
    if (err.code !== code) throw new Error(`expected code ${code}, got ${err.code}: ${err.message}`);
    if (re && !re.test(err.message)) throw new Error(`message "${err.message}" does not match ${re}`);
    return err;
  }
  throw new Error(`expected an EngineError ${code}, nothing was thrown`);
}

export function tempDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'propdesk-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Round to cents for comparisons. */
export const c2 = (x: number) => Math.round(x * 100) / 100;
