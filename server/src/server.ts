// Server assembly: database → engine → REST (/api) + WebSocket (/ws) + static web/dist.
// index.ts calls startServer(); tests boot it on port 0 with a temp data dir.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { createAdaptorServer } from '@hono/node-server';
import { Engine } from './engine/engine.ts';
import { createLogger } from './log.ts';
import { systemClock } from './market/clock.ts';
import { DepthService } from './market/depth.ts';
import { defaultSocketFactory } from './market/socket.ts';
import type { DepthSource, Logger, MarketHub } from './market/types.ts';
import { Store } from './store.ts';
import { createApi, errorResponse } from './api/rest.ts';
import { staticFiles } from './api/static.ts';
import { attachWebSocket } from './api/ws.ts';
import { TickRecorder } from './replay/recorder.ts';

export const DEFAULT_STATIC_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));

export interface StartServerOptions {
  /** Default 4777; 0 picks a free port. */
  port?: number;
  /** Default 127.0.0.1. */
  host?: string;
  /** Directory holding propdesk.db, or ':memory:' for a throwaway database. */
  dataDir: string;
  market: MarketHub;
  log?: Logger;
  /** Injectable clock for the engine. */
  now?: () => number;
  /** What 'local' means for rollovers (default: machine zone). */
  localTz?: string;
  /** Built web app to serve (default web/dist); null disables static serving. */
  staticDir?: string | null;
  /** Live Binance order books for the chart's liquidity heatmap (default false: tests, simulated market). */
  orderBook?: boolean;
  /** Run the engine's 1 s scheduler (default true). */
  scheduler?: boolean;
  /** Detect process suspend from late scheduler ticks (default true). */
  detectSuspend?: boolean;
}

export interface RunningServer {
  port: number;
  url: string;
  engine: Engine;
  store: Store;
  /** Stop accepting connections, persist state, stop the market hub and close the database. */
  close(): Promise<void>;
}

export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const log = opts.log ?? createLogger();
  const store = new Store(opts.dataDir === ':memory:' ? ':memory:' : join(opts.dataDir, 'propdesk.db'));
  const engine = new Engine({
    store,
    market: opts.market,
    log,
    now: opts.now,
    localTz: opts.localTz,
    detectSuspend: opts.detectSuspend ?? true,
  });
  try {
    await opts.market.start();
    await engine.start({ scheduler: opts.scheduler ?? true });
  } catch (err) {
    engine.stop();
    await opts.market.stop().catch(() => {});
    store.close();
    throw err;
  }

  const recorder = new TickRecorder({ market: opts.market, store, now: engine.now, activeSymbols: () => engine.positionSymbols(), log });
  recorder.start();

  // Order books are recorded for the watchlist (the heatmap's history) and for whatever a chart shows.
  let depth: DepthSource | null = null;
  let offDepthSettings = () => {};
  if (opts.orderBook) {
    depth = new DepthService({ clock: systemClock, log, fetch: globalThis.fetch, socketFactory: defaultSocketFactory, store });
    depth.setRecorded(engine.getSettings().watchlist);
    offDepthSettings = engine.on((ev) => {
      if (ev.type === 'settings') depth?.setRecorded(ev.settings.watchlist);
    });
    depth.start();
  }

  const startedAt = Date.now();
  const app = new Hono();
  app.onError((err, c) => errorResponse(c, err, log));
  app.route('/api', createApi({ engine, market: opts.market, depth, log, startedAt }));
  const staticDir = opts.staticDir === undefined ? DEFAULT_STATIC_DIR : opts.staticDir;
  if (staticDir) app.use('*', staticFiles(staticDir));
  app.notFound((c) =>
    c.req.path === '/api' || c.req.path.startsWith('/api/') ? c.json({ error: 'Not found', code: 'not_found' }, 404) : c.text('Not found', 404),
  );

  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  const ws = attachWebSocket(server, { engine, market: opts.market, depth, log });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port ?? 4777, opts.host ?? '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    ws.close();
    offDepthSettings();
    depth?.stop();
    recorder.stop();
    engine.stop();
    await opts.market.stop().catch(() => {});
    store.close();
    throw err;
  }
  const addr = server.address() as AddressInfo;
  const host = opts.host ?? '127.0.0.1';

  let closing: Promise<void> | null = null;
  return {
    port: addr.port,
    url: `http://${host.includes(':') ? `[${host}]` : host}:${addr.port}`,
    engine,
    store,
    close() {
      closing ??= (async () => {
        ws.close();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        offDepthSettings();
        depth?.stop();
        recorder.stop();
        engine.stop();
        await opts.market.stop().catch((err: unknown) => log.warn('market: stop failed: %s', String(err)));
        store.close();
      })();
      return closing;
    },
  };
}
