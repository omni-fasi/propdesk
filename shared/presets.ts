// Prop-firm style challenge presets (generic, no real firm branding) and rule builders.

import type { AccountRules, AssetClass, ChallengePreset, DrawdownMode, PayoutPolicy, ZonedTime } from './types.ts';

export const NY_ROLLOVER: ZonedTime = { hour: 17, minute: 0, tz: 'America/New_York' };
export const LOCAL_MIDNIGHT: ZonedTime = { hour: 0, minute: 0, tz: 'local' };
export const NY_FLAT_BY: ZonedTime = { hour: 16, minute: 10, tz: 'America/New_York' };

const CFD_CLASSES: AssetClass[] = ['forex', 'crypto', 'metals', 'energy', 'stocks'];
const CFD_LEVERAGE: Partial<Record<AssetClass, number>> = { forex: 50, metals: 20, energy: 10, stocks: 5, crypto: 3 };

function futuresRules(start: number, target: number, maxLoss: number, dailyLoss: number | null, maxContracts: number, mode: DrawdownMode = 'trailing_eod'): AccountRules {
  return {
    startingBalance: start,
    profitTarget: target,
    maxLoss: { amount: maxLoss, mode, lockAt: mode === 'trailing_intraday' ? start + 100 : start },
    dailyLoss: dailyLoss == null ? null : { amount: dailyLoss, action: 'lock' },
    minTradingDays: 2,
    maxCalendarDays: null,
    consistencyPct: 0.5,
    maxContracts,
    leverage: null,
    allowedClasses: ['futures'],
    flatBy: NY_FLAT_BY,
    noWeekendHolding: true,
    rollover: NY_ROLLOVER,
  };
}

function funded(rules: AccountRules, payout: PayoutPolicy): { rules: AccountRules; payout: PayoutPolicy } {
  return { rules: { ...rules, profitTarget: null, minTradingDays: 0, maxCalendarDays: null, consistencyPct: null }, payout };
}

function futuresPreset(id: string, size: number, target: number, maxLoss: number, dailyLoss: number, contracts: number, fee: number, resetFee: number, minDayProfit: number): ChallengePreset {
  const rules = futuresRules(size, target, maxLoss, dailyLoss, contracts);
  const k = `${size / 1000}K`;
  return {
    id,
    name: `Futures ${k}`,
    tagline: 'End-of-day trailing drawdown · 1 step',
    style: 'futures',
    fee,
    resetFee,
    activationFee: 149,
    rules,
    phases: [{ name: 'Evaluation', profitTarget: target, minTradingDays: 2, maxCalendarDays: null }],
    funded: funded(rules, { profitSplit: 0.9, minWinningDays: 5, minDayProfit, maxPctOfProfit: 0.5, minAmount: 250 }),
    highlights: [
      `Hit +$${target.toLocaleString('en-US')} without losing $${maxLoss.toLocaleString('en-US')}`,
      `Max loss trails your best end-of-day balance, locks at $${size.toLocaleString('en-US')}`,
      `Daily loss limit $${dailyLoss.toLocaleString('en-US')} pauses trading until tomorrow`,
      `Max ${contracts} minis (${contracts * 10} micros) · flat by 4:10 PM ET`,
      'Best day must be ≤ 50% of total profit',
    ],
  };
}

const intraday = futuresRules(50_000, 3_000, 2_500, null, 10, 'trailing_intraday');
intraday.minTradingDays = 1;
intraday.consistencyPct = null;

const cfd50: AccountRules = {
  startingBalance: 50_000,
  profitTarget: 5_000,
  maxLoss: { amount: 5_000, mode: 'static', lockAt: null },
  dailyLoss: { amount: 2_500, action: 'fail' },
  minTradingDays: 4,
  maxCalendarDays: null,
  consistencyPct: null,
  maxContracts: null,
  leverage: CFD_LEVERAGE,
  allowedClasses: CFD_CLASSES,
  flatBy: null,
  noWeekendHolding: false,
  rollover: LOCAL_MIDNIGHT,
};

