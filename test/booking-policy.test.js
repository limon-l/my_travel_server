"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  canTransition,
  computeEndDate,
  holdKeyFor,
  isActiveStatus,
  overlapsExistingTrip,
  rangesOverlap,
} = require("../lib/booking-policy");

test("only Pending requests can be decided", () => {
  assert.equal(canTransition("Pending", "Confirmed"), true);
  assert.equal(canTransition("Pending", "Rejected"), true);
  assert.equal(canTransition("Confirmed", "Rejected"), false);
  assert.equal(canTransition("Rejected", "Confirmed"), false);
  assert.equal(canTransition("Confirmed", "Confirmed"), false);
  assert.equal(canTransition("Rejected", "Rejected"), false);
  assert.equal(canTransition("Unknown", "Confirmed"), false);
});

test("active statuses are Pending and Confirmed only", () => {
  assert.equal(isActiveStatus("Pending"), true);
  assert.equal(isActiveStatus("Confirmed"), true);
  assert.equal(isActiveStatus("Rejected"), false);
});

test("hold keys are deterministic per tour and calendar date", () => {
  assert.equal(holdKeyFor("tour-1", "2026-12-01"), "tour-1:2026-12-01");
  assert.notEqual(holdKeyFor("tour-1", "2026-12-01"), holdKeyFor("tour-1", "2026-12-02"));
  assert.notEqual(holdKeyFor("tour-1", "2026-12-01"), holdKeyFor("tour-2", "2026-12-01"));
});

test("end date is duration days after departure and never mutates the input", () => {
  const start = new Date("2026-12-01T00:00:00.000Z");
  const end = computeEndDate(start, 7);
  assert.equal(end.toISOString(), "2026-12-08T00:00:00.000Z");
  assert.equal(start.toISOString(), "2026-12-01T00:00:00.000Z");
});

test("overlap uses a half-open range", () => {
  const aStart = new Date("2026-12-01T00:00:00.000Z");
  const aEnd = new Date("2026-12-08T00:00:00.000Z");
  const touchingStart = new Date("2026-12-08T00:00:00.000Z");
  const touchingEnd = new Date("2026-12-12T00:00:00.000Z");

  assert.equal(rangesOverlap(aStart, aEnd, touchingStart, touchingEnd), false);
  assert.equal(
    rangesOverlap(aStart, aEnd, new Date("2026-12-07T00:00:00.000Z"), new Date("2026-12-10T00:00:00.000Z")),
    true,
  );
});

test("rejected trips never block a new request", () => {
  const candidateStart = new Date("2026-12-01T00:00:00.000Z");
  const candidateEnd = new Date("2026-12-08T00:00:00.000Z");
  const existing = [
    {
      status: "Rejected",
      startDate: "2026-12-02T00:00:00.000Z",
      endDate: "2026-12-05T00:00:00.000Z",
    },
  ];
  assert.equal(overlapsExistingTrip(existing, candidateStart, candidateEnd), false);
});

test("active overlapping trips block, non-overlapping trips do not", () => {
  const candidateStart = new Date("2026-12-01T00:00:00.000Z");
  const candidateEnd = new Date("2026-12-08T00:00:00.000Z");

  assert.equal(
    overlapsExistingTrip(
      [{ status: "Pending", startDate: "2026-12-04T00:00:00.000Z", endDate: "2026-12-09T00:00:00.000Z" }],
      candidateStart,
      candidateEnd,
    ),
    true,
  );

  assert.equal(
    overlapsExistingTrip(
      [{ status: "Confirmed", startDate: "2026-12-20T00:00:00.000Z", endDate: "2026-12-25T00:00:00.000Z" }],
      candidateStart,
      candidateEnd,
    ),
    false,
  );
});

test("malformed stored dates are ignored instead of blocking bookings", () => {
  assert.equal(
    overlapsExistingTrip(
      [{ status: "Pending", startDate: "not-a-date", endDate: "also-not" }],
      new Date("2026-12-01T00:00:00.000Z"),
      new Date("2026-12-08T00:00:00.000Z"),
    ),
    false,
  );
});
