// Production static serving of web/dist with SPA fallback to index.html.

import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { MiddlewareHandler } from 'hono';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Serves files under `root`; unknown paths without a file extension get index.html (client-side routes). */
export function staticFiles(root: string): MiddlewareHandler {
  const base = resolve(root);
  return async (c, next) => {
    const method = c.req.method;
    const path = c.req.path;
    if ((method !== 'GET' && method !== 'HEAD') || path === '/api' || path.startsWith('/api/') || path === '/ws') return next();
    const index = join(base, 'index.html');
    if (!existsSync(index)) return next();
    let rel: string;
    try {
      rel = decodeURIComponent(path);
    } catch {
      return next();
    }
    let file = resolve(base, `.${rel}`);
    if (file !== base && !file.startsWith(base + sep)) return next();
    if (!isFile(file)) {
      if (extname(rel) !== '') return next(); // a missing asset is a real 404
      file = index;
    }
    const body = await readFile(file);
    const immutable = file.startsWith(join(base, 'assets') + sep);
    return new Response(method === 'HEAD' ? null : body, {
      headers: {
        'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(body.length),
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      },
    });
  };
}
