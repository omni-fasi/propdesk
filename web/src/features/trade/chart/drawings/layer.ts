// Drawing tools on the trade chart. The layer builds the scene its primitive paints, and turns pointer
// gestures into drawings: place with the armed tool (press-drag, or click then click for two-point tools),
// select, drag a handle or the whole drawing; Delete removes, Esc cancels. Drawings are anchored to time +
// price, so they follow panning / zooming and show on every timeframe. The magnet snaps points to the
// bar's open / high / low / close when the pointer is near one (handy for marking liquidity at highs / lows).

import type { Logical } from 'lightweight-charts';
import type { Drawing, DrawingKind, InstrumentSpec } from '@shared/types';
import { clampLevels, dist, distToSegment, inBox, isPositionKind, logicalToTime, positionLevels, timeToLogical, type Pt } from '@shared/drawings';
import { pnl, qtyForRisk, roundPrice } from '@shared/risk';
import { fmtMoney, fmtPct, fmtPrice, fmtQtyWithUnit } from '@/lib/format';
import { serverNow } from '@/store/app';
import { useTrade } from '../../store';
import { distUnit, qtyForValue, ticksToUnits } from '../../ticket/riskMath';
import type { Bar } from '../barAggregator';
import type { ChartController, ChartInteraction } from '../controller';
import { C } from '../theme';
import { DrawingsPrimitive, handlesOf, type AxisLabel, type Handle, type Scene, type SceneItem } from './render';
import { useDrawings } from './store';

const HANDLE_PX = 7;
const LINE_PX = 5;
const MAGNET_PX = 14;
/** A press that moves less than this is a click: two-point tools then wait for a second click. */
const CLICK_PX = 4;

interface Frame {
  /** x of bar index 0 and px per bar (lightweight-charts only maps whole indexes). */
  x0: number;
  spacing: number;
  bars: Bar[];
  tf: number;
  width: number;
  height: number;
}

interface At {
  logical: number;
  time: number;
  price: number;
}

interface Gesture {
  placing: boolean;
  handle: Handle | 'body';
  /** The drawing as shown while the gesture runs. */
  d: Drawing;
  orig: Drawing;
  start: { x: number; y: number } & At;
  moved: boolean;
  /** Two-point placement after a plain click: the second point follows the mouse until the next click. */
  waiting: boolean;
}

function isEditable(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
}

function fmtDist(spec: InstrumentSpec, diff: number): string {
  const u = distUnit(spec);
  if (u.short === 'pt') return fmtPrice(spec, Math.abs(diff));
  return `${ticksToUnits(spec, Math.round(Math.abs(diff) / spec.tickSize))} ${u.label.toLowerCase()}`;
}

/** Size the position tool prices its $ amounts at: the order ticket's sizing for this symbol. */
function positionQty(spec: InstrumentSpec, entry: number, sl: number): number {
  const t = useTrade.getState().ticket;
  if (t.symbol === spec.symbol) {
    if (t.sizeMode === 'risk' && t.risk) return qtyForRisk(spec, t.risk, entry, sl) || spec.minQty;
    if (t.sizeMode === 'value' && t.value) return qtyForValue(spec, t.value, entry) || spec.minQty;
    if (t.qty && t.qty > 0) return t.qty;
  }
  return spec.defaultQty;
}

export class DrawingLayer implements ChartInteraction {
  private readonly ctrl: ChartController;
  private readonly primitive: DrawingsPrimitive;
  private symbol = '';
  private spec: InstrumentSpec | null = null;
  private gesture: Gesture | null = null;
  private hoverId: string | null = null;
  private detach: Array<() => void> = [];

  constructor(ctrl: ChartController) {
    this.ctrl = ctrl;
    this.primitive = new DrawingsPrimitive(() => this.scene());
    ctrl.candles.attachPrimitive(this.primitive);
    ctrl.setInteraction(this);
    const redraw = () => this.primitive.update();
    this.detach.push(
      useDrawings.subscribe((s, p) => {
        if (s.tool !== p.tool && this.gesture?.placing) this.gesture = null;
        redraw();
      }),
      useTrade.subscribe((s, p) => {
        if (s.ticket !== p.ticket) redraw();
      }),
    );
    const onKey = (e: KeyboardEvent) => this.onKey(e);
    window.addEventListener('keydown', onKey);
    this.detach.push(() => window.removeEventListener('keydown', onKey));
  }

