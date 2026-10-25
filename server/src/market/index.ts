// Market data entry point: real providers (Binance USDⓈ-M futures + Yahoo Finance) behind the MarketHub
// contract, or the simulated random-walk hub when PROPDESK_FAKE_MARKET=1.

import { createFakeMarketHub } from './fake.ts';
import { createHub } from './hub.ts';
import type { MarketHub, MarketHubOptions } from './types.ts';

export type { Logger, MarketGap, MarketHub, MarketHubOptions } from './types.ts';

export function createMarketHub(opts: MarketHubOptions): MarketHub {
  if (process.env.PROPDESK_FAKE_MARKET === '1') {
    opts.log.warn('market: PROPDESK_FAKE_MARKET=1, using simulated random-walk data');
    return createFakeMarketHub({ instruments: opts.instruments, randomWalk: true });
  }
  return createHub(opts);
}
