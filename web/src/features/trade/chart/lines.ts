// Line specs for the chart: open positions (entry / SL / TP each), working orders (+ their attached bracket),
// the ticket preview and rule levels. Monochrome except SL (red), TP (green) and rule levels (amber).

import { LineStyle } from 'lightweight-charts';
import { create } from 'zustand';
import type { Order, Position } from '@shared/types';
import type { LineSpec } from './controller';
import { C } from './theme';

export const KEY = {
  pos: (tradeId: string) => `pos-${tradeId}`,
  posSl: (tradeId: string) => `pos-${tradeId}-sl`,
  posTp: (tradeId: string) => `pos-${tradeId}-tp`,
  order: (id: string) => `ord-${id}`,
  orderSl: (id: string) => `ord-${id}-sl`,
  orderTp: (id: string) => `ord-${id}-tp`,
  draftPrice: 'draft-price',
  draftSl: 'draft-sl',
  draftTp: 'draft-tp',
  maxLoss: 'rule-max',
  dailyLoss: 'rule-daily',
};

export function positionLineSpecs(positions: readonly Position[]): LineSpec[] {
  const out: LineSpec[] = [];
  for (const p of positions) {
    const id = p.tradeId;
    out.push({ key: KEY.pos(id), price: p.avgPrice, color: C.entry, style: LineStyle.Solid, labelColor: C.entry, labelTextColor: '#000000' });
    if (p.sl != null) out.push({ key: KEY.posSl(id), price: p.sl, color: C.sl, style: LineStyle.Solid, labelColor: C.sl, labelTextColor: '#ffffff', drag: { kind: 'sl', tradeId: id } });
    if (p.tp != null) out.push({ key: KEY.posTp(id), price: p.tp, color: C.tp, style: LineStyle.Solid, labelColor: C.tp, labelTextColor: '#000000', drag: { kind: 'tp', tradeId: id } });
  }
  return out;
}

export function orderLineSpecs(orders: Order[]): LineSpec[] {
  const out: LineSpec[] = [];
  for (const o of orders) {
    if (o.price == null) continue;
    out.push({ key: KEY.order(o.id), price: o.price, color: C.order, style: LineStyle.Dashed, labelColor: C.orderLabel, labelTextColor: '#f2f2f2', drag: { kind: 'order', orderId: o.id, field: 'price' } });
    if (o.sl != null)
      out.push({ key: KEY.orderSl(o.id), price: o.sl, color: C.slDraft, style: LineStyle.SparseDotted, labelColor: C.slLabelDraft, labelTextColor: '#ffffff', drag: { kind: 'order', orderId: o.id, field: 'sl' } });
    if (o.tp != null)
      out.push({ key: KEY.orderTp(o.id), price: o.tp, color: C.tpDraft, style: LineStyle.SparseDotted, labelColor: C.tpLabelDraft, labelTextColor: '#ffffff', drag: { kind: 'order', orderId: o.id, field: 'tp' } });
  }
  return out;
}

export function draftLineSpecs(d: { price: number | null; sl: number | null; tp: number | null }): LineSpec[] {
  const out: LineSpec[] = [];
  if (d.price != null) out.push({ key: KEY.draftPrice, price: d.price, color: C.draft, style: LineStyle.Dotted, labelColor: C.draftLabel, labelTextColor: '#f2f2f2', drag: { kind: 'draft', field: 'price' } });
  if (d.sl != null) out.push({ key: KEY.draftSl, price: d.sl, color: C.slDraft, style: LineStyle.Dotted, labelColor: C.slLabelDraft, labelTextColor: '#ffffff', drag: { kind: 'draft', field: 'sl' } });
  if (d.tp != null) out.push({ key: KEY.draftTp, price: d.tp, color: C.tpDraft, style: LineStyle.Dotted, labelColor: C.tpLabelDraft, labelTextColor: '#ffffff', drag: { kind: 'draft', field: 'tp' } });
  return out;
}

export function ruleLineSpecs(levels: { maxLoss: number | null; dailyLoss: number | null }): LineSpec[] {
  const out: LineSpec[] = [];
  if (levels.maxLoss != null) out.push({ key: KEY.maxLoss, price: levels.maxLoss, color: C.rule, style: LineStyle.LargeDashed, labelColor: C.ruleLabel, labelTextColor: '#ffd38a' });
  if (levels.dailyLoss != null) out.push({ key: KEY.dailyLoss, price: levels.dailyLoss, color: C.rule, style: LineStyle.SparseDotted, labelColor: C.ruleLabel, labelTextColor: '#ffd38a' });
  return out;
}

/** Stable signature so effects only fire when a line actually changes. */
export function specsSignature(specs: LineSpec[]): string {
  return specs.map((s) => `${s.key}:${s.price}`).join('|');
}

/** Which line is being dragged and where (tags show the $ at the dragged price). */
export const useChartDrag = create<{ key: string | null; price: number | null }>(() => ({ key: null, price: null }));

export function useDragPrice(key: string): number | null {
  return useChartDrag((s) => (s.key === key ? s.price : null));
}
