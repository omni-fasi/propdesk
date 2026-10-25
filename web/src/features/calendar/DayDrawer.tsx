// Day drawer: the day's numbers and flags (with lock times), intraday P&L curve, trades & fills, and the day journal note.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, NotebookPen } from 'lucide-react';
import clsx from 'clsx';
import type { Account, DayNote, EquityPoint, Fill, Trade } from '@shared/types';
import { addDays, parseDayKey, tradingDayBounds } from '@shared/time';
import { api, errorMessage } from '@/api/client';
import { useApp } from '@/store/app';
import { useNow } from '@/store/hooks';
import { fmtMoney, fmtPct, fmtTime } from '@/lib/format';
import { navigate } from '@/lib/router';
import { Button, IconButton } from '@/components/ui/Button';
import { Drawer } from '@/components/ui/Modal';
import { Money } from '@/components/ui/Money';
import { Skeleton } from '@/components/ui/Misc';
import { Tabs } from '@/components/ui/Tabs';
import { accountName, directionClass, directionLabel, exitReasonClass, exitReasonLabel, fmtDayLong, fmtR, fmtTradePrice, fmtTradeQty, moodEmoji, moodLabel, plural } from '../journal/labels';
import { chronological, closeTime, computeKpis } from '../journal/stats';
import { TradeDrawer } from '../journal/TradeDrawer';
import { dayLockSpans, isTraded, type DayAgg, type LockSpan } from './calendarMath';
import { FLAG_INFO, FLAG_TONE_CLASS, flagAccounts, sortedFlags } from './flags';
import { DayNoteEditor } from './DayNoteEditor';
import { IntradayChart } from './IntradayChart';
import { useLiveDayRefresh } from './useMonthData';

function localMidnight(key: string): number {
  const { year, month, day } = parseDayKey(key);
  return new Date(year, month - 1, day).getTime();
}

interface DayData {
  trades: Trade[];
  fills: Fill[];
  notes: DayNote[];
  equity: EquityPoint[] | null;
  locks: LockSpan[];
}

