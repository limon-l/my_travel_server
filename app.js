"use strict";

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");

const {
  Booking,
  Tour,
  User,
  bookingWritesGuaranteed,
  getIndexState,
} = require("./models");
const { authenticate, isSelf, requireAdmin, requireSelfOrAdmin } = require("./lib/auth");
const {
  BOOKING_STATUSES,
  canTransition,
  computeEndDate,
  holdKeyFor,
  overlapsExistingTrip,
} = require("./lib/booking-policy");
const { asyncRoute, errorHandler, errors, notFoundHandler } = require("./lib/http");
const { createRateLimiter } = require("./lib/rate-limit");
const { sanitizeTourInput } = require("./lib/tour-input");
const {
  clampString,
  isTodayOrLater,
  isValidObjectId,
  normalizeAvailableDates,
  normalizeEmail,
  parseDateOnly,
  toDateOnly,
  todayUtc,
} = require("./lib/validation");
const { isConfigured } = require("./lib/session-token");

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_ORIGINS = ["http://localhost:3000", "https://my-travel-client.vercel.app"];

function allowedOrigins() {
  const configured = process.env.CLIENT_ORIGIN;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return configured.split(",").map((origin) => origin.trim()).filter(Boolean);
  }
  return DEFAULT_ORIGINS;
}

function createRateLimiterFor({ windowMs, max, keyPrefix, message }) {
  return createRateLimiter({
    windowMs,
    max,
    keyPrefix,
    onLimit: () => errors.tooMany(message),
  });
}

function toSafeBooking(booking) {
  if (!booking) return null;
  return {
    _id: String(booking._id),
    tour: booking.tour,
    tourTitle: booking.tourTitle,
    tourImage: booking.tourImage,
    startDate: booking.startDate,
    endDate: booking.endDate,
    totalPrice: booking.totalPrice,
    status: booking.status,
    statusNote: booking.statusNote,
    statusUpdatedAt: booking.statusUpdatedAt,
    createdAt: booking.createdAt,
  };
}

/**
 * Adds the traveller fields operations needs without leaking storage internals
 * (`holdKey`, `clientRequestId`, the raw `user` ref) to the browser.
 */
function toBookingRecord(booking, { includeTraveller = false } = {}) {
  const record = toSafeBooking(booking);
  if (!record) return null;
  if (includeTraveller) {
    record.userName = booking.userName;
    record.userEmail = booking.userEmail;
  }
  return record;
}

