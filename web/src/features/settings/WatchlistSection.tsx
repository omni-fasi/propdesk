import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, GripVertical, Plus, X } from 'lucide-react';
import { ASSET_CLASS_LABELS } from '@shared/instruments';
import { useApp } from '@/store/app';
import { IconButton } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Popover } from '@/components/ui/Popover';
import { SettingsSection } from './SettingRow';
import { saveSettings } from './save';

function AddSymbol({ watchlist }: { watchlist: string[] }) {
  const instruments = useApp((s) => s.instruments);
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = new Map<string, typeof instruments>();
    for (const i of instruments) {
      if (watchlist.includes(i.symbol)) continue;
      if (needle && !i.symbol.toLowerCase().includes(needle) && !i.name.toLowerCase().includes(needle)) continue;
      const list = out.get(i.group) ?? [];
      list.push(i);
      out.set(i.group, list);
    }
    return [...out.entries()];
  }, [instruments, watchlist, q]);

  return (
    <Popover
      align="end"
      className="w-80 p-0"
      triggerClassName="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong bg-panel-3 px-2.5 text-[13px] text-fg transition-colors hover:border-[#3a3a3a] hover:bg-[#222]"
      trigger={
        <>
          <Plus size={14} /> Add symbol
        </>
      }
    >
      {(close) => (
        <div className="flex max-h-96 flex-col">
          <div className="border-b border-line p-2">
            <Input autoFocus size="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search symbol or name" />
          </div>
          <div className="min-h-0 overflow-y-auto p-1">
            {groups.length === 0 && <div className="px-3 py-4 text-center text-xs text-muted">Nothing to add</div>}
            {groups.map(([group, list]) => (
              <div key={group} className="py-1">
                <div className="px-2.5 py-1 text-2xs font-medium uppercase tracking-wider text-faint">{group}</div>
                {list.map((i) => (
                  <button
                    key={i.symbol}
                    type="button"
                    onClick={() => {
                      saveSettings({ watchlist: [...watchlist, i.symbol] });
                      setQ('');
                      close();
                    }}
                    className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-panel-3"
                  >
                    <span className="num font-medium text-fg">{i.symbol}</span>
                    <span className="truncate text-xs text-muted">{i.name}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </Popover>
  );
}

export function WatchlistSection() {
  const watchlist = useApp((s) => s.settings.watchlist);
  const instrumentMap = useApp((s) => s.instrumentMap);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= watchlist.length) return;
    const next = [...watchlist];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    saveSettings({ watchlist: next });
  };
  const remove = (sym: string) => saveSettings({ watchlist: watchlist.filter((s) => s !== sym) });

  return (
    <SettingsSection id="watchlist" title="Watchlist" description="Symbols on the trade page, in this order. Drag to reorder.">
      <div className="flex items-center justify-between py-3">
        <span className="text-xs text-muted">{watchlist.length} symbols</span>
        <AddSymbol watchlist={watchlist} />
      </div>
      <ul className="py-1">
        {watchlist.map((sym, i) => {
          const spec = instrumentMap[sym];
          return (
            <li
              key={sym}
              draggable
              onDragStart={(e) => {
                setDragFrom(i);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(i);
              }}
              onDragLeave={() => setDragOver((o) => (o === i ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragFrom != null) move(dragFrom, i);
                setDragFrom(null);
                setDragOver(null);
              }}
              onDragEnd={() => {
                setDragFrom(null);
                setDragOver(null);
              }}
              className={clsx(
                'group flex items-center gap-3 rounded-md px-1 py-1.5 transition-colors',
                dragOver === i && dragFrom !== i ? 'bg-panel-3' : 'hover:bg-panel-2',
                dragFrom === i && 'opacity-40',
              )}
            >
              <GripVertical size={14} className="shrink-0 cursor-grab text-faint" />
              <span className="num w-20 shrink-0 text-[13px] font-medium text-fg">{sym}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted">{spec ? spec.name : 'Unknown symbol'}</span>
              {spec && <span className="hidden text-2xs text-faint sm:inline">{ASSET_CLASS_LABELS[spec.assetClass]}</span>}
              <span className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <IconButton label="Move up" icon={<ArrowUp size={13} />} size="xs" onClick={() => move(i, i - 1)} disabled={i === 0} />
                <IconButton label="Move down" icon={<ArrowDown size={13} />} size="xs" onClick={() => move(i, i + 1)} disabled={i === watchlist.length - 1} />
                <IconButton label={`Remove ${sym}`} icon={<X size={13} />} size="xs" onClick={() => remove(sym)} />
              </span>
            </li>
          );
        })}
        {watchlist.length === 0 && <li className="py-6 text-center text-sm text-muted">Your watchlist is empty.</li>}
      </ul>
    </SettingsSection>
  );
}
