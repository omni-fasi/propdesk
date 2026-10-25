// Hand-written decoder for Yahoo Finance streamer frames: protobuf `PricingData`, base64 inside JSON.
// Wire types used: 0 varint (int32, zigzag sint64), 1 64-bit (double), 2 length-delimited (string), 5 32-bit (float).
// Field numbers verified against live frames (2026-10-24): e.g. 3 time is zigzag ms, 6 quoteType is a plain varint.

export interface PricingData {
  id: string;
  price?: number;
  /** Trade time, ms since epoch. */
  time?: number;
  currency?: string;
  exchange?: string;
  quoteType?: number;
  marketHours?: number;
  /** Percent (−1.29 = −1.29 %). */
  changePercent?: number;
  dayVolume?: number;
  dayHigh?: number;
  dayLow?: number;
  change?: number;
  shortName?: string;
  expireDate?: number;
  openPrice?: number;
  previousClose?: number;
  strikePrice?: number;
  underlyingSymbol?: string;
  openInterest?: number;
  optionsType?: number;
  miniOption?: number;
  lastSize?: number;
  bid?: number;
  bidSize?: number;
  ask?: number;
  askSize?: number;
  priceHint?: number;
  vol24hr?: number;
  volAllCurrencies?: number;
  fromCurrency?: string;
  lastMarket?: string;
  circulatingSupply?: number;
  marketCap?: number;
}

type Kind = 'string' | 'float' | 'double' | 'sint64' | 'int32';

const FIELDS: Record<number, [keyof PricingData, Kind]> = {
  1: ['id', 'string'],
  2: ['price', 'float'],
  3: ['time', 'sint64'],
  4: ['currency', 'string'],
  5: ['exchange', 'string'],
  6: ['quoteType', 'int32'],
  7: ['marketHours', 'int32'],
  8: ['changePercent', 'float'],
  9: ['dayVolume', 'sint64'],
  10: ['dayHigh', 'float'],
  11: ['dayLow', 'float'],
  12: ['change', 'float'],
  13: ['shortName', 'string'],
  14: ['expireDate', 'sint64'],
  15: ['openPrice', 'float'],
  16: ['previousClose', 'float'],
  17: ['strikePrice', 'float'],
  18: ['underlyingSymbol', 'string'],
  19: ['openInterest', 'sint64'],
  20: ['optionsType', 'int32'],
  21: ['miniOption', 'sint64'],
  22: ['lastSize', 'sint64'],
  23: ['bid', 'float'],
  24: ['bidSize', 'sint64'],
  25: ['ask', 'float'],
  26: ['askSize', 'sint64'],
  27: ['priceHint', 'sint64'],
  28: ['vol24hr', 'sint64'],
  29: ['volAllCurrencies', 'sint64'],
  30: ['fromCurrency', 'string'],
  31: ['lastMarket', 'string'],
  32: ['circulatingSupply', 'double'],
  33: ['marketCap', 'double'],
};

const WIRE: Record<Kind, number> = { int32: 0, sint64: 0, double: 1, string: 2, float: 5 };
const TWO_63 = 2 ** 63;
const TWO_64 = 2 ** 64;
const utf8 = new TextDecoder();

/** Zigzag-decode an unsigned varint value (exact up to 2^53). */
function zigzag(v: number): number {
  return v % 2 === 1 ? -(v + 1) / 2 : v / 2;
}

export function decodePricingData(buf: Uint8Array): PricingData {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: Record<string, unknown> = {};
  let pos = 0;

  const need = (n: number) => {
    if (pos + n > buf.length) throw new Error('truncated PricingData');
  };
  // Numbers instead of bitwise ops: values (ms timestamps, volumes) exceed 32 bits.
  const varint = (): number => {
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      need(1);
      const b = buf[pos++];
      result += (b & 0x7f) * mul;
      if (b < 0x80) return result;
      mul *= 128;
    }
    throw new Error('varint too long');
  };

  while (pos < buf.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    const def = FIELDS[field];
    // A field whose wire type differs from the schema is skipped rather than misread.
    const name = def && WIRE[def[1]] === wire ? def[0] : null;
    switch (wire) {
      case 0: {
        const v = varint();
        if (name) out[name] = def[1] === 'sint64' ? zigzag(v) : v >= TWO_63 ? v - TWO_64 : v;
        break;
      }
      case 1:
        need(8);
        if (name) out[name] = view.getFloat64(pos, true);
        pos += 8;
        break;
      case 2: {
        const len = varint();
        need(len);
        if (name) out[name] = utf8.decode(buf.subarray(pos, pos + len));
        pos += len;
        break;
      }
      case 5:
        need(4);
        if (name) out[name] = view.getFloat32(pos, true);
        pos += 4;
        break;
      default:
        throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
  if (typeof out.id !== 'string' || !out.id) throw new Error('PricingData without id');
  return out as unknown as PricingData;
}

/**
 * Decode one streamer frame: `{"type":"pricing","message":"<base64>"}` (version=2) or a bare base64
 * string (version 1). Returns null for frames that carry no pricing data.
 */
export function decodeStreamerFrame(text: string): PricingData | null {
  let b64 = text.trim();
  if (!b64) return null;
  if (b64.startsWith('{')) {
    const msg = JSON.parse(b64) as { type?: unknown; message?: unknown };
    if (msg.type !== 'pricing' || typeof msg.message !== 'string') return null;
    b64 = msg.message;
  }
  return decodePricingData(Buffer.from(b64, 'base64'));
}
