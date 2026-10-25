// Reconnecting WebSocket client (exponential backoff + jitter, connect timeout) over an injectable socket factory.

import WebSocketClient from 'ws';
import type { Clock, TimerHandle } from './clock.ts';
import { errorMessage } from './http.ts';
import type { Logger } from './types.ts';

/** The subset of the WHATWG WebSocket API used here: Node's global WebSocket, the `ws` package, or a test double. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  /** Drop the TCP connection without waiting for the close handshake (`ws` has it; WHATWG sockets do not). */
  terminate?(): void;
}

export type SocketFactory = (url: string, headers?: Record<string, string>) => SocketLike;

/**
 * The `ws` client: like the built-in WebSocket it takes custom headers, and it can terminate() — the
 * built-in one keeps the process alive for up to ~15 s after close() waiting for the server's close frame.
 */
export const defaultSocketFactory: SocketFactory = (url, headers) =>
  new WebSocketClient(url, { headers, perMessageDeflate: false }) as unknown as SocketLike;

/** Node's built-in (undici) WebSocket; it accepts non-standard `{ headers }` as the second argument. */
export const builtinSocketFactory: SocketFactory = (url, headers) => {
  const ws = new WebSocket(url, headers ? { headers } : undefined);
  ws.binaryType = 'arraybuffer';
  return ws as unknown as SocketLike;
};

function closeSocket(ws: SocketLike, code: number, reason: string): void {
  try {
    if (typeof ws.terminate === 'function') ws.terminate();
    else ws.close(code, reason);
  } catch {
    // already closed
  }
}

export type SocketState = 'idle' | 'connecting' | 'open' | 'waiting' | 'stopped';

export interface CloseInfo {
  wasOpen: boolean;
  code: number | null;
  reason: string;
  lastMessageAt: number | null;
  openedAt: number | null;
}

export interface ReconnectingSocketOptions {
  name: string;
  url: string;
  headers?: Record<string, string>;
  clock: Clock;
  log: Logger;
  factory: SocketFactory;
  connectTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** A connection that stayed open this long resets the backoff. */
  stableMs?: number;
  random?: () => number;
  /** Asked after a close: false parks the socket idle until ensure() (e.g. nothing is subscribed). */
  wanted?: () => boolean;
  onOpen?: () => void;
  onMessage: (text: string) => void;
  onClose?: (info: CloseInfo) => void;
}

const decoder = new TextDecoder();
const noop = () => {};

function toText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return decoder.decode(data);
  if (ArrayBuffer.isView(data)) return decoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return String(data);
}

function describeError(ev: unknown): string {
  const e = ev as { message?: unknown; error?: unknown } | null;
  if (e && typeof e.message === 'string' && e.message) return e.message;
  if (e && e.error instanceof Error) return e.error.message;
  return 'socket error';
}

export class ReconnectingSocket {
  state: SocketState = 'idle';
  openedAt: number | null = null;
  lastMessageAt: number | null = null;
  lastError: string | null = null;
  /** When the connection was lost; null while open and before the first attempt. */
  downSince: number | null = null;
  /** Consecutive failed attempts; reset by a connection that stayed up for stableMs. */
  failures = 0;
  everOpened = false;

  private readonly o: ReconnectingSocketOptions & Required<Pick<ReconnectingSocketOptions, 'connectTimeoutMs' | 'minBackoffMs' | 'maxBackoffMs' | 'stableMs' | 'random'>>;
  private ws: SocketLike | null = null;
  private timer: TimerHandle | null = null;
  private connectTimer: TimerHandle | null = null;
  private running = false;

  constructor(opts: ReconnectingSocketOptions) {
    this.o = {
      connectTimeoutMs: 15_000,
      minBackoffMs: 1_000,
      maxBackoffMs: 60_000,
      stableMs: 30_000,
      random: Math.random,
      ...opts,
    };
  }

  get isOpen(): boolean {
    return this.state === 'open';
  }

  /** Connect now and keep reconnecting until stop(). */
  start(): void {
    this.running = true;
    if (this.state === 'idle' || this.state === 'stopped') this.connect();
  }

  /** Reconnect a socket that was parked idle because it was not wanted. */
  ensure(): void {
    if (this.running && this.state === 'idle') this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
    const ws = this.ws;
    this.detach();
    if (ws) closeSocket(ws, 1000, 'stop');
    this.state = 'stopped';
    this.openedAt = null;
  }

  send(text: string): boolean {
    if (!this.ws || this.state !== 'open') return false;
    try {
      this.ws.send(text);
      return true;
    } catch (e) {
      this.lastError = errorMessage(e);
      return false;
    }
  }

