import { useEffect, useState } from 'react';
import type { DailyStat } from '@shared/types';
import { api } from '@/api/client';

/** The DailyStat of one account and day. undefined = loading, null = none / unavailable. */
export function useDayStat(accountId: string | null | undefined, day: string | null, refreshKey?: unknown): DailyStat | null | undefined {
  const [stat, setStat] = useState<DailyStat | null | undefined>(undefined);
  useEffect(() => {
    if (!accountId || !day) {
      setStat(null);
      return;
    }
    let alive = true;
    api
      .daily({ accountId, from: day, to: day })
      .then((rows) => {
        if (alive) setStat(rows.find((r) => r.day === day && r.accountId === accountId) ?? rows[0] ?? null);
      })
      .catch(() => {
        if (alive) setStat((s) => s ?? null);
      });
    return () => {
      alive = false;
    };
  }, [accountId, day, refreshKey]);
  return stat;
}
