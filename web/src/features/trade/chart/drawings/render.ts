// Paints the drawing layer's scene on the price pane (a series primitive) plus its price-axis labels.
// Drawings stay grey / white like the rest of the UI; only the position tool uses profit / loss colors.

import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesPrimitive, ISeriesPrimitiveAxisView, SeriesAttachedParameter, Time } from 'lightweight-charts';
import type { Pt } from '@shared/drawings';
import type { Drawing } from '@shared/types';
import { C, FONT } from '../theme';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];
type Ctx = CanvasRenderingContext2D;

/** Draggable points: anchors, rectangle corners, the position tool's entry / target / stop / right edge. */
export type Handle = 'p0' | 'p1' | 'c01' | 'c10' | 'entry' | 'tp' | 'sl' | 'end';

export interface SceneItem {
  d: Drawing;
  /** First / second anchor on screen (b = a for one-point drawings). */
  a: Pt;
  b: Pt;
  /** Position tool: y of the target and the stop. */
  yTp: number;
  ySl: number;
  /** Selected, being placed or edited: brighter, with handles. */
  active: boolean;
  hover: boolean;
  /** Position tool texts. */
  labels: { target: string; stop: string; center: string } | null;
}

export interface AxisLabel {
  y: number;
  text: string;
  bg: string;
  fg: string;
}

export interface Scene {
  items: SceneItem[];
  axis: AxisLabel[];
}

const LINE = '#a3a3a3';
const LINE_ACTIVE = '#f5f5f5';
const BOX_FILL = 'rgba(245, 245, 245, 0.05)';
const BOX_FILL_ACTIVE = 'rgba(245, 245, 245, 0.09)';
const TP_FILL = 'rgba(31, 199, 115, 0.16)';
const SL_FILL = 'rgba(242, 54, 69, 0.16)';

export function handlesOf(it: Pick<SceneItem, 'd' | 'a' | 'b' | 'yTp' | 'ySl'>): Array<{ id: Handle; p: Pt }> {
  const { a, b } = it;
  switch (it.d.kind) {
    case 'trendline':
      return [
        { id: 'p0', p: a },
        { id: 'p1', p: b },
      ];
    case 'hray':
      return [{ id: 'p0', p: a }];
    case 'rect':
      return [
        { id: 'p0', p: a },
        { id: 'p1', p: b },
        { id: 'c01', p: { x: a.x, y: b.y } },
        { id: 'c10', p: { x: b.x, y: a.y } },
      ];
    case 'long':
    case 'short':
      return [
        { id: 'entry', p: a },
        { id: 'tp', p: { x: a.x, y: it.yTp } },
        { id: 'sl', p: { x: a.x, y: it.ySl } },
        { id: 'end', p: { x: b.x, y: a.y } },
      ];
    default:
      return [];
  }
}

const crisp = (v: number) => Math.round(v) + 0.5;

function segment(ctx: Ctx, a: Pt, b: Pt): void {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
}

function horizontal(ctx: Ctx, x1: number, x2: number, y: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, crisp(y));
  ctx.lineTo(x2, crisp(y));
  ctx.stroke();
}

/** A label centered on cx, kept inside the pane. */
function pill(ctx: Ctx, text: string, cx: number, cy: number, bg: string, fg: string, paneWidth: number): void {
  const w = Math.round(ctx.measureText(text).width + 12);
  const h = 18;
  const left = Math.round(Math.max(2, Math.min(cx - w / 2, paneWidth - w - 2)));
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(left, Math.round(cy - h / 2), w, h, 3);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.fillText(text, left + w / 2, Math.round(cy) + 0.5);
}

function drawPosition(ctx: Ctx, it: SceneItem, paneWidth: number): void {
  const { a, b, yTp, ySl } = it;
  const x1 = Math.round(Math.min(a.x, b.x));
  const x2 = Math.round(Math.max(a.x, b.x));
  ctx.fillStyle = TP_FILL;
  ctx.fillRect(x1, Math.min(a.y, yTp), x2 - x1, Math.abs(yTp - a.y));
  ctx.fillStyle = SL_FILL;
  ctx.fillRect(x1, Math.min(a.y, ySl), x2 - x1, Math.abs(ySl - a.y));
  horizontal(ctx, x1, x2, a.y);
  if (!it.labels) return;
  const cx = (x1 + x2) / 2;
  const away = (y: number) => (y < a.y ? -13 : 13);
  pill(ctx, it.labels.target, cx, yTp + away(yTp), 'rgba(31, 199, 115, 0.92)', '#03150b', paneWidth);
  pill(ctx, it.labels.stop, cx, ySl + away(ySl), 'rgba(242, 54, 69, 0.92)', '#ffffff', paneWidth);
  pill(ctx, it.labels.center, cx, a.y, '#262626', '#e5e5e5', paneWidth);
}

function drawItem(ctx: Ctx, it: SceneItem, width: number): void {
  const { d, a, b } = it;
  ctx.strokeStyle = it.active || it.hover ? LINE_ACTIVE : LINE;
  ctx.lineWidth = 1;
  switch (d.kind) {
    case 'trendline':
      segment(ctx, a, b);
      break;
    case 'hline':
      horizontal(ctx, 0, width, a.y);
      break;
    case 'hray':
      horizontal(ctx, a.x, width, a.y);
      break;
    case 'rect': {
      const x = crisp(Math.min(a.x, b.x));
      const y = crisp(Math.min(a.y, b.y));
      const w = Math.round(Math.abs(b.x - a.x));
      const h = Math.round(Math.abs(b.y - a.y));
      ctx.fillStyle = it.active ? BOX_FILL_ACTIVE : BOX_FILL;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      break;
    }
    case 'long':
    case 'short':
      drawPosition(ctx, it, width);
      break;
  }
  if (!it.active) return;
  for (const { p } of handlesOf(it)) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = C.bg;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = LINE_ACTIVE;
    ctx.stroke();
  }
}

function axisView(l: AxisLabel): ISeriesPrimitiveAxisView {
  return { coordinate: () => l.y, text: () => l.text, textColor: () => l.fg, backColor: () => l.bg };
}

/** Series primitive painting whatever scene `build` returns; `update()` asks the chart for a redraw. */
export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  private scene: Scene = { items: [], axis: [] };
  private axis: ISeriesPrimitiveAxisView[] = [];
  private readonly views: IPrimitivePaneView[];
  private readonly build: () => Scene;
  private requestUpdate: (() => void) | null = null;

  constructor(build: () => Scene) {
    this.build = build;
    const renderer: IPrimitivePaneRenderer = { draw: (t) => this.draw(t) };
    this.views = [{ zOrder: () => 'normal', renderer: () => renderer }];
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
    this.axis = this.scene.axis.map(axisView);
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
    return this.axis;
  }

  private draw(target: Target): void {
    const items = this.scene.items;
    if (!items.length) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.font = `11px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const it of items) drawItem(ctx, it, mediaSize.width);
      ctx.restore();
    });
  }
}
