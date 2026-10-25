// PLACEHOLDER API — implemented by the realism layer (WebAudio-synthesized, respects settings.sounds / volume).
// Who plays what: the realism layer plays market/rule sounds from bus events (fill, profit/loss trade close,
// stop/target hits, warnings, breach, pass, lock). Feature UIs only play direct UI feedback: 'order' when an
// order is submitted, 'cancel', 'reject' when the server rejects an action, 'click' for minor toggles.

export type SoundKind =
  | 'click'
  | 'order'
  | 'cancel'
  | 'reject'
  | 'fill'
  | 'profit'
  | 'loss'
  | 'stop'
  | 'target'
  | 'warning'
  | 'breach'
  | 'pass'
  | 'lock';

export function playSound(_kind: SoundKind): void {}
