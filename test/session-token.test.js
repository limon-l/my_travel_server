"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

process.env.API_SESSION_SECRET = "test-secret-that-is-definitely-long-enough-1234";

const { signToken, verifyToken, MIN_SECRET_LENGTH } = require("../lib/session-token");

function tamper(token, index) {
  const chars = token.split("");
  chars[index] = chars[index] === "a" ? "b" : "a";
  return chars.join("");
}

test("a signed token round-trips the identity", () => {
  const token = signToken({ sub: "user-1", role: "user", name: "Ada", email: "ada@example.com" });
  const identity = verifyToken(token);
  assert.ok(identity);
  assert.equal(identity.sub, "user-1");
  assert.equal(identity.role, "user");
  assert.equal(identity.name, "Ada");
});

test("unknown roles are downgraded to user", () => {
  const token = signToken({ sub: "user-1", role: "superuser" });
  assert.equal(verifyToken(token).role, "user");
});

test("admin role is preserved", () => {
  const token = signToken({ sub: "admin", role: "admin" });
  assert.equal(verifyToken(token).role, "admin");
});

test("tampered payloads are rejected", () => {
  const token = signToken({ sub: "user-1", role: "user" });
  const [encoded, signature] = token.split(".");
  const forgedPayload = Buffer.from(
    JSON.stringify({ sub: "admin", role: "admin", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 120 }),
  ).toString("base64url");
  assert.equal(verifyToken(`${forgedPayload}.${signature}`), null);
  assert.equal(verifyToken(tamper(token, 0)), null);
  assert.equal(verifyToken(encoded), null);
  assert.equal(verifyToken(""), null);
  assert.equal(verifyToken(undefined), null);
});

test("expired tokens are rejected", () => {
  const token = signToken({ sub: "user-1" }, { ttlSeconds: 30 });
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60 * 1000;
  try {
    assert.equal(verifyToken(token), null);
  } finally {
    Date.now = realNow;
  }
});

test("a missing or short secret disables signing and verification", () => {
  const original = process.env.API_SESSION_SECRET;
  process.env.API_SESSION_SECRET = "short";
  try {
    assert.throws(() => signToken({ sub: "user-1" }), /API_SESSION_SECRET/);
    assert.equal(verifyToken("anything.anything"), null);
  } finally {
    process.env.API_SESSION_SECRET = original;
  }
});

test("the minimum secret length is enforced and documented", () => {
  assert.equal(MIN_SECRET_LENGTH, 32);
  assert.ok(crypto.randomBytes(32).toString("base64url").length >= MIN_SECRET_LENGTH);
});
