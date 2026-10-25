// WebSocket client: keeps the store in sync, re-bootstraps after reconnects, routes moments to the bus.

import { useEffect } from 'react';
import type { ClientMessage, ServerMessage } from '@shared/api';
import { useApp } from '@/store/app';
import { bus } from './bus';

/** After a reconnect (e.g. the service restarted after an update), reload if a newer web build is being served. */
async function reloadIfNewBuild(): Promise<void> {
  try {
    const html = await (await fetch('/', { cache: 'no-store' })).text();
    const served = html.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
    const running = [...document.scripts].map((s) => s.getAttribute('src')).find((src) => src?.startsWith('/assets/index-'));
    if (served && running && served !== running) location.reload();
  } catch {
    // Offline or dev server: nothing to do.
  }
}

class Socket {
  private ws: WebSocket | null = null;
  private retries = 0;
  private everOpened = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private subscribeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Quote interest per owner (component); the union is sent to the server. */
  private owners = new Map<string, string[]>();
  private chartSymbol: string | null = null;
  private bookSymbol: string | null = null;
  private sentSymbols = '';
  latencyMs: number | null = null;

  connect(): void {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      this.sentSymbols = '';
      useApp.getState().setConnected(true);
      bus.emit('connection', { connected: true });
      this.flushSubscriptions();
      this.send({ type: 'chart', symbol: this.chartSymbol });
      if (this.bookSymbol) this.send({ type: 'book', symbol: this.bookSymbol });
      this.startPing();
      if (this.everOpened) {
        void reloadIfNewBuild();
        useApp
          .getState()
          .bootstrap()
          .then(() => bus.emit('resynced', undefined))
          .catch(() => {});
      }
      this.everOpened = true;
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPing();
      useApp.getState().setConnected(false);
      bus.emit('connection', { connected: false });
      const delay = Math.min(10_000, 500 * 2 ** this.retries++);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  private handle(msg: ServerMessage): void {
    const app = useApp.getState();
    if (msg.type === 'pong') this.latencyMs = Date.now() - msg.t;
    app.apply(msg);
    switch (msg.type) {
      case 'candle':
        bus.emit('candle', { symbol: msg.symbol, candle: msg.candle });
        break;
      case 'book':
        bus.emit('book', msg.frame);
        break;
      case 'book_row':
        bus.emit('bookRow', { symbol: msg.symbol, row: msg.row });
        break;
      case 'fill':
        bus.emit('fill', msg.fill);
        break;
      case 'trade':
        bus.emit('trade', msg.trade);
        if (msg.trade.status === 'closed') bus.emit('tradeClosed', msg.trade);
        break;
      case 'order':
        bus.emit('order', msg.order);
        break;
      case 'event':
        bus.emit('event', msg.event);
        break;
      case 'position':
        bus.emit('position', msg.position);
        break;
      case 'position_closed':
        bus.emit('positionClosed', { accountId: msg.accountId, symbol: msg.symbol, tradeId: msg.tradeId });
        break;
      case 'snapshot':
        bus.emit('snapshot', msg.snapshot);
        break;
    }
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.send({ type: 'ping', t: Date.now() }), 15_000);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private flushSubscriptions(): void {
    const all = new Set<string>();
    for (const list of this.owners.values()) for (const s of list) all.add(s);
    if (this.chartSymbol) all.add(this.chartSymbol);
    const symbols = [...all].sort();
    const key = symbols.join(',');
    if (key === this.sentSymbols) return;
    this.sentSymbols = key;
    this.send({ type: 'subscribe', symbols });
  }

  private scheduleFlush(): void {
    if (this.subscribeTimer) return;
    this.subscribeTimer = setTimeout(() => {
      this.subscribeTimer = null;
      this.flushSubscriptions();
    }, 50);
  }

  /** Declare the symbols `owner` needs live quotes for (replaces its previous list). */
  setQuoteSymbols(owner: string, symbols: string[]): void {
    this.owners.set(owner, symbols);
    this.scheduleFlush();
  }

  clearQuoteSymbols(owner: string): void {
    this.owners.delete(owner);
    this.scheduleFlush();
  }

  /** Symbol whose live 1m candles the chart wants (bus 'candle' events). */
  setChartSymbol(symbol: string | null): void {
    if (symbol === this.chartSymbol) return;
    this.chartSymbol = symbol;
    this.send({ type: 'chart', symbol });
    this.scheduleFlush();
  }

  /** Symbol whose live order book the heatmap wants (bus 'book' / 'bookRow' events), or null. */
  setBookSymbol(symbol: string | null): void {
    if (symbol === this.bookSymbol) return;
    this.bookSymbol = symbol;
    this.send({ type: 'book', symbol });
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}

export const socket = new Socket();

/** Keep live quotes flowing for `symbols` while the component is mounted. */
export function useQuoteSubscription(owner: string, symbols: string[]): void {
  const key = [...new Set(symbols)].sort().join(',');
  useEffect(() => {
    socket.setQuoteSymbols(owner, key ? key.split(',') : []);
    return () => socket.clearQuoteSymbols(owner);
  }, [owner, key]);
}
