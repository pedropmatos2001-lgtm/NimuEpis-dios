import { sleep } from './util.js';
import { USER_AGENT } from './config.js';

/**
 * Minimal client-side rate limiter: guarantees at least `minIntervalMs`
 * (+ small jitter, to avoid thundering-herd alignment with other clients)
 * between the *starts* of consecutive requests through this limiter.
 */
export class RateLimiter {
  constructor(minIntervalMs) {
    this.minIntervalMs = minIntervalMs;
    this.nextAllowedAt = 0;
  }

  async wait() {
    const now = Date.now();
    const jitter = Math.floor(Math.random() * 150);
    if (now < this.nextAllowedAt) await sleep(this.nextAllowedAt - now + jitter);
    this.nextAllowedAt = Math.max(now, this.nextAllowedAt) + this.minIntervalMs;
  }
}

/**
 * GET/POST JSON with retry + exponential backoff + jitter.
 *  - 429: honours Retry-After when present, else backs off.
 *  - 5xx / network errors: retried with backoff.
 *  - other 4xx: fail fast (caller bug or missing resource — retrying won't help).
 * SECURITY: `headers` (which may carry Bearer tokens) are never echoed into
 * error messages or logs — errors carry `label` + HTTP status only.
 */
export async function fetchJson(
  url,
  { label, headers = {}, limiter, retries = 4, method = 'GET', body, timeoutMs, maxRetryAfterMs = Infinity } = {},
) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      const backoff = 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
      await sleep(backoff);
    }
    if (limiter) await limiter.wait();
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        // Opcional: um teto por pedido. Sem ele, uma ligação pendurada pendura
        // quem chama (o passo incremental dos episódios passa-o, ver
        // episodes-backfill.js). Um pedido cortado conta como erro de rede.
        ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
    } catch (err) {
      lastError = new Error(`${label}: network error (${err.message})`); // retryable
      continue;
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      lastError = new Error(`${label}: HTTP 429 (rate limited)`);
      if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(Math.min(retryAfter * 1000, maxRetryAfterMs));
      continue;
    }
    if (res.status >= 500) {
      lastError = new Error(`${label}: HTTP ${res.status}`);
      continue; // server hiccup — retry
    }
    if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`); // 4xx — fail fast
    return res.json();
  }
  throw lastError ?? new Error(`${label}: failed after ${retries} retries`);
}
