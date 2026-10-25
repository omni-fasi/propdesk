// Wallet summary from the transaction ledger (the trader's personal "prop budget"). See SPEC §6.

import type { WalletSummary, WalletTx } from '../../../shared/types.ts';
import { round2 } from '../../../shared/risk.ts';
import { calendarDayOf, monthKeyOf } from '../../../shared/time.ts';

const FEE_KINDS: ReadonlySet<WalletTx['kind']> = new Set(['challenge_fee', 'reset_fee', 'activation_fee']);

/** `txs` newest first. monthSpent = fees paid in the current calendar month of `localTz`. */
export function walletSummary(txs: WalletTx[], monthBudget: number | null, localTz: string, now: number): WalletSummary {
  const month = monthKeyOf(calendarDayOf(now, localTz));
  let deposited = 0;
  let withdrawn = 0;
  let feesPaid = 0;
  let payouts = 0;
  let monthSpent = 0;
  for (const t of txs) {
    if (t.kind === 'deposit') deposited += t.amount;
    else if (t.kind === 'withdrawal') withdrawn += Math.abs(t.amount);
    else if (t.kind === 'payout') payouts += t.amount;
    else if (FEE_KINDS.has(t.kind)) {
      feesPaid += Math.abs(t.amount);
      if (monthKeyOf(calendarDayOf(t.ts, localTz)) === month) monthSpent += Math.abs(t.amount);
    }
  }
  return {
    balance: txs[0]?.balanceAfter ?? 0,
    deposited: round2(deposited),
    withdrawn: round2(withdrawn),
    feesPaid: round2(feesPaid),
    payouts: round2(payouts),
    net: round2(payouts - feesPaid),
    monthSpent: round2(monthSpent),
    monthBudget,
  };
}
