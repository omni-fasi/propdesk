// Imperative wrapper around one lightweight-charts instance: candles + volume, live bars, fill markers,
// price lines (position / bracket / orders / ticket preview / rule levels) with HTML tags kept aligned,
// mouse dragging of lines, and pointer routing to the drawing tools. React feeds it data; it never
// re-renders on ticks.

import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LineStyle,
  type LineWidth,
  type LogicalRange,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle, Fill, InstrumentSpec, Timeframe } from '@shared/types';
import { TIMEFRAME_SECONDS } from '@shared/types';
import { roundPrice } from '@shared/risk';
import { fmtQty } from '@shared/format';
import { BarAggregator, barIndexAt, type Bar } from './barAggregator';
import { C, baseChartOptions, timeFormatters } from './theme';

export type DragTarget =
  | { kind: 'sl' | 'tp'; tradeId: string }
  | { kind: 'order'; orderId: string; field: 'price' | 'sl' | 'tp' }
  | { kind: 'draft'; field: 'price' | 'sl' | 'tp' };

export interface LineSpec {
  key: string;
  price: number;
  color: string;
  style: LineStyle;
  width?: LineWidth;
  /** Axis label background / text (defaults: line color / auto contrast). */
  labelColor?: string;
  labelTextColor?: string;
  axisLabel?: boolean;
  drag?: DragTarget;
}

/** Pointer gestures handled by a layer on top of the chart (the drawing tools). x, y are pane pixels. */
export interface ChartInteraction {
  /** A tool is armed: it gets presses in the pane before the price lines. */
  armed(): boolean;
  /** A press in the pane; true = handled (the gesture is theirs until up()). */
  down(x: number, y: number): boolean;
  /** Owns the pointer: dragging, or placing a second point between clicks. */
  busy(): boolean;
  move(x: number, y: number): void;
  up(): void;
  cancel(): void;
  /** Cursor while hovering x, y (null: nothing of theirs there). */
  hover(x: number, y: number): string | null;
  leave(): void;
}

export interface LegendInfo {
  bar: Bar;
  prevClose: number | null;
  hovering: boolean;
}

export interface ChartCallbacks {
  onLegend?(info: LegendInfo | null): void;
  onNeedOlder?(): void;
  onDragStart?(spec: LineSpec, price: number): void;
  onDragMove?(spec: LineSpec, price: number): void;
  /** price null = cancelled (Esc / line vanished). */
  onDragEnd?(spec: LineSpec, price: number | null): void;
  onShiftClick?(price: number): void;
}

interface Override {
  price: number;
  /** ms epoch; Infinity while the mouse is down. */
  until: number;
}

interface DragState {
  spec: LineSpec;
  pointerId: number;
  price: number;
  startPrice: number;
}

const HIT_PX = 6;
const TAG_H = 20;

const toCandle = (b: Bar) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close });
const toVolume = (b: Bar) => ({ time: b.time as UTCTimestamp, value: b.volume, color: b.close >= b.open ? C.upVol : C.downVol });

export class ChartController {
  readonly chart: IChartApi;
  readonly candles: ISeriesApi<'Candlestick'>;
  readonly volume: ISeriesApi<'Histogram'>;
  cb: ChartCallbacks = {};

  private host: HTMLElement;
  private wrapper: HTMLElement;
  private markers: ISeriesMarkersPluginApi<Time>;
  private spec: InstrumentSpec | null = null;
  private tf: Timeframe = '1m';
  private agg: BarAggregator | null = null;
  private fills: Fill[] = [];
  private groups = new Map<string, LineSpec[]>();
  private lines = new Map<string, { spec: LineSpec; line: IPriceLine }>();
  private overrides = new Map<string, Override>();
  private tags = new Map<string, { el: HTMLElement; y: number | null; x: number }>();
  private plus: { el: HTMLElement; y: number | null } | null = null;
  private plusHovered = false;
  private plusHideTimer: ReturnType<typeof setTimeout> | null = null;
  private hoverPrice: number | null = null;
  private hovering = false;
  private drag: DragState | null = null;
  private lineHover = false;
  private interaction: ChartInteraction | null = null;
  /** Pointer captured for an interaction gesture. */
  private gesturePointer: number | null = null;
  private raf = 0;
  private destroyed = false;
  private detach: Array<() => void> = [];

