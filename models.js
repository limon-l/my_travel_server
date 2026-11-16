"use strict";

const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    password: { type: String, required: true },
    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
    },
    hometown: { type: String, trim: true, maxlength: 120 },
    dob: { type: String, maxlength: 10 },
  },
  { timestamps: true },
);

const TourSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 160 },
    shortDesc: { type: String, trim: true, maxlength: 400 },
    fullDesc: { type: String, maxlength: 20000 },
    price: { type: Number, required: true, min: 0, max: 1000000 },
    duration: { type: Number, required: true, min: 1, max: 365 },
    priority: {
      type: String,
      enum: ["Standard", "Premium", "VIP"],
      default: "Standard",
    },
    image: { type: String, maxlength: 2048 },
    location: { type: String, trim: true, maxlength: 160 },
    /**
     * Published departures, stored as `YYYY-MM-DD` calendar dates. A date that is
     * not present here can never be booked, regardless of what a client sends.
     */
    availableDates: { type: [String], default: [] },
  },
  { timestamps: true },
);

const BookingSchema = new mongoose.Schema(
  {
    user: { type: String, ref: "User", required: true, index: true },
    userName: { type: String, maxlength: 120 },
    userEmail: { type: String, maxlength: 254 },
    tour: { type: mongoose.Schema.Types.ObjectId, ref: "Tour", required: true },
    tourTitle: { type: String, maxlength: 160 },
    tourImage: { type: String, maxlength: 2048 },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    totalPrice: { type: Number, min: 0 },
    status: {
      type: String,
      enum: ["Pending", "Confirmed", "Rejected"],
      default: "Pending",
      index: true,
    },
    statusUpdatedAt: { type: Date, default: Date.now },
    statusNote: { type: String, maxlength: 500 },
    /**
     * `tourId:YYYY-MM-DD` while the booking is Pending or Confirmed.
     * A unique sparse index on this field is the database-native guard that
     * prevents two people from holding the same departure under concurrency.
     */
    holdKey: { type: String },
    /**
     * Optional client-supplied request identifier scoped to the traveller.
     * Enables safe replay of a retried submission instead of a duplicate request.
     */
    clientRequestId: { type: String },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

TourSchema.index({ priority: 1 });
TourSchema.index({ location: 1 });

BookingSchema.index({ user: 1, startDate: 1 });
BookingSchema.index({ tour: 1, startDate: 1, status: 1 });
BookingSchema.index(
  { holdKey: 1 },
  {
    unique: true,
    sparse: true,
    name: "one_active_booking_per_departure",
  },
);
BookingSchema.index(
  { clientRequestId: 1 },
  { unique: true, sparse: true, name: "idempotent_booking_requests" },
);

const User = mongoose.models.User || mongoose.model("User", UserSchema);
const Tour = mongoose.models.Tour || mongoose.model("Tour", TourSchema);
const Booking = mongoose.models.Booking || mongoose.model("Booking", BookingSchema);

/**
 * The two indexes that make booking writes safe. They are verified against the
 * live collection, not assumed from the schema: a pre-existing duplicate active
 * booking can leave `holdKey` without its unique index, and a misconfigured index
 * is worse than none because it looks safe.
 */
const REQUIRED_BOOKING_INDEXES = Object.freeze([
  {
    name: "one_active_booking_per_departure",
    keys: { holdKey: 1 },
    unique: true,
    sparse: true,
  },
  {
    name: "idempotent_booking_requests",
    keys: { clientRequestId: 1 },
    unique: true,
    sparse: true,
  },
]);

function indexMatches(actual, required) {
  if (!actual) return false;
  if (Boolean(actual.unique) !== required.unique) return false;
  if (Boolean(actual.sparse) !== required.sparse) return false;

  const actualKeys = actual.key || {};
  const requiredKeys = required.keys;
  const actualNames = Object.keys(actualKeys);
  const requiredNames = Object.keys(requiredKeys);
  if (actualNames.length !== requiredNames.length) return false;
  return requiredNames.every((name) => actualKeys[name] === requiredKeys[name]);
}

/**
 * Pure comparison so the rule can be unit tested without a database.
 * @param {Array<{name?: string, key?: object, unique?: boolean, sparse?: boolean}>} indexes
 */
function evaluateIndexes(indexes = []) {
  const list = Array.isArray(indexes) ? indexes : [];
  const missing = [];
  const invalid = [];

  for (const required of REQUIRED_BOOKING_INDEXES) {
    const actual =
      list.find((index) => index.name === required.name) ||
      list.find((index) => indexMatches(index, required));

    if (!actual) missing.push(required.name);
    else if (!indexMatches(actual, required)) invalid.push(required.name);
  }

  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
}

let indexState = {
  verified: false,
  checkedAt: null,
  error: "Index verification has not run",
  missing: REQUIRED_BOOKING_INDEXES.map((index) => index.name),
  invalid: [],
  names: [],
};

function getIndexState() {
  return { ...indexState, missing: [...indexState.missing], invalid: [...indexState.invalid] };
}

/**
 * Booking writes are only allowed when both unique indexes are confirmed. Reads,
 * authentication and the admin decision queue keep working during an index
 * incident, so operators can still see and resolve data.
 */
function bookingWritesGuaranteed() {
  return indexState.verified === true;
}

/**
 * Builds and verifies indexes. A pre-existing duplicate active booking makes the
 * unique hold index fail; that is reported and booking writes are blocked rather
 * than silently losing the concurrency guarantee.
 */
async function ensureIndexes() {
  try {
    await Promise.all([User.init(), Tour.init(), Booking.init()]);
    const indexes = await Booking.collection.indexes();
    const result = evaluateIndexes(indexes);

    indexState = {
      verified: result.ok,
      checkedAt: new Date().toISOString(),
      error: result.ok
        ? null
        : "Required booking indexes are missing or misconfigured",
      missing: result.missing,
      invalid: result.invalid,
      names: indexes.map((index) => String(index.name || "(unnamed)")),
    };

    if (!result.ok) {
      console.error(
        "[indexes] Booking guarantees are NOT active. Missing:",
        result.missing,
        "Invalid:",
        result.invalid,
        "Run scripts/migrate-hold-keys.js, then restart.",
      );
    } else {
      console.log("[indexes] Booking guarantees verified");
    }

    return { ok: result.ok, ...result };
  } catch (error) {
    indexState = {
      verified: false,
      checkedAt: new Date().toISOString(),
      error: error.message,
      missing: REQUIRED_BOOKING_INDEXES.map((index) => index.name),
      invalid: [],
      names: [],
    };
    console.error(
      "Index creation failed. Booking writes are blocked. Run scripts/migrate-hold-keys.js to repair booking hold keys.",
      error.message,
    );
    return { ok: false, error: error.message };
  }
}

module.exports = {
  Booking,
  REQUIRED_BOOKING_INDEXES,
  Tour,
  User,
  bookingWritesGuaranteed,
  ensureIndexes,
  evaluateIndexes,
  getIndexState,
};
