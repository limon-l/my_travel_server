# Wanderlust Atlas — API

Express 5 + MongoDB service for Wanderlust Atlas. It owns authentication, tour
inventory, departure availability, booking requests, and the operations queue.

The client is a Next.js app in `../my_travel_client`. Browser traffic is expected to
arrive through the client's same-origin bridge, authenticated with a short-lived
HMAC bearer token. The API still enforces every rule independently.

---

## Table of contents

- [Security model](#security-model)
- [Architecture](#architecture)
- [Local setup](#local-setup)
- [Environment variables](#environment-variables)
- [Scripts](#scripts)
- [API reference](#api-reference)
- [Booking rules](#booking-rules)
- [Testing](#testing)
- [Deployment](#deployment)
- [Known limitations](#known-limitations)

---

## Security model

The previous build accepted `userId` from the browser, exposed a public seed/delete
route, and shipped an admin login with a reusable demo password. Those paths are
gone.

- **Token-based identity.** Private routes require
  `Authorization: Bearer <token>`. Tokens are HMAC-SHA256, carry
  `{ sub, role, name, email, exp }`, expire after 120 seconds, and are rejected when
  the payload is tampered with or the secret is missing/short.
- **Role checks on the server.** Admin routes require a verified `role: "admin"`.
  Client registration always writes `role: "user"`; a role field in the body is
  ignored.
- **Ownership checks.** A customer can read/modify only their own bookings and
  profile. Admins can read bookings but must reject a `Confirmed` booking before
  deleting it so the decision remains auditable.
- **Server-owned money and duration.** `totalPrice` and `endDate` are derived from
  the stored tour; the browser cannot send either.
- **Server-owned status.** Only `Pending → Confirmed | Rejected` is allowed, with an
  atomic `findOneAndUpdate` guard so concurrent decisions cannot both win.
- **Unique departure guard.** `holdKey` (`tourId:YYYY-MM-DD`) has a unique sparse
  index while a booking is `Pending` or `Confirmed`, preventing two travellers from
  holding the same departure under concurrency. Rejecting a booking removes the
  key.
- **Verified indexes.** At startup the API inspects the live `bookings` collection
  and only enables booking writes when both unique indexes exist with the expected
  shape. On failure it logs the exact problem, `/api/health` reports
  `bookingIndexes: "unverified"`, and `POST /api/bookings` answers `503`.
- **Idempotent submission.** An optional `Idempotency-Key` header is stored as
  `clientRequestId` (`sub:key`) with a unique sparse index; a retry returns the
  original booking instead of creating a duplicate.
- **Validation and limits.** Object IDs, calendar dates, email addresses, URLs, and
  string lengths are validated. JSON bodies are capped at 64 KB.
- **Rate limiting.** Sign-in: 10 attempts / 15 min per IP+email. Registration:
  10 / hour per IP+email.
- **CORS allowlist.** Only `CLIENT_ORIGIN` origins (plus localhost/known client by
  default) are allowed.
- **Hardening headers.** `x-powered-by` is disabled; `trust proxy` is set for
  Render; errors return stable JSON codes; the not-found handler hides route
  details.
- **Manual seeding.** `GET /api/seed` no longer exists. Seeding is a CLI command
  requiring `--confirm`, a non-production `NODE_ENV`, and `MONGO_URI`.

Not implemented:

- Email verification, password reset, MFA, refresh tokens, and token revocation.
- Payment processing. `totalPrice` is stored for display; no charge is made.
- Audit-log persistence beyond `status`, `statusNote`, and `statusUpdatedAt`.

## Architecture

```
app.js                 createApp(): middleware, routes, error handlers
index.js               process entry: env check, DB connect, listen, shutdown
api/server.js          compatibility re-export of app.js
models.js              Mongoose schemas and indexes
lib/session-token.js   HMAC sign/verify (shared contract with the client)
lib/auth.js            authenticate / requireAdmin / requireSelfOrAdmin
lib/booking-policy.js  transitions, date math, hold keys, overlap checks
lib/validation.js      dates, emails, URLs, ObjectIds, string clamps
lib/http.js            asyncRoute, typed errors, JSON error handler
lib/rate-limit.js      bounded limiter with sweeps and Retry-After headers
lib/tour-input.js      create/patch allowlisting and tour field validation
scripts/seed.js        opt-in example data
scripts/migrate-hold-keys.js  backfill/repair holdKey (dry-run by default)
test/                  node:test unit tests + gated Mongo integration tests
```

## Local setup

Requirements: Node.js 22, npm, and reachable MongoDB.

```bash
npm install
```

Copy `.env.example` to `.env` and fill in:

```env
PORT=5000
MONGO_URI=your_mongodb_connection_string
CLIENT_ORIGIN=http://localhost:3000
API_SESSION_SECRET=the-same-value-as-the-client
ADMIN_EMAIL=operator@example.com
ADMIN_PASSWORD_HASH=a-bcrypt-hash-at-cost-12
```

Generate the shared secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Generate the admin hash (never store the plaintext):

```bash
node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 12))" "your-password"
```

Start:

```bash
npm start        # production
npm run dev      # nodemon
```

The process still starts without `API_SESSION_SECRET` so `/api/health` can report
degradation, but authenticated routes fail closed and a startup warning is logged.
Treat a missing secret as a deployment error.

### Optional example data

```bash
node scripts/seed.js --confirm
```

This appends the tours in `scripts/seed-data.json`; it does not clear existing data.
It refuses to run in production.

### Upgrading an existing database

Backfill hold keys so the unique departure index applies to historical bookings:

```bash
node scripts/migrate-hold-keys.js          # dry run, reports conflicts
node scripts/migrate-hold-keys.js --apply  # writes keys
```

Take and review a backup before `--apply` in production. Duplicate active bookings
are reported, not silently merged.

## Environment variables

| Variable             | Required        | Notes                                                        |
| -------------------- | --------------- | ------------------------------------------------------------ |
| `PORT`               | No (5000)       | HTTP port.                                                   |
| `MONGO_URI`          | Yes             | MongoDB connection string.                                   |
| `CLIENT_ORIGIN`      | Recommended     | Comma-separated allowed origins.                             |
| `API_SESSION_SECRET` | Production      | Shared HMAC secret, 32+ chars, identical to the client.      |
| `ADMIN_EMAIL`        | For admin login | Operator address; registration rejects this address.         |
| `ADMIN_PASSWORD_HASH`| For admin login | bcrypt hash, cost 12+; never a plaintext password.            |
| `TEST_MONGO_URI`     | Tests only      | Disposable database whose name contains `test`.              |

If `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` are unset, no built-in admin exists.
Admin access then requires a database user whose `role` is `admin`, created by an
operator through a trusted path.

## Scripts

| Command                       | What it does                                      |
| ----------------------------- | ------------------------------------------------- |
| `npm start`                   | Start the API                                     |
| `npm run dev`                 | Start with nodemon                                |
| `npm test`                    | `node --test` (Windows-safe, no directory arg)    |
| `npm run seed`                | Same as `node scripts/seed.js`; still needs `--confirm` |
| `npm run migrate:hold-keys`   | Backfill hold keys (dry-run unless `--apply`)     |

Windows note: use `npm.cmd` if PowerShell blocks `npm.ps1`.

## API reference

Public:

| Method | Path                            | Notes                                      |
| ------ | ------------------------------- | ------------------------------------------ |
| GET    | `/`                             | Liveness; reports DB state                 |
| GET    | `/api/health`                   | Readiness; `503` when DB is down or booking indexes are unverified |

`/api/health` reports process *and* dependency state:

```json
{
  "status": "ok",
  "database": "up",
  "checks": { "database": "up", "bookingIndexes": "verified" },
  "bookingWrites": "enabled"
}
```

MongoDB runs with `bufferCommands: false` and bounded timeouts, so an outage
answers `503 SERVICE_UNAVAILABLE` immediately instead of buffering into a generic
`500`. Liveness is `/`; readiness is `/api/health`.
| POST   | `/api/register`                 | Creates a `user`; 8+ char password         |
| POST   | `/api/login`                    | Returns `{ id, name, email, role }`        |
| GET    | `/api/tours`                    | Catalogue                                  |
| GET    | `/api/tours/:id`                | Tour detail                                |
| GET    | `/api/tours/:id/available-dates`| Free published departures                  |

Authenticated customer:

| Method | Path                 | Notes                                             |
| ------ | -------------------- | ------------------------------------------------- |
| POST   | `/api/bookings`      | Body: `{ tourId, startDate }`; optional idempotency key |
| GET    | `/api/bookings/:userId` | Self or admin only                            |
| DELETE | `/api/bookings/:id`  | Owner (Pending only) or admin (not Confirmed)     |
| GET    | `/api/users/:id`     | Self or admin only; never returns `password`      |
| PUT    | `/api/users/:id`     | Self only; `{ name, hometown, dob }`              |

Admin:

| Method | Path                                | Notes                                  |
| ------ | ----------------------------------- | -------------------------------------- |
| GET    | `/api/admin/bookings`               | Optional `?status=`; capped at 500     |
| PUT    | `/api/admin/bookings/:id/status`    | `{ status: "Confirmed" \| "Rejected", note? }` |
| GET    | `/api/admin/summary`                | Counts, 14-day activity, top tours, recent requests |
| POST   | `/api/tours`                        | Create tour                            |
| PATCH  | `/api/tours/:id`                    | Edit allowlisted fields; never rewrites booking snapshots |
| DELETE | `/api/tours/:id`                    | Blocked while active bookings exist    |
| PUT    | `/api/tours/:id/available-dates`    | Replace published departures           |

`PATCH /api/tours/:id` accepts only `title`, `shortDesc`, `fullDesc`, `location`,
`image`, `price`, `duration` and `priority`. Unknown fields such as `_id`,
timestamps or booking state are ignored. Bookings store their own `tourTitle`,
`tourImage`, `totalPrice`, `startDate` and `endDate` snapshots, so a catalogue
edit never changes an existing request. A duration change applies only to
departures requested afterwards.

### Response conventions

- Success: JSON payload; `201` for created resources.
- Errors: `{ "error": "human readable", "code": "MACHINE_CODE", "details"?: ... }`.
- Common codes: `UNAUTHENTICATED`, `INVALID_SESSION`, `FORBIDDEN`, `NOT_FOUND`,
  `CONFLICT`, `INVALID_REQUEST`, `RATE_LIMITED`, `INTERNAL_ERROR`,
  `SERVICE_UNAVAILABLE`.
- Authentication and registration limits answer `429` with `Retry-After` and
  `X-RateLimit-*` headers. The limiter is bounded and sweeps expired keys, so
  attacker-controlled identifiers cannot grow memory without limit.
- An unknown `?status=` value on `/api/admin/bookings` is rejected with
  `400 INVALID_REQUEST` rather than silently returning everything.

## Booking rules

- A departure must be published on the tour and be today or later in UTC.
- `endDate` is `startDate + duration` (exclusive end) computed by the server.
- A traveller cannot hold overlapping active trips.
- One active booking per tour+date across all travellers (unique `holdKey`).
- Disabling a departure never deletes or rejects existing bookings; the response
  reports `affectedBookings` so the UI can warn.
- Rejected bookings free the departure and their status is final.
- A traveller may withdraw only a Pending request. An administrator may delete a
  Pending or Rejected booking, but a Confirmed booking must be rejected first so
  the decision stays auditable.
- Deleting a tour is blocked while it has pending or confirmed bookings.
- Booking writes are refused with `503 SERVICE_UNAVAILABLE` while the required
  unique indexes (`one_active_booking_per_departure`, `idempotent_booking_requests`)
  are missing or misconfigured. Reads and admin decisions keep working.

## Testing

```bash
npm test
```

Unit coverage includes token signing/verification, transitions, hold keys, date math,
overlap detection, validation, malformed stored dates, the bounded rate limiter,
tour create/patch validation, and required-index evaluation. Integration tests cover
authentication, ownership, lifecycle, concurrency, departure disabling, tour-edit
snapshot preservation, and admin filter validation; they are skipped unless
`TEST_MONGO_URI` is set:

```bash
TEST_MONGO_URI="mongodb://localhost:27017/wanderlust_test" npm test
```

The test runner refuses production-looking database names. Real-DB tests require a
disposable MongoDB instance. Unit-only runs (no `TEST_MONGO_URI`) execute the pure
suites and report the database tests as skipped, never passed.

## Deployment

`render.yaml` declares a web service with:

- Build: `npm ci`
- Start: `npm start`
- Health check: `/api/health`
- Secrets (`sync: false`): `MONGO_URI`, `CLIENT_ORIGIN`, `API_SESSION_SECRET`,
  `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`

Production checklist:

1. Provision a fresh `API_SESSION_SECRET` and set the same value in the client.
2. Set `CLIENT_ORIGIN` to the deployed client origin(s).
3. Set a bcrypt admin hash; do not reuse the old demo password.
4. Confirm `/api/health` returns `200` with `database: "up"` and
   `bookingIndexes: "verified"`.
5. Run the hold-key migration if the database predates this version.
6. Rotate any credential that was ever present in the previous public README.

Deployment, secret provisioning, and credential rotation require owner approval and
are not performed by this repository.

## Known limitations

- The deployed instance at `my-travel-server-0d5q.onrender.com` has been observed
  returning `500` for `GET /api/tours` while `/` returns `200`. Render logs and the
  deployed revision were not available here, so the production root cause is
  unresolved and production readiness is **BLOCKED**.
- MongoDB was unreachable from the development sandbox
  (`querySrv ECONNREFUSED`), so the real-database integration and concurrency suites
  could not run locally.
- Rate limiting is in-process and resets on restart; a multi-instance deployment
  needs a shared store.
- No refresh-token rotation or revocation list.
