/**
 * THE REHEARSAL CLOCK, inside the server under test (test-only, never
 * loaded in production).
 *
 * A club rehearsal (e2e/rehearsal/) replays a fortnight of a club's life in
 * a few minutes, so the server under test has to believe it is Friday 10:00
 * when the rehearsal says it is. Only a few routes take the `x-test-now`
 * header; the analyze route, the admin-group route, generate-teams and
 * most of the libraries read `new Date()` / `Date.now()` directly.
 *
 * So the rehearsal starts the Next dev server with
 *
 *   NODE_OPTIONS="--require <this file>"  MT_REHEARSAL_CLOCK_FILE=<path>
 *
 * and this file replaces the global `Date` with a subclass whose "now" is
 * the real now plus an offset in milliseconds, read from that file. The
 * runner writes the offset before every step. With the variable unset, or
 * the file missing or garbled, the offset is 0: exactly the real clock.
 *
 * Only "now" moves: `new Date(x)` with an argument, `Date.UTC`, `Date.parse`
 * and every method behave exactly as before. Timers (setTimeout and
 * friends) run on the monotonic clock and are untouched.
 *
 * The file is re-read at most every REFRESH_MS, so a write is visible to
 * the server within that time; the runner waits a little longer after
 * each write.
 */
"use strict";

const fs = require("node:fs");

const REFRESH_MS = 20;

/**
 * Pure core, exported for the unit test: a Date constructor whose now is
 * `RealDate.now() + getOffset()`.
 *
 * Not a subclass: it returns plain RealDate instances and shares
 * RealDate.prototype, so `instanceof Date` holds both for dates made
 * through it and for dates Node made internally (fs stats, primordials)
 * with the original constructor.
 */
function makeShiftedDate(RealDate, getOffset) {
  const realNow = RealDate.now.bind(RealDate);
  function shiftedNow() {
    const off = Number(getOffset());
    return realNow() + (Number.isFinite(off) ? off : 0);
  }
  function ShiftedDate(...args) {
    // `Date()` called as a function returns a string of "now".
    if (!new.target) return new RealDate(shiftedNow()).toString();
    return args.length === 0 ? new RealDate(shiftedNow()) : new RealDate(...args);
  }
  Object.setPrototypeOf(ShiftedDate, RealDate);
  ShiftedDate.prototype = RealDate.prototype;
  ShiftedDate.now = shiftedNow;
  ShiftedDate.UTC = RealDate.UTC;
  ShiftedDate.parse = RealDate.parse;
  return ShiftedDate;
}

/** Offset reader with a small cache, so a hot path calling Date.now()
 *  thousands of times does not stat the file each time. */
function fileOffsetReader(file, RealDate) {
  let cached = 0;
  let readAt = -Infinity;
  return function getOffset() {
    const t = RealDate.now();
    if (t - readAt < REFRESH_MS) return cached;
    readAt = t;
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      const off = typeof parsed === "number" ? parsed : Number(parsed && parsed.offsetMs);
      cached = Number.isFinite(off) ? off : 0;
    } catch {
      cached = 0;
    }
    return cached;
  };
}

function install() {
  const file = process.env.MT_REHEARSAL_CLOCK_FILE;
  if (!file) return false;
  if (globalThis.__mtRehearsalClockInstalled) return true;
  const RealDate = globalThis.Date;
  globalThis.Date = makeShiftedDate(RealDate, fileOffsetReader(file, RealDate));
  globalThis.__mtRehearsalClockInstalled = true;
  return true;
}

install();

module.exports = { makeShiftedDate, fileOffsetReader, install };
