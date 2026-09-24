/**
 * Does the MESSAGE name the bench? A necessary condition for an EXPLICIT
 * bench (2026-09-24, Erdal's "in"), never a classifier: it only ever
 * refuses the model's "bench", it never produces one.
 */
import { describe, it, expect } from "vitest";
import { namesTheBench } from "../bench-words";

describe("namesTheBench", () => {
  it.each([
    "In. For bench👍",
    "in but stick me on the bench",
    "put me on the bench, let Habib play",
    "@Match Time move Salman to bench",
    "bench Ronaldo",
    "happy to be benched",
    "In as a reserve",
    "reserves list please",
    "I'll be a sub",
    "on the subs bench",
    "happy to be substitute",
    "put me on standby",
    "stick me on the waiting list",
    "waitlist me",
    "🪑",
    // Turkish: yedek, and its softened forms (yedeğe, yedeğim).
    "yedekte kalayım",
    "Yedek olarak varım",
    "beni yedeğe yaz",
    "YEDEK",
  ])("names the bench: %s", (body) => {
    expect(namesTheBench(body)).toBe(true);
  });

  it.each([
    "in",
    "In",
    "IN",
    "varım",
    "count me in",
    "14.Erdal",
    "I'm in, see you Tuesday",
    "subject to work, in",
    "benchmark",
    "reservation at 9",
    "",
  ])("does not name the bench: %s", (body) => {
    expect(namesTheBench(body)).toBe(false);
  });
});
