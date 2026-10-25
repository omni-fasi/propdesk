// Confirmation summary: every $ figure of the order in one place.

import type { InstrumentSpec } from '@shared/types';
import { MOOD_MAP } from '@shared/journal';
import { fmtLeverage, fmtMoney, fmtPct, fmtPrice, fmtQtyWithUnit } from '@/lib/format';
import { WorkHours } from '@/components/ui/Money';
import type { Ticket } from '../store';
import type { TicketChecks } from './checks';
import type { TicketCalc } from './riskMath';

function R({ k, v, tone }: { k: string; v: React.ReactNode; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-0.5">
      <span className="text-muted">{k}</span>
      <span className={`tnum text-right ${tone ?? 'text-fg'}`}>{v}</span>
    </div>
  );
}

export function OrderSummary({ spec, ticket, calc, checks }: { spec: InstrumentSpec; ticket: Ticket; calc: TicketCalc; checks: TicketChecks }) {
  const mood = ticket.mood ? MOOD_MAP[ticket.mood] : null;
  return (
    <div className="flex flex-col gap-2 text-[13px]">
      <div className="rounded-md border border-line bg-panel-2 px-3 py-2">
        <R k="Size" v={`${fmtQtyWithUnit(spec, calc.qty)} · worth ${fmtMoney(calc.notional, { whole: true })}`} />
        <R k={ticket.type === 'market' ? 'Entry (now)' : ticket.type === 'limit' ? 'Limit price' : 'Stop trigger'} v={calc.entry != null ? fmtPrice(spec, calc.entry) : '—'} />
        <R k="Stop-loss (net)" v={calc.sl != null ? `${fmtPrice(spec, calc.sl)} · ${fmtMoney(-(calc.risk ?? 0))}` : 'none'} tone={calc.sl != null ? 'text-loss' : 'text-warn'} />
        <R k="Take-profit (net)" v={calc.tp != null ? `${fmtPrice(spec, calc.tp)} · ${fmtMoney(calc.reward ?? 0, { sign: true })}` : 'none'} tone={calc.tp == null ? 'text-muted' : (calc.reward ?? 0) > 0 ? 'text-profit' : 'text-loss'} />
        {calc.rr != null && <R k="Risk : reward" v={`1 : ${calc.rr.toFixed(2)}`} />}
        <R k="Fees" v={calc.feesAtStop != null || calc.feesAtTarget != null ? `${fmtMoney(calc.feesAtTarget ?? calc.feesAtStop ?? 0)} at target · ${fmtMoney(calc.feesAtStop ?? calc.fees)} at stop` : fmtMoney(calc.fees)} />
        {checks.pctMaxLoss != null && <R k="Of max-loss buffer" v={fmtPct(checks.pctMaxLoss, 1)} tone={checks.pctMaxLoss >= 1 ? 'text-loss' : undefined} />}
        {checks.pctDaily != null && <R k="Of daily-loss buffer" v={fmtPct(checks.pctDaily, 1)} tone={checks.pctDaily >= 1 ? 'text-loss' : undefined} />}
        {checks.margin != null && <R k="Margin held" v={`${fmtMoney(checks.margin.held, { whole: true })} (${fmtLeverage(checks.margin.leverage)}) · back when you close`} />}
        {(mood || ticket.setup) && <R k="Check-in" v={`${mood ? `${mood.emoji} ${mood.label}` : ''}${mood && ticket.setup ? ' · ' : ''}${ticket.setup ?? ''}`} />}
      </div>
      {calc.risk != null && calc.risk > 0 && (
        <div className="text-xs">
          You could lose {fmtMoney(calc.risk)} including fees <WorkHours value={calc.risk} />
        </div>
      )}
      {checks.riskyReasons.length > 0 && (
        <div className="rounded-md bg-warn/10 px-3 py-2 text-xs text-warn">Risky: {checks.riskyReasons.join(' · ')}. Hold the button to confirm.</div>
      )}
    </div>
  );
}
