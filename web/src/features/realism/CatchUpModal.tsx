import { Moon } from 'lucide-react';
import { useApp } from '@/store/app';
import { fmtDateTime } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { clearCatchUps, useRealism } from './store';

/** "While you were away": what the server executed during sleep / downtime. Waits for any moment to close first. */
export function CatchUpModal() {
  const items = useRealism((s) => s.catchUps);
  const blocked = useRealism((s) => s.moments.length > 0);
  const accounts = useApp((s) => s.accounts);
  if (items.length === 0 || blocked) return null;
  return (
    <Modal
      open
      onClose={clearCatchUps}
      title={
        <span className="flex items-center gap-2">
          <Moon size={16} className="text-muted" /> While you were away
        </span>
      }
      description="The broker never sleeps. This happened while PropDesk was closed or your computer was asleep."
      size="md"
      footer={
        <Button variant="primary" onClick={clearCatchUps}>
          Got it
        </Button>
      }
    >
      <ul className="flex flex-col divide-y divide-line">
        {items.map((ev) => (
          <li key={ev.id} className="flex flex-col gap-0.5 py-3 first:pt-0 last:pb-0">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium text-fg">{(ev.accountId && accounts[ev.accountId]?.name) || ev.title}</span>
              <span className="tnum shrink-0 text-2xs text-faint">{fmtDateTime(ev.ts)}</span>
            </div>
            {ev.accountId && accounts[ev.accountId] && ev.title && <div className="text-xs text-muted">{ev.title}</div>}
            <p className="text-sm text-muted">{ev.message}</p>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