const cfd100: AccountRules = {
  ...cfd50,
  startingBalance: 100_000,
  profitTarget: 10_000,
  maxLoss: { amount: 10_000, mode: 'static', lockAt: null },
  dailyLoss: { amount: 5_000, action: 'fail' },
};

const allDay25: AccountRules = {
  startingBalance: 25_000,
  profitTarget: 2_500,
  maxLoss: { amount: 1_500, mode: 'trailing_eod', lockAt: 25_000 },
  dailyLoss: { amount: 750, action: 'fail' },
  minTradingDays: 3,
  maxCalendarDays: null,
  consistencyPct: 0.5,
  maxContracts: null,
  leverage: { crypto: 3, metals: 20, energy: 10, stocks: 5 },
  allowedClasses: ['crypto', 'metals', 'energy', 'stocks'],
  flatBy: null,
  noWeekendHolding: false,
  rollover: LOCAL_MIDNIGHT,
};

export const PRESETS: ChallengePreset[] = [
  futuresPreset('fut-50k', 50_000, 3_000, 2_000, 1_000, 5, 149, 99, 150),
  futuresPreset('fut-100k', 100_000, 6_000, 3_000, 2_000, 10, 249, 149, 200),
  futuresPreset('fut-150k', 150_000, 9_000, 4_500, 3_000, 15, 349, 199, 250),
  {
    id: 'fut-50k-intraday',
    name: 'Futures 50K · Intraday trailing',
    tagline: 'Drawdown trails every tick of open profit · 1 step',
    style: 'futures',
    fee: 167,
    resetFee: 80,
    activationFee: 130,
    rules: intraday,
    phases: [{ name: 'Evaluation', profitTarget: 3_000, minTradingDays: 1, maxCalendarDays: null }],
    funded: funded(intraday, { profitSplit: 0.9, minWinningDays: 5, minDayProfit: 100, maxPctOfProfit: 0.5, minAmount: 500 }),
    highlights: [
      'Hit +$3,000 without losing $2,500',
      'Max loss trails your peak equity in real time (open profit counts!)',
      'Stops trailing at $50,100 · no daily loss limit',
      'Max 10 minis (100 micros) · flat by 4:10 PM ET',
    ],
  },
  {
    id: 'cfd-2step-50k',
    name: '2-Step 50K',
    tagline: 'Forex · gold · crypto · stocks · static drawdown',
    style: 'cfd',
    fee: 345,
    resetFee: 299,
    activationFee: 0,
    rules: cfd50,
    phases: [
      { name: 'Phase 1', profitTarget: 5_000, minTradingDays: 4, maxCalendarDays: null },
      { name: 'Phase 2', profitTarget: 2_500, minTradingDays: 4, maxCalendarDays: null },
    ],
    funded: funded(cfd50, { profitSplit: 0.8, minWinningDays: 2, minDayProfit: 100, maxPctOfProfit: 1, minAmount: 100 }),
    highlights: [
      'Phase 1: +$5,000 (10%) · Phase 2: +$2,500 (5%)',
      'Static max loss $5,000 (10%) — never moves',
      'Daily loss $2,500 (5%) fails the account',
      'Minimum 4 trading days per phase · 80% profit split',
    ],
  },
  {
    id: 'cfd-2step-100k',
    name: '2-Step 100K',
    tagline: 'Forex · gold · crypto · stocks · static drawdown',
    style: 'cfd',
    fee: 540,
    resetFee: 459,
    activationFee: 0,
    rules: cfd100,
    phases: [
      { name: 'Phase 1', profitTarget: 10_000, minTradingDays: 4, maxCalendarDays: null },
      { name: 'Phase 2', profitTarget: 5_000, minTradingDays: 4, maxCalendarDays: null },
    ],
    funded: funded(cfd100, { profitSplit: 0.8, minWinningDays: 2, minDayProfit: 200, maxPctOfProfit: 1, minAmount: 100 }),
    highlights: [
      'Phase 1: +$10,000 (10%) · Phase 2: +$5,000 (5%)',
      'Static max loss $10,000 (10%)',
      'Daily loss $5,000 (5%) fails the account',
      'Minimum 4 trading days per phase · 80% profit split',
    ],
  },
  {
    id: 'allday-1step-25k',
    name: '24/7 1-Step 25K',
    tagline: 'Crypto · gold · oil · stocks perps — trade weekends too',
    style: 'crypto',
    fee: 199,
    resetFee: 179,
    activationFee: 0,
    rules: allDay25,
    phases: [{ name: 'Evaluation', profitTarget: 2_500, minTradingDays: 3, maxCalendarDays: null }],
    funded: funded(allDay25, { profitSplit: 0.9, minWinningDays: 3, minDayProfit: 100, maxPctOfProfit: 1, minAmount: 100 }),
    highlights: [
      'Hit +$2,500 (10%) without losing $1,500 (6%)',
      'Max loss trails your best end-of-day balance, locks at $25,000',
      'Daily loss $750 (3%) fails the account',
      'Best day ≤ 50% of profit · markets open 24/7',
    ],
  },
];

