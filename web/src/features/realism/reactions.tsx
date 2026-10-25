// How the app reacts to real-time moments: sounds, toasts, desktop notifications, full-screen moments
// and post-trade reviews. Called from RealismLayer's bus subscriptions.

import type { AccountEvent, Fill, Trade } from '@shared/types';
import { DAY_MS } from '@shared/time';
import { useApp, serverNow } from '@/store/app';
import { fmtMoney, fmtPrice, fmtQtyWithUnit, fmtWorkHours } from '@/lib/format';
import { playSound } from '@/lib/sounds';
import { toast } from '@/components/ui/Toast';
import { Pnl } from '@/components/ui/Money';
import { EXIT_LABELS } from '@/features/challenges/accountUtils';
import { notifyDesktop } from './notify';
import { firstTime, getLastSeen, markSeen } from './seen';
import { closeMomentsFor, pushCatchUp, queueReview, showMoment } from './store';

function accountName(id: string | null | undefined): string | null {
  if (!id) return null;
  return useApp.getState().accounts[id]?.name ?? null;
}

/** Account name, only when the moment is not about the selected account (or there are several). */
function accountSuffix(id: string | null | undefined): string | null {
  const s = useApp.getState();
  if (!id) return null;
  const many = Object.values(s.accounts).filter((a) => a.status === 'active' && !a.archived).length > 1;
  return many || s.activeAccountId !== id ? accountName(id) : null;
}

function joinParts(parts: Array<string | null | undefined | false>): string {
  return parts.filter(Boolean).join(' · ');
}

// ───────────────────────────── fills & trades ─────────────────────────────

/** Partial exits: a fill sound, unless the trade closes right after (then the close sound plays instead). */
const pendingFillSound = new Map<string, ReturnType<typeof setTimeout>>();

export function onFill(fill: Fill): void {
  const app = useApp.getState();
  const spec = app.instrumentMap[fill.symbol];
  // Liquidations come with a breach / lock moment that has its own sound.
  if (fill.role !== 'liquidation') {
    if (fill.realizedPnl === 0) playSound('fill');
    else {
      const prev = pendingFillSound.get(fill.tradeId);
      if (prev) clearTimeout(prev);
      pendingFillSound.set(
        fill.tradeId,
        setTimeout(() => {
          pendingFillSound.delete(fill.tradeId);
          playSound('fill');
        }, 260),
      );
    }
  }
  const qty = spec ? fmtQtyWithUnit(spec, fill.qty) : String(fill.qty);
  const price = spec ? fmtPrice(spec, fill.price) : String(fill.price);
  notifyDesktop(`Filled · ${fill.side === 'buy' ? 'Bought' : 'Sold'} ${qty} ${fill.symbol}`, joinParts([`@ ${price}`, accountName(fill.accountId)]), { tag: `trade:${fill.tradeId}` });
}

const MOMENT_EXITS = new Set(['breach', 'daily_loss', 'passed']);

export function onTradeClosed(trade: Trade): void {
  const pending = pendingFillSound.get(trade.id);
  if (pending) {
    clearTimeout(pending);
    pendingFillSound.delete(trade.id);
  }
  const app = useApp.getState();
  const { settings } = app;
  const net = trade.netPnl;
  const reason = trade.exitReason;
  const covered = reason != null && MOMENT_EXITS.has(reason);

  if (!covered) {
    playSound('fill');

    const wage = settings.showWorkHours ? settings.hourlyWage : null;
    toast({
      title: (
        <span className="flex items-baseline gap-2">
          {trade.symbol} {trade.direction} closed <Pnl value={net} className="font-semibold" />
        </span>
      ),
      description: joinParts([reason ? EXIT_LABELS[reason] : null, fmtWorkHours(net, wage), accountSuffix(trade.accountId)]) || undefined,
      tone: net > 0 ? 'profit' : 'loss',
      duration: 5000,
    });
  }

  const title = reason === 'stop_loss' ? 'Stop-loss hit' : reason === 'take_profit' ? 'Target hit' : 'Trade closed';
  notifyDesktop(`${title} · ${trade.symbol} ${fmtMoney(net, { sign: true })}`, joinParts([reason ? EXIT_LABELS[reason] : null, accountName(trade.accountId)]), { tag: `trade:${trade.id}` });

  if (settings.postTradeReview && trade.review == null) queueReview(trade);
}

