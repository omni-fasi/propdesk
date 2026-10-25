// Account-aware checks for the order ticket: what blocks submission, what deserves a warning, and whether
// an order counts as "risky" (stronger confirmation). Mirrors the server's validation where it can tell
// client-side; the server stays the authority.

import type { Account, AccountLock, InstrumentSpec, OrderType, Position, SessionState, Settings } from '@shared/types';
import { ASSET_CLASS_LABELS } from '@shared/instruments';
import { contractsEquivalent, notional } from '@shared/risk';
import { fmtLeverage, fmtMoney, fmtPct, fmtQty } from '@/lib/format';
import { isEntry, type SizeMode, type TicketCalc } from './riskMath';

export type BlockAction = 'accounts' | 'checkin' | null;

export interface TicketBlock {
  text: string;
  action: BlockAction;
  tone: 'muted' | 'warn' | 'loss';
}

export interface TicketWarning {
  tone: 'info' | 'warn' | 'loss';
  text: string;
}

export interface CheckContext {
  account: Account | null;
  spec: InstrumentSpec;
  calc: TicketCalc;
  type: OrderType;
  price: number | null;
  position: Position | null;
  positions: Position[];
  instrumentMap: Record<string, InstrumentSpec>;
  equity: number | null;
  dayPnl: number | null;
  maxLossBuffer: number | null;
  dailyLossBuffer: number | null;
  settings: Settings;
  session: SessionState | null;
  sessionText: string;
  connected: boolean;
  hasQuote: boolean;
  lock: AccountLock | null;
  checkinMissing: boolean;
  sizeMode: SizeMode;
  riskInput: number | null;
  valueInput: number | null;
  /** The stop-loss field has a usable value. */
  slSet: boolean;
}

/** Margin on leveraged accounts: a deposit of position value ÷ leverage, held while the position is open. */
export interface MarginInfo {
  /** Held for this order's size. */
  held: number;
  leverage: number;
  /** Already held by positions in other symbols. */
  others: number;
  /** Largest position value in this symbol the account can hold right now: (equity − others) × leverage. */
  maxValue: number | null;
  equity: number | null;
}

export interface TicketChecks {
  block: TicketBlock | null;
  warnings: TicketWarning[];
  risky: boolean;
  riskyReasons: string[];
  /** Net loss at the stop (fees included) / max-loss buffer. */
  pctMaxLoss: number | null;
  pctDaily: number | null;
  margin: MarginInfo | null;
  contractsAfter: number | null;
}

const STATUS_TEXT: Record<Account['status'], string> = {
  active: 'active',
  passed: 'passed',
  failed: 'failed',
  closed: 'been closed',
};

