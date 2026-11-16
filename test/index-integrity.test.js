"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  REQUIRED_BOOKING_INDEXES,
  evaluateIndexes,
  getIndexState,
} = require("../models");

const HOLD = {
  name: "one_active_booking_per_departure",
  key: { holdKey: 1 },
  unique: true,
  sparse: true,
};

const IDEMPOTENCY = {
  name: "idempotent_booking_requests",
  key: { clientRequestId: 1 },
  unique: true,
  sparse: true,
};

const OTHER = { name: "_id_", key: { _id: 1 }, unique: true };

test("both required booking indexes must be present", () => {
  assert.equal(REQUIRED_BOOKING_INDEXES.length, 2);

  const missingBoth = evaluateIndexes([OTHER]);
  assert.equal(missingBoth.ok, false);
  assert.deepEqual(missingBoth.missing.sort(), [
    "idempotent_booking_requests",
    "one_active_booking_per_departure",
  ]);

  const missingOne = evaluateIndexes([OTHER, HOLD]);
  assert.equal(missingOne.ok, false);
  assert.deepEqual(missingOne.missing, ["idempotent_booking_requests"]);
});

test("a non-unique or non-sparse lookalike is treated as invalid, not satisfied", () => {
  const notUnique = evaluateIndexes([{ ...HOLD, unique: false }, IDEMPOTENCY]);
  assert.equal(notUnique.ok, false);
  assert.deepEqual(notUnique.invalid, ["one_active_booking_per_departure"]);

  const notSparse = evaluateIndexes([HOLD, { ...IDEMPOTENCY, sparse: false }]);
  assert.equal(notSparse.ok, false);
  assert.deepEqual(notSparse.invalid, ["idempotent_booking_requests"]);
});

test("an index is matched by shape when the stored name differs", () => {
  const renamed = evaluateIndexes([
    { name: "holdKey_1", key: { holdKey: 1 }, unique: true, sparse: true },
    IDEMPOTENCY,
  ]);
  assert.equal(renamed.ok, true);
});

test("the full, correct pair passes", () => {
  const result = evaluateIndexes([OTHER, HOLD, IDEMPOTENCY]);
  assert.deepEqual(result, { ok: true, missing: [], invalid: [] });
});

test("state starts unverified so booking writes fail closed before the check runs", () => {
  const state = getIndexState();
  assert.equal(typeof state.verified, "boolean");
  // The module is loaded outside a database connection in unit tests.
  assert.equal(state.verified, false);
  assert.equal(state.checkedAt, null);
});