  destroy(): void {
    for (const d of this.detach) d();
    this.ctrl.setInteraction(null);
    try {
      this.ctrl.candles.detachPrimitive(this.primitive);
    } catch {
      // chart already gone
    }
  }

  setSymbol(symbol: string, spec: InstrumentSpec): void {
    if (symbol !== this.symbol) {
      this.gesture = null;
      this.hoverId = null;
      const st = useDrawings.getState();
      if (st.selectedId) st.select(null);
      void st.load(symbol);
    }
    this.symbol = symbol;
    this.spec = spec;
    this.primitive.update();
  }

  // ───────────────────────────── ChartInteraction ─────────────────────────────

  armed(): boolean {
    return useDrawings.getState().tool !== 'cursor' || !!this.gesture?.waiting;
  }

  busy(): boolean {
    return this.gesture != null;
  }

  down(x: number, y: number): boolean {
    const f = this.frame();
    if (!f) return false;
    const st = useDrawings.getState();
    if (this.gesture?.waiting) {
      this.move(x, y);
      this.finish();
      return true;
    }
    if (st.tool !== 'cursor') return this.place(st.tool, f, x, y);
    const hit = this.hit(f, x, y);
    if (!hit) {
      if (st.selectedId) st.select(null);
      return false;
    }
    st.select(hit.d.id);
    const at = this.at(f, x, y, false);
    if (at) this.gesture = { placing: false, handle: hit.handle, d: hit.d, orig: hit.d, start: { x, y, ...at }, moved: false, waiting: false };
    this.primitive.update();
    return true;
  }

  move(x: number, y: number): void {
    const g = this.gesture;
    const f = this.frame();
    if (!g || !f) return;
    if (!g.moved && Math.hypot(x - g.start.x, y - g.start.y) >= CLICK_PX) g.moved = true;
    if (!g.moved && !g.waiting) return;
    const next = this.edit(g, f, x, y);
    if (next) {
      g.d = next;
      this.primitive.update();
    }
  }

  up(): void {
    const g = this.gesture;
    if (!g || g.waiting) return;
    if (g.placing && !g.moved && (g.d.kind === 'trendline' || g.d.kind === 'rect')) {
      g.waiting = true;
      return;
    }
    this.finish();
  }

  cancel(): void {
    if (!this.gesture) return;
    this.gesture = null;
    this.primitive.update();
  }

  hover(x: number, y: number): string | null {
    if (useDrawings.getState().tool !== 'cursor') {
      this.setHover(null);
      return 'crosshair';
    }
    const f = this.frame();
    const hit = f ? this.hit(f, x, y) : null;
    this.setHover(hit?.d.id ?? null);
    if (!hit) return null;
    if (hit.handle !== 'body') return 'pointer';
    return hit.d.kind === 'hline' ? 'ns-resize' : 'move';
  }

  leave(): void {
    this.setHover(null);
  }

  // ───────────────────────────── gestures ─────────────────────────────

  private place(kind: DrawingKind, f: Frame, x: number, y: number): boolean {
    const at = this.at(f, x, y, useDrawings.getState().magnet);
    if (!at) return false;
    const now = serverNow();
    const p = { time: at.time, price: at.price };
    let d: Drawing = { id: crypto.randomUUID(), symbol: this.symbol, kind, points: [p], tp: null, sl: null, createdAt: now, updatedAt: now };
    let handle: Gesture['handle'] = 'p0';
    if (kind === 'trendline' || kind === 'rect') {
      d = { ...d, points: [p, { ...p }] };
      handle = 'p1';
    } else if (isPositionKind(kind)) {
      d = this.newPosition(d, f, at);
      handle = 'body';
    }
    this.gesture = { placing: true, handle, d, orig: d, start: { x, y, ...at }, moved: false, waiting: false };
    this.primitive.update();
    return true;
  }

