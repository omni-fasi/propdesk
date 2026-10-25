// Minimal hash router: #/<page>?<params>

import { useSyncExternalStore } from 'react';

export type Page = 'trade' | 'calendar' | 'journal' | 'challenges' | 'wallet' | 'settings';
export const PAGES: Page[] = ['trade', 'calendar', 'journal', 'challenges', 'wallet', 'settings'];

export interface Route {
  page: Page;
  params: URLSearchParams;
}

let cachedHash = '';
let cachedRoute: Route = { page: 'trade', params: new URLSearchParams() };

function current(): Route {
  const hash = location.hash;
  if (hash === cachedHash) return cachedRoute;
  const raw = hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const page = (PAGES as string[]).includes(path) ? (path as Page) : 'trade';
  cachedHash = hash;
  cachedRoute = { page, params: new URLSearchParams(query) };
  return cachedRoute;
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, current);
}

type Params = Record<string, string | number | boolean | null | undefined>;

function build(page: Page, params?: Params): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return `#/${page}${s ? `?${s}` : ''}`;
}

export function navigate(page: Page, params?: Params): void {
  location.hash = build(page, params);
}

/** Update query params of the current page without adding a history entry. */
export function setParams(params: Params): void {
  const { page, params: cur } = current();
  const merged: Params = Object.fromEntries(cur.entries());
  Object.assign(merged, params);
  history.replaceState(null, '', build(page, merged));
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function hrefFor(page: Page, params?: Params): string {
  return build(page, params);
}