  constructor(host: HTMLElement, wrapper: HTMLElement) {
    this.host = host;
    this.wrapper = wrapper;
    this.chart = createChart(host, baseChartOptions());
    this.candles = this.chart.addSeries(CandlestickSeries, {
      upColor: C.up,
      downColor: C.down,
      wickUpColor: C.up,
      wickDownColor: C.down,
      borderVisible: false,
      priceLineVisible: true,
      priceLineWidth: 1,
      lastValueVisible: true,
    });
    this.volume = this.chart.addSeries(HistogramSeries, {
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    this.volume.priceScale().applyOptions({ scaleMargins: { top: 0.84, bottom: 0 }, visible: false });
    this.markers = createSeriesMarkers(this.candles, []);

    const onCrosshair = (p: MouseEventParams<Time>) => this.handleCrosshair(p);
    const onRange = (r: LogicalRange | null) => {
      if (r && r.from < 30 && this.agg && this.agg.bars.length > 0) this.cb.onNeedOlder?.();
    };
    this.chart.subscribeCrosshairMove(onCrosshair);
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    this.detach.push(() => {
      this.chart.unsubscribeCrosshairMove(onCrosshair);
      this.chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
    });
    this.attachPointer();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    if (this.plusHideTimer) clearTimeout(this.plusHideTimer);
    for (const d of this.detach) {
      try {
        d();
      } catch {
        // chart already gone
      }
    }
    try {
      this.chart.remove();
    } catch {
      // ignore
    }
    this.lines.clear();
    this.tags.clear();
  }

  // ───────────────────────────── Instrument & data ─────────────────────────────

  setInstrument(spec: InstrumentSpec, tf: Timeframe): void {
    if (this.destroyed) return;
    this.spec = spec;
    this.tf = tf;
    const daily = tf === '1d';
    const f = timeFormatters(daily);
    this.candles.applyOptions({ priceFormat: { type: 'price', precision: spec.pricePrecision, minMove: spec.tickSize } });
    this.chart.applyOptions({
      localization: { timeFormatter: f.timeFormatter },
      timeScale: { tickMarkFormatter: f.tickMarkFormatter, timeVisible: !daily, secondsVisible: false },
    });
  }

  get bars(): Bar[] {
    return this.agg?.bars ?? [];
  }

  get timeframeSec(): number {
    return TIMEFRAME_SECONDS[this.tf];
  }

  setBars(bars: Bar[], loadedAtSec: number): void {
    if (this.destroyed) return;
    this.agg = new BarAggregator(this.timeframeSec, bars, loadedAtSec);
    try {
      this.candles.setData(bars.map(toCandle));
      this.volume.setData(bars.map(toVolume));
    } catch (e) {
      console.error('chart setData failed', e);
    }
    this.chart.timeScale().resetTimeScale();
    this.chart.priceScale('right').applyOptions({ autoScale: true });
    this.chart.timeScale().scrollToRealTime();
    this.recomputeMarkers();
    this.emitLegend();
  }

  clearBars(): void {
    if (this.destroyed) return;
    this.agg = null;
    try {
      this.candles.setData([]);
      this.volume.setData([]);
      this.markers.setMarkers([]);
    } catch {
      // ignore
    }
    this.cb.onLegend?.(null);
  }

  /** Older history in front. Returns how many bars were added. */
  prependBars(older: Bar[]): number {
    if (this.destroyed || !this.agg) return 0;
    const n = this.agg.prepend(older);
    if (n > 0) {
      try {
        this.candles.setData(this.agg.bars.map(toCandle));
        this.volume.setData(this.agg.bars.map(toVolume));
      } catch (e) {
        console.error('chart prepend failed', e);
      }
      this.recomputeMarkers();
    }
    return n;
  }

  applyMinute(c: Candle): void {
    if (this.destroyed || !this.agg) return;
    this.draw(this.agg.applyMinute(c));
  }

  applyPrice(price: number, tsMs: number): void {
    if (this.destroyed || !this.agg) return;
    this.draw(this.agg.applyPrice(price, Math.floor(tsMs / 1000)));
  }

  private draw(res: { bar: Bar; isNew: boolean } | null): void {
    if (!res) return;
    try {
      this.candles.update(toCandle(res.bar));
      this.volume.update(toVolume(res.bar));
    } catch {
      return;
    }
    if (res.isNew && this.fills.some((f) => f.ts / 1000 >= res.bar.time)) this.recomputeMarkers();
    if (!this.hovering) this.emitLegend();
  }

  priceScaleWidth(): number {
    try {
      return this.chart.priceScale('right').width();
    } catch {
      return 72;
    }
  }

  resetView(): void {
    if (this.destroyed) return;
    this.chart.timeScale().resetTimeScale();
    this.chart.priceScale('right').applyOptions({ autoScale: true });
    this.chart.timeScale().scrollToRealTime();
  }

  // ───────────────────────────── Fill markers ─────────────────────────────

  setFills(fills: Fill[]): void {
    this.fills = fills;
    this.recomputeMarkers();
  }

  private recomputeMarkers(): void {
    if (this.destroyed) return;
    const bars = this.bars;
    const spec = this.spec;
    if (!bars.length || !spec || !this.fills.length) {
      this.markers.setMarkers([]);
      return;
    }
    const first = bars[0].time;
    const groups = new Map<string, { time: number; side: 'buy' | 'sell'; qty: number }>();
    for (const f of this.fills) {
      const t = Math.floor(f.ts / 1000);
      if (t < first) continue;
      const i = barIndexAt(bars, t);
      if (i < 0) continue;
      const time = bars[i].time;
      const k = `${time}|${f.side}`;
      const g = groups.get(k);
      if (g) g.qty += f.qty;
      else groups.set(k, { time, side: f.side, qty: f.qty });
    }
    const markers: SeriesMarker<Time>[] = [...groups.values()]
      .sort((a, b) => a.time - b.time || (a.side === 'buy' ? -1 : 1))
      .map((g) => ({
        time: g.time as UTCTimestamp,
        position: g.side === 'buy' ? 'belowBar' : 'aboveBar',
        shape: g.side === 'buy' ? 'arrowUp' : 'arrowDown',
        color: g.side === 'buy' ? C.up : C.down,
        text: `${g.side === 'buy' ? 'B' : 'S'} ${fmtQty(spec, g.qty)}`,
        size: 1,
      }));
    try {
      this.markers.setMarkers(markers);
    } catch {
      // ignore
    }
  }

  // ───────────────────────────── Legend & crosshair ─────────────────────────────

  refreshLegend(): void {
    if (!this.destroyed) this.emitLegend();
  }

  private emitLegend(index?: number): void {
    const bars = this.bars;
    if (!bars.length) {
      this.cb.onLegend?.(null);
      return;
    }
    const i = index != null && index >= 0 && index < bars.length ? index : bars.length - 1;
    this.cb.onLegend?.({ bar: bars[i], prevClose: i > 0 ? bars[i - 1].close : null, hovering: index != null });
  }

  private handleCrosshair(p: MouseEventParams<Time>): void {
    if (this.destroyed) return;
    const inPane = !!p.point && p.point.x >= 0 && p.point.y >= 0;
    if (inPane && p.logical != null) {
      this.hovering = true;
      const idx = Math.round(p.logical);
      if (idx >= 0 && idx < this.bars.length) this.emitLegend(idx);
      else this.emitLegend();
    } else if (this.hovering) {
      this.hovering = false;
      this.emitLegend();
    }
    if (inPane && p.point && !this.drag) {
      const price = this.candles.coordinateToPrice(p.point.y);
      this.hoverPrice = price != null && this.spec ? roundPrice(this.spec, price) : null;
      this.showPlus(p.point.y);
    } else if (!this.plusHovered) {
      this.schedulePlusHide();
    }
  }

  /** "+" price handle next to the price axis (follows the crosshair). */
  setPlusHandle(el: HTMLElement): () => void {
    this.plus = { el, y: null };
    el.style.visibility = 'hidden';
    return () => {
      if (this.plus?.el === el) this.plus = null;
    };
  }

  setPlusHovered(on: boolean): void {
    this.plusHovered = on;
    if (on && this.plusHideTimer) {
      clearTimeout(this.plusHideTimer);
      this.plusHideTimer = null;
    }
    if (!on) this.schedulePlusHide();
  }

  /** Price under the "+" handle (snapped to the tick grid). */
  get plusPrice(): number | null {
    return this.hoverPrice;
  }

  get plusY(): number | null {
    return this.plus?.y ?? null;
  }

  private showPlus(y: number): void {
    if (!this.plus) return;
    if (this.plusHideTimer) {
      clearTimeout(this.plusHideTimer);
      this.plusHideTimer = null;
    }
    const x = this.chart.timeScale().width();
    this.plus.y = y;
    this.plus.el.style.visibility = 'visible';
    this.plus.el.style.transform = `translate(${x - 22}px, ${Math.round(y - 9)}px)`;
  }

  private schedulePlusHide(): void {
    if (!this.plus || this.plusHideTimer) return;
    this.plusHideTimer = setTimeout(() => {
      this.plusHideTimer = null;
      if (this.plus && !this.plusHovered) this.plus.el.style.visibility = 'hidden';
    }, 160);
  }

  // ───────────────────────────── Price lines ─────────────────────────────

  setGroup(name: string, specs: LineSpec[]): void {
    if (this.destroyed) return;
    this.groups.set(name, specs);
    this.reconcile();
  }

  private reconcile(): void {
    const desired = new Map<string, LineSpec>();
    for (const g of this.groups.values()) for (const s of g) if (Number.isFinite(s.price) && s.price > 0) desired.set(s.key, s);

    for (const [key, entry] of this.lines) {
      if (desired.has(key)) continue;
      try {
        this.candles.removePriceLine(entry.line);
      } catch {
        // ignore
      }
      this.lines.delete(key);
      this.overrides.delete(key);
      if (this.drag?.spec.key === key) this.cancelDrag();
    }

    for (const [key, spec] of desired) {
      const o = this.overrides.get(key);
      if (o && o.until !== Infinity && this.spec && Math.abs(o.price - spec.price) < this.spec.tickSize / 2) this.overrides.delete(key);
      const price = this.overrides.get(key)?.price ?? spec.price;
      const opts = {
        price,
        color: spec.color,
        lineStyle: spec.style,
        lineWidth: spec.width ?? 1,
        axisLabelVisible: spec.axisLabel ?? true,
        axisLabelColor: spec.labelColor ?? '',
        axisLabelTextColor: spec.labelTextColor ?? '',
        title: '',
        lineVisible: true,
      };
      const cur = this.lines.get(key);
      if (!cur) {
        this.lines.set(key, { spec, line: this.candles.createPriceLine(opts) });
        continue;
      }
      const s = cur.spec;
      if (
        s.price !== spec.price ||
        s.color !== spec.color ||
        s.style !== spec.style ||
        s.width !== spec.width ||
        s.labelColor !== spec.labelColor ||
        s.labelTextColor !== spec.labelTextColor ||
        s.axisLabel !== spec.axisLabel ||
        cur.line.options().price !== price
      ) {
        cur.line.applyOptions(opts);
      }
      cur.spec = spec;
      if (this.drag?.spec.key === key) this.drag.spec = spec;
    }
  }

  /** Current price of a line, including an in-progress drag. */
  linePrice(key: string): number | null {
    const o = this.overrides.get(key);
    if (o) return o.price;
    return this.lines.get(key)?.spec.price ?? null;
  }

  /** HTML tag that should sit on a line (positioned every frame). Returns the unregister function. */
  registerTag(key: string, el: HTMLElement): () => void {
    if (this.tags.get(key)?.el !== el) {
      this.tags.set(key, { el, y: null, x: 0 });
      el.style.visibility = 'hidden';
    }
    return () => {
      if (this.tags.get(key)?.el === el) this.tags.delete(key);
    };
  }

  /** After a drag was committed: hold the line at `price` until the store catches up (or revert on null). */
  settle(key: string, price: number | null): void {
    if (price == null) {
      this.overrides.delete(key);
      this.restoreLine(key);
      return;
    }
    this.overrides.set(key, { price, until: Date.now() + 2500 });
  }

  private restoreLine(key: string): void {
    const cur = this.lines.get(key);
    if (cur) cur.line.applyOptions({ price: this.overrides.get(key)?.price ?? cur.spec.price });
  }

  private frame = (): void => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.frame);
    if (this.tags.size === 0 && this.overrides.size === 0) return;
    const now = Date.now();
    for (const [key, o] of this.overrides) {
      if (o.until < now) {
        this.overrides.delete(key);
        this.restoreLine(key);
      }
    }
    let paneH = 0;
    try {
      paneH = this.chart.paneSize(0).height;
    } catch {
      return;
    }
    const items: Array<{ t: { el: HTMLElement; y: number | null; x: number }; y: number | null; x: number }> = [];
    for (const [key, t] of this.tags) {
      const price = this.linePrice(key);
      const y = price == null ? null : this.candles.priceToCoordinate(price);
      const visible = y != null && y >= 0 && y <= paneH;
      items.push({ t, y: visible ? Math.round(y) : null, x: 0 });
    }
    // Tags of lines closer than a tag's height (several positions near one price) sit side by side.
    const shown = items.filter((i) => i.y != null).sort((a, b) => a.y! - b.y!);
    if (shown.some((i, n) => n > 0 && i.y! - shown[n - 1].y! < TAG_H + 2)) {
      const placed: Array<{ y: number; x: number; w: number }> = [];
      const widths = shown.map((i) => i.t.el.offsetWidth);
      shown.forEach((i, n) => {
        const w = widths[n];
        let x = 0;
        for (let moved = true; moved; ) {
          moved = false;
          for (const p of placed) {
            if (Math.abs(p.y - i.y!) < TAG_H + 2 && x < p.x + p.w + 4 && x + w + 4 > p.x) {
              x = p.x + p.w + 4;
              moved = true;
            }
          }
        }
        placed.push({ y: i.y!, x, w });
        i.x = x;
      });
    }
    for (const { t, y, x } of items) {
      if (y === t.y && (y == null || x === t.x)) continue;
      t.y = y;
      t.x = x;
      if (y == null) t.el.style.visibility = 'hidden';
      else {
        t.el.style.visibility = 'visible';
        t.el.style.transform = `translate(${x}px, ${y - TAG_H / 2}px)`;
      }
    }
  };

