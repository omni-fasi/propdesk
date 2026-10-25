// Trade detail drawer: chart of the trade, facts, executions and journal editing.
// Exported for reuse (the calendar's day drawer opens it on top of itself).

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Lock, Play } from 'lucide-react';
import clsx from 'clsx';
import type { Fill, Trade } from '@shared/types';
import { api, errorMessage } from '@/api/client';
import { useApp } from '@/store/app';
import { fmtDate, fmtDateTime, fmtDuration, fmtMoney, fmtPct, fmtTime } from '@/lib/format';
import { Badge, KindBadge } from '@/components/ui/Badge';
import { Button, IconButton } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Modal';
import { Money, Pnl, WorkHours } from '@/components/ui/Money';
import { Skeleton } from '@/components/ui/Misc';
import { toast } from '@/components/ui/Toast';
import { TradeChart } from './TradeChart';
import { TradeReplayModal } from './TradeReplay';
import { draftFrom, draftPatch, TradeJournalForm, type JournalDraft } from './TradeJournalForm';
import { directionClass, directionLabel, exitReasonClass, exitReasonLabel, fmtR, fmtTradePrice, fmtTradeQty, specOf } from './labels';
import { closeTime, holdTime, resultOf } from './stats';

export interface TradeDrawerProps {
  /** null = closed. */
  trade: Trade | null;
  onClose: () => void;
  /** Called with the server's copy after a journal save. */
  onUpdated?: (t: Trade) => void;
  /** Step through a list (buttons + J / K keys). */
  onPrev?: () => void;
  onNext?: () => void;
}

export function TradeDrawer(props: TradeDrawerProps) {
  if (!props.trade) return null;
  return <TradeDrawerBody key={props.trade.id} {...props} trade={props.trade} />;
}

/** Fills that belong to the trade (a flip's closing fill may carry the next trade's id). */
function tradeFills(all: Fill[], t: Trade): Fill[] {
  const own = all.filter((f) => f.tradeId === t.id);
  const close = closeTime(t);
  const hasExit = own.some((f) => Math.abs(f.ts - close) <= 1000 && f.realizedPnl !== 0);
  const flip = hasExit ? [] : all.filter((f) => f.tradeId !== t.id && f.symbol === t.symbol && Math.abs(f.ts - close) <= 1000);
  return [...own, ...flip].sort((a, b) => a.ts - b.ts);
}

