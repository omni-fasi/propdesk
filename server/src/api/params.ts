// Request body / query-string parsing for the REST layer. Failures throw EngineError('invalid').

import type { Context } from 'hono';
import { fail } from '../engine/errors.ts';
import { isDayKey } from '../engine/validation.ts';

const MAX_BODY = 1_000_000;

/** Parsed JSON body ({} when empty). Never throws anything but EngineError. */
export async function jsonBody(c: Context): Promise<unknown> {
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    fail('invalid', 'Could not read the request body');
  }
  if (text.length > MAX_BODY) fail('invalid', 'Request body is too large');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail('invalid', 'Request body is not valid JSON');
  }
}

/** accountId query param: an id, or null for 'all' / missing. */
export function accountParam(c: Context): string | null {
  const v = c.req.query('accountId');
  return v == null || v === '' || v === 'all' ? null : v;
}

export function msParam(c: Context, name: string): number | null {
  const v = c.req.query(name);
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) fail('invalid', `${name} must be a timestamp in milliseconds`);
  return n;
}

export function intParam(c: Context, name: string, def: number, min: number, max: number): number {
  const v = c.req.query(name);
  if (v == null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail('invalid', `${name} must be a whole number between ${min} and ${max}`);
  return n;
}

export function dayParam(c: Context, name: string): string | null {
  const v = c.req.query(name);
  if (v == null || v === '') return null;
  if (!isDayKey(v)) fail('invalid', `${name} must be a date (YYYY-MM-DD)`);
  return v;
}

export function enumParam<T extends string>(c: Context, name: string, values: readonly T[], def: T): T {
  const v = c.req.query(name);
  if (v == null || v === '') return def;
  if (!(values as readonly string[]).includes(v)) fail('invalid', `${name} must be one of: ${values.join(', ')}`);
  return v as T;
}