export const PRESET_MAP: Record<string, ChallengePreset> = Object.fromEntries(PRESETS.map((p) => [p.id, p]));

/** Evaluation rules for a phase (0-based index). */
export function rulesForPhase(preset: ChallengePreset, phaseIndex: number): AccountRules {
  const ph = preset.phases[phaseIndex] ?? preset.phases[0];
  return { ...preset.rules, profitTarget: ph.profitTarget, minTradingDays: ph.minTradingDays, maxCalendarDays: ph.maxCalendarDays };
}

/** Rules for a practice account: no challenge limits, sane leverage so sizes stay realistic. */
export function practiceRules(startingBalance = 50_000): AccountRules {
  return {
    startingBalance,
    profitTarget: null,
    maxLoss: null,
    dailyLoss: null,
    minTradingDays: 0,
    maxCalendarDays: null,
    consistencyPct: null,
    maxContracts: Math.max(5, Math.round(startingBalance / 5_000)),
    leverage: { forex: 50, metals: 20, energy: 10, stocks: 5, crypto: 10 },
    allowedClasses: null,
    flatBy: null,
    noWeekendHolding: false,
    rollover: LOCAL_MIDNIGHT,
  };
}

export interface CustomChallengeInput {
  startingBalance: number;
  profitTarget: number;
  maxLoss: number;
  maxLossMode: DrawdownMode;
  dailyLoss: number | null;
  dailyLossAction: 'fail' | 'lock';
  minTradingDays: number;
  consistencyPct: number | null;
  /** futures: CME futures only (NY rollover, flat by 4:10 PM ET). cfd: everything else. all: every market. */
  markets: 'futures' | 'cfd' | 'all';
  maxContracts: number | null;
}

export function buildCustomRules(input: CustomChallengeInput): AccountRules {
  const futuresOnly = input.markets === 'futures';
  return {
    startingBalance: input.startingBalance,
    profitTarget: input.profitTarget,
    maxLoss: {
      amount: input.maxLoss,
      mode: input.maxLossMode,
      lockAt: input.maxLossMode === 'static' ? null : input.startingBalance,
    },
    dailyLoss: input.dailyLoss ? { amount: input.dailyLoss, action: input.dailyLossAction } : null,
    minTradingDays: input.minTradingDays,
    maxCalendarDays: null,
    consistencyPct: input.consistencyPct,
    maxContracts: input.markets === 'cfd' ? null : (input.maxContracts ?? Math.max(1, Math.round(input.startingBalance / 10_000))),
    leverage: futuresOnly ? null : CFD_LEVERAGE,
    allowedClasses: futuresOnly ? ['futures'] : input.markets === 'cfd' ? CFD_CLASSES : null,
    flatBy: futuresOnly ? NY_FLAT_BY : null,
    noWeekendHolding: futuresOnly,
    rollover: futuresOnly ? NY_ROLLOVER : LOCAL_MIDNIGHT,
  };
}

/** A believable price for a custom challenge of this size. */
export function suggestedFee(startingBalance: number): number {
  return Math.max(49, Math.round(startingBalance * 0.003) - 1);
}