function useTradeFills(t: Trade): Fill[] | null {
  const [fills, setFills] = useState<Fill[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setFills(null);
    api
      .fills({ accountId: t.accountId, from: t.openedAt - 1000, to: closeTime(t) + 1000, limit: 1000 })
      .then((rows) => !cancelled && setFills(tradeFills(rows, t)))
      .catch(() => !cancelled && setFills([]));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.id, t.accountId, t.openedAt, t.closedAt]);
  return fills;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function TradeDrawerBody({ trade, onClose, onUpdated, onPrev, onNext }: TradeDrawerProps & { trade: Trade }) {
  const account = useApp((s) => s.accounts[trade.accountId]);
  const instruments = useApp((s) => s.instrumentMap);
  const spec = specOf(instruments, trade.symbol);
  const fills = useTradeFills(trade);
  const [replay, setReplay] = useState(false);

  // `base` is the latest server copy (prop updates from outside, or the response of our own save).
  const [base, setBase] = useState(trade);
  useEffect(() => setBase(trade), [trade]);
  const [draft, setDraft] = useState<JournalDraft>(() => draftFrom(trade));
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const dirty = draftPatch(draft, base) != null;

  // Re-sync the form from the server copy when it changes and nothing is being edited.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!dirtyRef.current) setDraft(draftFrom(base));
  }, [base]);

  const save = useCallback(async (): Promise<boolean> => {
    const body = draftPatch(draft, base);
    if (!body) return true;
    setSaveState('saving');
    try {
      const updated = await api.updateTrade(base.id, body);
      setBase(updated);
      setDraft(draftFrom(updated));
      setSaveState('saved');
      onUpdated?.(updated);
      return true;
    } catch (e) {
      setSaveState('error');
      toast({ tone: 'loss', title: 'Journal not saved', description: errorMessage(e) });
      return false;
    }
  }, [draft, base, onUpdated]);

  // Leaving the drawer (close / previous / next) saves pending journal edits first.
  const leave = useCallback(
    async (go: (() => void) | undefined) => {
      if (!go) return;
      if (dirtyRef.current && !(await save())) return;
      go();
    },
    [save],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          void save();
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'j' && onNext) void leave(onNext);
      if (e.key === 'k' && onPrev) void leave(onPrev);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, leave, onNext, onPrev]);

  const result = resultOf(trade.netPnl);
  const fmtP = (p: number | null | undefined) => fmtTradePrice(instruments, trade.symbol, p);
  const hold = holdTime(trade);
  const closed = closeTime(trade);
  const capture = trade.mfe > 0.005 && trade.netPnl > 0 ? trade.netPnl / trade.mfe : null;

  return (
    <Drawer
      open
      width={800}
      onClose={() => void leave(onClose)}
      title={
        <span className="flex items-center gap-2">
          <span>{trade.symbol}</span>
          <span className={clsx('text-sm font-medium', directionClass(trade))}>{directionLabel(trade)}</span>
          <span className="truncate text-sm font-normal text-muted">{spec?.name}</span>
        </span>
      }
      subtitle={
        <span className="flex items-center gap-2">
          {account ? (
            <>
              <span className="truncate">{account.name}</span>
              <KindBadge kind={account.kind} phase={account.phase} phaseCount={account.phaseCount} size="xs" />
            </>
          ) : (
            <span>Unknown account</span>
          )}
          <span className="text-faint">·</span>
          <span className="tnum">{fmtDate(closed, { weekday: true })}</span>
        </span>
      }
      actions={
        (onPrev || onNext) && (
          <>
            <IconButton label="Previous trade (K)" icon={<ChevronUp size={16} />} disabled={!onPrev} onClick={() => void leave(onPrev)} />
            <IconButton label="Next trade (J)" icon={<ChevronDown size={16} />} disabled={!onNext} onClick={() => void leave(onNext)} />
          </>
        )
      }
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="flex items-center gap-1.5 text-2xs text-faint">
            <Lock size={12} /> Prices, fills and P&L are permanent records — only the journal can be edited.
          </span>
          <span className="flex items-center gap-2">
            <span className={clsx('text-xs', saveState === 'error' ? 'text-loss' : 'text-faint')}>
              {saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Not saved' : dirty ? 'Unsaved changes' : saveState === 'saved' ? 'Saved' : ''}
            </span>
            <Button variant="primary" size="sm" disabled={!dirty} loading={saveState === 'saving'} onClick={() => void save()} title="Save (Ctrl+Enter)">
              Save journal
            </Button>
          </span>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-2xs font-medium uppercase tracking-wider text-faint">Net P&L</div>
            <div className="flex items-baseline gap-3">
              <Pnl value={trade.netPnl} className="text-3xl font-semibold tracking-tight" />
              <span className={clsx('tnum text-base font-medium', trade.rMultiple == null ? 'text-faint' : trade.rMultiple >= 0 ? 'text-profit' : 'text-loss')}>{fmtR(trade.rMultiple)}</span>
              <Badge tone={result === 'win' ? 'profit' : result === 'loss' ? 'loss' : 'neutral'}>{result === 'win' ? 'Win' : result === 'loss' ? 'Loss' : 'Break-even'}</Badge>
            </div>
            <WorkHours value={trade.netPnl} />
          </div>
          <div className="flex items-end gap-3">
            <div className="tnum text-right text-xs text-muted">
              <div>
                {fmtDateTime(trade.openedAt)} → {fmtDate(closed) === fmtDate(trade.openedAt) ? fmtTime(closed, { seconds: false }) : fmtDateTime(closed)}
              </div>
              <div className="text-faint">held {fmtDuration(hold)}</div>
            </div>
            <Button size="sm" icon={<Play size={14} />} onClick={() => setReplay(true)} title="Watch the trade play back">
              Replay
            </Button>
          </div>
        </div>
        {replay && <TradeReplayModal trade={trade} onClose={() => setReplay(false)} />}

        <TradeChart trade={trade} fills={fills} spec={spec} />

        <div className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg border border-line px-4 py-3 sm:grid-cols-3">
          <Fact label="Avg entry" value={fmtP(trade.avgEntry)} />
          <Fact label="Avg exit" value={fmtP(trade.avgExit)} />
          <Fact label="Size" value={spec ? `${fmtTradeQty(instruments, trade.symbol, trade.maxQty)} ${spec.unitLabel}` : fmtTradeQty(instruments, trade.symbol, trade.maxQty)} sub={trade.entryQty !== trade.maxQty ? `${fmtTradeQty(instruments, trade.symbol, trade.entryQty)} in total` : undefined} />
          <Fact label="Gross P&L" value={<Money value={trade.grossPnl} sign colored />} />
          <Fact label="Fees" value={<Money value={-trade.fees} className="text-muted" />} />
          <Fact label="Net P&L" value={<Money value={trade.netPnl} sign colored />} />
          <Fact label="Initial stop" value={fmtP(trade.initialStop)} sub={trade.initialStop == null ? 'No stop when opened' : undefined} />
          <Fact label="Risk" value={<Money value={trade.riskAmount} className={trade.riskAmount == null ? 'text-faint' : undefined} />} sub={trade.riskAmount != null && account ? `${fmtPct(trade.riskAmount / account.rules.startingBalance, 2)} of the account` : undefined} />
          <Fact label="R multiple" value={fmtR(trade.rMultiple)} />
          <Fact label="MAE" value={<Money value={trade.mae} className={trade.mae < -0.005 ? 'text-loss' : 'text-faint'} />} sub="Worst open P&L" />
          <Fact label="MFE" value={<Money value={trade.mfe} className={trade.mfe > 0.005 ? 'text-profit' : 'text-faint'} />} sub={capture != null ? `Kept ${fmtPct(Math.min(1, capture), 0)} of it` : 'Best open P&L'} />
          <Fact label="Exit" value={<span className={exitReasonClass(trade.exitReason)}>{exitReasonLabel(trade.exitReason)}</span>} sub={fmtDuration(hold)} />
        </div>

        <Executions fills={fills} trade={trade} />

        <TradeJournalForm trade={base} draft={draft} onChange={(p) => setDraft((d) => ({ ...d, ...p }))} />
      </div>
    </Drawer>
  );
}

