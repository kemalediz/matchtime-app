/**
 * A REPEATABLE Math.random INSIDE THE SERVER UNDER TEST (club scenarios
 * only, never loaded in production).
 *
 * The team balancer swaps players at random (src/lib/team-balancer.ts), so
 * two runs of the same club would make different teams, write different
 * TeamAssignment rows and, downstream, ask the model different questions:
 * a replay would miss and an A/B diff would be noise. So a scenario run
 * starts the Next dev server with
 *
 *   NODE_OPTIONS="--require <this file>"  MT_SCENARIO_RANDOM_SEED=<seed>
 *
 * and Math.random becomes a seeded generator that is RESEEDED AT THE START
 * OF EVERY HTTP REQUEST from (seed, method, path, how many requests to that
 * path came before). The runner sends the same requests in the same order
 * every run, so each request draws the same numbers whatever ran before it.
 * With the variable unset this file does nothing.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS preload for node --require */
"use strict";

const http = require("node:http");

/** FNV-1a, 32 bit: a string to a seed. */
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: small, fast, good enough for shuffles. */
function mulberry32(a) {
  let s = a >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A Math.random replacement and the hook that reseeds it per request. */
function makeSeededRandom(seed) {
  let gen = mulberry32(hash32(String(seed)));
  const perPath = new Map();
  return {
    random: () => gen(),
    onRequest(method, url) {
      const p = String(url || "").split("?")[0];
      const k = `${method} ${p}`;
      const n = (perPath.get(k) || 0) + 1;
      perPath.set(k, n);
      gen = mulberry32(hash32(`${seed}\u0000${k}\u0000${n}`));
    },
  };
}

function install() {
  const seed = process.env.MT_SCENARIO_RANDOM_SEED;
  if (!seed) return false;
  if (globalThis.__mtScenarioRandomInstalled) return true;
  const r = makeSeededRandom(seed);
  Math.random = r.random;
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function patchedEmit(event, req, ...rest) {
    if (event === "request" && req) r.onRequest(req.method, req.url);
    return emit.call(this, event, req, ...rest);
  };
  globalThis.__mtScenarioRandomInstalled = true;
  return true;
}

install();

module.exports = { makeSeededRandom, hash32, mulberry32, install };
