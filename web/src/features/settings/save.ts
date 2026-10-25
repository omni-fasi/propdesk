// Optimistic settings saves with a small shared status for the "Saved" indicator.

import { create } from 'zustand';
import type { Settings } from '@shared/types';
import { errorMessage } from '@/api/client';
import { useApp } from '@/store/app';
import { toast } from '@/components/ui/Toast';

type Status = 'idle' | 'saving' | 'saved' | 'error';

export const useSaveStatus = create<{ status: Status; error: string | null; pending: number }>(() => ({ status: 'idle', error: null, pending: 0 }));

let savedTimer: ReturnType<typeof setTimeout> | null = null;

/** Saves a settings patch (applied to the store immediately, rolled back on error). */
export async function saveSettings(patch: Partial<Settings>): Promise<boolean> {
  useSaveStatus.setState((s) => ({ status: 'saving', error: null, pending: s.pending + 1 }));
  try {
    await useApp.getState().updateSettings(patch);
    useSaveStatus.setState((s) => {
      const pending = Math.max(0, s.pending - 1);
      return { pending, status: pending > 0 ? 'saving' : s.status === 'error' ? 'error' : 'saved' };
    });
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => useSaveStatus.setState((s) => (s.status === 'saved' ? { status: 'idle' } : s)), 1800);
    return true;
  } catch (e) {
    const msg = errorMessage(e);
    useSaveStatus.setState((s) => ({ pending: Math.max(0, s.pending - 1), status: 'error', error: msg }));
    toast({ title: "Couldn't save settings", description: msg, tone: 'loss' });
    return false;
  }
}
