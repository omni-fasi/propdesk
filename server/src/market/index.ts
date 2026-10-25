// PLACEHOLDER — replaced by the market-data implementation (Binance + Yahoo providers).
// Until then the server runs on the simulated random-walk hub.

import type { MarketHub, MarketHubOptions } from './types.ts';
import { createFakeMarketHub } from './fake.ts';

export type { MarketHub, MarketHubOptions } from './types.ts';

export function createMarketHub(opts: MarketHubOptions): MarketHub {
  opts.log.warn('market: using simulated random-walk data (real providers not implemented yet)');
  return createFakeMarketHub({ instruments: opts.instruments, randomWalk: true });
}
