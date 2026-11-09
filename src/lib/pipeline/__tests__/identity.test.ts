/**
 * Identity resolution, as pure code (rewritten 2026-11-09).
 *
 * WHO a name is, is the model's (`who-is-who.ts`, Kemal: "never use
 * string matching"): `resolvePerson` only reads the pick for the name as
 * quoted and checks the member is on the roster it resolves against. What
 * stays code's is about the reference itself: raw digits and an empty
 * reference are never a person, and an ambiguity BAILS. No spelling, near
 * miss, prefix, first name or alias resolves anybody here any more; the
 * cases those used to answer ("David" is not Davide, "habibi" is Habib,
 * "Moham" is Mohammed, "Davdie" is Davide) are the model's, and are
 * checked live (`scripts/live-check-who-is-who.ts`).
 */
import { describe, it, expect } from "vitest";
import { isRawDigitName, resolvePerson } from "../identity";
import type { PersonPick } from "../who-is-who";
import { member } from "./helpers";

const roster = [
  member("kemal"),
  member("habib"),
  member("najib"),
  member("ehtisham"),
  member("aydin"),
  member("zair"),
  member("davide", { name: "Davide De Sousa" }),
];
const picks = (entries: Array<[string, PersonPick]>) => new Map<string, PersonPick>(entries);

describe("isRawDigitName", () => {
  it.each([
    ["158055467598020", true],
    ["+44 7700 900009", true],
    ["447700900009", true],
    ["Najib", false],
    ["Zair Malik", false],
  ])("%s → %s", (input, expected) => {
    expect(isRawDigitName(input)).toBe(expected);
  });
});

describe("resolvePerson reads the model's pick", () => {
  it("a sure pick of a member on the roster resolves to that member", () => {
    const r = resolvePerson("habibi", roster, picks([["habibi", { kind: "member", userId: "u-habib" }]]));
    expect(r).toMatchObject({ kind: "resolved", member: { userId: "u-habib" } });
  });

  it("'none' is somebody nobody in the club is: unknown, never a member (Vets MNF, 'David - Kemal's son')", () => {
    const r = resolvePerson("David", roster, picks([["David", { kind: "none" }]]));
    expect(r).toEqual({ kind: "unknown", name: "David" });
  });

  it("several possible members BAIL, with the candidates on the roster", () => {
    const r = resolvePerson("Ali", roster, picks([["Ali", { kind: "ambiguous", userIds: ["u-kemal", "u-zair", "u-ghost"] }]]));
    expect(r.kind).toBe("ambiguous");
    expect(r.kind === "ambiguous" ? r.candidates.map((m) => m.userId) : []).toEqual(["u-kemal", "u-zair"]);
  });

  it("a pick the model was not sure of (one candidate) BAILS too: a member moves only on a sure pick", () => {
    const r = resolvePerson("Dav", roster, picks([["Dav", { kind: "ambiguous", userIds: ["u-davide"] }]]));
    expect(r.kind).toBe("ambiguous");
  });

  it("a member not on THIS roster (e.g. not attending) is not resolved, and not a guest either", () => {
    const attending = roster.filter((m) => m.userId !== "u-habib");
    const r = resolvePerson("Habib", attending, picks([["Habib", { kind: "member", userId: "u-habib" }]]));
    expect(r.kind).toBe("ambiguous");
  });

  it("an unidentified name (a failed call) BAILS: nobody moved, nobody provisioned", () => {
    const r = resolvePerson("Najib", roster, picks([["Najib", { kind: "unidentified", why: "the call failed" }]]));
    expect(r.kind).toBe("ambiguous");
  });

  it("the pick is found under the name as quoted: a leading @ and extra spaces do not lose it", () => {
    const p = picks([["Zair Malik", { kind: "member", userId: "u-zair" }]]);
    expect(resolvePerson("@Zair  Malik", roster, p)).toMatchObject({ kind: "resolved", member: { userId: "u-zair" } });
  });
});

describe("no spelling resolves anybody (2026-11-09)", () => {
  // RED on main: every one of these resolved by code before.
  it.each([
    ["Kemal Ediz", "an exact full name"],
    ["Kemal", "an exact first name"],
    ["Ul Haq", "a whole token of a member's name"],
    ["Davide", "an exact first name with a surname on record"],
    ["my dad Najib", "a member's first name inside a longer reference"],
  ])("'%s' (%s) with no pick resolves nobody: it is an ambiguity, never a guess", (ref) => {
    const r = resolvePerson(ref, roster, undefined);
    expect(r.kind).toBe("ambiguous");
  });

  it("an empty pick map is the same: nobody was asked, so nobody is resolved", () => {
    expect(resolvePerson("Kemal", roster, new Map()).kind).toBe("ambiguous");
  });
});

describe("what stays code's: the reference itself", () => {
  it("refuses raw @lid digits (2026-05-05, Izzet/Elnur, a5a150a), whatever the pick", () => {
    const r = resolvePerson("158055467598020", roster, picks([["158055467598020", { kind: "member", userId: "u-kemal" }]]));
    expect(r.kind).toBe("not-a-person");
  });

  it("refuses an empty reference and one with no letters", () => {
    expect(resolvePerson("", roster, undefined).kind).toBe("not-a-person");
    expect(resolvePerson("  @ ", roster, undefined).kind).toBe("not-a-person");
    expect(resolvePerson("12", roster, undefined).kind).toBe("not-a-person");
  });

  it("a non-Latin name is still a name (the pick decides who)", () => {
    const r = resolvePerson("Айдын", roster, picks([["Айдын", { kind: "member", userId: "u-aydin" }]]));
    expect(r).toMatchObject({ kind: "resolved", member: { userId: "u-aydin" } });
  });
});
