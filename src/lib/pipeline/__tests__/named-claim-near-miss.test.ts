/**
 * VETS MNF, 2026-11-09 14:42: "David - Kemal's son, is on the bench".
 *
 * The owner Kemal posted it, untagged. David is not a member; nobody called
 * David is in the club. The attendance extractor read it right:
 * `{subject: other, polarity: bench, personRef: "David", personKind: named}`.
 * Our resolver then read "David" as the member Davide De Sousa (the club's
 * owner, CONFIRMED for that night) through the first-name NEAR MISS in
 * `identity.ts` ("davide" starts with "david", five letters, one apart), and
 * the engine moved Davide from CONFIRMED to BENCH. MatchTime posted a list
 * with "Bench: 1. Davide" and offered his place to the bench.
 *
 * David and Davide are two different names. A near miss on a bare first
 * name is a guess, and a guess must never move an existing member. The
 * roster below is the club's real one (read-only lookup, 2026-11-09),
 * with its real aliases.
 */
import { describe, it, expect } from "vitest";
import { decide } from "../engine";
import { resolvePerson } from "../identity";
import { NOW, attendanceFacts, claim, member, msg, statusOf, world } from "./helpers";
import type { Member } from "../types";

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

describe("resolvePerson: 'David' is not Davide De Sousa (Vets, 2026-11-09)", () => {
  it.each(["David", "david", "DAVID"])("'%s' is an unknown person, not the member Davide", (ref) => {
    expect(resolvePerson(ref, VETS)).toEqual({ kind: "unknown", name: ref });
  });

  it("other names one letter off a member's are not that member either", () => {
    const squad = [
      member("daniela", { name: "Daniela Rossi" }),
      member("simone", { name: "Simone Bianchi" }),
      member("andrea", { name: "Andrea Conti" }),
    ];
    for (const ref of ["Daniel", "Simon", "Andre"]) {
      expect(resolvePerson(ref, squad).kind, ref).toBe("unknown");
    }
  });

  // The legitimate matches stay.
  it.each([
    ["Davide", "Davide De Sousa"],
    ["davide", "Davide De Sousa"],
    ["Davide De Sousa", "Davide De Sousa"],
    ["davide de sousa", "Davide De Sousa"],
    ["Stuart", "Stuart Belcher"],
    ["Belcher", "Stuart Belcher"],
    ["smiler", "Nabz"],
    ["CJ", "Cj - Barber Lab"],
    ["Mustafa", "Mustafa Cayir"],
    ["Mustafa Çayır", "Mustafa Cayir"],
  ])("'%s' still resolves to %s", (ref, name) => {
    const r = resolvePerson(ref, VETS);
    expect(r.kind === "resolved" && r.member.name).toBe(name);
  });

  it("an accent difference is the same name: 'Jose' is José Silva, 'José' is Jose Silva", () => {
    expect(resolvePerson("Jose", [member("jose", { name: "José Silva" })])).toMatchObject({ kind: "resolved" });
    expect(resolvePerson("José", [member("jose", { name: "Jose Silva" })])).toMatchObject({ kind: "resolved" });
  });
});

describe("the engine: an admin's 'David is on the bench' never moves Davide (Vets, 2026-11-09)", () => {
  const BODY = "David - Kemal's son, is on the bench";
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
  const facts = () =>
    attendanceFacts([
      claim({
        subject: "other",
        polarity: "bench",
        personRef: "David",
        personKind: "named",
        personNamed: true,
        benchAsked: true,
        confidence: 0.9,
      }),
    ]);

  it("THE INCIDENT: Davide stays CONFIRMED and nothing is written about him", () => {
    const r = decide({
      now: NOW,
      state: state(),
      messages: [msg({ from: "kemal", body: BODY, route: "other_att", facts: facts() })],
    });
    expect(statusOf(r.nextState, "davide")).toBe("CONFIRMED");
    const writes = r.writes.filter((w) => w.kind === "attendance");
    expect(writes.filter((w) => "userId" in w && w.userId === "u-davide")).toHaveLength(0);
    expect(r.outcomes[0].reasons.join(" | ")).toMatch(/"David" is not a member/);
  });

  it("the same message about the member by his real name still benches him", () => {
    const f = facts();
    (f.claims[0] as { personRef: string }).personRef = "Davide";
    const r = decide({
      now: NOW,
      state: state(),
      messages: [msg({ from: "kemal", body: "Davide is on the bench", route: "other_att", facts: f })],
    });
    expect(statusOf(r.nextState, "davide")).toBe("BENCH");
  });
});
