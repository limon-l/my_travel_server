"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { sanitizeTourInput } = require("../lib/tour-input");

const FUTURE = "2099-06-01";
const PAST = "2000-01-01";

function createBody(overrides = {}) {
  return { title: "Atlantic Walk", price: 1200, duration: 7, ...overrides };
}

test("create requires a title, price and duration", () => {
  assert.throws(() => sanitizeTourInput({ price: 1, duration: 1 }), /title/i);
  assert.throws(() => sanitizeTourInput({ title: "X", duration: 1 }), /price/i);
  assert.throws(() => sanitizeTourInput({ title: "X", price: 1 }), /duration/i);
  assert.throws(() => sanitizeTourInput(null), /title/i);
});

test("create ignores fields that are not editable", () => {
  const { set } = sanitizeTourInput(
    createBody({ _id: "507f1f77bcf86cd799439011", status: "Confirmed", totalPrice: 1 }),
  );
  assert.equal(set._id, undefined);
  assert.equal(set.status, undefined);
  assert.equal(set.totalPrice, undefined);
});

test("price and duration boundaries are enforced", () => {
  assert.equal(sanitizeTourInput(createBody({ price: 0 })).set.price, 0);
  assert.equal(sanitizeTourInput(createBody({ price: 1_000_000 })).set.price, 1_000_000);
  assert.throws(() => sanitizeTourInput(createBody({ price: -1 })), /Price/);
  assert.throws(() => sanitizeTourInput(createBody({ price: "free" })), /Price/);
  assert.throws(() => sanitizeTourInput(createBody({ price: null })), /Price/);

  assert.throws(() => sanitizeTourInput(createBody({ duration: 0 })), /Duration/);
  assert.throws(() => sanitizeTourInput(createBody({ duration: 366 })), /Duration/);
  assert.throws(() => sanitizeTourInput(createBody({ duration: 2.5 })), /Duration/);
});

test("image URLs must be http(s) or a local path", () => {
  assert.equal(
    sanitizeTourInput(createBody({ image: "https://images.example.com/a.jpg" })).set.image,
    "https://images.example.com/a.jpg",
  );
  assert.equal(sanitizeTourInput(createBody({ image: "/covers/a.jpg" })).set.image, "/covers/a.jpg");
  assert.throws(() => sanitizeTourInput(createBody({ image: "javascript:alert(1)" })), /Image/);
  assert.throws(() => sanitizeTourInput(createBody({ image: "not a url" })), /Image/);
});

test("priority is limited to the stored enum", () => {
  assert.equal(sanitizeTourInput(createBody({ priority: "VIP" })).set.priority, "VIP");
  assert.equal(sanitizeTourInput(createBody()).set.priority, undefined);
  assert.throws(() => sanitizeTourInput(createBody({ priority: "Luxury" })), /Priority/);
});

test("available dates are normalised, de-duplicated and future-only", () => {
  const { availableDates } = sanitizeTourInput(
    createBody({ availableDates: [FUTURE, FUTURE, `${FUTURE}T00:00:00.000Z`] }),
  );
  assert.deepEqual(availableDates, [FUTURE]);

  assert.throws(() => sanitizeTourInput(createBody({ availableDates: [PAST] })), /past/i);
  assert.throws(() => sanitizeTourInput(createBody({ availableDates: "nope" })), /array/i);
});

test("patch accepts a single editable field and never touches others", () => {
  const { set, unset } = sanitizeTourInput({ price: 1500 }, { mode: "patch" });
  assert.deepEqual(set, { price: 1500 });
  assert.deepEqual(unset, {});

  const titleOnly = sanitizeTourInput({ title: "  New title  " }, { mode: "patch" });
  assert.deepEqual(titleOnly.set, { title: "New title" });
});

test("patch rejects an empty body and invalid values", () => {
  assert.throws(() => sanitizeTourInput({}, { mode: "patch" }), /No editable fields/);
  assert.throws(() => sanitizeTourInput({ title: "   " }, { mode: "patch" }), /title/i);
  assert.throws(() => sanitizeTourInput({ duration: 0 }, { mode: "patch" }), /Duration/);
  assert.throws(
    () => sanitizeTourInput({ availableDates: [FUTURE] }, { mode: "patch" }),
    /No editable fields/,
  );
});

test("patch silently ignores non-editable fields", () => {
  const { set } = sanitizeTourInput(
    { price: 1500, _id: "507f1f77bcf86cd799439011", status: "Confirmed" },
    { mode: "patch" },
  );
  assert.deepEqual(set, { price: 1500 });
});

test("patch treats an empty string as an explicit clear for optional fields", () => {
  const { set, unset } = sanitizeTourInput(
    { shortDesc: "", fullDesc: "", location: "", image: "" },
    { mode: "patch" },
  );
  assert.deepEqual(set, {});
  assert.deepEqual(Object.keys(unset).sort(), ["fullDesc", "image", "location", "shortDesc"]);
});
