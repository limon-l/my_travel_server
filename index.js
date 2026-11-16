"use strict";

const mongoose = require("mongoose");
require("dotenv").config();

const { createApp, isSecretConfigured } = require("./app");
const { bookingWritesGuaranteed, ensureIndexes } = require("./models");

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;

/*
 * `bufferCommands: false` makes an unavailable database fail immediately with a
 * dependency error instead of buffering for 10 seconds and surfacing as a 500.
 * `/api/health` reports the degradation and the API answers 503 for
 * database-backed routes while the connection is down.
 */
mongoose.set("bufferCommands", false);
mongoose.set("strictQuery", true);

if (!isSecretConfigured()) {
  console.warn(
    "[security] API_SESSION_SECRET is missing or shorter than 32 characters. " +
      "All authenticated endpoints will reject requests until it is configured.",
  );
}

mongoose.connection.on("disconnected", () => {
  console.warn("[mongo] Disconnected. Database-backed routes will answer 503.");
});

mongoose.connection.on("connected", () => {
  console.log("[mongo] Connected");
});

async function start() {
  if (!MONGO_URI) {
    console.error("[startup] MONGO_URI is not set. Database-backed routes will answer 503.");
  } else {
    try {
      await mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 8000,
        connectTimeoutMS: 8000,
        socketTimeoutMS: 45000,
        bufferCommands: false,
      });
      const indexes = await ensureIndexes();
      if (!indexes.ok) {
        console.warn("[startup] Continuing in degraded mode: booking writes are blocked.");
      }
    } catch (error) {
      // Listen anyway so /api/health can report the degradation instead of the
      // process dying behind a generic platform error page.
      console.error("[startup] MongoDB connection failed:", error.message);
    }
  }

  const app = createApp();
  const server = app.listen(PORT, () => {
    console.log(`Wanderlust API listening on port ${PORT}`);
    console.log(
      `[startup] booking writes ${bookingWritesGuaranteed() ? "enabled" : "BLOCKED (indexes unverified)"}`,
    );
  });

  const shutdown = async (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await mongoose.disconnect().catch(() => {});
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start();

module.exports = { start };
