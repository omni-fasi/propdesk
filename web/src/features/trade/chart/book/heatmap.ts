// Order book heatmap on the price pane, drawn behind the candles (a series primitive). Every stored minute
// is a column of price buckets — green where buy orders were waiting, red where sell orders were waiting,
// brighter = more size — and the live book is the newest column plus depth bars along the right edge,
// with the biggest walls labelled. Columns narrower than 2 px are merged (averaged) on higher timeframes.

import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, Logical, SeriesAttachedParameter, Time } from 'lightweight-charts';
import type { BookFrame, BookLevel, BookRow, InstrumentSpec } from '@shared/types';
import { timeToLogical } from '@shared/drawings';
import type { ChartController } from '../controller';
import { FONT } from '../theme';
import { useBook } from './store';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];

interface Scene {
  /** Rectangles batched by fill color: heat cells (behind the candles) and live depth bars. */
  fills: Array<{ color: string; path: Path2D }>;
  /** Wall sizes, drawn above the candles. */
  labels: Array<{ x: number; y: number; text: string; color: string }>;
}

const EMPTY: Scene = { fills: [], labels: [] };
/** Brightness steps of the heat cells. */
const LEVELS = 10;
const MIN_COL_PX = 2;
const BUY = [31, 199, 115];
const SELL = [242, 54, 69];
const rgba = (c: number[], a: number) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a.toFixed(3)})`;
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

interface Column {
  left: number;
  right: number;
  step: number;
  /** Rows merged into this column (sizes are summed, averaged when drawn). */
  n: number;
  bids: Map<number, number>;
  asks: Map<number, number>;
}

function addLevels(m: Map<number, number>, levels: BookLevel[]): void {
  for (const [i, q] of levels) m.set(i, (m.get(i) ?? 0) + q);
}

class HeatPrimitive implements ISeriesPrimitive<Time> {
  private scene: Scene = EMPTY;
  private readonly build: () => Scene;
  private readonly views: IPrimitivePaneView[];
  private requestUpdate: (() => void) | null = null;

  constructor(build: () => Scene) {
    this.build = build;
    const heat: IPrimitivePaneRenderer = { draw: (t) => this.drawFills(t) };
    const labels: IPrimitivePaneRenderer = { draw: (t) => this.drawLabels(t) };
    this.views = [
      { zOrder: () => 'bottom', renderer: () => heat },
      { zOrder: () => 'top', renderer: () => labels },
    ];
  }

  attached(p: SeriesAttachedParameter<Time>): void {
    this.requestUpdate = p.requestUpdate;
  }

  detached(): void {
    this.requestUpdate = null;
  }

  update(): void {
    this.requestUpdate?.();
  }

  updateAllViews(): void {
    this.scene = this.build();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  private drawFills(target: Target): void {
    const fills = this.scene.fills;
    if (!fills.length) return;
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      for (const f of fills) {
        ctx.fillStyle = f.color;
        ctx.fill(f.path);
      }
    });
  }

  private drawLabels(target: Target): void {
    const labels = this.scene.labels;
    if (!labels.length) return;
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.save();
      ctx.font = `10px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const l of labels) {
        const w = ctx.measureText(l.text).width + 6;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
        ctx.fillRect(Math.round(l.x - w), Math.round(l.y - 7), Math.round(w), 14);
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, l.x - 3, l.y + 0.5);
      }
      ctx.restore();
    });
  }
}

export class BookLayer {
  private readonly ctrl: ChartController;
  private readonly primitive: HeatPrimitive;
  private readonly off: () => void;
  private spec: InstrumentSpec | null = null;
  /** The last scene and what it was built from (crosshair moves redraw without changes). */
  private cache: { key: string; scene: Scene } | null = null;

  constructor(ctrl: ChartController) {
    this.ctrl = ctrl;
    this.primitive = new HeatPrimitive(() => this.safeScene());
    ctrl.candles.attachPrimitive(this.primitive);
    this.off = useBook.subscribe(() => this.primitive.update());
  }

  destroy(): void {
    this.off();
    try {
      this.ctrl.candles.detachPrimitive(this.primitive);
    } catch {
      // chart already gone
    }
  }

  setSpec(spec: InstrumentSpec): void {
    this.spec = spec;
    this.primitive.update();
  }

  private safeScene(): Scene {
    try {
      return this.scene();
    } catch {
      return EMPTY;
    }
  }

  private scene(): Scene {
    const st = useBook.getState();
    const spec = this.spec;
    const bars = this.ctrl.bars;
    if (!st.on || !spec || st.active !== spec.symbol || !bars.length) return EMPTY;
    const ts = this.ctrl.chart.timeScale();
    const x0 = ts.logicalToCoordinate(0 as Logical);
    const x1 = ts.logicalToCoordinate(1 as Logical);
    if (x0 == null || x1 == null || x1 === x0) return EMPTY;
    const spacing = x1 - x0;
    const { width, height } = this.ctrl.chart.paneSize(0);
    const pTop = this.ctrl.candles.coordinateToPrice(0);
    const pBot = this.ctrl.candles.coordinateToPrice(height);
    if (pTop == null || pBot == null || pTop <= pBot) return EMPTY;
    const tf = this.ctrl.timeframeSec;
    const key = [st.rows.length, st.rows.at(-1)?.t, st.frame?.ts, x0, spacing, width, height, pTop, pBot, tf, bars.length, bars[0].time].join('|');
    if (this.cache?.key === key) return this.cache.scene;
    const scene = this.build(st.rows, st.frame, spec, { x0, spacing, width, height, pTop, pBot, tf, bars });
    this.cache = { key, scene };
    return scene;
  }