function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins().includes(origin)) return callback(null, true);
        console.warn(`CORS blocked request from origin: ${origin}`);
        return callback(new Error("Not allowed by CORS"));
      },
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
      credentials: true,
    }),
  );
  app.use(express.json({ limit: "64kb" }));

  const databaseReady = () => mongoose.connection.readyState === 1;

  // Liveness: always answers so the platform can reach the process.
  app.get("/", (req, res) => {
    res.json({
      status: databaseReady() ? "ok" : "degraded",
      service: "my_travel_server",
      database: databaseReady() ? "up" : "down",
    });
  });

  // Readiness: fails loudly when the database is unreachable. This is what an
  // uptime monitor should watch; the previous root-only check masked outages.
  app.get("/api/health", (req, res) => {
    const ready = databaseReady();
    const indexes = getIndexState();

    res.status(ready ? 200 : 503).json({
      status: ready && indexes.verified ? "ok" : "degraded",
      database: ready ? "up" : "down",
      checks: {
        database: ready ? "up" : "down",
        bookingIndexes: indexes.verified ? "verified" : "unverified",
      },
      // Booking writes are refused while the unique indexes are unverified.
      bookingWrites: bookingWritesGuaranteed() ? "enabled" : "blocked",
      indexError: indexes.error || undefined,
      timestamp: new Date().toISOString(),
    });
  });

  /*
   * Dependency guard: everything below needs MongoDB. Without this, a failed
   * connection surfaced as a generic 500 from a buffered query. Requests now get
   * a stable 503 SERVICE_UNAVAILABLE the client can recover from.
   */
  app.use((req, res, next) => {
    if (req.path === "/api/health" || req.path === "/") return next();
    if (mongoose.connection.readyState === 1) return next();
    return next(
      errors.unavailable(
        "The travel database is temporarily unavailable. Please retry in a moment.",
      ),
    );
  });

  // Booking writes depend on the unique hold/idempotency indexes. Reads and the
  // admin decision queue stay available so operators can resolve conflicts.
  const requireBookingIntegrity = (req, res, next) => {
    if (bookingWritesGuaranteed()) return next();
    return next(
      errors.unavailable(
        "Booking requests are paused while the server verifies departure guarantees. Please retry shortly.",
      ),
    );
  };

  const signInLimiter = createRateLimiterFor({
    windowMs: 15 * 60 * 1000,
    max: 10,
    keyPrefix: "login",
    message: "Too many sign-in attempts. Try again in a few minutes.",
  });
  const registerLimiter = createRateLimiterFor({
    windowMs: 60 * 60 * 1000,
    max: 10,
    keyPrefix: "register",
    message: "Too many accounts created from this connection. Try again later.",
  });

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  app.post(
    "/api/login",
    signInLimiter,
    asyncRoute(async (req, res) => {
      const email = normalizeEmail(req.body?.email);
      const password = req.body?.password;

      if (!email || typeof password !== "string" || password.length === 0) {
        throw errors.badRequest("Email and password are required");
      }

      const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL || "");
      const adminHash = process.env.ADMIN_PASSWORD_HASH;

      if (adminEmail && adminHash && email === adminEmail) {
        const valid = await bcrypt.compare(password, adminHash);
        if (valid) {
          return res.json({
            id: "admin",
            name: "Wanderlust Operations",
            email: adminEmail,
            role: "admin",
          });
        }
        // Deliberately falls through to the generic failure below so a wrong
        // admin password is indistinguishable from an unknown account.
      }

      const user = await User.findOne({ email }).select("name email password role");
      if (!user) {
        // Constant-ish work factor to avoid a cheap account-enumeration oracle.
        await bcrypt.compare(password, "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv");
        throw errors.unauthenticated("Invalid email or password");
      }

      const valid = await bcrypt.compare(password, user.password);
      if (!valid) throw errors.unauthenticated("Invalid email or password");

      return res.json({
        id: String(user._id),
        name: user.name,
        email: user.email,
        role: user.role === "admin" ? "admin" : "user",
      });
    }),
  );

  app.post(
    "/api/register",
    registerLimiter,
    asyncRoute(async (req, res) => {
      const name = clampString(req.body?.name, 120);
      const email = normalizeEmail(req.body?.email);
      const password = req.body?.password;
      const hometown = clampString(req.body?.hometown, 120);
      const dob = clampString(req.body?.dob, 10);

      if (!name) throw errors.badRequest("Your full name is required");
      if (!email) throw errors.badRequest("A valid email address is required");
      if (typeof password !== "string" || password.length < 8) {
        throw errors.badRequest("Password must be at least 8 characters");
      }
      if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
        throw errors.badRequest("Date of birth must use YYYY-MM-DD");
      }

      const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL || "");
      if (adminEmail && email === adminEmail) {
        throw errors.forbidden("This email address is reserved");
      }

      const existing = await User.findOne({ email }).select("_id");
      if (existing) throw errors.conflict("An account with this email already exists");

      const hashedPassword = await bcrypt.hash(password, 12);
      try {
        await User.create({
          name,
          email,
          password: hashedPassword,
          hometown,
          dob,
          // Role is never accepted from the client.
          role: "user",
        });
      } catch (error) {
        if (error?.code === 11000) {
          throw errors.conflict("An account with this email already exists");
        }
        throw error;
      }

      return res.status(201).json({ message: "User registered successfully" });
    }),
  );

  // ---------------------------------------------------------------------------
  // Tours (public reads, admin writes)
  // ---------------------------------------------------------------------------

  app.get(
    "/api/tours",
    asyncRoute(async (req, res) => {
      const tours = await Tour.find().sort({ createdAt: -1 }).lean();
      res.json(tours);
    }),
  );

  app.get(
    "/api/tours/:id",
    asyncRoute(async (req, res) => {
      if (!isValidObjectId(req.params.id)) throw errors.notFound("Tour not found");
      const tour = await Tour.findById(req.params.id).lean();
      if (!tour) throw errors.notFound("Tour not found");
      res.json(tour);
    }),
  );

  app.get(
    "/api/tours/:id/available-dates",
    asyncRoute(async (req, res) => {
      if (!isValidObjectId(req.params.id)) throw errors.notFound("Tour not found");
      const tour = await Tour.findById(req.params.id).select("availableDates").lean();
      if (!tour) throw errors.notFound("Tour not found");

      const published = Array.isArray(tour.availableDates) ? tour.availableDates : [];
      const occupied = await Booking.find({
        tour: req.params.id,
        status: { $in: ["Pending", "Confirmed"] },
      })
        .select("startDate")
        .lean();

      const occupiedDates = new Set(occupied.map((booking) => toDateOnly(booking.startDate)));
      const today = todayUtc();

      const freeDates = published
        .filter((date) => isTodayOrLater(date) && !occupiedDates.has(date))
        .sort();

      res.json({ availableDates: freeDates, publishedCount: published.length });
    }),
  );

  app.post(
    "/api/tours",
    authenticate,
    requireAdmin,
    asyncRoute(async (req, res) => {
      const { set, availableDates } = sanitizeTourInput(req.body, { mode: "create" });
      const tour = await Tour.create({
        ...set,
        ...(availableDates ? { availableDates } : {}),
      });
      res.status(201).json(tour);
    }),
  );

  /**
   * Edits the catalogue entry only. Booking snapshots are deliberately untouched:
   * a traveller's stored title, image, price and dates never change because
   * operations corrected the live tour. A duration change affects requests made
   * after it, never existing ones.
   */
  app.patch(
    "/api/tours/:id",
    authenticate,
    requireAdmin,
    asyncRoute(async (req, res) => {
      if (!isValidObjectId(req.params.id)) throw errors.notFound("Tour not found");

      const { set, unset } = sanitizeTourInput(req.body, { mode: "patch" });
      const update = {};
      if (Object.keys(set).length > 0) update.$set = set;
      if (Object.keys(unset).length > 0) update.$unset = unset;

      const tour = await Tour.findByIdAndUpdate(req.params.id, update, {
        new: true,
        runValidators: true,
      }).lean();

      if (!tour) throw errors.notFound("Tour not found");
      res.json({ message: "Tour updated", tour });
    }),
  );

  app.delete(
    "/api/tours/:id",
    authenticate,
    requireAdmin,
    asyncRoute(async (req, res) => {
      if (!isValidObjectId(req.params.id)) throw errors.notFound("Tour not found");

      const activeBookings = await Booking.countDocuments({
        tour: req.params.id,
        status: { $in: ["Pending", "Confirmed"] },
      });
      if (activeBookings > 0) {
        throw errors.conflict(
          "This tour has pending or confirmed bookings. Resolve them before deleting it.",
          { activeBookings },
        );
      }

      const deleted = await Tour.findByIdAndDelete(req.params.id);
      if (!deleted) throw errors.notFound("Tour not found");
      res.json({ message: "Deleted" });
    }),
  );

  app.put(
    "/api/tours/:id/available-dates",
    authenticate,
    requireAdmin,
    asyncRoute(async (req, res) => {
      if (!isValidObjectId(req.params.id)) throw errors.notFound("Tour not found");

      const parsed = normalizeAvailableDates(req.body?.availableDates);
      if (!parsed.ok) throw errors.badRequest(parsed.error);

      const tour = await Tour.findById(req.params.id);
      if (!tour) throw errors.notFound("Tour not found");

      const previous = Array.isArray(tour.availableDates) ? tour.availableDates : [];
      const added = parsed.dates.filter((date) => !previous.includes(date));
      const pastAdditions = added.filter((date) => !isTodayOrLater(date));
      if (pastAdditions.length > 0) {
        throw errors.badRequest(
          "Departures must be today or later. Past dates cannot be published.",
          pastAdditions,
        );
      }

      // Policy: disabling a departure never deletes or rejects existing bookings.
      // The response reports what is affected so the admin UI can warn.
      const disabled = previous.filter((date) => !parsed.dates.includes(date));
      let affectedBookings = [];
      if (disabled.length > 0) {
        const start = parseDateOnly(disabled[0]);
        const end = new Date(parseDateOnly(disabled[disabled.length - 1]).getTime() + DAY_MS);
        const active = await Booking.find({
          tour: req.params.id,
          status: { $in: ["Pending", "Confirmed"] },
          startDate: { $gte: start, $lt: end },
        })
          .select("startDate status")
          .lean();
        const disabledSet = new Set(disabled);
        affectedBookings = active
          .map((booking) => ({
            date: toDateOnly(booking.startDate),
            status: booking.status,
          }))
          .filter((booking) => disabledSet.has(booking.date));
      }

      tour.availableDates = parsed.dates;
      await tour.save();

      res.json({
        message: "Available dates updated",
        availableDates: parsed.dates,
        affectedBookings,
      });
    }),
  );

  // ---------------------------------------------------------------------------
  // Bookings
  // ---------------------------------------------------------------------------

  app.post(
    "/api/bookings",
    authenticate,
    requireBookingIntegrity,
    asyncRoute(async (req, res) => {
      const dateOnly = toDateOnly(req.body?.startDate);
      if (!dateOnly) {
        throw errors.badRequest("startDate must be a calendar date in YYYY-MM-DD format");
      }
      if (!isTodayOrLater(dateOnly)) {
        throw errors.badRequest("The departure date has already passed");
      }
      if (!isValidObjectId(req.body?.tourId)) {
        throw errors.badRequest("A valid tour is required");
      }

      const tour = await Tour.findById(req.body.tourId).lean();
      if (!tour) throw errors.notFound("Tour not found");

      const publishedDates = Array.isArray(tour.availableDates) ? tour.availableDates : [];
      if (!publishedDates.includes(dateOnly)) {
        throw errors.conflict(
          "That departure is no longer available. Please choose another published date.",
        );
      }

      // Server owns money and duration; the browser supplies neither.
      const duration = Number(tour.duration) > 0 ? Number(tour.duration) : 1;
      const start = parseDateOnly(dateOnly);
      const end = computeEndDate(start, duration);

      const userBookings = await Booking.find({
        user: req.identity.sub,
        status: { $in: ["Pending", "Confirmed"] },
      })
        .select("startDate endDate status")
        .lean();

      if (overlapsExistingTrip(userBookings, start, end)) {
        throw errors.conflict(
          "You already have a trip during these dates. Cancel or await a decision on it first.",
        );
      }

      const legacyOccupied = await Booking.findOne({
        tour: req.body.tourId,
        status: { $in: ["Pending", "Confirmed"] },
        startDate: { $gte: start, $lt: new Date(start.getTime() + DAY_MS) },
      })
        .select("_id")
        .lean();
      if (legacyOccupied) {
        throw errors.conflict("Another traveller already holds this departure.");
      }

      const clientRequestId = normalizeRequestId(req.get("idempotency-key"));
      const account = await User.findById(req.identity.sub).select("name email").lean();

      try {
        const booking = await Booking.create({
          user: req.identity.sub,
          userName: account?.name || req.identity.name || "Traveller",
          userEmail: account?.email || req.identity.email || "",
          tour: tour._id,
          tourTitle: tour.title,
          tourImage: tour.image,
          startDate: start,
          endDate: end,
          totalPrice: tour.price,
          status: "Pending",
          statusUpdatedAt: new Date(),
          statusNote: "Awaiting an operations decision",
          holdKey: holdKeyFor(tour._id, dateOnly),
          ...(clientRequestId ? { clientRequestId: `${req.identity.sub}:${clientRequestId}` } : {}),
        });

        return res.status(201).json({
          message: "Booking request submitted. It is pending review.",
          booking: toSafeBooking(booking),
        });
      } catch (error) {
        if (error?.code === 11000 && error?.keyPattern?.clientRequestId && clientRequestId) {
          const existing = await Booking.findOne({
            clientRequestId: `${req.identity.sub}:${clientRequestId}`,
          }).lean();
          if (existing) {
            return res.status(200).json({
              message: "This request was already submitted.",
              replayed: true,
              booking: toSafeBooking(existing),
            });
          }
        }
        if (error?.code === 11000) {
          throw errors.conflict("Another traveller already holds this departure.");
        }
        throw error;
      }
    }),
  );

  app.get(
    "/api/bookings/:userId",
    authenticate,
    requireSelfOrAdmin,
    asyncRoute(async (req, res) => {
      const isAdmin = req.identity.role === "admin";
      const bookings = await Booking.find({ user: req.params.userId })
        .populate("tour", "_id title image availableDates")
        .sort({ startDate: 1 })
        .lean();
      res.json(bookings.map((booking) => toBookingRecord(booking, { includeTraveller: isAdmin })));
    }),
  );

  app.delete(
    "/api/bookings/:id",
    authenticate,
    asyncRoute(async (req, res) => {
      if (!isValidObjectId(req.params.id)) throw errors.notFound("Booking not found");

      const booking = await Booking.findById(req.params.id);
      if (!booking) throw errors.notFound("Booking not found");

      const owner = isSelf(req.identity, booking.user);
      const admin = req.identity.role === "admin";

      if (!owner && !admin) throw errors.forbidden();

      if (owner && !admin) {
        if (booking.status !== "Pending") {
          throw errors.conflict(
            "Only requests that are still pending can be withdrawn. Contact operations for confirmed trips.",
          );
        }
      } else if (booking.status === "Confirmed") {
        throw errors.conflict(
          "Reject the confirmed booking before deleting it so the decision stays auditable.",
        );
      }

      await Booking.findByIdAndDelete(req.params.id);
      res.json({ message: "Booking cancelled" });
    }),
  );

  // ---------------------------------------------------------------------------
  // Operations (admin)
  // ---------------------------------------------------------------------------

  app.get(
    "/api/admin/bookings",
    authenticate,
    requireAdmin,
    asyncRoute(async (req, res) => {
      const filter = {};
      const requestedStatus = req.query.status;

      if (typeof requestedStatus === "string" && requestedStatus.length > 0) {
        if (!BOOKING_STATUSES.includes(requestedStatus)) {
          throw errors.badRequest("status must be Pending, Confirmed or Rejected", {
            allowed: BOOKING_STATUSES,
          });
        }
        filter.status = requestedStatus;
      }

      const bookings = await Booking.find(filter)
        .sort({ status: 1, createdAt: -1 })
        .limit(500)
        .lean();

      res.json(bookings.map((booking) => toBookingRecord(booking, { includeTraveller: true })));
    }),
  );

  app.put(
    "/api/admin/bookings/:id/status",
    authenticate,
    requireAdmin,
    asyncRoute(async (req, res) => {
      if (!isValidObjectId(req.params.id)) throw errors.notFound("Booking not found");

      const status = req.body?.status;
      if (status !== "Confirmed" && status !== "Rejected") {
        throw errors.badRequest("Status must be Confirmed or Rejected");
      }

      const note = clampString(req.body?.note, 400);
      const booking = await Booking.findById(req.params.id);
      if (!booking) throw errors.notFound("Booking not found");

      if (!canTransition(booking.status, status)) {
        throw errors.conflict(
          booking.status === status
            ? "This request has already been decided."
            : `A ${booking.status.toLowerCase()} request cannot become ${status.toLowerCase()}.`,
          { currentStatus: booking.status, requestedStatus: status },
        );
      }

      const update = {
        status,
        statusUpdatedAt: new Date(),
        statusNote:
          note ||
          (status === "Confirmed"
            ? "Your booking has been approved by operations"
            : "Your booking was declined by operations"),
      };

      // Atomic guard: only one concurrent decision can win because the filter
      // still requires the previous status.
      const updatedQuery = Booking.findOneAndUpdate(
        { _id: booking._id, status: booking.status },
        status === "Rejected" ? { $set: update, $unset: { holdKey: 1 } } : { $set: update },
        { new: true },
      );

      const updated = await updatedQuery;
      if (!updated) {
        throw errors.conflict("This request was decided by someone else a moment ago.");
      }

      res.json({
        message: `Booking ${status.toLowerCase()} successfully`,
        booking: toSafeBooking(updated),
      });
    }),
  );

  app.get(
    "/api/admin/summary",
    authenticate,
    requireAdmin,
    asyncRoute(async (req, res) => {
      const since = new Date(Date.now() - 13 * DAY_MS);
      since.setUTCHours(0, 0, 0, 0);

      const [pending, confirmed, rejected, tours, tourDocs, daily, topTours, recent] =
        await Promise.all([
          Booking.countDocuments({ status: "Pending" }),
          Booking.countDocuments({ status: "Confirmed" }),
          Booking.countDocuments({ status: "Rejected" }),
          Tour.countDocuments({}),
          Tour.find().select("availableDates").lean(),
          Booking.aggregate([
            { $match: { createdAt: { $gte: since } } },
            {
              $group: {
                _id: {
                  $dateToString: {
                    format: "%Y-%m-%d",
                    date: "$createdAt",
                    timezone: "UTC",
                  },
                },
                count: { $sum: 1 },
              },
            },
          ]),
          Booking.aggregate([
            { $match: { tourTitle: { $type: "string" } } },
            { $group: { _id: "$tourTitle", count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
            { $limit: 5 },
          ]),
          Booking.find()
            .sort({ createdAt: -1 })
            .limit(6)
            .select("tourTitle userName status startDate createdAt")
            .lean(),
        ]);

      const today = todayUtc();
      const activeDepartures = tourDocs.reduce(
        (total, tour) =>
          total + (tour.availableDates || []).filter((date) => isTodayOrLater(date)).length,
        0,
      );

      const upcomingConfirmed = await Booking.countDocuments({
        status: "Confirmed",
        startDate: { $gte: parseDateOnly(today) },
      });

      // Fill missing days so the chart never implies a gap in collection.
      const perDay = new Map(daily.map((entry) => [entry._id, entry.count]));
      const requestsByDay = [];
      for (let offset = 13; offset >= 0; offset -= 1) {
        const date = new Date(Date.now() - offset * DAY_MS).toISOString().slice(0, 10);
        requestsByDay.push({ date, count: perDay.get(date) || 0 });
      }

      res.json({
        pending,
        confirmed,
        rejected,
        tours,
        activeDepartures,
        upcomingConfirmed,
        totalRequests: pending + confirmed + rejected,
        requestsByDay,
        topTours: topTours.map((entry) => ({ tourTitle: entry._id, count: entry.count })),
        recentBookings: recent.map((booking) => ({
          _id: String(booking._id),
          tourTitle: booking.tourTitle,
          userName: booking.userName,
          status: booking.status,
          startDate: booking.startDate,
          createdAt: booking.createdAt,
        })),
      });
    }),
  );

  // ---------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------

  app.get(
    "/api/users/:id",
    authenticate,
    requireSelfOrAdmin,
    asyncRoute(async (req, res) => {
      if (!isValidObjectId(req.params.id)) throw errors.notFound("User not found");
      const user = await User.findById(req.params.id).select("-password").lean();
      if (!user) throw errors.notFound("User not found");
      res.json(user);
    }),
  );

  app.put(
    "/api/users/:id",
    authenticate,
    asyncRoute(async (req, res) => {
      if (!isValidObjectId(req.params.id)) throw errors.notFound("User not found");
      if (!isSelf(req.identity, req.params.id)) {
        throw errors.forbidden("You can only edit your own profile");
      }

      const update = {
        name: clampString(req.body?.name, 120),
        hometown: clampString(req.body?.hometown, 120),
        dob: clampString(req.body?.dob, 10),
      };
      if (update.name === undefined) throw errors.badRequest("Name cannot be empty");
      if (update.dob && !/^\d{4}-\d{2}-\d{2}$/.test(update.dob)) {
        throw errors.badRequest("Date of birth must use YYYY-MM-DD");
      }

      const updated = await User.findByIdAndUpdate(req.params.id, update, {
        new: true,
        runValidators: true,
      })
        .select("-password")
        .lean();
      if (!updated) throw errors.notFound("User not found");
      res.json(updated);
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

function normalizeRequestId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 100) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) return null;
  return trimmed;
}

module.exports = {
  createApp,
  isSecretConfigured: isConfigured,
};
