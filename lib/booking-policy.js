"use strict";

/**
 * Booking domain rules. Kept free of Express/Mongoose so they can be unit tested
 * and reasoned about in isolation.
 *
 * Persisted statuses are intentionally limited to the three values the product
 * already stores. Nothing here renames or invents a status.
 */

const BOOKING_STATUSES = Object.freeze(["Pending", "Confirmed", "Rejected"]);
const ACTIVE_STATUSES = Object.freeze(["Pending", "Confirmed"]);

const ALLOWED_TRANSITIONS = Object.freeze({
  Pending: Object.freeze(["Confirmed", "Rejected"]),
  Confirmed: Object.freeze([]),
  Rejected: Object.freeze([]),
});

function isBookingStatus(value) {
  return BOOKING_STATUSES.includes(value);
}

function isActiveStatus(value) {
  return ACTIVE_STATUSES.includes(value);
}

function canTransition(from, to) {
  const allowed = ALLOWED_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * A departure ("tour + calendar date") can only be held by one active booking.
 * `holdKey` is the database-level uniqueness handle; it is unset when a booking
 * is rejected or removed so the departure becomes available again.
 */
function holdKeyFor(tourId, dateOnly) {
  return `${String(tourId)}:${dateOnly}`;
}

/**
 * Duration is counted as whole days from the departure date. The stored
 * `endDate` is exclusive of the final day for overlap maths, matching the
 * original implementation's behaviour.
 */
function computeEndDate(startDate, durationDays) {
  const end = new Date(startDate.getTime());
  end.setUTCDate(end.getUTCDate() + durationDays);
  return end;
}

/** Half-open overlap test on [start, end). */
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * The original product rule: a traveller cannot hold two active trips whose
 * date ranges overlap, regardless of destination. Rejected trips do not block.
 */
function overlapsExistingTrip(existingBookings, candidateStart, candidateEnd) {
  return existingBookings.some((booking) => {
    if (!isActiveStatus(booking.status)) return false;
    const start = new Date(booking.startDate);
    const end = new Date(booking.endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
    return rangesOverlap(start, end, candidateStart, candidateEnd);
  });
}

module.exports = {
  ACTIVE_STATUSES,
  ALLOWED_TRANSITIONS,
  BOOKING_STATUSES,
  canTransition,
  computeEndDate,
  holdKeyFor,
  isActiveStatus,
  isBookingStatus,
  overlapsExistingTrip,
  rangesOverlap,
};