  /** A new long / short: stop 8% of the visible price range away, target at 2R, about a quarter of the screen wide. */
  private newPosition(d: Drawing, f: Frame, at: At): Drawing {
    const spec = this.spec!;
    const top = this.ctrl.candles.coordinateToPrice(0) ?? at.price;
    const bottom = this.ctrl.candles.coordinateToPrice(f.height) ?? at.price;
    const risk = Math.min(Math.max(spec.tickSize, roundPrice(spec, Math.abs(top - bottom) * 0.08)), roundPrice(spec, at.price / 2));
    const dir = d.kind === 'long' ? 1 : -1;
    const width = Math.min(60, Math.max(8, Math.round(f.width / f.spacing / 4)));
    return {
      ...d,
      points: [
        { time: at.time, price: at.price },
        { time: logicalToTime(f.bars, f.tf, at.logical + width), price: at.price },
      ],
      tp: roundPrice(spec, at.price + dir * risk * 2),
      sl: roundPrice(spec, at.price - dir * risk),
    };
  }

  /** The gesture's drawing with the pointer at x, y. */
  private edit(g: Gesture, f: Frame, x: number, y: number): Drawing | null {
    const spec = this.spec!;
    const at = this.at(f, x, y, g.handle !== 'body' && useDrawings.getState().magnet);
    if (!at) return null;
    const o = g.orig;
    const pts = o.points.map((p) => ({ ...p }));
    const toL = (t: number) => timeToLogical(f.bars, f.tf, t);
    const toT = (l: number) => logicalToTime(f.bars, f.tf, l);
    switch (g.handle) {
      case 'body': {
        const dl = at.logical - g.start.logical;
        const dp = at.price - g.start.price;
        const shift = (p: number) => roundPrice(spec, p + dp);
        if (o.points.some((p) => shift(p.price) <= 0) || (o.sl != null && shift(o.sl) <= 0) || (o.tp != null && shift(o.tp) <= 0)) return null;
        return {
          ...o,
          points: o.points.map((p) => ({ time: o.kind === 'hline' ? p.time : toT(toL(p.time) + dl), price: shift(p.price) })),
          tp: o.tp == null ? null : shift(o.tp),
          sl: o.sl == null ? null : shift(o.sl),
        };
      }
      case 'p0':
        pts[0] = { time: at.time, price: at.price };
        break;
      case 'p1':
        pts[1] = { time: at.time, price: at.price };
        break;
      case 'c01':
        pts[0].time = at.time;
        pts[1].price = at.price;
        break;
      case 'c10':
        pts[1].time = at.time;
        pts[0].price = at.price;
        break;
      case 'entry':
      case 'tp':
      case 'sl': {
        if (!isPositionKind(o.kind) || o.tp == null || o.sl == null) return null;
        const entry = g.handle === 'entry' ? at.price : o.points[0].price;
        const lv = clampLevels(o.kind, entry, g.handle === 'tp' ? at.price : o.tp, g.handle === 'sl' ? at.price : o.sl, spec.tickSize);
        if (lv.sl <= 0) return null;
        const start = g.handle === 'entry' ? toT(Math.min(at.logical, Math.ceil(toL(o.points[1].time)) - 1)) : o.points[0].time;
        return { ...o, points: [{ time: start, price: entry }, { time: o.points[1].time, price: entry }], tp: roundPrice(spec, lv.tp), sl: roundPrice(spec, lv.sl) };
      }
      case 'end':
        pts[1] = { time: toT(Math.max(at.logical, Math.floor(toL(o.points[0].time)) + 1)), price: o.points[0].price };
        break;
    }
    return { ...o, points: pts };
  }

