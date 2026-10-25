// Journal vocabularies and default settings.

import type { Mood, Settings } from './types.ts';
import { DEFAULT_WATCHLIST } from './instruments.ts';

export interface MoodInfo {
  id: Mood;
  label: string;
  emoji: string;
  /** good: helps execution · neutral · bad: known to hurt execution. */
  tone: 'good' | 'neutral' | 'bad';
}

export const MOODS: MoodInfo[] = [
  { id: 'calm', label: 'Calm', emoji: '😌', tone: 'good' },
  { id: 'focused', label: 'Focused', emoji: '🎯', tone: 'good' },
  { id: 'confident', label: 'Confident', emoji: '💪', tone: 'good' },
  { id: 'excited', label: 'Excited', emoji: '⚡', tone: 'neutral' },
  { id: 'bored', label: 'Bored', emoji: '😐', tone: 'neutral' },
  { id: 'tired', label: 'Tired', emoji: '🥱', tone: 'neutral' },
  { id: 'anxious', label: 'Anxious', emoji: '😰', tone: 'bad' },
  { id: 'fearful', label: 'Fearful', emoji: '😨', tone: 'bad' },
  { id: 'fomo', label: 'FOMO', emoji: '🏃', tone: 'bad' },
  { id: 'frustrated', label: 'Frustrated', emoji: '😤', tone: 'bad' },
  { id: 'revenge', label: 'Revenge', emoji: '😡', tone: 'bad' },
];

export const MOOD_MAP: Record<Mood, MoodInfo> = Object.fromEntries(MOODS.map((m) => [m.id, m])) as Record<Mood, MoodInfo>;

export const SETUP_GRADES = ['A+', 'A', 'B', 'C', 'No setup'] as const;

export const MISTAKES = [
  'No stop-loss',
  'Moved stop further',
  'Oversized',
  'Chased entry',
  'Entered too early',
  'Exited too early',
  'Held a loser too long',
  'Revenge trade',
  'FOMO entry',
  'Overtrading',
  'Ignored my plan',
  'Traded the news',
] as const;

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  traderName: null,
  hourlyWage: null,
  showWorkHours: true,
  sounds: true,
  volume: 0.6,
  notifications: true,
  confirmOrders: 'risky',
  riskyPct: 0.25,
  requireStopLoss: false,
  emotionCheckin: 'optional',
  postTradeReview: true,
  tilt: {
    enabled: true,
    maxConsecutiveLosses: 3,
    cooldownMinutes: 15,
    maxTradesPerDay: null,
    personalDailyLoss: null,
  },
  revengeGuard: true,
  monthlyBudget: null,
  watchlist: DEFAULT_WATCHLIST,
  activeAccountId: null,
  chartTimeframe: '1m',
  lastSymbol: 'MNQ',
};
