"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isTodayOrLater,
  isValidObjectId,
  normalizeAvailableDates,
  normalizeEmail,
  normalizeUrl,
  parseDateOnly,
  toDateOnly,
  todayUtc,
} = require("../lib/validation");

test("parseDateOnly accepts real calendar dates only", () => {
  assert.equal(parseDateOnly("2026-12-01").toISOString(), "2026-12-01T00:00:00.000Z");
  assert.equal(parseDateOnly("2026-02-31"), null);
  assert.equal(parseDateOnly("2026-13-01"), null);
  assert.equal(parseDateOnly("01/12/2026"), null);
  assert.equal(parseDateOnly("2026-1-1"), null);
  assert.equal(parseDateOnly(""), null);
  assert.equal(parseDateOnly(undefined), null);
});

test("toDateOnly normalises timestamps without timezone drift", () => {
  assert.equal(toDateOnly("2026-12-01T00:00:00.000Z"), "2026-12-01");
  assert.equal(toDateOnly("2026-12-01T23:30:00.000Z"), "2026-12-01");
  assert.equal(toDateOnly(new Date("2026-12-01T10:00:00.000Z")), "2026-12-01");
  assert.equal(toDateOnly("nonsense"), null);
});

test("past departure dates are rejected against today in UTC", () => {
  const now = new Date("2026-11-14T12:00:00.000Z");
  assert.equal(todayUtc(now), "2026-11-14");
  assert.equal(isTodayOrLater("2026-11-13", now), false);
  assert.equal(isTodayOrLater("2026-11-14", now), true);
  assert.equal(isTodayOrLater("2026-11-15", now), true);
});

test("available dates are de-duplicated, sorted and validated", () => {
  const result = normalizeAvailableDates(["2026-12-02", "2026-12-01", "2026-12-02"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.dates, ["2026-12-01", "2026-12-02"]);

  assert.equal(normalizeAvailableDates("2026-12-01").ok, false);
  assert.equal(normalizeAvailableDates(["not-a-date"]).ok, false);
  assert.equal(normalizeAvailableDates([null, "", "2026-12-01"]).dates.length, 1);
});

test("emails are normalised and validated", () => {
  assert.equal(normalizeEmail("  Ada@Example.COM "), "ada@example.com");
  assert.equal(normalizeEmail("not-an-email"), null);
  assert.equal(normalizeEmail("a@b"), null);
});

test("tour image URLs accept https and relative paths, reject scripts", () => {
  assert.equal(normalizeUrl("https://example.com/a.jpg"), "https://example.com/a.jpg");
  assert.equal(normalizeUrl("/images/a.jpg"), "/images/a.jpg");
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl(""), null);
});

test("object id validation rejects route injection attempts", () => {
  assert.equal(isValidObjectId("507f1f77bcf86cd799439011"), true);
  assert.equal(isValidObjectId("admin"), false);
  assert.equal(isValidObjectId("../../etc/passwd"), false);
});
