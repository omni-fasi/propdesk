// The realism layer, mounted once in App: reacts to real-time moments (sounds, toasts, desktop notifications),
// shows the full-screen breach / pass / lock moments, the lock banner, post-trade reviews, the
// "while you were away" summary and first-run onboarding.

import { useEffect } from 'react';
import { useBus } from '@/api/bus';
import { useApp } from '@/store/app';
import { BreachModal } from './BreachModal';
import { CatchUpModal } from './CatchUpModal';
import { LockBanner } from './LockBanner';
import { LockOverlay } from './LockOverlay';
import { Onboarding } from './Onboarding';
import { PassModal } from './PassModal';
import { onEvent, onFill, onTradeClosed, replayMissed } from './reactions';
import { ReviewQueue } from './ReviewPrompt';
import { useRealism } from './store';

function MomentHost() {
  const moment = useRealism((s) => s.moments[0] ?? null);
  if (!moment) return null;
  const key = `${moment.key}:${moment.openedAt}`;
  switch (moment.type) {
    case 'breach':
      return <BreachModal key={key} moment={moment} />;
    case 'pass':
      return <PassModal key={key} moment={moment} />;
    case 'lock':
      return <LockOverlay key={key} moment={moment} />;
  }
}

export function RealismLayer() {
  const onboarded = useApp((s) => s.settings.onboarded);

  useBus('fill', onFill);
  useBus('tradeClosed', onTradeClosed);
  useBus('event', onEvent);
  useBus('resynced', () => replayMissed(useApp.getState().events));
  useEffect(() => {
    replayMissed(useApp.getState().events);
  }, []);

  return (
    <>
      <LockBanner />
      <ReviewQueue />
      <MomentHost />
      <CatchUpModal />
      {!onboarded && <Onboarding />}
    </>
  );
}