  private build(
    rows: BookRow[],
    frame: BookFrame | null,
    spec: InstrumentSpec,
    g: { x0: number; spacing: number; width: number; height: number; pTop: number; pBot: number; tf: number; bars: ChartController['bars'] },
  ): Scene {
    const { x0, spacing, width, height, pTop, pBot, tf, bars } = g;
    const xOf = (t: number) => x0 + timeToLogical(bars, tf, t) * spacing - spacing / 2;
    const yOf = (p: number) => ((pTop - p) / (pTop - pBot)) * height;
    const inView = (p: number, step: number) => p + step >= pBot && p <= pTop;

    // Columns: stored minutes (merged while narrower than MIN_COL_PX), then the live book.
    const cols: Column[] = [];
    let cur: Column | null = null;
    const add = (row: Pick<BookRow, 'step' | 'bids' | 'asks'>, left: number, right: number) => {
      if (right < 0 || left > width) {
        cur = null;
        return;
      }
      if (cur && cur.step === row.step && cur.right - cur.left < MIN_COL_PX && Math.abs(left - cur.right) < 1) {
        cur.right = right;
        cur.n++;
      } else {
        cur = { left, right, step: row.step, n: 1, bids: new Map(), asks: new Map() };
        cols.push(cur);
      }
      addLevels(cur.bids, row.bids);
      addLevels(cur.asks, row.asks);
    };
    for (const r of rows) add(r, xOf(r.t), xOf(r.t + 60));
    if (frame) {
      const t0 = Math.floor(frame.ts / 60_000) * 60;
      const left = xOf(t0);
      cur = null;
      add(frame, left, Math.max(left + MIN_COL_PX, xOf(frame.ts / 1000)));
    }

    // Brightness relative to the visible cells: the top 3 % are full strength.
    const values: number[] = [];
    for (const c of cols) {
      for (const m of [c.bids, c.asks]) for (const [i, q] of m) if (inView(i * c.step, c.step)) values.push(q / c.n);
    }
    const fills: Scene['fills'] = [];
    const labels: Scene['labels'] = [];
    if (values.length) {
      const sample = values.length > 4000 ? values.filter((_, k) => k % Math.ceil(values.length / 4000) === 0) : values;
      sample.sort((a, b) => a - b);
      const ref = sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.97))] || sample[sample.length - 1];
      const paths: Array<Array<Path2D | null>> = [Array(LEVELS + 1).fill(null), Array(LEVELS + 1).fill(null)];
      for (const c of cols) {
        const left = Math.round(c.left);
        const w = Math.max(1, Math.round(c.right) - left);
        ([c.bids, c.asks] as const).forEach((m, side) => {
          for (const [i, q] of m) {
            const p = i * c.step;
            if (!inView(p, c.step)) continue;
            const lv = Math.round(Math.min(1, q / c.n / ref) ** 0.55 * LEVELS);
            if (lv < 1) continue;
            const top = Math.round(yOf(p + c.step));
            const h = Math.max(1, Math.round(yOf(p)) - top);
            (paths[side][lv] ??= new Path2D()).rect(left, top, w, h);
          }
        });
      }
      paths.forEach((byLevel, side) =>
        byLevel.forEach((path, lv) => {
          if (path) fills.push({ color: rgba(side ? SELL : BUY, 0.04 + (0.52 * lv) / LEVELS), path });
        }),
      );
    }

    // Live depth along the right edge, the three biggest walls on each side labelled.
    if (frame) {
      const maxW = Math.min(120, width * 0.16);
      const sides = [frame.bids, frame.asks].map((lv) => lv.filter(([i]) => inView(i * frame.step, frame.step)));
      const maxQ = Math.max(0, ...sides.flat().map(([, q]) => q));
      if (maxQ > 0) {
        const walls: Array<Scene['labels'][number] & { q: number }> = [];
        sides.forEach((levels, side) => {
          const color = side ? SELL : BUY;
          const bars = new Path2D();
          const big = new Path2D();
          const top3 = new Set([...levels].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([i]) => i));
          for (const [i, q] of levels) {
            const p = i * frame.step;
            const top = Math.round(yOf(p + frame.step));
            const h = Math.max(1, Math.round(yOf(p)) - top);
            const len = Math.max(1, Math.round((q / maxQ) * maxW));
            (top3.has(i) ? big : bars).rect(width - len, top, len, h);
            if (top3.has(i) && q >= maxQ * 0.15) walls.push({ x: width - len - 2, y: top + h / 2, text: `${compact.format(q)} ${spec.unitLabel}`, color: rgba(color, 1), q });
          }
          fills.push({ color: rgba(color, 0.32), path: bars }, { color: rgba(color, 0.7), path: big });
        });
        // Biggest walls first; a label too close to one already placed is left out.
        for (const w of walls.sort((a, b) => b.q - a.q)) {
          if (labels.every((l) => Math.abs(l.y - w.y) >= 15)) labels.push({ x: w.x, y: w.y, text: w.text, color: w.color });
        }
      }
    }
    return { fills, labels };
  }
}
