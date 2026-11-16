"use strict";

/**
 * Real HTTP + MongoDB integration tests.
 *
 * These are skipped unless TEST_MONGO_URI points at a database whose name
 * contains "test". That guard makes it impossible to accidentally run this suite
 * against the production database.
 *
 *   TEST_MONGO_URI="mongodb://127.0.0.1:27017/wanderlust_test" npm test
 *
 * The suite uses synthetic users, tours and bookings only and drops the test
 * database at the end.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const testUri = process.env.TEST_MONGO_URI || "";
const databaseName = (() => {
  try {
    return new URL(testUri).pathname.replace(/^\//, "");
  } catch {
    return "";
  }
})();

const canRun = testUri.length > 0 && /test/i.test(databaseName);
const skipReason = !testUri
  ? "TEST_MONGO_URI is not set; real database integration is BLOCKED in this environment."
  : "TEST_MONGO_URI must include 'test' in the database name to protect production data.";

process.env.API_SESSION_SECRET =
  process.env.API_SESSION_SECRET || "integration-secret-that-is-long-enough-1234";

let server;
let baseUrl;
let models;
let signToken;

test.before(async () => {
  if (!canRun) return;

  await mongoose.connect(testUri, { serverSelectionTimeoutMS: 10000 });
  models = require("../models");
  ({ signToken } = require("../lib/session-token"));
  const { createApp } = require("../app");

  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;

  await Promise.all([models.User.deleteMany({}), models.Tour.deleteMany({}), models.Booking.deleteMany({})]);
  const indexResult = await models.ensureIndexes();
  assert.equal(indexResult.ok, true, "integration database must expose the unique booking indexes");
});

test.after(async () => {
  if (!canRun) return;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await new Promise((resolve) => server.close(resolve));
});

async function call(path, { token, method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, body: json };
}

const tokenFor = (sub, role = "user") => signToken({ sub: String(sub), role });

const DAY_MS = 24 * 60 * 60 * 1000;
const dayFromNow = (days) => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
const utcStart = (dateOnly) => new Date(`${dateOnly}T00:00:00.000Z`);

test("integration: authenticated routes reject anonymous callers", { skip: canRun ? false : skipReason }, async () => {
  assert.equal((await call("/admin/bookings")).status, 401);
  assert.equal((await call("/bookings/abc")).status, 401);
  assert.equal((await call("/tours/507f1f77bcf86cd799439011", { method: "DELETE" })).status, 401);
});

test("booking lifecycle, ownership and concurrency", { skip: canRun ? false : skipReason }, async () => {
  const { User, Tour, Booking } = models;

  const departure = dayFromNow(30);
  const unpublishedDate = dayFromNow(31);

  const tour = await Tour.create({
    title: "Test Departure Tour",
    shortDesc: "Synthetic",
    price: 1234,
    duration: 5,
    priority: "Standard",
    availableDates: [departure],
  });

  const [alice, bob] = await User.create([
    { name: "Alice", email: "alice@example.test", password: "x", role: "user" },
    { name: "Bob", email: "bob@example.test", password: "x", role: "user" },
  ]);

  const aliceToken = tokenFor(alice._id);
  const bobToken = tokenFor(bob._id);
  const adminToken = tokenFor("admin", "admin");

  // A customer cannot call admin endpoints.
  assert.equal((await call("/admin/bookings", { token: aliceToken })).status, 403);
  assert.equal((await call("/admin/summary", { token: aliceToken })).status, 403);

  // A customer cannot read another customer's bookings.
  assert.equal((await call(`/bookings/${bob._id}`, { token: aliceToken })).status, 403);

  // Unpublished dates are refused even when the browser asks for them.
  const unpublished = await call("/bookings", {
    token: aliceToken,
    method: "POST",
    body: { tourId: String(tour._id), startDate: unpublishedDate, price: 1, duration: 1 },
  });
  assert.equal(unpublished.status, 409);

  // The server ignores body-supplied identity and money.
  const created = await call("/bookings", {
    token: aliceToken,
    method: "POST",
    headers: { "Idempotency-Key": "intent-alice-1" },
    body: { tourId: String(tour._id), startDate: departure, userId: String(bob._id), price: 1 },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.booking.status, "Pending");
  assert.equal(created.body.booking.totalPrice, 1234);

  const persisted = await Booking.findById(created.body.booking._id).lean();
  assert.equal(String(persisted.user), String(alice._id));

  // Replaying the same intent returns the same booking rather than a duplicate.
  const replay = await call("/bookings", {
    token: aliceToken,
    method: "POST",
    headers: { "Idempotency-Key": "intent-alice-1" },
    body: { tourId: String(tour._id), startDate: departure },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.booking._id, created.body.booking._id);
  assert.equal(await Booking.countDocuments({ user: String(alice._id) }), 1);

  // Another traveller cannot hold the same departure.
  const conflict = await call("/bookings", {
    token: bobToken,
    method: "POST",
    body: { tourId: String(tour._id), startDate: departure },
  });
  assert.equal(conflict.status, 409);

  // Concurrent admin decisions: exactly one may win.
  const [first, second] = await Promise.all([
    call(`/admin/bookings/${created.body.booking._id}/status`, {
      token: adminToken,
      method: "PUT",
      body: { status: "Confirmed" },
    }),
    call(`/admin/bookings/${created.body.booking._id}/status`, {
      token: adminToken,
      method: "PUT",
      body: { status: "Rejected" },
    }),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 409]);

  const finalState = await Booking.findById(created.body.booking._id).lean();
  assert.ok(["Confirmed", "Rejected"].includes(finalState.status));

  // Terminal states cannot be changed again.
  const again = await call(`/admin/bookings/${created.body.booking._id}/status`, {
    token: adminToken,
    method: "PUT",
    body: { status: finalState.status === "Confirmed" ? "Rejected" : "Confirmed" },
  });
  assert.equal(again.status, 409);
});

test("disabling a departure preserves existing bookings and reports them", { skip: canRun ? false : skipReason }, async () => {
  const { User, Tour, Booking } = models;
  const first = dayFromNow(60);
  const second = dayFromNow(61);

  const tour = await Tour.create({
    title: "Disable Tour",
    price: 100,
    duration: 2,
    availableDates: [first, second],
  });
  const user = await User.create({ name: "Cara", email: "cara@example.test", password: "x" });
  const booking = await Booking.create({
    user: String(user._id),
    tour: tour._id,
    tourTitle: tour.title,
    startDate: utcStart(first),
    endDate: new Date(utcStart(first).getTime() + 2 * DAY_MS),
    totalPrice: 100,
    status: "Pending",
    holdKey: `${tour._id}:${first}`,
  });

  const response = await call(`/tours/${tour._id}/available-dates`, {
    token: tokenFor("admin", "admin"),
    method: "PUT",
    body: { availableDates: [second] },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.availableDates, [second]);
  assert.equal(response.body.affectedBookings.length, 1);
  assert.equal(response.body.affectedBookings[0].date, first);
  assert.ok(await Booking.findById(booking._id));
});

test("tour edits change the catalogue but never booking snapshots", { skip: canRun ? false : skipReason }, async () => {
  const { User, Tour, Booking } = models;
  const adminToken = tokenFor("admin", "admin");
  const departure = dayFromNow(90);

  const tour = await Tour.create({
    title: "Original Title",
    price: 500,
    duration: 3,
    availableDates: [departure],
  });
  const user = await User.create({ name: "Dana", email: "dana@example.test", password: "x" });
  const booking = await Booking.create({
    user: String(user._id),
    tour: tour._id,
    tourTitle: tour.title,
    startDate: utcStart(departure),
    endDate: new Date(utcStart(departure).getTime() + 3 * DAY_MS),
    totalPrice: tour.price,
    status: "Confirmed",
    holdKey: `${tour._id}:${departure}`,
  });

  // Only admins may edit, and an empty patch is rejected.
  assert.equal(
    (await call(`/tours/${tour._id}`, { method: "PATCH", token: tokenFor(user._id), body: { price: 1 } }))
      .status,
    403,
  );
  assert.equal((await call(`/tours/${tour._id}`, { method: "PATCH", token: adminToken, body: {} })).status, 400);
  assert.equal(
    (await call(`/tours/${tour._id}`, {
      method: "PATCH",
      token: adminToken,
      body: { price: -5 },
    })).status,
    400,
  );

  const updated = await call(`/tours/${tour._id}`, {
    method: "PATCH",
    token: adminToken,
    body: { title: "Corrected Title", price: 650, duration: 4 },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.tour.title, "Corrected Title");
  assert.equal(updated.body.tour.price, 650);

  // The traveller's stored snapshot is untouched by the catalogue edit.
  const stored = await Booking.findById(booking._id).lean();
  assert.equal(stored.tourTitle, "Original Title");
  assert.equal(stored.totalPrice, 500);
  assert.equal(stored.startDate.toISOString(), utcStart(departure).toISOString());
});

test("admin booking filters reject unknown statuses", { skip: canRun ? false : skipReason }, async () => {
  const response = await call("/admin/bookings?status=Archived", {
    token: tokenFor("admin", "admin"),
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "INVALID_REQUEST");

  assert.equal(
    (await call("/admin/bookings?status=Pending", { token: tokenFor("admin", "admin") })).status,
    200,
  );
});
