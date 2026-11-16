"use strict";

/**
 * Uniform API error envelope: `{ error, code }` plus optional details.
 * Keeping one shape means the Next.js client can translate status codes into
 * actionable messages without guessing per route.
 */

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const errors = {
  badRequest: (message, details) =>
    new ApiError(400, "INVALID_REQUEST", message, details),
  unauthenticated: (message = "Authentication required") =>
    new ApiError(401, "UNAUTHENTICATED", message),
  invalidSession: () =>
    new ApiError(401, "INVALID_SESSION", "Your session has expired. Please sign in again."),
  forbidden: (message = "You do not have permission to do that") =>
    new ApiError(403, "FORBIDDEN", message),
  notFound: (message = "Resource not found") =>
    new ApiError(404, "NOT_FOUND", message),
  conflict: (message, details) =>
    new ApiError(409, "CONFLICT", message, details),
  tooMany: (message = "Too many attempts. Please wait and try again.") =>
    new ApiError(429, "RATE_LIMITED", message),
  unavailable: (message = "Service temporarily unavailable") =>
    new ApiError(503, "SERVICE_UNAVAILABLE", message),
};

function notFoundHandler(req, res) {
  res.status(404).json({
    error: `Route not found: ${req.method} ${req.originalUrl}`,
    code: "ROUTE_NOT_FOUND",
  });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(error, req, res, next) {
  if (error instanceof ApiError) {
    const body = { error: error.message, code: error.code };
    if (error.details !== undefined) body.details = error.details;
    return res.status(error.status).json(body);
  }

  if (error && error.name === "ValidationError") {
    return res.status(400).json({
      error: "The request contained invalid values",
      code: "INVALID_REQUEST",
      details: Object.keys(error.errors || {}),
    });
  }

  if (error && error.name === "CastError") {
    return res.status(400).json({
      error: "One of the provided identifiers is not valid",
      code: "INVALID_IDENTIFIER",
    });
  }

  if (error && error.code === 11000) {
    return res.status(409).json({
      error: "That record already exists",
      code: "DUPLICATE",
    });
  }

  console.error("Unhandled API error:", error);
  return res.status(500).json({
    error: "Something went wrong on the server",
    code: "INTERNAL_ERROR",
  });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { ApiError, asyncRoute, errorHandler, errors, notFoundHandler };