function useDayData(day: string, accountId: string) {
  const account = useApp((s) => (accountId === 'all' ? null : (s.accounts[accountId] ?? null)));
  const rollover = account?.rules.rollover;
  const [state, setState] = useState<{ key: string; data: DayData | null; error: string | null }>({ key: '', data: null, error: null });
  const [nonce, setNonce] = useState(0);
  const key = `${day}|${accountId}`;

  useEffect(() => {
    let cancelled = false;
    // Wide enough for 17:00 New York rollovers: trades of trading day D may close on D−1 (local).
    const from = localMidnight(addDays(day, -1));
    const to = localMidnight(addDays(day, 2)) - 1;
    const bounds = rollover ? tradingDayBounds(day, rollover) : null;
    Promise.all([
      api.trades({ accountId, from, to, status: 'closed', limit: 2000 }),
      api.fills({ accountId, from, to, limit: 5000 }),
      api.notes({ from: day, to: day }),
      bounds ? api.equity({ accountId, from: bounds.start, to: bounds.end }).catch(() => null) : Promise.resolve(null),
      api.events({ accountId, from, before: to + 1, limit: 1000 }).catch(() => []),
    ])
      .then(([trades, fills, notes, equity, events]) => {
        if (cancelled) return;
        setState({
          key,
          error: null,
          data: {
            trades: chronological(trades.filter((t) => t.tradingDay === day)),
            fills: fills.filter((f) => f.tradingDay === day).sort((a, b) => a.ts - b.ts),
            notes,
            equity,
            locks: dayLockSpans(events, day, (id) => useApp.getState().accounts[id]?.rules.rollover),
          },
        });
      })
      .catch((e) => !cancelled && setState((s) => ({ ...s, key, error: errorMessage(e) })));
    return () => {
      cancelled = true;
    };
  }, [key, day, accountId, rollover, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useLiveDayRefresh(accountId, day, day, reload, 500);

  const replaceTrade = useCallback((t: Trade) => {
    setState((s) => (s.data ? { ...s, data: { ...s.data, trades: s.data.trades.map((x) => (x.id === t.id ? t : x)) } } : s));
  }, []);

  return { data: state.key === key ? state.data : null, error: state.key === key ? state.error : null, reload, replaceTrade, account };
}

/** When the flag's locks were in force: 17:03 → 17:08 · Voluntary 5-minute break. */
function LockTimes({ spans, accounts }: { spans: LockSpan[]; accounts: Record<string, Account> | null }) {
  const now = useNow(15_000);
  return spans.map((s) => (
    <span key={`${s.accountId}|${s.from}`} className="mt-1 block text-xs text-muted">
      <span className="tnum text-fg">
        {fmtTime(s.from, { seconds: false })} → {s.untilDayEnd ? 'end of day' : fmtTime(s.to, { seconds: false })}
      </span>
      {now < s.to && <span className="text-fg"> (still on)</span>}
      {accounts && ` · ${accountName(accounts, s.accountId)}`} · {s.message}
    </span>
  ));
}

function Fact({ label, children, sub }: { label: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-2xs font-medium uppercase tracking-wider text-faint">{label}</span>
      <span className="tnum truncate text-sm font-semibold text-fg">{children}</span>
      {sub != null && <span className="tnum truncate text-2xs text-muted">{sub}</span>}
    </div>
  );
}

export interface DayDrawerProps {
  day: string | null;
  accountId: string;
  agg: DayAgg | undefined;
  onClose: () => void;
  onNavigate: (day: string) => void;
}

export function DayDrawer({ day, ...rest }: DayDrawerProps) {
  if (!day) return null;
  return <DayDrawerBody day={day} {...rest} />;
}

type Tab = 'trades' | 'fills';

function DayDrawerBody({ day, accountId, agg, onClose, onNavigate }: DayDrawerProps & { day: string }) {
  const accounts = useApp((s) => s.accounts);
  const instruments = useApp((s) => s.instrumentMap);
  const { data, error, reload, replaceTrade, account } = useDayData(day, accountId);
  const [tab, setTab] = useState<Tab>('trades');
  const [openTradeId, setOpenTradeId] = useState<string | null>(null);
  const trades = data?.trades ?? [];
  const openIdx = openTradeId ? trades.findIndex((t) => t.id === openTradeId) : -1;
  const openTrade = openIdx >= 0 ? trades[openIdx] : null;
  const k = useMemo(() => computeKpis(trades), [trades]);
  const tradesNet = Math.round(trades.reduce((s, t) => s + t.netPnl, 0) * 100) / 100;
  const traded = isTraded(agg);
  const net = agg?.net ?? tradesNet;
  const scope = accountId === 'all' ? null : accountId;
  const myNote = data?.notes.find((n) => (n.accountId ?? null) === scope) ?? null;
  const otherNotes = (data?.notes ?? []).filter((n) => (n.accountId ?? null) !== scope && (n.text.trim() || n.mood));
  const startBalance = account && agg?.rows[0] ? agg.rows[0].startBalance : null;
  const flags = agg ? sortedFlags(agg.flags) : [];
  const mismatch = data != null && agg != null && Math.abs(agg.net - tradesNet) >= 0.01;

  useEffect(() => setOpenTradeId(null), [day, accountId]);

  return (
    <>
      <Drawer
        open
        width={720}
        onClose={() => {
          // Esc reaches both drawers: while a trade is open on top, only the trade drawer closes.
          if (!openTradeId) onClose();
        }}
        title={fmtDayLong(day)}
        subtitle={accountId === 'all' ? 'All accounts' : (account?.name ?? 'Account')}
        actions={
          <>
            <IconButton label="Previous day" icon={<ChevronLeft size={16} />} onClick={() => onNavigate(addDays(day, -1))} />
            <IconButton label="Next day" icon={<ChevronRight size={16} />} onClick={() => onNavigate(addDays(day, 1))} />
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {/* Numbers */}
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="text-2xs font-medium uppercase tracking-wider text-faint">Net P&L</div>
              <Money value={traded || trades.length ? net : 0} sign colored className={clsx('text-3xl font-semibold tracking-tight', !traded && !trades.length && 'text-faint')} />
            </div>
            {traded && (
              <Button
                size="sm"
                variant="outline"
                icon={<NotebookPen size={14} />}
                onClick={() => navigate('journal', { range: 'custom', from: day, to: day, account: accountId === 'all' ? null : accountId })}
              >
                Open in journal
              </Button>
            )}
          </div>

          {flags.length > 0 && agg && (
            <div className="flex flex-col gap-1.5">
              {flags.map((f) => {
                const info = FLAG_INFO[f];
                const Icon = info.icon;
                const names = accountId === 'all' ? flagAccounts(agg, f, accounts) : [];
                return (
                  <div key={f} className="flex items-start gap-2 rounded-md border border-line bg-panel-2 px-3 py-2 text-[13px]">
                    <Icon size={15} className={clsx('mt-px shrink-0', FLAG_TONE_CLASS[info.tone])} />
                    <span>
                      <span className="font-medium text-fg">{info.label}</span>
                      {names.length > 0 && <span className="text-muted"> · {names.join(', ')}</span>}
                      <span className="block text-xs text-muted">{info.description}</span>
                      {data && <LockTimes spans={data.locks.filter((s) => s.flag === f)} accounts={names.length > 1 ? accounts : null} />}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          <div className="grid grid-cols-3 gap-x-6 gap-y-3 rounded-lg border border-line px-4 py-3 sm:grid-cols-4">
            <Fact label="Gross">{agg ? <Money value={agg.gross} sign colored /> : '—'}</Fact>
            <Fact label="Fees">{agg ? fmtMoney(-agg.fees) : '—'}</Fact>
            <Fact label="Trades" sub={agg && agg.trades ? `${agg.wins}W · ${agg.losses}L` : undefined}>
              {agg?.trades ?? trades.length}
            </Fact>
            <Fact label="Win rate">{agg && agg.trades ? fmtPct(agg.wins / agg.trades, 0) : '—'}</Fact>
            <Fact label="Best trade" sub={k.best ? `${k.best.symbol} ${directionLabel(k.best)}` : undefined}>
              {k.best ? <Money value={k.best.netPnl} sign colored /> : '—'}
            </Fact>
            <Fact label="Worst trade" sub={k.worst ? `${k.worst.symbol} ${directionLabel(k.worst)}` : undefined}>
              {k.worst ? <Money value={k.worst.netPnl} sign colored /> : '—'}
            </Fact>
            <Fact label="Loss streak" sub="Longest, in a row">
              {data ? plural(k.longestLossStreak, 'loss', 'losses') : '—'}
            </Fact>
            {account && agg?.rows[0] ? (
              <Fact label="Equity range" sub={`${fmtMoney(agg.rows[0].startBalance, { whole: true })} → ${fmtMoney(agg.rows[0].endBalance, { whole: true })}`}>
                <span className="text-muted">
                  {fmtMoney(agg.rows[0].lowEquity, { whole: true })}–{fmtMoney(agg.rows[0].highEquity, { whole: true })}
                </span>
              </Fact>
            ) : (
              <Fact label="Avg trade">{k.expectancy != null ? <Money value={k.expectancy} sign colored /> : '—'}</Fact>
            )}
          </div>

          {/* Intraday curve */}
          <div className="rounded-lg border border-line px-3 pb-2 pt-2.5">
            {data ? (
              <IntradayChart trades={trades} equity={data.equity} startBalance={startBalance} />
            ) : error ? (
              <div className="flex h-[200px] flex-col items-center justify-center gap-2 text-sm text-muted">
                Couldn’t load this day — {error}
                <Button size="sm" variant="secondary" onClick={reload}>
                  Retry
                </Button>
              </div>
            ) : (
              <Skeleton className="h-[200px] w-full" />
            )}
          </div>

          {/* Trades & fills */}
          <div className="rounded-lg border border-line">
            <div className="flex items-center justify-between border-b border-line px-3">
              <Tabs
                size="sm"
                value={tab}
                onChange={setTab}
                items={[
                  { id: 'trades', label: 'Trades', count: trades.length },
                  { id: 'fills', label: 'Fills', count: data?.fills.length ?? 0 },
                ]}
              />
              {mismatch && (
                <span className="text-2xs text-faint" title="The day total counts every fill of this trading day; trades are listed on the day they closed.">
                  Trades {fmtMoney(tradesNet, { sign: true })} · day incl. other fills {fmtMoney(net, { sign: true })}
                </span>
              )}
            </div>
            {!data ? (
              <div className="space-y-2 p-3">
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ) : tab === 'trades' ? (
              trades.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-faint">No trades closed on this trading day.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="h-7 text-2xs uppercase tracking-wider text-faint">
                        <th className="px-3 text-left font-medium">Time</th>
                        {accountId === 'all' && <th className="px-2 text-left font-medium">Account</th>}
                        <th className="px-2 text-left font-medium">Symbol</th>
                        <th className="px-2 text-right font-medium">Qty</th>
                        <th className="px-2 text-right font-medium">Entry → exit</th>
                        <th className="px-2 text-right font-medium">Net</th>
                        <th className="px-2 text-right font-medium">R</th>
                        <th className="px-2 text-center font-medium">Mood</th>
                        <th className="px-3 text-left font-medium">Exit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trades.map((t) => (
                        <tr
                          key={t.id}
                          tabIndex={0}
                          onClick={() => setOpenTradeId(t.id)}
                          onKeyDown={(e) => e.key === 'Enter' && setOpenTradeId(t.id)}
                          className="h-8 cursor-pointer border-t border-line/60 transition-colors hover:bg-panel-2 focus:outline-none focus-visible:bg-panel-3"
                        >
                          <td className="tnum whitespace-nowrap px-3 text-muted">
                            {fmtTime(t.openedAt, { seconds: false })} → {fmtTime(closeTime(t), { seconds: false })}
                          </td>
                          {accountId === 'all' && <td className="max-w-32 truncate px-2 text-muted">{accountName(accounts, t.accountId)}</td>}
                          <td className="whitespace-nowrap px-2">
                            <span className="font-semibold text-fg">{t.symbol}</span> <span className={clsx('text-xs', directionClass(t))}>{directionLabel(t)}</span>
                          </td>
                          <td className="tnum px-2 text-right">{fmtTradeQty(instruments, t.symbol, t.maxQty)}</td>
                          <td className="tnum whitespace-nowrap px-2 text-right text-muted">
                            {fmtTradePrice(instruments, t.symbol, t.avgEntry)} → {fmtTradePrice(instruments, t.symbol, t.avgExit)}
                          </td>
                          <td className="px-2 text-right">
                            <Money value={t.netPnl} sign colored className="font-semibold" />
                          </td>
                          <td className={clsx('tnum px-2 text-right', t.rMultiple == null ? 'text-faint' : t.rMultiple >= 0 ? 'text-profit' : 'text-loss')}>{fmtR(t.rMultiple)}</td>
                          <td className="px-2 text-center" title={t.tags?.mood ? moodLabel(t.tags.mood) : 'No mood logged'}>
                            {t.tags?.mood ? moodEmoji(t.tags.mood) : <span className="text-faint">·</span>}
                          </td>
                          <td className={clsx('whitespace-nowrap px-3', exitReasonClass(t.exitReason))}>{exitReasonLabel(t.exitReason)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : data.fills.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-faint">No fills on this trading day.</div>
            ) : (
              <div className="max-h-80 overflow-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="h-7 text-2xs uppercase tracking-wider text-faint">
                      <th className="px-3 text-left font-medium">Time</th>
                      {accountId === 'all' && <th className="px-2 text-left font-medium">Account</th>}
                      <th className="px-2 text-left font-medium">Symbol</th>
                      <th className="px-2 text-left font-medium">Side</th>
                      <th className="px-2 text-right font-medium">Qty</th>
                      <th className="px-2 text-right font-medium">Price</th>
                      <th className="px-2 text-right font-medium">Fee</th>
                      <th className="px-3 text-right font-medium">Realized</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.fills.map((f) => (
                      <tr key={f.id} className="h-7 border-t border-line/60">
                        <td className="tnum px-3 text-muted">{fmtTime(f.ts)}</td>
                        {accountId === 'all' && <td className="max-w-32 truncate px-2 text-muted">{accountName(accounts, f.accountId)}</td>}
                        <td className="px-2 font-medium text-fg">{f.symbol}</td>
                        <td className={clsx('px-2 font-medium', f.side === 'buy' ? 'text-profit' : 'text-loss')}>{f.side === 'buy' ? 'Buy' : 'Sell'}</td>
                        <td className="tnum px-2 text-right">{fmtTradeQty(instruments, f.symbol, f.qty)}</td>
                        <td className="tnum px-2 text-right">{fmtTradePrice(instruments, f.symbol, f.price)}</td>
                        <td className="tnum px-2 text-right text-muted">{fmtMoney(-f.fee)}</td>
                        <td className="px-3 text-right">{f.realizedPnl !== 0 ? <Money value={f.realizedPnl} sign colored /> : <span className="text-faint">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Journal note */}
          <div className="rounded-lg border border-line px-4 py-3">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Day journal</h3>
              <span className="text-2xs text-faint">{scope ? `Note for ${account?.name ?? 'this account'}` : 'Note for the day (all accounts)'}</span>
            </div>
            {data ? (
              <DayNoteEditor key={`${day}|${scope ?? 'all'}`} day={day} accountId={scope} initial={myNote} />
            ) : (
              <Skeleton className="h-32 w-full" />
            )}
            {otherNotes.length > 0 && (
              <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
                {otherNotes.map((n) => (
                  <div key={`${n.accountId ?? 'all'}`} className="text-[13px]">
                    <div className="mb-0.5 text-2xs text-faint">
                      {n.accountId ? accountName(accounts, n.accountId) : 'Day note (all accounts)'}
                      {n.mood && <span className="ml-1.5">{moodEmoji(n.mood)} {moodLabel(n.mood)}</span>}
                    </div>
                    <div className="whitespace-pre-wrap text-muted">{n.text}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Drawer>

      <TradeDrawer
        trade={openTrade}
        onClose={() => setOpenTradeId(null)}
        onUpdated={replaceTrade}
        onPrev={openIdx > 0 ? () => setOpenTradeId(trades[openIdx - 1].id) : undefined}
        onNext={openIdx >= 0 && openIdx < trades.length - 1 ? () => setOpenTradeId(trades[openIdx + 1].id) : undefined}
      />
    </>
  );
}