  private finish(): void {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    const st = useDrawings.getState();
    if (g.placing) {
      const [a, b] = g.d.points;
      // A two-point drawing needs two different points (a double click in place draws nothing).
      if (b && a.time === b.time && a.price === b.price) {
        this.primitive.update();
        return;
      }
      st.save({ ...g.d, updatedAt: serverNow() });
      st.setTool('cursor');
      st.select(g.d.id);
    } else if (g.moved && g.d !== g.orig) {
      st.save(g.d);
    }
    this.primitive.update();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || isEditable(e.target)) return;
    const st = useDrawings.getState();
    if (e.key === 'Escape') {
      // Like TradingView: Esc drops what is being drawn and puts the cursor back; then it deselects.
      if (this.gesture?.placing || st.tool !== 'cursor') {
        this.cancel();
        st.setTool('cursor');
      } else if (this.gesture) this.cancel();
      else if (st.selectedId) st.select(null);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && st.selectedId && !this.gesture) {
      const d = st.bySymbol[this.symbol]?.find((x) => x.id === st.selectedId);
      if (d) {
        e.preventDefault();
        st.remove(d);
      }
      return;
    }
    // TradingView's shortcuts: Alt+T trend line, Alt+H horizontal line, Alt+J horizontal ray, Alt+Shift+R rectangle.
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const tool = e.code === 'KeyT' ? 'trendline' : e.code === 'KeyH' ? 'hline' : e.code === 'KeyJ' ? 'hray' : e.code === 'KeyR' && e.shiftKey ? 'rect' : null;
      if (tool) {
        e.preventDefault();
        this.gesture = null;
        st.setTool(tool);
      }
    }
  }

  // ───────────────────────────── geometry ─────────────────────────────

  private frame(): Frame | null {
    const bars = this.ctrl.bars;
    if (!bars.length || !this.spec) return null;
    try {
      const ts = this.ctrl.chart.timeScale();
      const x0 = ts.logicalToCoordinate(0 as Logical);
      const x1 = ts.logicalToCoordinate(1 as Logical);
      if (x0 == null || x1 == null || x1 === x0) return null;
      const size = this.ctrl.chart.paneSize(0);
      return { x0, spacing: x1 - x0, bars, tf: this.ctrl.timeframeSec, width: size.width, height: size.height };
    } catch {
      return null;
    }
  }

  private yOf(price: number): number | null {
    return this.ctrl.candles.priceToCoordinate(price);
  }

  /** Bar and price under x, y (the time snaps to the nearest bar; the magnet snaps the price to its OHLC). */
  private at(f: Frame, x: number, y: number, magnet: boolean): At | null {
    const logical = Math.round((x - f.x0) / f.spacing);
    const raw = this.ctrl.candles.coordinateToPrice(y);
    if (raw == null || !Number.isFinite(raw)) return null;
    let price: number = raw;
    const bar = magnet ? f.bars[logical] : undefined;
    if (bar) {
      let best = MAGNET_PX;
      for (const v of [bar.open, bar.high, bar.low, bar.close]) {
        const vy = this.yOf(v);
        if (vy != null && Math.abs(vy - y) < best) {
          best = Math.abs(vy - y);
          price = v;
        }
      }
    }
    if (!(price > 0)) return null;
    return { logical, time: logicalToTime(f.bars, f.tf, logical), price: roundPrice(this.spec!, price) };
  }

  private project(f: Frame, d: Drawing, active: boolean, hover: boolean, withLabels: boolean): SceneItem | null {
    const ya = this.yOf(d.points[0].price);
    if (ya == null) return null;
    const xOf = (t: number) => f.x0 + timeToLogical(f.bars, f.tf, t) * f.spacing;
    const a = { x: xOf(d.points[0].time), y: ya };
    let b = a;
    if (d.points[1]) {
      const yb = this.yOf(d.points[1].price);
      if (yb == null) return null;
      b = { x: xOf(d.points[1].time), y: yb };
    }
    const yTp = d.tp == null ? a.y : (this.yOf(d.tp) ?? a.y);
    const ySl = d.sl == null ? a.y : (this.yOf(d.sl) ?? a.y);
    return { d, a, b, yTp, ySl, active, hover, labels: withLabels && isPositionKind(d.kind) ? this.positionLabels(d) : null };
  }

  private onBody(it: SceneItem, p: Pt): boolean {
    const { a, b } = it;
    switch (it.d.kind) {
      case 'trendline':
        return distToSegment(p, a, b) <= LINE_PX;
      case 'hline':
        return Math.abs(p.y - a.y) <= LINE_PX;
      case 'hray':
        return p.x >= a.x - LINE_PX && Math.abs(p.y - a.y) <= LINE_PX;
      case 'rect':
        return inBox(p, a, b, LINE_PX);
      default:
        return inBox(p, { x: a.x, y: it.yTp }, { x: b.x, y: it.ySl }, 2);
    }
  }

  /** The selected drawing's handles first, then the topmost drawing under the pointer. */
  private hit(f: Frame, x: number, y: number): { d: Drawing; handle: Handle | 'body' } | null {
    const st = useDrawings.getState();
    if (st.hidden) return null;
    const p = { x, y };
    const items: SceneItem[] = [];
    for (const d of st.bySymbol[this.symbol] ?? []) {
      const it = this.project(f, d, false, false, false);
      if (it) items.unshift(it);
    }
    const selected = items.find((it) => it.d.id === st.selectedId);
    for (const it of selected ? [selected, ...items.filter((x) => x !== selected)] : items) {
      for (const h of handlesOf(it)) if (dist(p, h.p) <= HANDLE_PX) return { d: it.d, handle: h.id };
      if (this.onBody(it, p)) return { d: it.d, handle: 'body' };
    }
    return null;
  }

  private setHover(id: string | null): void {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.primitive.update();
  }

  // ───────────────────────────── scene ─────────────────────────────

  private drawings(): Drawing[] {
    const st = useDrawings.getState();
    const g = this.gesture;
    const base = st.hidden ? [] : (st.bySymbol[this.symbol] ?? []);
    if (!g) return base;
    return g.placing ? [...base, g.d] : base.map((d) => (d.id === g.d.id ? g.d : d));
  }

  private scene(): Scene {
    const f = this.frame();
    if (!f) return { items: [], axis: [] };
    const selected = useDrawings.getState().selectedId;
    const items: SceneItem[] = [];
    const axis: AxisLabel[] = [];
    for (const d of this.drawings()) {
      const it = this.project(f, d, d.id === selected || d.id === this.gesture?.d.id, d.id === this.hoverId, true);
      if (!it) continue;
      items.push(it);
      this.axisLabels(it, axis);
    }
    return { items, axis };
  }

  /** Price-axis labels: always for horizontal lines / rays, for the other kinds while selected. */
  private axisLabels(it: SceneItem, out: AxisLabel[]): void {
    const spec = this.spec!;
    const { d } = it;
    const grey = (y: number, price: number) => {
      out.push({ y, text: fmtPrice(spec, price), bg: '#3a3a3a', fg: '#f5f5f5' });
    };
    if (d.kind === 'hline' || d.kind === 'hray') return grey(it.a.y, d.points[0].price);
    if (!it.active) return;
    if (isPositionKind(d.kind) && d.tp != null && d.sl != null) {
      grey(it.a.y, d.points[0].price);
      out.push({ y: it.yTp, text: fmtPrice(spec, d.tp), bg: C.tp, fg: '#03150b' });
      out.push({ y: it.ySl, text: fmtPrice(spec, d.sl), bg: C.sl, fg: '#ffffff' });
      return;
    }
    grey(it.a.y, d.points[0].price);
    if (d.points[1]) grey(it.b.y, d.points[1].price);
  }

  private positionLabels(d: Drawing): SceneItem['labels'] {
    const spec = this.spec;
    const lv = positionLevels(d);
    if (!spec || !lv) return null;
    const qty = positionQty(spec, lv.entry, lv.sl);
    const line = (name: string, price: number, diff: number, money: number) =>
      `${name} ${fmtPrice(spec, price)} · ${fmtDist(spec, diff)} (${fmtPct(Math.abs(diff) / lv.entry, 2)}) · ${fmtMoney(money, { sign: true })}`;
    return {
      target: line('Target', lv.tp, lv.reward, pnl(spec, lv.dir, qty, lv.entry, lv.tp)),
      stop: line('Stop', lv.sl, lv.risk, pnl(spec, lv.dir, qty, lv.entry, lv.sl)),
      center: `${d.kind === 'long' ? 'Long' : 'Short'} ${fmtQtyWithUnit(spec, qty)} · R:R ${lv.ratio.toFixed(2)}`,
    };
  }
}
