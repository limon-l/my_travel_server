"use strict";

/**
 * Explicit, opt-in development seed.
 *
 * The previous implementation exposed this destructive operation as a public
 * `GET /api/seed` route: anyone could delete every tour. Seeding now requires a
 * deliberate CLI invocation, a non-production environment and `--confirm`.
 *
 *   node scripts/seed.js --confirm
 */

const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
require("dotenv").config();

const { Tour } = require("../models");

async function main() {
  const confirmed = process.argv.includes("--confirm");
  if (!confirmed) {
    console.error("Refusing to seed. Re-run with --confirm.");
    process.exit(1);
  }
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to seed while NODE_ENV=production.");
    process.exit(1);
  }
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is required.");
    process.exit(1);
  }

  const file = path.join(__dirname, "seed-data.json");
  const tours = JSON.parse(fs.readFileSync(file, "utf8"));

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const result = await Tour.insertMany(tours);
  console.log(`Inserted ${result.length} example tours.`);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
