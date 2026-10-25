// Journal filter bar (one row above everything it scopes: trade log and analytics).

import { useState } from 'react';
import { CalendarRange, Check, ChevronDown, X } from 'lucide-react';
import { MOODS, SETUP_GRADES } from '@shared/journal';
import { fmtDayKey } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Input, Select, type SelectOption } from '@/components/ui/Input';
import { MenuItem, Popover } from '@/components/ui/Popover';
import { Segmented } from '@/components/ui/Tabs';
import { AccountFilter } from './AccountFilter';
import {
  activeFilterCount,
  CLEAR_FILTERS,
  isDayKey,
  RANGE_OPTIONS,
  rangeLabel,
  type JournalFilters,
  type MoodFilter,
  type RangePreset,
  type ReviewFilter,
  type SideFilter,
} from './filters';
import type { TradeResult } from './stats';

const ALL = '__all__';

function CustomRange({ from, to, onApply }: { from: string | null; to: string | null; onApply: (from: string | null, to: string | null) => void }) {
  const [a, setA] = useState(from ?? '');
  const [b, setB] = useState(to ?? '');
  const valid = (a === '' || isDayKey(a)) && (b === '' || isDayKey(b)) && (a !== '' || b !== '');
  return (
    <div className="flex flex-col gap-2 border-t border-line px-2.5 pb-1.5 pt-2.5">
      <div className="text-2xs font-medium uppercase tracking-wider text-faint">Custom range (trading days)</div>
      <div className="flex items-center gap-1.5">
        <Input type="date" size="sm" value={a} max={b || undefined} onChange={(e) => setA(e.target.value)} aria-label="From" className="flex-1" />
        <span className="text-faint">–</span>
        <Input type="date" size="sm" value={b} min={a || undefined} onChange={(e) => setB(e.target.value)} aria-label="To" className="flex-1" />
      </div>
      <Button size="sm" variant="primary" disabled={!valid} onClick={() => onApply(a || null, b || null)}>
        Apply range
      </Button>
    </div>
  );
}

function RangePicker({ filters, onChange }: { filters: JournalFilters; onChange: (patch: Partial<JournalFilters>) => void }) {
  const label = rangeLabel(filters, (k) => fmtDayKey(k, { weekday: false, year: k.slice(0, 4) !== String(new Date().getFullYear()) }));
  return (
    <Popover
      className="w-72"
      triggerClassName="flex h-8 items-center gap-2 rounded-md border border-line-strong bg-panel-2 px-2.5 text-[13px] text-fg transition-colors hover:border-[#3a3a3a]"
      trigger={
        <>
          <CalendarRange size={14} className="text-muted" />
          <span className="font-medium">{label}</span>
          <ChevronDown size={14} className="text-faint" />
        </>
      }
    >
      {(close) => (
        <div className="flex flex-col">
          {RANGE_OPTIONS.filter((o) => o.value !== 'custom').map((o) => (
            <MenuItem
              key={o.value}
              active={filters.range === o.value}
              onClick={() => {
                onChange({ range: o.value as RangePreset });
                close();
              }}
              className="justify-between"
            >
              <span className={filters.range === o.value ? 'font-semibold' : undefined}>{o.label}</span>
              {filters.range === o.value && <Check size={16} strokeWidth={2.5} />}
            </MenuItem>
          ))}
          <CustomRange
            from={filters.range === 'custom' ? filters.from : null}
            to={filters.range === 'custom' ? filters.to : null}
            onApply={(from, to) => {
              onChange({ range: 'custom', from, to });
              close();
            }}
          />
        </div>
      )}
    </Popover>
  );
}

export interface FiltersBarProps {
  filters: JournalFilters;
  onChange: (patch: Partial<JournalFilters>) => void;
  /** Symbols present in the current date range. */
  symbols: string[];
  /** Free-text setups present in the current date range (grades are always offered). */
  customSetups: string[];
}

export function FiltersBar({ filters, onChange, symbols, customSetups }: FiltersBarProps) {
  const symbolOptions: SelectOption<string>[] = [{ value: ALL, label: 'All symbols' }, ...[...new Set([...symbols, ...(filters.symbol ? [filters.symbol] : [])])].sort().map((s) => ({ value: s, label: s }))];
  const moodOptions: SelectOption<string>[] = [{ value: ALL, label: 'Any mood' }, ...MOODS.map((m) => ({ value: m.id, label: `${m.emoji}  ${m.label}` })), { value: 'none', label: 'No mood logged' }];
  const setups = [...new Set([...customSetups, ...(filters.setup && filters.setup !== 'none' && !(SETUP_GRADES as readonly string[]).includes(filters.setup) ? [filters.setup] : [])])];
  const setupOptions: SelectOption<string>[] = [
    { value: ALL, label: 'Any setup' },
    ...SETUP_GRADES.map((g) => ({ value: g, label: g === 'No setup' ? 'No setup (impulse)' : `Setup ${g}` })),
    ...setups.map((s) => ({ value: s, label: s })),
    { value: 'none', label: 'Not graded' },
  ];
  const reviewOptions: SelectOption<string>[] = [
    { value: ALL, label: 'Reviewed & unreviewed' },
    { value: 'reviewed', label: 'Reviewed' },
    { value: 'unreviewed', label: 'To review' },
  ];
  const active = activeFilterCount(filters);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <AccountFilter value={filters.account} onChange={(account) => onChange({ account })} />
      <RangePicker filters={filters} onChange={onChange} />
      <div className="mx-1 h-5 w-px bg-line" />
      <Select size="sm" aria-label="Symbol" className="w-36" value={filters.symbol ?? ALL} options={symbolOptions} onChange={(v) => onChange({ symbol: v === ALL ? null : v })} />
      <Segmented<string>
        value={filters.side ?? ALL}
        onChange={(v) => onChange({ side: v === ALL ? null : (v as SideFilter) })}
        options={[
          { value: ALL, label: 'Both sides' },
          { value: 'long', label: 'Long' },
          { value: 'short', label: 'Short' },
        ]}
      />
      <Segmented<string>
        value={filters.result ?? ALL}
        onChange={(v) => onChange({ result: v === ALL ? null : (v as TradeResult) })}
        options={[
          { value: ALL, label: 'All results' },
          { value: 'win', label: 'Wins' },
          { value: 'loss', label: 'Losses' },
          { value: 'be', label: 'Break-even', title: 'Net P&L within half a cent of zero' },
        ]}
      />
      <Select size="sm" aria-label="Mood" className="w-40" value={filters.mood ?? ALL} options={moodOptions} onChange={(v) => onChange({ mood: v === ALL ? null : (v as MoodFilter) })} />
      <Select size="sm" aria-label="Setup" className="w-40" value={filters.setup ?? ALL} options={setupOptions} onChange={(v) => onChange({ setup: v === ALL ? null : v })} />
      <Select size="sm" aria-label="Review status" className="w-48" value={filters.review ?? ALL} options={reviewOptions} onChange={(v) => onChange({ review: v === ALL ? null : (v as ReviewFilter) })} />
      {active > 0 && (
        <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => onChange(CLEAR_FILTERS)}>
          Clear {active} filter{active === 1 ? '' : 's'}
        </Button>
      )}
    </div>
  );
}