function Fact({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-2xs font-medium uppercase tracking-wider text-faint">{label}</span>
      <span className="tnum truncate text-sm font-medium text-fg">{value}</span>
      {sub && <span className="truncate text-2xs text-faint">{sub}</span>}
    </div>
  );
}

const ROLE_LABEL: Record<Fill['role'], string> = { entry: 'Entry', exit: 'Exit', stop_loss: 'Stop loss', take_profit: 'Take profit', liquidation: 'Liquidation' };

function Executions({ fills, trade }: { fills: Fill[] | null; trade: Trade }) {
  const instruments = useApp((s) => s.instrumentMap);
  return (
    <div className="rounded-lg border border-line">
      <div className="flex h-8 items-center justify-between border-b border-line px-3 text-xs font-semibold uppercase tracking-wider text-muted">
        Executions
        {fills && <span className="tnum font-normal normal-case tracking-normal text-faint">{fills.length} fill{fills.length === 1 ? '' : 's'}</span>}
      </div>
      {!fills ? (
        <div className="space-y-2 p-3">
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ) : fills.length === 0 ? (
        <div className="px-3 py-3 text-xs text-faint">No fill records found for this trade.</div>
      ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="h-7 text-2xs uppercase tracking-wider text-faint">
              <th className="px-3 text-left font-medium">Time</th>
              <th className="px-2 text-left font-medium">Side</th>
              <th className="px-2 text-right font-medium">Qty</th>
              <th className="px-2 text-right font-medium">Price</th>
              <th className="px-2 text-right font-medium">Fee</th>
              <th className="px-2 text-right font-medium">Realized</th>
              <th className="px-3 text-left font-medium">Type</th>
            </tr>
          </thead>
          <tbody>
            {fills.map((f) => (
              <tr key={f.id} className="h-7 border-t border-line/60">
                <td className="tnum px-3 text-muted">{fmtTime(f.ts)}</td>
                <td className={clsx('px-2 font-medium', f.side === 'buy' ? 'text-profit' : 'text-loss')}>{f.side === 'buy' ? 'Buy' : 'Sell'}</td>
                <td className="tnum px-2 text-right">{fmtTradeQty(instruments, f.symbol, f.qty)}</td>
                <td className="tnum px-2 text-right">{fmtTradePrice(instruments, f.symbol, f.price)}</td>
                <td className="tnum px-2 text-right text-muted">{fmtMoney(-f.fee)}</td>
                <td className="px-2 text-right">{f.realizedPnl !== 0 ? <Money value={f.realizedPnl} sign colored /> : <span className="text-faint">—</span>}</td>
                <td className="px-3 text-muted">
                  {ROLE_LABEL[f.role] ?? f.role}
                  {f.liquidity === 'maker' && <span className="ml-1 text-faint">· maker</span>}
                  {f.tradeId !== trade.id && <span className="ml-1 text-faint">· flip</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
