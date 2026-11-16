"use strict";

/**
 * Signed, short-lived session tokens used between the Next.js server and this API.
 *
 * The browser never mints these tokens. The Next.js server signs one per upstream
 * request using the shared `API_SESSION_SECRET`, and this API verifies it before
 * trusting any identity. This replaces the previous design, where the browser
 * supplied `userId` in the request body.
 */

const crypto = require("crypto");

const MAX_FUTURE_SKEW_SECONDS = 60;
const MIN_SECRET_LENGTH = 32;

function getSecret() {
  const secret = process.env.API_SESSION_SECRET;
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    return null;
  }
  return secret;
}

function encode(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function signatureFor(encoded, secret) {
  return crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
}

function isConfigured() {
  return getSecret() !== null;
}

/**
 * @param {{sub: string, role?: string, name?: string, email?: string}} identity
 * @param {{ttlSeconds?: number}} [options]
 */
function signToken(identity, options = {}) {
  const secret = getSecret();
  if (!secret) {
    throw new Error("API_SESSION_SECRET is missing or shorter than 32 characters");
  }
  if (!identity || typeof identity.sub !== "string" || identity.sub.length === 0) {
    throw new Error("Cannot sign a token without a subject");
  }

  const ttlSeconds = Math.min(Math.max(options.ttlSeconds || 120, 30), 900);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: identity.sub,
    role: identity.role === "admin" ? "admin" : "user",
    iat: now,
    exp: now + ttlSeconds,
  };
  if (identity.name) payload.name = String(identity.name).slice(0, 120);
  if (identity.email) payload.email = String(identity.email).slice(0, 254);

  const encoded = encode(payload);
  return `${encoded}.${signatureFor(encoded, secret)}`;
}

/**
 * Verifies signature, expiry and shape. Returns `null` for anything untrusted.
 */
function verifyToken(token) {
  const secret = getSecret();
  if (!secret || typeof token !== "string") return null;

  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) return null;

  const encoded = token.slice(0, separator);
  const provided = token.slice(separator + 1);
  const expected = signatureFor(encoded, secret);

  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");
  if (expectedBuffer.length !== providedBuffer.length) return null;
  if (!crypto.timingSafeEqual(expectedBuffer, providedBuffer)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
  if (!Number.isInteger(payload.exp)) return null;

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) return null;
  if (Number.isInteger(payload.iat) && payload.iat - now > MAX_FUTURE_SKEW_SECONDS) {
    return null;
  }

  return {
    sub: payload.sub,
    role: payload.role === "admin" ? "admin" : "user",
    name: typeof payload.name === "string" ? payload.name : undefined,
    email: typeof payload.email === "string" ? payload.email : undefined,
  };
}

module.exports = {
  MAX_FUTURE_SKEW_SECONDS,
  MIN_SECRET_LENGTH,
  isConfigured,
  signToken,
  verifyToken,
};
