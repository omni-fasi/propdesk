import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useApp } from '@/store/app';
import { socket } from '@/api/socket';
import { useRoute, type Page } from '@/lib/router';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Misc';
import { ConfirmHost, Toaster } from '@/components/ui/Toast';
import { NavRail } from '@/components/shell/NavRail';
import { TopBar } from '@/components/shell/TopBar';
import { TradePage } from '@/features/trade/TradePage';
import { CalendarPage } from '@/features/calendar/CalendarPage';
import { JournalPage } from '@/features/journal/JournalPage';
import { ChallengesPage } from '@/features/challenges/ChallengesPage';
import { WalletPage } from '@/features/wallet/WalletPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { RealismLayer } from '@/features/realism/RealismLayer';

function PageView({ page }: { page: Page }) {
  switch (page) {
    case 'trade':
      return <TradePage />;
    case 'calendar':
      return <CalendarPage />;
    case 'journal':
      return <JournalPage />;
    case 'challenges':
      return <ChallengesPage />;
    case 'wallet':
      return <WalletPage />;
    case 'settings':
      return <SettingsPage />;
  }
}

function Splash({ error, onRetry }: { error?: string | null; onRetry?: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-bg">
      <img src="/icon.svg" alt="" className="size-14" />
      <div className="text-lg font-semibold tracking-tight text-fg">PropDesk</div>
      {error ? (
        <>
          <div className="max-w-sm text-center text-sm text-muted">Can’t reach the trading server ({error}). It may still be starting…</div>
          <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={onRetry}>
            Retry now
          </Button>
        </>
      ) : (
        <Spinner size={18} className="text-muted" />
      )}
    </div>
  );
}

export function App() {
  const status = useApp((s) => s.status);
  const error = useApp((s) => s.error);
  const { page } = useRoute();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    useApp
      .getState()
      .bootstrap()
      .then(() => socket.connect())
      .catch(() => {
        // Server not up yet (e.g. right after login): keep retrying quietly.
        const t = setTimeout(() => setAttempt((n) => n + 1), 2000);
        return () => clearTimeout(t);
      });
  }, [attempt]);

  if (status !== 'ready') return <Splash error={status === 'error' ? error : null} onRetry={() => setAttempt((n) => n + 1)} />;

  return (
    <div className="flex h-full bg-bg text-fg">
      <NavRail page={page} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-h-0 flex-1">
          <PageView page={page} />
        </main>
      </div>
      <RealismLayer />
      <ConfirmHost />
      <Toaster />
    </div>
  );
}
