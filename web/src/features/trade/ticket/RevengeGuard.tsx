// Revenge-trade guard: a loss < 2 min ago and a bigger order now → pause and choose.

import { create } from 'zustand';
import { Coffee } from 'lucide-react';
import type { Trade } from '@shared/types';
import { fmtDuration, fmtMoney } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';

export type GuardChoice = 'break' | 'place' | 'cancel';

interface GuardRequest {
  trade: Trade;
  agoMs: number;
  sizeText: string;
  resolve: (c: GuardChoice) => void;
}

const useGuard = create<{ req: GuardRequest | null }>(() => ({ req: null }));

export function askRevengeGuard(trade: Trade, agoMs: number, sizeText: string): Promise<GuardChoice> {
  return new Promise((resolve) => {
    useGuard.getState().req?.resolve('cancel');
    useGuard.setState({ req: { trade, agoMs, sizeText, resolve } });
  });
}

export function RevengeGuardHost() {
  const req = useGuard((s) => s.req);
  if (!req) return null;
  const done = (c: GuardChoice) => {
    req.resolve(c);
    useGuard.setState({ req: null });
  };
  return (
    <Modal open onClose={() => done('cancel')} size="sm" title="Take a breath first" backdropClassName="bg-black/80">
      <div className="flex flex-col gap-3 text-sm text-muted">
        <p>
          You lost <span className="tnum font-semibold text-loss">{fmtMoney(req.trade.netPnl)}</span> on {req.trade.symbol} {fmtDuration(req.agoMs)} ago, and this order is bigger ({req.sizeText}).
        </p>
        <p>Sizing up right after a loss is how most challenges are lost. If this trade is in your plan, it will still be there in five minutes.</p>
        <div className="mt-1 flex flex-col gap-2">
          <Button variant="primary" size="lg" icon={<Coffee size={15} />} onClick={() => done('break')} data-autofocus>
            Take a 5-minute break
          </Button>
          <Button variant="ghost" onClick={() => done('place')}>
            I’m calm — place it
          </Button>
        </div>
      </div>
    </Modal>
  );
}
