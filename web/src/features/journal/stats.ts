// Pure journal analytics over closed trades. No React, no store — safe to unit test.
//
// Conventions
// - A trade's result comes from its NET P&L (after fees): > +$0.005 win, < −$0.005 loss, otherwise break-even.
// - Win rate = wins / all trades (break-evens count in the denominator).
// - Profit factor = Σ net of winners / |Σ net of losers|; Infinity with winners and no losers; null with neither.
// - Order-dependent metrics (streaks, drawdown, equity curve) use realization order: close time, then open time.
// - Break-even trades break win and loss streaks.
// - Drawdown is measured on the cumulative net P&L curve starting at 0 (the start of the filtered period).

import type { Mood, Trade } from '@shared/types';
import { MOODS, MOOD_MAP, SETUP_GRADES } from '@shared/journal';
import { weekdayOfKey } from '@shared/time';
import { fmtDuration, fmtPct } from '@shared/format';
import { fmtMoneyProse, plural } from './labels';

export type TradeResult = 'win' | 'loss' | 'be';

const EPS = 0.005;

export function resultOf(net: number): TradeResult {
  return net > EPS ? 'win' : net < -EPS ? 'loss' : 'be';
}

export function closeTime(t: Pick<Trade, 'closedAt' | 'openedAt'>): number {
  return t.closedAt ?? t.openedAt;
}

export function holdTime(t: Pick<Trade, 'closedAt' | 'openedAt'>): number {
  return Math.max(0, closeTime(t) - t.openedAt);
}

export function isReviewed(t: Pick<Trade, 'review'>): boolean {
  return t.review != null;
}

const round2 = (x: number) => Math.round(x * 100) / 100 || 0;