  // ───────────────────────────── Dragging ─────────────────────────────

  setInteraction(i: ChartInteraction | null): void {
    if (this.interaction && this.interaction !== i) this.interaction.cancel();
    this.interaction = i;
  }

  private lockScroll(on: boolean): void {
    this.chart.applyOptions(
      on
        ? { handleScroll: false, handleScale: false }
        : {
            handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
            handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true },
          },
    );
  }

  /** An interaction took the press: keep the pointer and stop the chart from panning meanwhile. */
  private claim(e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    this.gesturePointer = e.pointerId;
    try {
      this.wrapper.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    this.lockScroll(true);
    if (this.plus) this.plus.el.style.visibility = 'hidden';
  }

  private releaseGesture(): void {
    const id = this.gesturePointer;
    if (id == null) return;
    this.gesturePointer = null;
    try {
      this.wrapper.releasePointerCapture(id);
    } catch {
      // ignore
    }
    this.lockScroll(false);
  }

  private setCursor(cursor: string | null): void {
    this.host.style.cursor = cursor ?? '';
  }

  private local(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const r = this.host.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private inPane(x: number, y: number): boolean {
    try {
      const w = this.chart.timeScale().width();
      const h = this.chart.paneSize(0).height;
      return x >= 0 && x <= w && y >= 0 && y <= h;
    } catch {
      return false;
    }
  }

  private hitTest(x: number, y: number): LineSpec | null {
    if (!this.inPane(x, y)) return null;
    let best: LineSpec | null = null;
    let bestD = HIT_PX + 0.5;
    for (const [key, { spec }] of this.lines) {
      if (!spec.drag) continue;
      const price = this.linePrice(key);
      if (price == null) continue;
      const py = this.candles.priceToCoordinate(price);
      if (py == null) continue;
      const d = Math.abs(py - y);
      if (d < bestD) {
        best = spec;
        bestD = d;
      }
    }
    return best;
  }

  private setLineHover(on: boolean): void {
    if (on === this.lineHover) return;
    this.lineHover = on;
    this.setCursor(on ? 'ns-resize' : null);
  }

  /** Start dragging a line from its HTML tag. */
  startDrag(key: string, e: PointerEvent): void {
    const entry = this.lines.get(key);
    if (!entry?.spec.drag || this.drag) return;
    this.beginDrag(entry.spec, e);
  }

  private beginDrag(spec: LineSpec, e: PointerEvent): void {
    const price = this.linePrice(spec.key) ?? spec.price;
    this.drag = { spec, pointerId: e.pointerId, price, startPrice: price };
    this.overrides.set(spec.key, { price, until: Infinity });
    try {
      this.wrapper.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    this.lockScroll(true);
    this.host.style.cursor = 'ns-resize';
    if (this.plus) this.plus.el.style.visibility = 'hidden';
    this.cb.onDragStart?.(spec, price);
  }

  private moveDrag(e: PointerEvent): void {
    const d = this.drag;
    if (!d || !this.spec) return;
    const { y } = this.local(e);
    const raw = this.candles.coordinateToPrice(y);
    if (raw == null || !Number.isFinite(raw) || raw <= 0) return;
    const price = roundPrice(this.spec, raw);
    if (price === d.price) return;
    d.price = price;
    this.overrides.set(d.spec.key, { price, until: Infinity });
    this.lines.get(d.spec.key)?.line.applyOptions({ price });
    this.cb.onDragMove?.(d.spec, price);
  }

  private endDrag(commit: boolean): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try {
      this.wrapper.releasePointerCapture(d.pointerId);
    } catch {
      // ignore
    }
    this.lockScroll(false);
    this.host.style.cursor = this.lineHover ? 'ns-resize' : '';
    const moved = commit && d.price !== d.startPrice;
    if (moved) {
      // Hold the new price until the parent commits (it calls settle()).
      this.overrides.set(d.spec.key, { price: d.price, until: Date.now() + 10_000 });
    } else {
      this.overrides.delete(d.spec.key);
      this.restoreLine(d.spec.key);
    }
    this.cb.onDragEnd?.(d.spec, moved ? d.price : null);
  }

  private cancelDrag(): void {
    if (this.drag) this.endDrag(false);
  }

  private attachPointer(): void {
    const w = this.wrapper;
    const isUi = (e: Event) => e.target instanceof Element && !!e.target.closest('[data-chart-ui]');

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || this.drag || this.gesturePointer != null || isUi(e)) return;
      const { x, y } = this.local(e);
      const ix = this.interaction;
      const inPane = this.inPane(x, y);
      // An armed drawing tool takes the press; otherwise the price lines come first, then the drawings.
      if (ix && inPane && ix.armed() && ix.down(x, y)) return this.claim(e);
      const hit = this.hitTest(x, y);
      if (hit) {
        e.preventDefault();
        e.stopPropagation();
        this.beginDrag(hit, e);
        return;
      }
      if (ix && inPane && !e.shiftKey && ix.down(x, y)) return this.claim(e);
      if (e.shiftKey && inPane && this.spec) {
        const raw = this.candles.coordinateToPrice(y);
        if (raw != null && raw > 0) {
          e.preventDefault();
          e.stopPropagation();
          this.cb.onShiftClick?.(roundPrice(this.spec, raw));
        }
      }
    };
    const onMove = (e: PointerEvent) => {
      if (this.drag) {
        if (e.pointerId === this.drag.pointerId) {
          e.preventDefault();
          e.stopPropagation();
          this.moveDrag(e);
        }
        return;
      }
      const ix = this.interaction;
      if (ix?.busy()) {
        if (this.gesturePointer === e.pointerId) {
          e.preventDefault();
          e.stopPropagation();
        }
        const { x, y } = this.local(e);
        ix.move(x, y);
        return;
      }
      if (e.buttons !== 0 || isUi(e)) {
        this.setLineHover(false);
        return;
      }
      const { x, y } = this.local(e);
      const onLine = !!this.hitTest(x, y);
      this.setLineHover(onLine);
      if (!onLine && ix) this.setCursor(this.inPane(x, y) ? ix.hover(x, y) : null);
    };
    const onUp = (e: PointerEvent) => {
      if (this.drag && e.pointerId === this.drag.pointerId) {
        e.preventDefault();
        e.stopPropagation();
        this.endDrag(e.type === 'pointerup');
        return;
      }
      if (this.gesturePointer === e.pointerId) {
        e.preventDefault();
        e.stopPropagation();
        this.releaseGesture();
        if (e.type === 'pointerup') this.interaction?.up();
        else this.interaction?.cancel();
      }
    };
    const onLost = (e: PointerEvent) => {
      // Capture lost without a pointerup (window blur, element gone): treat as cancelled.
      if (this.drag && e.pointerId === this.drag.pointerId) this.endDrag(false);
      if (this.gesturePointer === e.pointerId) {
        this.gesturePointer = null;
        this.lockScroll(false);
        this.interaction?.cancel();
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      if (this.drag) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.drag) {
        e.stopPropagation();
        this.endDrag(false);
      }
    };
    const onLeave = () => {
      this.setLineHover(false);
      if (!this.interaction?.busy()) {
        this.interaction?.leave();
        this.setCursor(null);
      }
    };

    w.addEventListener('pointerdown', onDown, true);
    w.addEventListener('pointermove', onMove, true);
    w.addEventListener('pointerup', onUp, true);
    w.addEventListener('pointercancel', onUp, true);
    w.addEventListener('lostpointercapture', onLost, true);
    w.addEventListener('mousedown', onMouseDown, true);
    w.addEventListener('pointerleave', onLeave);
    window.addEventListener('keydown', onKey, true);
    this.detach.push(() => {
      w.removeEventListener('pointerdown', onDown, true);
      w.removeEventListener('pointermove', onMove, true);
      w.removeEventListener('pointerup', onUp, true);
      w.removeEventListener('pointercancel', onUp, true);
      w.removeEventListener('lostpointercapture', onLost, true);
      w.removeEventListener('mousedown', onMouseDown, true);
      w.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('keydown', onKey, true);
    });
  }
}
