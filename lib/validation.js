"use strict";

const mongoose = require("mongoose");

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Departures are calendar dates, not instants. The whole product stores them as
 * `YYYY-MM-DD` strings interpreted in UTC, which removes server/browser timezone
 * drift from availability checks. This is the documented date policy.
 */
function parseDateOnly(value) {
  if (typeof value !== "string" || !DATE_ONLY_PATTERN.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Rejects impossible calendar days such as 2026-02-31, which Date would roll over.
  if (parsed.toISOString().slice(0, 10) !== value) return null;
  return parsed;
}

function toDateOnly(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  if (typeof value !== "string") return null;
  if (DATE_ONLY_PATTERN.test(value)) {
    const parsed = parseDateOnly(value);
    return parsed ? parsed.toISOString().slice(0, 10) : null;
  }
  // Timestamps are normalised to UTC before being reduced to a calendar date.
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function isTodayOrLater(dateOnly, now = new Date()) {
  return typeof dateOnly === "string" && dateOnly >= todayUtc(now);
}

function normalizeAvailableDates(input) {
  if (!Array.isArray(input)) {
    return { ok: false, error: "availableDates must be an array of YYYY-MM-DD strings" };
  }
  const normalized = [];
  for (const raw of input) {
    if (raw === null || raw === undefined || raw === "") continue;
    const dateOnly = toDateOnly(raw);
    if (!dateOnly) {
      return { ok: false, error: `Invalid date: ${String(raw)}` };
    }
    normalized.push(dateOnly);
  }
  return { ok: true, dates: [...new Set(normalized)].sort() };
}

function isValidObjectId(value) {
  return typeof value === "string" && mongoose.isValidObjectId(value);
}

function isNonEmptyString(value, { max = 500 } = {}) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;
}

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 254) return null;
  return email;
}

function normalizeUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return null;
  if (trimmed.startsWith("/")) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function clampString(value, max) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, max);
}

module.exports = {
  DATE_ONLY_PATTERN,
  clampString,
  isNonEmptyString,
  isTodayOrLater,
  isValidObjectId,
  normalizeAvailableDates,
  normalizeEmail,
  normalizeUrl,
  parseDateOnly,
  toDateOnly,
  todayUtc,
};
