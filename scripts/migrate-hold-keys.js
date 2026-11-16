"use strict";

/**
 * Backfills `holdKey` for existing active bookings so the unique departure guard
 * applies to historical records too. Without this, older Pending/Confirmed rows
 * rely only on the pre-insert check.
 *
 * Dry run (default):  node scripts/migrate-hold-keys.js
 * Apply:              node scripts/migrate-hold-keys.js --apply
 *
 * Requires a reviewed backup before `--apply` in production.
 */

const mongoose = require("mongoose");
require("dotenv").config();

const { Booking } = require("../models");
const { holdKeyFor } = require("../lib/booking-policy");

function dateOnly(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is required.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });

  const bookings = await Booking.find({ status: { $in: ["Pending", "Confirmed"] } })
    .select("tour startDate status holdKey")
    .sort({ createdAt: 1 })
    .lean();

  const seen = new Map();
  const updates = [];
  const conflicts = [];

  for (const booking of bookings) {
    const day = dateOnly(booking.startDate);
    if (!day || !booking.tour) continue;
    const key = holdKeyFor(booking.tour, day);
    if (seen.has(key)) {
      conflicts.push({ keep: seen.get(key), duplicate: String(booking._id), key });
      continue;
    }
    seen.set(key, String(booking._id));
    if (booking.holdKey !== key) {
      updates.push({ id: booking._id, key });
    }
  }

  console.log(`Active bookings scanned: ${bookings.length}`);
  console.log(`Hold keys to write: ${updates.length}`);
  console.log(`Duplicate departures found: ${conflicts.length}`);
  if (conflicts.length > 0) {
    console.log("Resolve these manually before creating the unique index:");
    console.log(JSON.stringify(conflicts, null, 2));
  }

  if (!apply) {
    console.log("Dry run only. Re-run with --apply to write hold keys.");
  } else {
    for (const update of updates) {
      await Booking.updateOne({ _id: update.id }, { $set: { holdKey: update.key } });
    }
    console.log(`Wrote ${updates.length} hold keys.`);
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
