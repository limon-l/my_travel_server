"use strict";

/**
 * Tour write validation, shared by create and update.
 *
 * Only the fields operations actually edits are accepted. Everything else in the
 * request body is ignored, so a caller cannot smuggle `_id`, timestamps or any
 * other stored field through this path.
 *
 * Bookings store snapshots (`tourTitle`, `tourImage`, `totalPrice`, `startDate`,
 * `endDate`). Editing a tour therefore never rewrites an existing request. A
 * duration change only affects departures requested after the change.
 */

const { errors } = require("./http");
const {
  clampString,
  isTodayOrLater,
  normalizeAvailableDates,
  normalizeUrl,
} = require("./validation");

const PRIORITIES = Object.freeze(["Standard", "Premium", "VIP"]);
const MAX_PRICE = 1_000_000;
const MAX_DURATION = 365;

function present(source, field) {
  return Object.prototype.hasOwnProperty.call(source, field) && source[field] !== undefined;
}

function readPrice(value) {
  if (value === null || value === "") {
    throw errors.badRequest("Price must be a number between 0 and 1,000,000");
  }
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0 || price > MAX_PRICE) {
    throw errors.badRequest("Price must be a number between 0 and 1,000,000");
  }
  return price;
}

function readDuration(value) {
  if (value === null || value === "") {
    throw errors.badRequest("Duration must be a whole number of days between 1 and 365");
  }
  const duration = Number(value);
  if (!Number.isInteger(duration) || duration < 1 || duration > MAX_DURATION) {
    throw errors.badRequest("Duration must be a whole number of days between 1 and 365");
  }
  return duration;
}

function readText(value, max, label) {
  const text = clampString(value, max);
  if (!text) throw errors.badRequest(`${label} cannot be empty`);
  return text;
}

/**
 * @param {unknown} body
 * @param {{ mode?: "create" | "patch" }} [options]
 * @returns {{ set: object, unset: object, availableDates?: string[] }}
 */
function sanitizeTourInput(body, { mode = "create" } = {}) {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const isCreate = mode === "create";
  const set = {};
  const unset = {};

  if (isCreate || present(source, "title")) {
    if (!present(source, "title")) throw errors.badRequest("Tour title is required");
    set.title = readText(source.title, 160, "Tour title");
  }

  if (isCreate || present(source, "price")) {
    if (!present(source, "price")) throw errors.badRequest("Price is required");
    set.price = readPrice(source.price);
  }

  if (isCreate || present(source, "duration")) {
    if (!present(source, "duration")) throw errors.badRequest("Duration is required");
    set.duration = readDuration(source.duration);
  }

  if (present(source, "shortDesc")) {
    const shortDesc = clampString(source.shortDesc, 400);
    if (shortDesc === undefined) unset.shortDesc = "";
    else set.shortDesc = shortDesc;
  }

  if (present(source, "fullDesc")) {
    const fullDesc = clampString(source.fullDesc, 20000);
    if (fullDesc === undefined) unset.fullDesc = "";
    else set.fullDesc = fullDesc;
  }

  if (present(source, "location")) {
    const location = clampString(source.location, 160);
    if (location === undefined) unset.location = "";
    else set.location = location;
  }

  if (present(source, "image")) {
    const raw = typeof source.image === "string" ? source.image.trim() : "";
    if (raw.length === 0) {
      unset.image = "";
    } else {
      const image = normalizeUrl(raw);
      if (!image) {
        throw errors.badRequest("Image must be an absolute http(s) URL or a local path");
      }
      set.image = image;
    }
  }

  if (present(source, "priority")) {
    if (!PRIORITIES.includes(source.priority)) {
      throw errors.badRequest("Priority must be Standard, Premium or VIP");
    }
    set.priority = source.priority;
  }

  let availableDates;
  if (isCreate && present(source, "availableDates")) {
    const parsed = normalizeAvailableDates(source.availableDates);
    if (!parsed.ok) throw errors.badRequest(parsed.error);
    const past = parsed.dates.filter((date) => !isTodayOrLater(date));
    if (past.length > 0) {
      throw errors.badRequest("New departures cannot be in the past", past);
    }
    availableDates = parsed.dates;
  }

  if (!isCreate && Object.keys(set).length === 0 && Object.keys(unset).length === 0) {
    throw errors.badRequest("No editable fields were provided");
  }

  return { set, unset, availableDates };
}

module.exports = { MAX_DURATION, MAX_PRICE, PRIORITIES, sanitizeTourInput };
