/**
 * In-memory sliding-window rate limiter (per IP + per route bucket).
 *
 * The MASTER PROMPT requires rate limiting on all user-triggered endpoints
 * (analyze / chat / user-source submission). In this single-process
 * deployment an in-memory window is sufficient and avoids external
 * middleware (Redis). Buckets are pruned lazily.
 *
 * Returns a `limit()` helper usable from route handlers:
 *
 *   const verdict = limit(req, { key: "analyze", max: 6, windowMs: 60 * 60_000 });
 *   if (!verdict.ok) return 429 …;
 */

export interface RateLimitOptions {
  /** Bucket name — counts are tracked per (bucket + client IP). */
  key: string;
  /** Max allowed hits inside the window. */
  max: number;
  /** Window length in ms. */
  windowMs: number;
}

export interface RateLimitVerdict {
  ok: boolean;
  /** Hits counted inside the current window (including this one). */
  count: number;
  /** ms until the oldest hit leaves the window (present when blocked). */
  retryAfterMs?: number;
}

type Bucket = { hits: number[] };

/** bucket name → ip → hit timestamps */
const buckets = new Map<string, Map<string, Bucket>>();

/** Extract the client IP from proxy headers (sandbox Caddy sets X-Forwarded-For). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? "local";
}

/**
 * Count one hit against (bucket, ip) and tell whether it is allowed.
 * Never throws — a limiter failure must not break the endpoint.
 */
export function hit(req: Request, opts: RateLimitOptions): RateLimitVerdict {
  try {
    const now = Date.now();
    const ip = clientIp(req);
    let byIp = buckets.get(opts.key);
    if (!byIp) {
      byIp = new Map();
      buckets.set(opts.key, byIp);
    }
    let bucket = byIp.get(ip);
    if (!bucket) {
      bucket = { hits: [] };
      byIp.set(ip, bucket);
    }

    // drop hits that left the window
    bucket.hits = bucket.hits.filter((t) => now - t < opts.windowMs);

    if (bucket.hits.length >= opts.max) {
      const oldest = bucket.hits[0] ?? now;
      return {
        ok: false,
        count: bucket.hits.length,
        retryAfterMs: Math.max(1000, opts.windowMs - (now - oldest)),
      };
    }

    bucket.hits.push(now);

    // lazy prune: if the ip map grew large, drop empty buckets
    if (byIp.size > 512) {
      for (const [ipKey, b] of byIp) {
        if (b.hits.every((t) => now - t >= opts.windowMs)) byIp.delete(ipKey);
      }
    }

    return { ok: true, count: bucket.hits.length };
  } catch {
    // limiter must never break the endpoint
    return { ok: true, count: 0 };
  }
}

/** Build a 429 Response with a Russian message + Retry-After header. */
export function tooManyRequests(v: RateLimitVerdict): Response {
  const secs = Math.ceil((v.retryAfterMs ?? 60_000) / 1000);
  return new Response(
    JSON.stringify({
      error:
        `Слишком много запросов. Лимит будет восстановлен через ${Math.max(1, secs)} с. ` +
        "Дождитесь и повторите попытку.",
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Retry-After": String(Math.max(1, secs)),
      },
    }
  );
}