/** Realization order: close time, then open time, then id (stable). */
export function chronological(trades: readonly Trade[]): Trade[] {
  return [...trades].sort((a, b) => closeTime(a) - closeTime(b) || a.openedAt - b.openedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ───────────────────────────── KPIs ─────────────────────────────

export interface Kpis {
  trades: number;
  wins: number;
  losses: number;
  breakEven: number;
  net: number;
  gross: number;
  fees: number;
  /** wins / trades; null without trades. */
  winRate: number | null;
  /** Σ net of winning trades (≥ 0). */
  grossWin: number;
  /** Σ net of losing trades (≤ 0). */
  grossLoss: number;
  profitFactor: number | null;
  /** Average net per trade. */
  expectancy: number | null;
  avgWin: number | null;
  /** Negative number. */
  avgLoss: number | null;
  /** avgWin / |avgLoss|. */
  payoffRatio: number | null;
  avgR: number | null;
  totalR: number | null;
  /** Trades that have an R multiple (an initial stop). */
  rTrades: number;
  /** Largest peak-to-trough drop of the cumulative net curve, as a positive amount. */
  maxDrawdown: number;
  avgHoldMs: number | null;
  avgWinHoldMs: number | null;
  avgLossHoldMs: number | null;
  best: Trade | null;
  worst: Trade | null;
  longestWinStreak: number;
  longestLossStreak: number;
  /** Streak at the end of the period (break-even ends streaks → null). */
  currentStreak: { kind: 'win' | 'loss'; count: number } | null;
}

export function computeKpis(trades: readonly Trade[]): Kpis {
  const list = chronological(trades);
  let net = 0;
  let gross = 0;
  let fees = 0;
  let wins = 0;
  let losses = 0;
  let be = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let rSum = 0;
  let rCount = 0;
  let holdSum = 0;
  let winHold = 0;
  let lossHold = 0;
  let best: Trade | null = null;
  let worst: Trade | null = null;
  let streakKind: TradeResult | null = null;
  let streak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  let cum = 0;
  let peak = 0;
  let maxDd = 0;

  for (const t of list) {
    net += t.netPnl;
    gross += t.grossPnl;
    fees += t.fees;
    const r = resultOf(t.netPnl);
    const h = holdTime(t);
    holdSum += h;
    if (r === 'win') {
      wins++;
      grossWin += t.netPnl;
      winHold += h;
    } else if (r === 'loss') {
      losses++;
      grossLoss += t.netPnl;
      lossHold += h;
    } else {
      be++;
    }
    if (t.rMultiple != null && Number.isFinite(t.rMultiple)) {
      rSum += t.rMultiple;
      rCount++;
    }
    if (!best || t.netPnl > best.netPnl) best = t;
    if (!worst || t.netPnl < worst.netPnl) worst = t;

    if (r === streakKind) streak++;
    else {
      streakKind = r;
      streak = 1;
    }
    if (r === 'win') maxWinStreak = Math.max(maxWinStreak, streak);
    if (r === 'loss') maxLossStreak = Math.max(maxLossStreak, streak);

    cum += t.netPnl;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
  }

  const n = list.length;
  return {
    trades: n,
    wins,
    losses,
    breakEven: be,
    net: round2(net),
    gross: round2(gross),
    fees: round2(fees),
    winRate: n ? wins / n : null,
    grossWin: round2(grossWin),
    grossLoss: round2(grossLoss),
    profitFactor: losses > 0 ? grossWin / -grossLoss : wins > 0 ? Infinity : null,
    expectancy: n ? net / n : null,
    avgWin: wins ? grossWin / wins : null,
    avgLoss: losses ? grossLoss / losses : null,
    payoffRatio: wins && losses ? grossWin / wins / Math.abs(grossLoss / losses) : null,
    avgR: rCount ? rSum / rCount : null,
    totalR: rCount ? rSum : null,
    rTrades: rCount,
    maxDrawdown: round2(maxDd),
    avgHoldMs: n ? holdSum / n : null,
    avgWinHoldMs: wins ? winHold / wins : null,
    avgLossHoldMs: losses ? lossHold / losses : null,
    best,
    worst,
    longestWinStreak: maxWinStreak,
    longestLossStreak: maxLossStreak,
    currentStreak: streakKind === 'win' || streakKind === 'loss' ? { kind: streakKind, count: streak } : null,
  };
}

// ───────────────────────────── Curves ─────────────────────────────

export interface CurvePoint {
  /** Close time (ms). */
  ts: number;
  /** Cumulative net P&L after this trade. */
  cum: number;
  /** Distance below the running peak (≥ 0). */
  drawdown: number;
  trade: Trade;
}

/** Cumulative net P&L by close time. */
export function equityCurve(trades: readonly Trade[]): CurvePoint[] {
  let cum = 0;
  let peak = 0;
  return chronological(trades).map((trade) => {
    cum += trade.netPnl;
    peak = Math.max(peak, cum);
    return { ts: closeTime(trade), cum: round2(cum), drawdown: round2(peak - cum), trade };
  });
}

export interface DayNet {
  day: string;
  net: number;
  trades: number;
  wins: number;
  losses: number;
}

/** Net P&L per trading day (of the close), oldest first. */
export function dailyNet(trades: readonly Trade[]): DayNet[] {
  const map = new Map<string, DayNet>();
  for (const t of trades) {
    let d = map.get(t.tradingDay);
    if (!d) map.set(t.tradingDay, (d = { day: t.tradingDay, net: 0, trades: 0, wins: 0, losses: 0 }));
    d.net += t.netPnl;
    d.trades++;
    const r = resultOf(t.netPnl);
    if (r === 'win') d.wins++;
    else if (r === 'loss') d.losses++;
  }
  return [...map.values()].map((d) => ({ ...d, net: round2(d.net) })).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

// ───────────────────────────── Breakdowns ─────────────────────────────

export interface Group {
  key: string;
  label: string;
  emoji?: string;
  trades: number;
  wins: number;
  losses: number;
  breakEven: number;
  net: number;
  winRate: number | null;
  /** Average net per trade. */
  avg: number | null;
  avgR: number | null;
}

interface Acc {
  key: string;
  label: string;
  emoji?: string;
  trades: number;
  wins: number;
  losses: number;
  be: number;
  net: number;
  rSum: number;
  rCount: number;
}

function acc(key: string, label: string, emoji?: string): Acc {
  return { key, label, emoji, trades: 0, wins: 0, losses: 0, be: 0, net: 0, rSum: 0, rCount: 0 };
}

function add(a: Acc, t: Trade): void {
  a.trades++;
  a.net += t.netPnl;
  const r = resultOf(t.netPnl);
  if (r === 'win') a.wins++;
  else if (r === 'loss') a.losses++;
  else a.be++;
  if (t.rMultiple != null && Number.isFinite(t.rMultiple)) {
    a.rSum += t.rMultiple;
    a.rCount++;
  }
}

function finish(a: Acc): Group {
  return {
    key: a.key,
    label: a.label,
    emoji: a.emoji,
    trades: a.trades,
    wins: a.wins,
    losses: a.losses,
    breakEven: a.be,
    net: round2(a.net),
    winRate: a.trades ? a.wins / a.trades : null,
    avg: a.trades ? a.net / a.trades : null,
    avgR: a.rCount ? a.rSum / a.rCount : null,
  };
}

/** Generic grouping. `keysOf` may return several keys (a trade counts in each) or none. */
export function groupTrades(
  trades: readonly Trade[],
  keysOf: (t: Trade) => string | readonly string[] | null,
  describe: (key: string) => { label: string; emoji?: string },
): Group[] {
  const map = new Map<string, Acc>();
  for (const t of trades) {
    const k = keysOf(t);
    if (k == null) continue;
    const keys = typeof k === 'string' ? [k] : [...new Set(k)];
    for (const key of keys) {
      let a = map.get(key);
      if (!a) {
        const d = describe(key);
        map.set(key, (a = acc(key, d.label, d.emoji)));
      }
      add(a, t);
    }
  }
  return [...map.values()].map(finish);
}

const NONE = 'none';

function orderBy(groups: Group[], order: readonly string[]): Group[] {
  const idx = (k: string) => {
    const i = order.indexOf(k);
    return i === -1 ? order.length : i;
  };
  return [...groups].sort((a, b) => idx(a.key) - idx(b.key) || b.trades - a.trades || a.label.localeCompare(b.label));
}

export function byMood(trades: readonly Trade[]): Group[] {
  const groups = groupTrades(
    trades,
    (t) => t.tags?.mood ?? NONE,
    (k) => (k === NONE ? { label: 'No mood logged' } : { label: MOOD_MAP[k as Mood]?.label ?? k, emoji: MOOD_MAP[k as Mood]?.emoji }),
  );
  return orderBy(groups, [...MOODS.map((m) => m.id), NONE]);
}

export function normalizeSetup(setup: string | null | undefined): string | null {
  const s = setup?.trim();
  return s ? s : null;
}

export function bySetup(trades: readonly Trade[]): Group[] {
  const groups = groupTrades(
    trades,
    (t) => normalizeSetup(t.tags?.setup) ?? NONE,
    (k) => ({ label: k === NONE ? 'Not graded' : k }),
  );
  const grades: readonly string[] = SETUP_GRADES;
  const graded = orderBy(
    groups.filter((g) => grades.includes(g.key)),
    grades,
  );
  const custom = groups.filter((g) => g.key !== NONE && !grades.includes(g.key)).sort((a, b) => b.trades - a.trades || a.label.localeCompare(b.label));
  return [...graded, ...custom, ...groups.filter((g) => g.key === NONE)];
}

export function bySymbol(trades: readonly Trade[]): Group[] {
  return groupTrades(
    trades,
    (t) => t.symbol,
    (k) => ({ label: k }),
  ).sort((a, b) => b.trades - a.trades || b.net - a.net || a.label.localeCompare(b.label));
}

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** By weekday of the trading day (matches the calendar). Mon–Fri always present; weekends only when traded. */
export function byWeekday(trades: readonly Trade[]): Group[] {
  const groups = groupTrades(
    trades,
    (t) => String(weekdayOfKey(t.tradingDay)),
    (k) => ({ label: WEEKDAY_NAMES[Number(k)] ?? k }),
  );
  const map = new Map(groups.map((g) => [g.key, g]));
  const out: Group[] = [];
  for (let w = 0; w < 7; w++) {
    const g = map.get(String(w));
    if (g) out.push(g);
    else if (w >= 1 && w <= 5) out.push(finish(acc(String(w), WEEKDAY_NAMES[w])));
  }
  return out;
}

export function hourLabel(h: number): string {
  return `${String(h).padStart(2, '0')}:00`;
}

/** 24 buckets by the local hour the trade was opened (0–23), empty hours included. */
export function byHour(trades: readonly Trade[], hourOf: (ts: number) => number = (ts) => new Date(ts).getHours()): Group[] {
  const groups = groupTrades(
    trades,
    (t) => String(hourOf(t.openedAt)),
    (k) => ({ label: hourLabel(Number(k)) }),
  );
  const map = new Map(groups.map((g) => [g.key, g]));
  return Array.from({ length: 24 }, (_, h) => map.get(String(h)) ?? finish(acc(String(h), hourLabel(h))));
}

export function bySide(trades: readonly Trade[]): Group[] {
  const groups = groupTrades(
    trades,
    (t) => t.direction,
    (k) => ({ label: k === 'long' ? 'Long' : 'Short' }),
  );
  const map = new Map(groups.map((g) => [g.key, g]));
  return [map.get('long') ?? finish(acc('long', 'Long')), map.get('short') ?? finish(acc('short', 'Short'))];
}

export type PlanKey = 'followed' | 'broke' | 'unknown';

export function planKey(t: Trade): PlanKey {
  if (t.review?.followedPlan === true) return 'followed';
  if (t.review?.followedPlan === false) return 'broke';
  return 'unknown';
}

export function byPlan(trades: readonly Trade[]): Group[] {
  const labels: Record<PlanKey, string> = { followed: 'Followed my plan', broke: 'Broke my plan', unknown: 'Not reviewed' };
  return orderBy(
    groupTrades(trades, planKey, (k) => ({ label: labels[k as PlanKey] ?? k })),
    ['followed', 'broke', 'unknown'],
  );
}

export const CLEAN_KEY = '__clean__';

/**
 * Each mistake: trades tagged with it and their total net ("cost"), most expensive first.
 * A trade with two mistakes counts in both. Reviewed trades without mistakes are returned last as CLEAN_KEY.
 */
export function byMistake(trades: readonly Trade[]): Group[] {
  const groups = groupTrades(
    trades,
    (t) => (t.review ? (t.review.mistakes?.length ? t.review.mistakes : CLEAN_KEY) : null),
    (k) => ({ label: k === CLEAN_KEY ? 'No mistakes' : k }),
  );
  const mistakes = groups.filter((g) => g.key !== CLEAN_KEY).sort((a, b) => a.net - b.net || b.trades - a.trades);
  return [...mistakes, ...groups.filter((g) => g.key === CLEAN_KEY)];
}

// ───────────────────────────── Plain-language insights ─────────────────────────────

export interface Insight {
  id: string;
  tone: 'profit' | 'loss' | 'neutral';
  text: string;
}

function minBy<T>(list: readonly T[], f: (x: T) => number): T | null {
  let out: T | null = null;
  for (const x of list) if (out === null || f(x) < f(out)) out = x;
  return out;
}

function maxBy<T>(list: readonly T[], f: (x: T) => number): T | null {
  let out: T | null = null;
  for (const x of list) if (out === null || f(x) > f(out)) out = x;
  return out;
}

const pct0 = (f: number | null) => (f == null ? '—' : fmtPct(f, 0));

function merge(groups: readonly Group[]): { trades: number; net: number; wins: number } {
  return groups.reduce((s, g) => ({ trades: s.trades + g.trades, net: s.net + g.net, wins: s.wins + g.wins }), { trades: 0, net: 0, wins: 0 });
}

/** Up to `limit` short, factual sentences about the trader's behaviour, most important first. */
export function buildInsights(trades: readonly Trade[], limit = 6): Insight[] {
  const out: Insight[] = [];
  const k = computeKpis(trades);
  if (k.trades === 0) return out;

  // Moods
  const moods = byMood(trades);
  const tagged = moods.filter((g) => g.key !== NONE && g.trades >= 2);
  const worst = minBy(tagged, (g) => g.net);
  if (worst && worst.net < 0) {
    out.push({
      id: 'mood-worst',
      tone: 'loss',
      text: `Trades taken while ${worst.emoji} ${worst.label} lost ${fmtMoneyProse(worst.net)} with a ${pct0(worst.winRate)} win rate (${plural(worst.trades, 'trade')}).`,
    });
  }
  const best = maxBy(tagged, (g) => g.net);
  if (best && best.net > 0 && best !== worst) {
    out.push({
      id: 'mood-best',
      tone: 'profit',
      text: `Your best results came while ${best.emoji} ${best.label}: ${fmtMoneyProse(best.net)} over ${plural(best.trades, 'trade')} (${pct0(best.winRate)} win rate).`,
    });
  }
  const good = merge(moods.filter((g) => g.key !== NONE && MOOD_MAP[g.key as Mood]?.tone === 'good'));
  const bad = merge(moods.filter((g) => g.key !== NONE && MOOD_MAP[g.key as Mood]?.tone === 'bad'));
  if (good.trades >= 2 && bad.trades >= 2) {
    const goodAvg = good.net / good.trades;
    const badAvg = bad.net / bad.trades;
    out.push({
      id: 'mood-tone',
      tone: badAvg < goodAvg ? 'loss' : 'neutral',
      text: `Average trade: ${fmtMoneyProse(goodAvg)} when calm, focused or confident vs ${fmtMoneyProse(badAvg)} when anxious, fearful, FOMO, frustrated or in revenge mode.`,
    });
  }

  // Plan adherence
  const plan = byPlan(trades);
  const followed = plan.find((g) => g.key === 'followed');
  const broke = plan.find((g) => g.key === 'broke');
  if (followed && broke && followed.trades >= 2 && broke.trades >= 2) {
    out.push({
      id: 'plan',
      tone: (broke.avg ?? 0) < (followed.avg ?? 0) ? 'loss' : 'neutral',
      text: `When you followed your plan you won ${pct0(followed.winRate)} of trades (avg ${fmtMoneyProse(followed.avg ?? 0)}); when you broke it, ${pct0(broke.winRate)} (avg ${fmtMoneyProse(broke.avg ?? 0)}).`,
    });
  } else if (broke && broke.trades >= 2 && broke.net < 0) {
    out.push({ id: 'plan', tone: 'loss', text: `Trades where you broke your plan cost ${fmtMoneyProse(broke.net)} over ${plural(broke.trades, 'trade')}.` });
  }

  // Mistakes
  const costliest = byMistake(trades).find((g) => g.key !== CLEAN_KEY && g.net < 0);
  if (costliest) {
    out.push({
      id: 'mistake',
      tone: 'loss',
      text: `Your costliest mistake: “${costliest.label}” — ${fmtMoneyProse(costliest.net)} across ${plural(costliest.trades, 'trade')}.`,
    });
  }

  // Holding losers vs winners
  if (k.avgWinHoldMs != null && k.avgLossHoldMs != null && k.wins >= 3 && k.losses >= 3 && k.avgWinHoldMs > 0 && k.avgLossHoldMs > 0) {
    const ratio = k.avgLossHoldMs / k.avgWinHoldMs;
    if (ratio >= 1.5) {
      out.push({
        id: 'hold',
        tone: 'loss',
        text: `You hold losing trades ${ratio.toFixed(1)}× longer than winners (${fmtDuration(k.avgLossHoldMs)} vs ${fmtDuration(k.avgWinHoldMs)}).`,
      });
    } else if (ratio <= 0.67) {
      out.push({
        id: 'hold',
        tone: 'profit',
        text: `You let winners run ${(1 / ratio).toFixed(1)}× longer than losers (${fmtDuration(k.avgWinHoldMs)} vs ${fmtDuration(k.avgLossHoldMs)}) — the right way round.`,
      });
    }
  }

  // Time of day
  const hours = byHour(trades).filter((g) => g.trades >= 3);
  const worstHour = minBy(hours, (g) => g.net);
  if (worstHour && worstHour.net < 0) {
    const h = Number(worstHour.key);
    out.push({
      id: 'hour',
      tone: 'loss',
      text: `Your weakest hour is ${hourLabel(h)}–${hourLabel((h + 1) % 24)}: ${fmtMoneyProse(worstHour.net)} over ${plural(worstHour.trades, 'trade')}.`,
    });
  }

  // Untagged share (data-quality nudge, lowest priority)
  const untagged = moods.find((g) => g.key === NONE);
  if (untagged && k.trades >= 5 && untagged.trades / k.trades >= 0.3) {
    out.push({
      id: 'mood-untagged',
      tone: 'neutral',
      text: `${pct0(untagged.trades / k.trades)} of these trades have no mood logged — tag your mood when you enter so these insights get sharper.`,
    });
  }

  return out.slice(0, limit);
}
