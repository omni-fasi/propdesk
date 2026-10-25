// Sounds, the TradingView way: a fill plays the execution sound (ours defaults to the "Order filled" voice clip,
// or one of TradingView's 8 execution sounds) and account alerts — risk warnings, breach, locks, pass, payout —
// play a TradingView alert sound. Placing, modifying, cancelling or rejecting an order is silent, as on
// TradingView. Files: TradingView's original mp3s plus the voice clip, fetched by
// scripts/fetch-platform-sounds.sh into web/public/sounds (personal use only).
//
// - Respects settings.sounds, fillSound, alertSound and volume, read at play time.
// - The AudioContext is created lazily and unlocked on the first pointer / key event (browser autoplay policy).
// - Like TradingView, one sound at a time: a sound still playing isn't restarted; a different one replaces it.

import type { FillSound } from '@shared/types';
import { useApp } from '@/store/app';

/** fill: every fill (entry, exit, stop, target). alert: account alerts. */
export type SoundKind = 'fill' | 'alert';

/** Names as TradingView's menus show them. */
export const SOUND_NAMES: Record<FillSound, string> = {
  order_filled: '“Order filled” voice',
  fired: 'Fired',
  '3_notes_reverb': '3 Notes Reverb',
  alarm_clock: 'Alarm Clock',
  beep_beep: 'Beep Beep',
  calling: 'Calling',
  chirpy: 'Chirpy',
  fault: 'Fault',
  hand_bell: 'Hand Bell',
};

const FILES: Record<FillSound, string> = {
  order_filled: 'order-filled.ogg',
  fired: 'tv-fired.mp3',
  '3_notes_reverb': 'tv-3-notes-reverb.mp3',
  alarm_clock: 'tv-alarm-clock.mp3',
  beep_beep: 'tv-beep-beep.mp3',
  calling: 'tv-calling.mp3',
  chirpy: 'tv-chirpy.mp3',
  fault: 'tv-fault.mp3',
  hand_bell: 'tv-hand-bell.mp3',
};

export function playSound(kind: SoundKind): void {
  const s = useApp.getState().settings;
  if (!s.sounds) return;
  const sound = kind === 'fill' ? s.fillSound : s.alertSound;
  if (sound) play(sound, s.volume);
}

/** Preview from Settings: plays even when sounds are switched off. */
export function testSound(sound: FillSound, volume?: number): void {
  play(sound, volume ?? useApp.getState().settings.volume);
}

// ───────────────────────────── engine ─────────────────────────────

const buffers = new Map<FillSound, Promise<AudioBuffer | null>>();
let ctx: AudioContext | null = null;
let playing: { sound: FillSound; src: AudioBufferSourceNode } | null = null;

function contextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ?? null;
}

function getContext(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = contextCtor();
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

function load(sound: FillSound): Promise<AudioBuffer | null> {
  let p = buffers.get(sound);
  if (!p) {
    const c = getContext();
    p = c
      ? fetch(`/sounds/${FILES[sound]}`)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
          .then((data) => c.decodeAudioData(data))
          .catch(() => {
            buffers.delete(sound); // retry next time
            return null;
          })
      : Promise.resolve(null);
    buffers.set(sound, p);
  }
  return p;
}

// Browsers only allow audio after a user gesture: resume on the first one and preload the chosen sounds.
if (typeof window !== 'undefined') {
  const unlock = () => {
    const c = getContext();
    if (c && c.state === 'suspended') void c.resume();
    const { fillSound, alertSound } = useApp.getState().settings;
    void load(fillSound);
    if (alertSound) void load(alertSound);
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('keydown', unlock, true);
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
}

function play(sound: FillSound, volume: number): void {
  const c = getContext();
  if (!c) return;
  if (c.state === 'suspended') void c.resume();
  if (playing?.sound === sound) return;
  void load(sound).then((buf) => {
    if (!buf || playing?.sound === sound) return;
    if (playing) {
      try {
        playing.src.stop();
      } catch {
        // already stopped
      }
    }
    const gain = c.createGain();
    gain.gain.value = Math.max(0, Math.min(1, volume));
    gain.connect(c.destination);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(gain);
    const current = { sound, src };
    playing = current;
    src.onended = () => {
      if (playing === current) playing = null;
    };
    src.start();
  });
}
