// Account lifecycle calls. Each one applies the server's answer to the store right away
// (the WebSocket echo arrives a moment later and is idempotent).

import type { CreateAccountRequest, PayoutResponse } from '@shared/api';
import type { Account, FeesMode, WalletSummary } from '@shared/types';
import { api, ApiRequestError } from '@/api/client';
import { useApp } from '@/store/app';

function applyAccount(account: Account): Account {
  useApp.getState().apply({ type: 'account', account });
  return account;
}

export function applyWallet(wallet: WalletSummary): void {
  useApp.getState().apply({ type: 'wallet', wallet });
}

export async function createAccount(body: CreateAccountRequest, opts: { activate?: boolean } = {}): Promise<Account> {
  const account = applyAccount(await api.createAccount(body));
  if (opts.activate ?? true) useApp.getState().setActiveAccount(account.id);
  return account;
}

export async function retryAccount(id: string): Promise<Account> {
  const account = applyAccount(await api.retryAccount(id));
  useApp.getState().setActiveAccount(account.id);
  return account;
}

export async function activateFunded(id: string): Promise<Account> {
  const account = applyAccount(await api.activateFunded(id));
  useApp.getState().setActiveAccount(account.id);
  return account;
}

export async function takeBreak(id: string, minutes: number): Promise<Account> {
  return applyAccount(await api.takeBreak(id, { minutes, message: `Voluntary ${minutes}-minute break` }));
}

export async function renameAccount(id: string, name: string): Promise<Account> {
  return applyAccount(await api.updateAccount(id, { name }));
}

export async function setArchived(id: string, archived: boolean): Promise<Account> {
  return applyAccount(await api.updateAccount(id, { archived }));
}

export async function setFees(id: string, fees: FeesMode): Promise<Account> {
  return applyAccount(await api.updateAccount(id, { fees }));
}

export async function requestPayout(id: string, amount: number): Promise<PayoutResponse> {
  const res = await api.requestPayout(id, { amount });
  applyAccount(res.account);
  applyWallet(res.wallet);
  return res;
}

export async function deposit(amount: number, note?: string): Promise<WalletSummary> {
  const res = await api.deposit({ amount, note: note?.trim() || undefined });
  applyWallet(res.summary);
  return res.summary;
}

export function isInsufficientFunds(e: unknown): boolean {
  return e instanceof ApiRequestError && e.code === 'insufficient_funds';
}
