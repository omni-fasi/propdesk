// Small leveled logger (implements the Logger interface consumed by the market layer).
// Level from PROPDESK_LOG_LEVEL: debug | info | warn | error | silent (default info).

import { format } from 'node:util';
import type { Logger } from './market/types.ts';

export type { Logger } from './market/types.ts';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function parseLevel(v: string | undefined): LogLevel {
  const l = (v ?? '').trim().toLowerCase();
  return l in RANK ? (l as LogLevel) : 'info';
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Prefix shown after the level, e.g. 'engine'. */
  name?: string;
  /** Output sink (defaults to stdout for debug/info, stderr for warn/error). */
  write?: (line: string, level: Exclude<LogLevel, 'silent'>) => void;
}

export function createLogger(opts: LoggerOptions = {}): Logger & { child(name: string): Logger; level: LogLevel } {
  const level = opts.level ?? parseLevel(process.env.PROPDESK_LOG_LEVEL);
  const min = RANK[level];
  const write =
    opts.write ??
    ((line: string, l: Exclude<LogLevel, 'silent'>) => {
      (l === 'warn' || l === 'error' ? process.stderr : process.stdout).write(line + '\n');
    });

  const emit = (l: Exclude<LogLevel, 'silent'>, msg: string, args: unknown[]) => {
    if (RANK[l] < min) return;
    const tag = l.toUpperCase().padEnd(5);
    const name = opts.name ? ` [${opts.name}]` : '';
    write(`${new Date().toISOString()} ${tag}${name} ${args.length ? format(msg, ...args) : msg}`, l);
  };

  return {
    level,
    debug: (msg, ...args) => emit('debug', msg, args),
    info: (msg, ...args) => emit('info', msg, args),
    warn: (msg, ...args) => emit('warn', msg, args),
    error: (msg, ...args) => emit('error', msg, args),
    child: (name: string) => createLogger({ level, write, name: opts.name ? `${opts.name}:${name}` : name }),
  };
}

/** A logger that discards everything (tests). */
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
