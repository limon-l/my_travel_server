"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { MAX_TRACKED_KEYS, clientKey, createRateLimiter } = require("../lib/rate-limit");
const { errors } = require("../lib/http");

function makeRequest({ ip = "203.0.113.5", email = "traveller@example.com" } = {}) {
  return { ip, socket: { remoteAddress: ip }, body: { email } };
}

function call(limiter, req) {
  const headers = {};
  const res = {
    headers,
    set(key, value) {
      headers[key] = value;
      return this;
    },
  };
  let error = null;
  limiter(req, res, (nextError) => {
    error = nextError || null;
  });
  return { error, headers };
}

function limiter(overrides = {}) {
  return createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 2,
    keyPrefix: "login",
    onLimit: () => errors.tooMany("Too many sign-in attempts."),
    ...overrides,
  });
}

test("allows requests up to the limit, then returns a typed 429 with Retry-After", () => {
  const limit = limiter();
  const request = makeRequest();

  assert.equal(call(limit, request).error, null);
  assert.equal(call(limit, request).error, null);

  const blocked = call(limit, request);
  assert.ok(blocked.error, "third attempt must be rejected");
  assert.equal(blocked.error.status, 429);
  assert.equal(blocked.error.code, "RATE_LIMITED");
  assert.match(blocked.headers["Retry-After"], /^\d+$/);
  assert.equal(blocked.headers["X-RateLimit-Remaining"], "0");
});

test("normalises the email so casing cannot bypass the limit", () => {
  const limit = limiter();
  assert.equal(call(limit, makeRequest({ email: "Traveller@Example.com" })).error, null);
  assert.equal(call(limit, makeRequest({ email: " traveller@example.com " })).error, null);
  assert.ok(call(limit, makeRequest({ email: "TRAVELLER@EXAMPLE.COM" })).error);
});

test("different travellers on the same IP are counted separately", () => {
  const limit = limiter();
  assert.equal(call(limit, makeRequest({ email: "one@example.com" })).error, null);
  assert.equal(call(limit, makeRequest({ email: "one@example.com" })).error, null);
  assert.ok(call(limit, makeRequest({ email: "one@example.com" })).error);
  assert.equal(call(limit, makeRequest({ email: "two@example.com" })).error, null);
});

test("the tracked-key map is bounded even when identifiers are unlimited", () => {
  const limit = limiter({ maxKeys: 3 });
  for (let index = 0; index < 50; index += 1) {
    call(limit, makeRequest({ email: `person-${index}@example.com` }));
  }
  assert.ok(limit.trackedKeys() <= 3, `expected <= 3 keys, saw ${limit.trackedKeys()}`);
  assert.ok(limit.trackedKeys() <= MAX_TRACKED_KEYS);
});

test("expired entries are swept so memory is reclaimed", () => {
  let now = 1_000_000;
  const limit = limiter({ now: () => now });

  for (let index = 0; index < 20; index += 1) {
    call(limit, makeRequest({ email: `sweep-${index}@example.com` }));
  }
  assert.equal(limit.trackedKeys(), 20);

  now += 16 * 60 * 1000;
  call(limit, makeRequest({ email: "fresh@example.com" }));

  assert.equal(limit.trackedKeys(), 1, "all expired keys should be removed by the sweep");
});

test("rate-limit keys are scoped by prefix, IP and email", () => {
  assert.equal(
    clientKey("login", makeRequest({ ip: "10.0.0.1", email: "A@B.com" })),
    "login:10.0.0.1:a@b.com",
  );
  assert.equal(
    clientKey("register", makeRequest({ ip: "10.0.0.1", email: "a@b.com" })),
    "register:10.0.0.1:a@b.com",
  );
});
