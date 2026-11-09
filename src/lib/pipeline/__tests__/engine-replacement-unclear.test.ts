/**
 * "X FOR Y" WITH Y UNCLEAR IS HELD WHOLE (review of #574).
 *
 * When who-is-who cannot place the player X takes the place of (two
 * Najibs, or one it is not sure of), X is not added either: adding him and
 * leaving Y would grow the squad by one. Nothing is written; the sender
 * hears the usual ambiguity.
 */
import { describe, expect, it } from "vitest";
import { decide } from "../engine";
import { NOW, attendanceFacts, claim, msg, statusOf, world } from "./helpers";
import type { PersonPick } from "../who-is-who";

const state = () => world({ players: ["kemal", "najib", "mojib", "zair"], confirmed: ["kemal", "najib"], maxPlayers: 14 });
const facts = () =>
  attendanceFacts([
    claim({ subject: "other", personRef: "Mojib", personKind: "named", personNamed: true, polarity: "in", replaces: "Najib", confidence: 0.95 }),
    claim({ subject: "other", personRef: "Najib", personKind: "named", personNamed: true, polarity: "out", confidence: 0.95 }),
  ]);
const run = (najib: PersonPick) =>
  decide({
    now: NOW,
    state: state(),
    messages: [
      {
        ...msg({ from: "kemal", body: "Mojib is replacing Najib", route: "other_att", tagged: true, facts: facts() }),
        people: new Map<string, PersonPick>([
          ["Mojib", { kind: "member", userId: "u-mojib" }],
          ["Najib", najib],
        ]),
      },
    ],
  });

describe("a stated replacement whose replaced player is unclear", () => {
  it("not sure who Najib is: Mojib is NOT added and Najib stays (the squad does not grow)", () => {
    const r = run({ kind: "ambiguous", userIds: ["u-najib"] });
    expect(statusOf(r.nextState, "mojib")).toBe("ABSENT");
    expect(statusOf(r.nextState, "najib")).toBe("CONFIRMED");
    expect(r.degradations.map((d) => d.detail).join(" | ")).toMatch(/the whole replacement is held/);
  });

  it("no answer about Najib (a failed call): held the same way", () => {
    const r = run({ kind: "unidentified", why: "the call failed" });
    expect(statusOf(r.nextState, "mojib")).toBe("ABSENT");
  });

  it("control: a Najib the model is sure of, and the replacement goes through", () => {
    const r = run({ kind: "member", userId: "u-najib" });
    expect(statusOf(r.nextState, "mojib")).toBe("CONFIRMED");
    expect(statusOf(r.nextState, "najib")).toBe("DROPPED");
  });
});