  /** Drop the current connection (if any) and connect again right away. */
  reconnect(reason: string): void {
    if (!this.running) return;
    if (this.state === 'idle' && this.o.wanted && !this.o.wanted()) return;
    if (this.state === 'waiting' || this.state === 'idle') {
      this.clearTimers();
      this.connect();
      return;
    }
    if (this.state !== 'open' && this.state !== 'connecting') return;
    this.o.log.info(`[${this.o.name}] reconnecting: ${reason}`);
    const ws = this.ws;
    this.handleClose(null, reason, true);
    if (ws) closeSocket(ws, 4000, reason.slice(0, 100));
  }

  private connect(): void {
    if (!this.running) return;
    this.state = 'connecting';
    let ws: SocketLike;
    try {
      ws = this.o.factory(this.o.url, this.o.headers);
    } catch (e) {
      this.lastError = errorMessage(e);
      this.handleClose(null, this.lastError);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.clearConnectTimer();
      const recovered = this.failures > 0 || this.downSince != null;
      this.state = 'open';
      this.everOpened = true;
      this.openedAt = this.o.clock.now();
      this.downSince = null;
      this.lastError = null;
      if (recovered) this.o.log.info(`[${this.o.name}] connected`);
      else this.o.log.debug(`[${this.o.name}] connected`);
      try {
        this.o.onOpen?.();
      } catch (e) {
        this.o.log.error(`[${this.o.name}] open handler failed: ${errorMessage(e)}`);
      }
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastMessageAt = this.o.clock.now();
      let text: string;
      try {
        text = toText(ev.data);
      } catch {
        return;
      }
      try {
        this.o.onMessage(text);
      } catch (e) {
        this.o.log.warn(`[${this.o.name}] message handler failed: ${errorMessage(e)}`);
      }
    };
    ws.onerror = (ev) => {
      if (this.ws !== ws) return;
      this.lastError = describeError(ev);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.handleClose(ev?.code ?? null, ev?.reason ?? '');
    };
    this.connectTimer = this.o.clock.setTimeout(() => {
      this.connectTimer = null;
      if (this.ws !== ws || this.state !== 'connecting') return;
      this.lastError = 'connect timeout';
      this.handleClose(null, 'connect timeout');
      closeSocket(ws, 1000, 'timeout');
    }, this.o.connectTimeoutMs);
  }

  private handleClose(code: number | null, reason: string, immediate = false): void {
    const now = this.o.clock.now();
    const wasOpen = this.state === 'open';
    const info: CloseInfo = { wasOpen, code, reason, lastMessageAt: this.lastMessageAt, openedAt: this.openedAt };
    this.detach();
    this.clearConnectTimer();
    if (wasOpen) {
      const stable = this.openedAt != null && now - this.openedAt >= this.o.stableMs;
      this.failures = stable ? 0 : this.failures + 1;
      this.downSince = now;
    } else {
      this.failures++;
      if (this.downSince == null) this.downSince = now;
    }
    this.openedAt = null;
    try {
      this.o.onClose?.(info);
    } catch (e) {
      this.o.log.error(`[${this.o.name}] close handler failed: ${errorMessage(e)}`);
    }
    if (!this.running) {
      this.state = 'stopped';
      return;
    }
    if (this.o.wanted && !this.o.wanted()) {
      this.state = 'idle';
      return;
    }
    const delay = immediate ? 0 : this.backoff();
    const what = wasOpen ? `closed${code != null ? ` (${code}${reason ? ` ${reason}` : ''})` : ''}` : `connect failed (${this.lastError ?? (reason || 'error')})`;
    const msg = `[${this.o.name}] ${what} — retry in ${(delay / 1000).toFixed(1)} s`;
    if (immediate) {
      // reconnect() already logged the reason
    } else if (wasOpen || this.failures === 1 || this.failures % 10 === 0) this.o.log.warn(msg);
    else this.o.log.debug(msg);
    this.state = 'waiting';
    this.timer = this.o.clock.setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private backoff(): number {
    if (this.failures === 0) return this.o.minBackoffMs;
    const base = Math.min(this.o.maxBackoffMs, this.o.minBackoffMs * 2 ** (this.failures - 1));
    return Math.round(base * (0.8 + 0.4 * this.o.random()));
  }

  private detach(): void {
    const ws = this.ws;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    // Keep an error listener: the `ws` package throws on unhandled 'error' events.
    ws.onerror = noop;
    this.ws = null;
  }

  private clearConnectTimer(): void {
    if (this.connectTimer != null) this.o.clock.clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private clearTimers(): void {
    this.clearConnectTimer();
    if (this.timer != null) this.o.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}
