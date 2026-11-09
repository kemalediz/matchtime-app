/**
 * VETS MNF, 2026-11-09 14:42: "David - Kemal's son, is on the bench".
 *
 * The owner Kemal posted it, untagged. David is not a member; nobody called
 * David is in the club. The attendance extractor read it right:
 * `{subject: other, polarity: bench, personRef: "David", personKind: named}`.
 * Our resolver then read "David" as the member Davide De Sousa (CONFIRMED
 * for that night) through the first-name NEAR MISS in `identity.ts`
 * ("davide" starts with "david", five letters, one apart), and the engine
 * moved Davide from CONFIRMED to BENCH.
 *
 * PR #570 removed the near miss, and with it the useful guesses ("Davdie"
 * for Davide, "habibi" for Habib). Since 2026-11-09 (option B, Kemal) who a
 * name is, is the MODEL's pick from the club's members with the message in
 * view (`who-is-who.ts`): it can tell "David, Kemal's son" from a typo of
 * Davide, which no spelling rule can. The engine only acts on the pick. The
 * roster below is the club's real one (read-only lookup, 2026-11-09), with
 * its real aliases; the picks are what the model is asked to say (checked
 * live in `scripts/live-check-who-is-who.ts`).
 */
import { describe, it, expect } from "vitest";
import { decide } from "../engine";
import { NOW, attendanceFacts, claim, member, msg, statusOf, world } from "./helpers";
import type { Member } from "../types";
import type { PersonPick } from "../who-is-who";

const VETS: Member[] = [
  member("andrew", { name: "Andrew" }),
  member("ben", { name: "Ben" }),
  member("bh", { name: "BH" }),
  member("cj", { name: "Cj - Barber Lab", aliases: ["cj"] }),
  member("craig", { name: "Craig" }),
  member("dan", { name: "Dan", aliases: ["dan"] }),
  member("davide", { name: "Davide De Sousa", aliases: ["davide"], isAdmin: true }),
  member("jon", { name: "Jon" }),
  member("kemal", { name: "Kemal", isAdmin: true }),
  member("luca", { name: "Luca" }),
  member("mustafa", { name: "Mustafa Cayir" }),
  member("nabz", { name: "Nabz", aliases: ["nabz", "smiler"] }),
  member("oumesh", { name: "Oumesh" }),
  member("rozeroner", { name: "Rozeroner" }),
  member("serg", { name: "Serg" }),
  member("shane", { name: "Shane" }),
  member("steff", { name: "Steff" }),
  member("steve", { name: "Steve" }),
  member("stuart", { name: "Stuart Belcher" }),
  member("utv", { name: "UTV" }),
  member("zeeshan", { name: "Zeeshan" }),
];

const state = () => {
  const s = world({
    players: VETS.map((m) => m.userId.slice(2)),
    admins: ["kemal", "davide"],
    maxPlayers: 14,
    confirmed: ["davide", "kemal", "andrew", "ben", "craig", "dan", "jon", "luca", "nabz", "shane", "steff", "steve", "serg"],
  });
  s.roster = VETS.map((m) => ({ ...m }));
  return s;
};
const benchClaim = (personRef: string) =>
  attendanceFacts([
    claim({ subject: "other", polarity: "bench", personRef, personKind: "named", personNamed: true, benchAsked: true, confidence: 0.9 }),
  ]);
const run = (body: string, personRef: string, people?: ReadonlyMap<string, PersonPick>) =>
  decide({
    now: NOW,
    state: state(),
    messages: [{ ...msg({ from: "kemal", body, route: "other_att", facts: benchClaim(personRef) }), ...(people ? { people } : {}) }],
  });
const davideWrites = (r: ReturnType<typeof decide>) =>
  r.writes.filter((w) => w.kind === "attendance" && "userId" in w && w.userId === "u-davide");

describe("the engine acts on the model's pick, never on spelling (Vets, 2026-11-09)", () => {
  it("THE INCIDENT: the model says 'David, Kemal's son' is nobody in the club: Davide stays CONFIRMED", () => {
    const r = run("David - Kemal's son, is on the bench", "David", new Map([["David", { kind: "none" }]]));
    expect(statusOf(r.nextState, "davide")).toBe("CONFIRMED");
    expect(davideWrites(r)).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" | ")).toMatch(/"David" is not a member/);
  });

  it("no pick at all (the call failed) moves nobody either", () => {
    const r = run("David - Kemal's son, is on the bench", "David");
    expect(statusOf(r.nextState, "davide")).toBe("CONFIRMED");
    expect(davideWrites(r)).toHaveLength(0);
  });

  it("a typo the model is sure of is the member: 'Davdie is on the bench' benches Davide (the guess #570 lost, back by the model)", () => {
    const r = run("Davdie is on the bench", "Davdie", new Map([["Davdie", { kind: "member", userId: "u-davide" }]]));
    expect(statusOf(r.nextState, "davide")).toBe("BENCH");
  });

  it("a pick the model was not sure of (one candidate) never moves a CONFIRMED member", () => {
    const r = run("Dav is on the bench", "Dav", new Map([["Dav", { kind: "ambiguous", userIds: ["u-davide"] }]]));
    expect(statusOf(r.nextState, "davide")).toBe("CONFIRMED");
    expect(davideWrites(r)).toHaveLength(0);
  });

  it("the same message by his real name still benches him, when the model says it is him", () => {
    const r = run("Davide is on the bench", "Davide", new Map([["Davide", { kind: "member", userId: "u-davide" }]]));
    expect(statusOf(r.nextState, "davide")).toBe("BENCH");
  });

  it("RED on main: a member's exact name with no pick is NOT resolved by code any more", () => {
    const r = run("Davide is on the bench", "Davide");
    expect(statusOf(r.nextState, "davide")).toBe("CONFIRMED");
  });
});
