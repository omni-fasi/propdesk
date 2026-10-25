import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Check, Pencil, X } from 'lucide-react';
import type { Account } from '@shared/types';
import { errorMessage } from '@/api/client';
import { IconButton } from '@/components/ui/Button';
import { toast } from '@/components/ui/Toast';
import { renameAccount } from './actions';

/** Account name with click-to-rename. Enter saves, Escape cancels. */
export function InlineName({ account, className }: { account: Account; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(account.name);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setValue(account.name);
  }, [account.name, editing]);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const save = async () => {
    const name = value.trim().replace(/\s+/g, ' ');
    if (!name || name === account.name) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await renameAccount(account.id, name.slice(0, 60));
      setEditing(false);
    } catch (e) {
      toast({ title: 'Could not rename the account', description: errorMessage(e), tone: 'loss' });
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <div className={clsx('flex min-w-0 items-center gap-1', className)}>
        <input
          ref={input}
          value={value}
          maxLength={60}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') {
              e.stopPropagation();
              setEditing(false);
            }
          }}
          className="h-7 min-w-0 flex-1 rounded-md border border-fg/50 bg-panel-2 px-2 text-sm font-semibold text-fg focus:outline-none"
          aria-label="Account name"
        />
        <IconButton label="Save name" icon={<Check size={14} />} size="xs" onClick={save} disabled={busy} />
        <IconButton label="Cancel" icon={<X size={14} />} size="xs" onClick={() => setEditing(false)} disabled={busy} />
      </div>
    );
  }

  return (
    <div className={clsx('group/name flex min-w-0 items-center gap-1', className)}>
      <h3 className="truncate text-[15px] font-semibold tracking-tight text-fg" title={account.name}>
        {account.name}
      </h3>
      <IconButton
        label="Rename"
        icon={<Pencil size={12} />}
        size="xs"
        className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover/name:opacity-100"
        onClick={() => setEditing(true)}
      />
    </div>
  );
}
