// PropDesk server entry point.
//   PROPDESK_PORT        default 4777 (bound to 127.0.0.1)
//   PROPDESK_DATA_DIR    default ~/.local/share/propdesk (propdesk.db)
//   PROPDESK_FAKE_MARKET=1  simulated random-walk market instead of the live feeds
//   PROPDESK_LOG_LEVEL   debug | info | warn | error | silent

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { INSTRUMENTS } from '../../shared/instruments.ts';
import { createLogger } from './log.ts';
import { createFakeMarketHub } from './market/fake.ts';
import { createMarketHub } from './market/index.ts';
import { startServer } from './server.ts';
import { VERSION } from './version.ts';

const log = createLogger();

const portEnv = Number(process.env.PROPDESK_PORT);
const port = Number.isInteger(portEnv) && portEnv > 0 && portEnv < 65536 ? portEnv : 4777;
const dataDir = process.env.PROPDESK_DATA_DIR || join(homedir(), '.local', 'share', 'propdesk');
mkdirSync(dataDir, { recursive: true });

const fake = process.env.PROPDESK_FAKE_MARKET === '1';
const market = fake
  ? createFakeMarketHub({ instruments: INSTRUMENTS, randomWalk: true })
  : createMarketHub({ instruments: INSTRUMENTS, log: log.child('market'), cacheDir: join(dataDir, 'cache') });

let server: Awaited<ReturnType<typeof startServer>>;
try {
  server = await startServer({ port, host: '127.0.0.1', dataDir, market, log, orderBook: !fake });
} catch (err) {
  log.error('PropDesk failed to start: %s', err instanceof Error ? err.message : String(err));
  process.exit(1);
}
log.info(`PropDesk ${VERSION} on ${server.url} · data ${dataDir}${fake ? ' · simulated market' : ''}`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) process.exit(1); // second signal: force
  shuttingDown = true;
  log.info(`${signal} received — saving state and shutting down`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  try {
    await server.close();
  } catch (err) {
    log.error('shutdown failed: %s', err instanceof Error ? err.message : String(err));
  }
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
