import { useState } from 'react';
import { PRESETS } from '@shared/presets';
import { useApp } from '@/store/app';
import { Modal } from '@/components/ui/Modal';
import { Money } from '@/components/ui/Money';
import { Tabs } from '@/components/ui/Tabs';
import { presetById } from './accountUtils';
import { CustomBuilder } from './CustomBuilder';
import { PracticeForm } from './PracticeForm';
import { PresetCard } from './PresetCard';
import { PresetCheckout } from './PresetCheckout';

export type NewTab = 'presets' | 'custom' | 'practice';

export function isNewTab(v: string | null): v is NewTab {
  return v === 'presets' || v === 'custom' || v === 'practice';
}

/** Preset gallery → checkout, custom challenge builder, or a live account (kind 'practice'). */
export function NewChallenge({ onClose, initialTab = 'presets', initialPreset = null }: { onClose: () => void; initialTab?: NewTab; initialPreset?: string | null }) {
  const storePresets = useApp((s) => s.presets);
  const balance = useApp((s) => s.wallet.balance);
  const presets = storePresets.length > 0 ? storePresets : PRESETS;
  const [tab, setTab] = useState<NewTab>(initialTab);
  const [selected, setSelected] = useState<string | null>(initialPreset);
  const preset = selected ? presetById(selected, presets) : null;

  return (
    <Modal open onClose={onClose} title="New account" description="Buy a challenge, build your own rules, or open a live account." size="full">
      <div className="flex flex-col gap-5">
        <div className="flex items-end justify-between gap-4 border-b border-line">
          <Tabs
            value={tab}
            onChange={(t) => {
              setTab(t);
              setSelected(null);
            }}
            items={[
              { id: 'presets', label: 'Challenges' },
              { id: 'custom', label: 'Custom challenge' },
              { id: 'practice', label: 'Live account' },
            ]}
          />
          <div className="pb-2 text-xs text-muted">
            Wallet <Money value={balance} className="font-medium text-fg" />
          </div>
        </div>

        {tab === 'presets' &&
          (preset ? (
            <PresetCheckout preset={preset} onBack={() => setSelected(null)} onDone={onClose} onNavigate={onClose} />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-3">
              {presets.map((p) => (
                <PresetCard key={p.id} preset={p} affordable={balance + 1e-9 >= p.fee} onSelect={() => setSelected(p.id)} />
              ))}
            </div>
          ))}
        {tab === 'custom' && <CustomBuilder onDone={onClose} onNavigate={onClose} />}
        {tab === 'practice' && <PracticeForm onDone={onClose} />}
      </div>
    </Modal>
  );
}
