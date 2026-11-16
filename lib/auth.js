"use strict";

const { errors } = require("./http");
const { verifyToken } = require("./session-token");

/**
 * Every route that touches private data must run through one of these guards.
 * Identity is established from a server-signed token only. Request bodies are
 * never trusted for identity or role.
 */

function readBearerToken(req) {
  const header = req.get("authorization");
  if (typeof header !== "string") return null;
  const separator = header.indexOf(" ");
  if (separator <= 0) return null;
  const scheme = header.slice(0, separator).toLowerCase();
  const token = header.slice(separator + 1).trim();
  if (scheme !== "bearer" || token.length === 0) return null;
  return token;
}

function authenticate(req, res, next) {
  const token = readBearerToken(req);
  if (!token) {
    return next(errors.unauthenticated());
  }

  const identity = verifyToken(token);
  if (!identity) {
    return next(errors.invalidSession());
  }

  req.identity = identity;
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.identity || req.identity.role !== "admin") {
    return next(errors.forbidden("Admin access required"));
  }
  return next();
}

function isSelf(identity, userId) {
  return Boolean(identity) && String(identity.sub) === String(userId);
}

function requireSelfOrAdmin(req, res, next) {
  if (!req.identity) return next(errors.unauthenticated());
  if (req.identity.role === "admin" || isSelf(req.identity, req.params.userId)) {
    return next();
  }
  return next(errors.forbidden("You can only access your own account"));
}

module.exports = {
  authenticate,
  isSelf,
  readBearerToken,
  requireAdmin,
  requireSelfOrAdmin,
};