// ───────────────────────────── rule & account events ─────────────────────────────

export function onEvent(ev: AccountEvent): void {
  markSeen(ev.ts);
  if (!firstTime(ev.id)) return;
  const id = ev.accountId;
  const suffix = accountSuffix(id);

  switch (ev.kind) {
    case 'warning':
      playSound('alert');
      toast({ title: ev.title, description: joinParts([ev.message, suffix]) || undefined, tone: 'warn', duration: 8000 });
      return;
    case 'breach':
      playSound('alert');
      if (id) showMoment('breach', id, ev);
      notifyDesktop(ev.title || 'Account failed', joinParts([ev.message, accountName(id)]), { sticky: true, tag: `breach:${id}` });
      return;
    case 'passed':
    case 'phase_passed':
      playSound('alert');
      if (id) showMoment('pass', id, ev);
      notifyDesktop(ev.title || 'Challenge passed', joinParts([ev.message, accountName(id)]), { tag: `pass:${id}` });
      return;
    case 'locked':
      playSound('alert');
      if (id) showMoment('lock', id, ev);
      notifyDesktop(ev.title || 'Trading locked', joinParts([ev.message, accountName(id)]), { tag: `lock:${id}` });
      return;
    case 'unlocked':
      playSound('alert');
      if (id) closeMomentsFor('lock', id);
      toast({ title: ev.title || 'Trading unlocked', description: joinParts([ev.message, suffix]) || undefined, tone: 'neutral' });
      return;
    case 'auto_flatten':
      playSound('alert');
      toast({ title: ev.title || 'Positions auto-flattened', description: joinParts([ev.message, suffix]) || undefined, tone: 'warn', duration: 7000 });
      return;
    case 'catch_up':
      pushCatchUp(ev);
      return;
    case 'payout':
      playSound('alert');
      toast({ title: ev.title || 'Payout received', description: joinParts([ev.message, suffix]) || undefined, tone: 'profit', duration: 7000 });
      notifyDesktop(ev.title || 'Payout received', ev.message, { tag: `payout:${ev.id}` });
      return;
    case 'funded':
      toast({ title: ev.title || 'Funded account active', description: joinParts([ev.message, suffix]) || undefined, tone: 'profit' });
      return;
    case 'order_rejected':
      toast({ title: ev.title || 'Order rejected', description: joinParts([ev.message, suffix]) || undefined, tone: 'loss', duration: 6000 });
      return;
    default:
      // stop_hit / target_hit are announced by the trade close; account_created / day_rollover / info stay quiet.
      return;
  }
}

// ───────────────────────────── missed while closed ─────────────────────────────

const REPLAY_WINDOW_MS = 3 * DAY_MS;

/**
 * Shows the moments this browser has not seen yet (e.g. a breach overnight, a catch-up after sleep), without
 * sounds. The first run only records "now" so old history is never replayed.
 */
export function replayMissed(events: AccountEvent[]): void {
  const now = serverNow();
  const newest = events.reduce((m, e) => Math.max(m, e.ts), 0);
  const last = getLastSeen();
  if (last == null) {
    markSeen(Math.max(newest, now));
    return;
  }
  const cutoff = Math.max(last, now - REPLAY_WINDOW_MS);
  const accounts = useApp.getState().accounts;
  const missed = events.filter((e) => e.ts > cutoff).sort((a, b) => a.ts - b.ts);
  for (const ev of missed) {
    if (!firstTime(ev.id)) continue;
    const id = ev.accountId;
    if (!id) continue;
    const account = accounts[id];
    switch (ev.kind) {
      case 'breach':
        if (!account || account.status === 'failed') showMoment('breach', id, ev, true);
        break;
      case 'passed':
      case 'phase_passed':
        if (!account || account.status === 'passed') showMoment('pass', id, ev, true);
        break;
      case 'catch_up':
        pushCatchUp(ev);
        break;
    }
  }
  if (newest > 0) markSeen(newest);
}
