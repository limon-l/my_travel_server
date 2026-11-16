"use strict";

/**
 * Compatibility entry point.
 *
 * This file used to contain a second, divergent implementation of the API
 * (immediate-confirmation bookings, no availability rules). Two sources of truth
 * caused production 404s and inconsistent booking behaviour. It now exports the
 * canonical app from `app.js`, so both entry paths behave identically.
 */

module.exports = require("../app");
