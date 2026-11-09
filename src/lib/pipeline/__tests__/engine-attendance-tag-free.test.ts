/**
 * ATTENDANCE NEVER NEEDS AN @Match Time TAG IN THE PLAYERS' GROUP
 * (Kemal, 2026-11-02).
 *
 * Sutton FC, 2 Nov 2026. Zair, an ordinary player, posted untagged:
 *
 *   "Sorry, Ismayil is out"
 *
 * The router read other_att and the extractor returned one claim
 * (other, out, "Ismayil", 0.95). The engine refused it, "requires an
 * @Match Time tag (interaction contract)", and Ismayil stayed on the
 * list. Kemal's ruling: every attendance message, about the sender or
 * about anybody else, is acted on without a tag. The engine's other
 * rules (the confidence floor, the admin-only bench guard, the banter
 * corroboration, capacity) are unchanged.
 */
import { describe, it, expect } from "vitest";
import { decide } from "./support/stub-picks";
import { NOW, SUTTON, attendanceFacts, claim, msg, statusOf, world } from "./helpers";

const CONFIRMED = ["kemal", "sait", "mustafa", "abid", "zair", "ismayil", "faris"];

function run(
  claims: ReturnType<typeof claim>[],
  o: { from: string; body: string; tagged?: boolean },
) {
  const state = world({ players: [...SUTTON, "ismayil"], confirmed: CONFIRMED });
  return decide({
    now: NOW,
    state,
    messages: [
      msg({
        from: o.from,
        body: o.body,
        tagged: o.tagged ?? false,
        route: "other_att",
        facts: attendanceFacts(claims),
      }),
    ],
  });
}

const ismayil = (polarity: "out" | "bench") =>
  claim({ subject: "other", personRef: "Ismayil", personNamed: true, polarity, confidence: 0.95 });

const reasons = (r: ReturnType<typeof run>) => r.outcomes[0].reasons.join(" | ");

describe("a player says a teammate is OUT, untagged (the 2026-11-02 Zair case)", () => {
  it("drops Ismayil", () => {
    const r = run([ismayil("out")], { from: "zair", body: "Sorry, Ismayil is out" });
    expect(statusOf(r.nextState, "ismayil")).toBe("DROPPED");
    expect(r.writes.some((w) => w.kind === "attendance" && w.userId === "u-ismayil")).toBe(true);
    expect(reasons(r)).not.toMatch(/@Match Time tag/i);
  });

  it("behaves exactly as the tagged message does", () => {
    const untagged = run([ismayil("out")], { from: "zair", body: "Sorry, Ismayil is out" });
    const tagged = run([ismayil("out")], { from: "zair", body: "Sorry, Ismayil is out", tagged: true });
    const shape = (r: ReturnType<typeof run>) =>
      r.writes.map((w) => ({ kind: w.kind, userId: "userId" in w ? w.userId : null }));
    expect(shape(untagged)).toEqual(shape(tagged));
    expect(untagged.nextState.rows).toEqual(tagged.nextState.rows);
  });

  it("still stops at the confidence floor: a joke drop changes nothing", () => {
    const r = run([{ ...ismayil("out"), confidence: 0.3 }], { from: "zair", body: "Ismayil is out lol" });
    expect(statusOf(r.nextState, "ismayil")).toBe("CONFIRMED");
  });
});

describe("the bench, untagged", () => {
  it("a player cannot bench a teammate, and the reason is the admin-only bench guard, not the tag", () => {
    const r = run([ismayil("bench")], { from: "zair", body: "put Ismayil on the bench" });
    expect(statusOf(r.nextState, "ismayil")).toBe("CONFIRMED");
    expect(reasons(r)).toMatch(/only an admin may bench/i);
    expect(reasons(r)).not.toMatch(/@Match Time tag/i);
  });

  it("an admin benches a player without tagging", () => {
    const r = run([ismayil("bench")], { from: "kemal", body: "put Ismayil on the bench" });
    expect(statusOf(r.nextState, "ismayil")).toBe("BENCH");
  });
});

describe("unchanged", () => {
  it("a player's own OUT, untagged", () => {
    const r = run([claim({ polarity: "out" })], { from: "zair", body: "I'm out" });
    expect(statusOf(r.nextState, "zair")).toBe("DROPPED");
  });

  it("an admin's untagged OUT for a player", () => {
    const r = run([ismayil("out")], { from: "kemal", body: "Ismayil is out" });
    expect(statusOf(r.nextState, "ismayil")).toBe("DROPPED");
  });
});
