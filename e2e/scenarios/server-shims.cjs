/**
 * The club scenarios' preload for the server under test: the rehearsal's
 * moving clock and the repeatable Math.random, as ONE --require (two quoted
 * --require entries in NODE_OPTIONS do not survive Next's own handling of
 * the variable for its child process). Test-only, never in production.
 */
"use strict";

require("../rehearsal/clock-shim.cjs");
require("./random-shim.cjs");