function fmtContracts(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function runChecks(c: CheckContext): TicketChecks {
  const { account, spec, calc, settings } = c;
  const rules = account?.rules ?? null;
  const entry = isEntry(calc.effect) && calc.qty > 0;
  const warnings: TicketWarning[] = [];
  const riskyReasons: string[] = [];

  // calc.risk already includes the entry and stop commissions.
  const cost = calc.risk;
  const pctMaxLoss = cost != null && c.maxLossBuffer != null && c.maxLossBuffer > 0 ? cost / c.maxLossBuffer : null;
  const pctDaily = cost != null && c.dailyLossBuffer != null && c.dailyLossBuffer > 0 ? cost / c.dailyLossBuffer : null;

  // Margin (leveraged accounts only).
  let margin: MarginInfo | null = null;
  let marginAfter: number | null = null;
  // Futures are governed by the contract limit (maxContracts), not notional margin — same as the server.
  const futuresByContracts = spec.assetClass === 'futures' && rules?.maxContracts != null;
  if (rules?.leverage && !futuresByContracts) {
    const lev = (cls: InstrumentSpec['assetClass']) => rules.leverage?.[cls] ?? 1;
    const leverage = lev(spec.assetClass);
    let others = 0;
    for (const p of c.positions) {
      if (p.symbol === spec.symbol) continue;
      const s = c.instrumentMap[p.symbol];
      if (s && !(s.assetClass === 'futures' && rules.maxContracts != null)) others += notional(s, p.qty, p.markPrice || p.avgPrice) / lev(s.assetClass);
    }
    const px = calc.entry ?? 0;
    if (px > 0) {
      marginAfter = others + notional(spec, calc.effect.after, px) / leverage;
      margin = {
        held: notional(spec, calc.qty, px) / leverage,
        leverage,
        others,
        maxValue: c.equity != null ? Math.max(0, (c.equity - others) * leverage) : null,
        equity: c.equity,
      };
    }
  }

  // Futures position limit.
  let contractsAfter: number | null = null;
  if (rules?.maxContracts != null && spec.miniEquivalent != null) {
    let total = 0;
    for (const p of c.positions) {
      if (p.symbol === spec.symbol) continue;
      const s = c.instrumentMap[p.symbol];
      if (s) total += contractsEquivalent(s, p.qty);
    }
    contractsAfter = Number((total + contractsEquivalent(spec, calc.effect.after)).toFixed(4));
  }

  // ── Notes about what the order does to the open positions ──
  const pos = c.position;
  if (pos && calc.qty > 0) {
    const count = c.positions.filter((p) => p.symbol === spec.symbol).length;
    const side = pos.qty > 0 ? 'LONG' : 'SHORT';
    const cur = `${side} ${fmtQty(spec, Math.abs(pos.qty))}`;
    const yours = count > 1 ? `your ${count} ${side} positions (${fmtQty(spec, Math.abs(pos.qty))})` : `your ${cur}`;
    const afterSide = calc.effect.after > 0 ? 'LONG' : 'SHORT';
    const after = `${afterSide} ${fmtQty(spec, Math.abs(calc.effect.after))}`;
    if (calc.effect.kind === 'reduce')
      warnings.push({ tone: 'info', text: `Closes ${fmtQty(spec, calc.qty)} of ${yours}${count > 1 ? ', oldest first' : ''}. Stops and targets stay as they are.` });
    else if (calc.effect.kind === 'close') warnings.push({ tone: 'info', text: `Closes ${yours}.` });
    else if (calc.effect.kind === 'flip') warnings.push({ tone: 'info', text: `Closes ${yours} and opens a ${after} — this order's stop and target go on the new position.` });
    else if (calc.effect.kind === 'add')
      warnings.push({ tone: 'info', text: `Opens a separate position with its own stop and target — ${yours} keep${count > 1 ? '' : 's'} theirs. Risk shown is for this one.` });
  }

  if (entry) {
    if (calc.sl == null) {
      riskyReasons.push('No stop-loss');
      if (!settings.requireStopLoss) {
        const left = c.maxLossBuffer != null ? ` You have ${fmtMoney(c.maxLossBuffer)} left before the account fails.` : '';
        warnings.push({ tone: 'warn', text: `No stop-loss — the loss is open-ended.${left}` });
      }
    }
    if (cost != null && c.maxLossBuffer != null && cost >= c.maxLossBuffer) {
      warnings.push({ tone: 'loss', text: `This stop would breach your max loss limit — the account would fail (${fmtMoney(c.maxLossBuffer)} left).` });
      riskyReasons.push('Stop beyond the max-loss limit');
    } else if (pctMaxLoss != null && pctMaxLoss >= settings.riskyPct) {
      warnings.push({ tone: 'warn', text: `Risks ${fmtPct(pctMaxLoss, 0)} of your max-loss buffer (your limit is ${fmtPct(settings.riskyPct, 0)}).` });
      riskyReasons.push(`${fmtPct(pctMaxLoss, 0)} of the max-loss buffer`);
    }
    if (cost != null && c.dailyLossBuffer != null && cost >= c.dailyLossBuffer) {
      warnings.push({ tone: 'loss', text: `This stop would breach your daily loss limit (${fmtMoney(c.dailyLossBuffer)} left today).` });
      riskyReasons.push('Stop beyond the daily loss limit');
    }
    const personal = settings.tilt.enabled ? settings.tilt.personalDailyLoss : null;
    if (cost != null && personal != null && c.dayPnl != null && c.dayPnl - cost <= -personal) {
      warnings.push({ tone: 'warn', text: `A stop-out would hit your personal daily stop of ${fmtMoney(personal, { whole: true })}.` });
      riskyReasons.push('Hits your personal daily stop');
    }
    // Commissions are charged on the position VALUE, so a big position with tight levels barely pays —
    // at the target and at the stop, each checked on its own (a target must not hide a fee-heavy stop).
    if (calc.grossReward != null && calc.feesAtTarget != null && calc.grossReward > 0) {
      const share = calc.feesAtTarget / calc.grossReward;
      if (calc.reward != null && calc.reward <= 0)
        warnings.push({ tone: 'loss', text: `Fees (${fmtMoney(calc.feesAtTarget)}) are bigger than the move to your target (+${fmtMoney(calc.grossReward)}) — you'd lose money even if it's hit.` });
      else if (share >= 0.3)
        warnings.push({ tone: 'warn', text: `Fees eat ${fmtPct(share, 0)} of your target: +${fmtMoney(calc.grossReward)} move − ${fmtMoney(calc.feesAtTarget)} fees = +${fmtMoney(calc.reward ?? 0)}. Widen the target or trade smaller.` });
    }
    if (calc.grossRisk != null && calc.feesAtStop != null && calc.risk != null && calc.risk > 0 && calc.feesAtStop / calc.risk >= 0.3) {
      warnings.push({
        tone: 'warn',
        text: `${fmtPct(calc.feesAtStop / calc.risk, 0)} of a stop-out would be fees: ${fmtMoney(calc.feesAtStop)} of the ${fmtMoney(calc.risk)} you'd lose. Fees are a % of the position's value, paid in and out — a wider stop with a smaller size risks the same with less going to fees.`,
      });
    }
    if (rules?.maxContracts != null && contractsAfter != null && contractsAfter > rules.maxContracts + 1e-9) {
      warnings.push({
        tone: 'loss',
        text: `Max position size is ${rules.maxContracts} contracts (${rules.maxContracts * 10} micros) — this would make ${fmtContracts(contractsAfter)}.`,
      });
    }
    if (margin && marginAfter != null && c.equity != null && marginAfter > c.equity) {
      const after = calc.entry != null ? notional(spec, calc.effect.after, calc.entry) : 0;
      const others = margin.others > 0 ? ` (your other positions already hold ${fmtMoney(margin.others, { whole: true })} of margin)` : '';
      warnings.push({
        tone: 'loss',
        text: `Too big for this account: ${fmtLeverage(margin.leverage)} leverage lets you hold up to ${fmtMoney(margin.maxValue ?? 0, { whole: true })} of ${spec.symbol} right now${others} — this would make your position ${fmtMoney(after, { whole: true })}. A stop-loss doesn't raise the limit.`,
      });
    }
  }

  // ── What blocks the button (first match wins) ──
  let block: TicketBlock | null = null;
  const set = (text: string, tone: TicketBlock['tone'] = 'muted', action: BlockAction = null) => {
    if (!block) block = { text, tone, action };
  };
  if (!account) set('Create a challenge or live account to start trading.', 'muted', 'accounts');
  else if (account.status !== 'active') set(`This account has ${STATUS_TEXT[account.status]} — trading is closed.`, 'muted', 'accounts');
  if (!c.connected) set('Disconnected from the server — reconnecting…', 'loss');
  if (c.session && !c.session.open) set(c.sessionText || 'Market closed', 'muted');
  if (!c.hasQuote) set('Waiting for a price…', 'muted');
  if (rules?.allowedClasses && !rules.allowedClasses.includes(spec.assetClass)) {
    const allowed = rules.allowedClasses.map((k) => ASSET_CLASS_LABELS[k]).join(', ');
    set(`${ASSET_CLASS_LABELS[spec.assetClass]} isn't allowed on this account (allowed: ${allowed}).`, 'warn');
  }
  if (c.lock && (entry || calc.qty === 0)) set(`Locked — ${c.lock.message}`, 'warn');
  if (calc.errors.length) set(calc.errors[0], 'warn');
  if (c.type !== 'market' && (c.price == null || !(c.price > 0))) set(`Enter a ${c.type} price`, 'muted');
  if (calc.qty <= 0) {
    if (c.sizeMode === 'risk') {
      if (!c.slSet) set('Set a stop-loss to size by risk', 'muted');
      else if (!(c.riskInput != null && c.riskInput > 0)) set('Enter the $ amount you want to risk', 'muted');
      else if (calc.riskTooSmall) set('Risk too small for the minimum size at this stop.', 'warn');
      else set('Enter a size', 'muted');
    } else if (c.sizeMode === 'value') {
      if (!(c.valueInput != null && c.valueInput > 0)) set('Enter the $ value of the position', 'muted');
      else if (calc.valueTooSmall && calc.entry != null)
        set(`Too small: the minimum size (${spec.minQty} ${spec.unitLabel}) is worth ${fmtMoney(notional(spec, spec.minQty, calc.entry), { whole: true })}.`, 'warn');
      else set('Enter a size', 'muted');
    } else set('Enter a size', 'muted');
  }
  if (settings.requireStopLoss && entry && calc.sl == null) set('A stop-loss is required (Settings › Discipline).', 'warn');
  if (c.checkinMissing && entry) set('Check in first: how are you feeling?', 'warn', 'checkin');

  return {
    block,
    warnings,
    risky: entry && riskyReasons.length > 0,
    riskyReasons,
    pctMaxLoss,
    pctDaily,
    margin,
    contractsAfter,
  };
}
