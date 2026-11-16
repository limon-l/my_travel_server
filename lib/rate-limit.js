"use strict";

/**
 * Bounded, in-process rate limiter.
 *
 * Design goals:
 * - Never grow without limit: expired entries are swept periodically and the map
 *   is hard-capped so an attacker cycling identifiers cannot exhaust memory.
 * - Key on IP + normalised email (never on a caller-supplied identifier alone).
 * - Emit standard `Retry-After` and `X-RateLimit-*` headers on every decision.
 * - Stay testable by accepting an injectable clock.
 *
 * A shared store is only required for multi-instance deployments; see README.
 */

const MAX_TRACKED_KEYS = 10_000;
const MAX_IDENTITY_LENGTH = 254;

function clientKey(prefix, req) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const raw = typeof req.body?.email === "string" ? req.body.email : "";
  const identity = raw.trim().toLowerCase().slice(0, MAX_IDENTITY_LENGTH);
  return `${prefix}:${ip}:${identity}`;
}

function createRateLimiter({
  windowMs,
  max,
  keyPrefix,
  onLimit,
  maxKeys = MAX_TRACKED_KEYS,
  now = () => Date.now(),
}) {
  if (!(windowMs > 0) || !(max > 0)) {
    throw new Error("createRateLimiter requires a positive windowMs and max");
  }

  const hits = new Map();
  const sweepInterval = Math.min(windowMs, 60_000);
  let lastSweep = now();

  function sweep(at) {
    for (const [key, entry] of hits) {
      if (entry.resetAt <= at) hits.delete(key);
    }
    lastSweep = at;
  }

  function evictOldest(count) {
    let removed = 0;
    for (const key of hits.keys()) {
      hits.delete(key);
      removed += 1;
      if (removed >= count) break;
    }
  }

  function middleware(req, res, next) {
    const at = now();
    if (at - lastSweep >= sweepInterval) sweep(at);

    const key = clientKey(keyPrefix, req);
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= at) {
      hits.set(key, { count: 1, resetAt: at + windowMs });

      if (hits.size > maxKeys) {
        sweep(at);
        if (hits.size > maxKeys) evictOldest(hits.size - maxKeys);
      }

      if (res?.set) res.set("X-RateLimit-Remaining", String(max - 1));
      return next();
    }

    entry.count += 1;

    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - at) / 1000));
      if (res?.set) {
        res.set("Retry-After", String(retryAfter));
        res.set("X-RateLimit-Limit", String(max));
        res.set("X-RateLimit-Remaining", "0");
      }
      const error = typeof onLimit === "function" ? onLimit(retryAfter) : new Error("Too many requests");
      return next(error);
    }

    if (res?.set) res.set("X-RateLimit-Remaining", String(max - entry.count));
    return next();
  }

  middleware.reset = () => hits.clear();
  middleware.trackedKeys = () => hits.size;
  return middleware;
}

module.exports = { MAX_IDENTITY_LENGTH, MAX_TRACKED_KEYS, clientKey, createRateLimiter };
