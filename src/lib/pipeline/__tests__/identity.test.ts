/**
 * Identity resolution — §9's "SURVIVES" column, as pure code.
 *
 * These guards were never about the model's competence, so they do not
 * die with the mega-prompt. What changes is that they run on a
 * `personRef` quoted verbatim from the message, before anything can
 * write, and that an ambiguity BAILS instead of picking one.
 */
import { describe, it, expect } from "vitest";
import { isRawDigitName, resolvePerson } from "../identity";
import { member } from "./helpers";

const roster = [
  member("kemal"),
  member("habib"),
  member("najib"),
  member("ehtisham"),
  member("aydin"),
  member("zair"),
];

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

describe("resolvePerson", () => {
  it("resolves an exact full name", () => {
    const r = resolvePerson("Zair Malik", roster);
    expect(r).toMatchObject({ kind: "resolved" });
  });

  it("resolves a first name", () => {
    const r = resolvePerson("Najib", roster);
    expect(r.kind === "resolved" && r.member.name).toBe("Najib Ahmadi");
  });

  it("resolves a near miss: 'habibi' → Habib Rahman (S12's real wording)", () => {
    const r = resolvePerson("habibi", roster);
    expect(r.kind === "resolved" && r.member.name).toBe("Habib Rahman");
  });

  it("resolves through a middle token: 'Ul Haq' → Ehtisham Ul Haq", () => {
    const r = resolvePerson("Ul Haq", roster);
    expect(r.kind === "resolved" && r.member.name).toBe("Ehtisham Ul Haq");
  });

  it("strips accents: 'Aydın' → Aydin Celik", () => {
    const r = resolvePerson("Aydın", roster);
    expect(r.kind === "resolved" && r.member.name).toBe("Aydin Celik");
  });

  it("refuses raw @lid digits (2026-05-05, Izzet/Elnur, a5a150a)", () => {
    const r = resolvePerson("@158055467598020", roster);
    expect(r).toMatchObject({ kind: "not-a-person" });
  });

  it("reads no meaning off words: whether a ref is a relationship is the extractor's personNamed (2026-10-30)", () => {
    for (const ref of ["my brother", "everyone", "lads"]) {
      expect(resolvePerson(ref, roster).kind, ref).not.toBe("not-a-person");
    }
  });

  it("BAILS on ambiguity rather than guessing", () => {
    const two = [...roster, member("najib2", { name: "Najib Khan" })];
    const r = resolvePerson("Najib", two);
    expect(r.kind).toBe("ambiguous");
  });

  it("reports an unfamiliar but usable name as unknown, not resolved", () => {
    const r = resolvePerson("Shahrokh", roster);
    expect(r).toMatchObject({ kind: "unknown", name: "Shahrokh" });
  });

  it("does not let a two-letter fragment match a real member", () => {
    expect(resolvePerson("Za", roster).kind).toBe("unknown");
  });
});

// ── Found by an adversarial review of this branch (2026-09-01) ─────────

describe("nearMiss must not resolve a DIFFERENT person", () => {
  const squad = [
    member("samir", { name: "Samir Khan" }),
    member("hasanali", { name: "Hasanali Zaidi" }),
    member("habib", { name: "Habib Rahimi" }),
  ];

  it.each([
    // Ordinary first names that merely SHARE A PREFIX with a member.
    // A tagged "Sami is out" about a guest called Sami used to drop
    // Samir Khan; "Sami's in" used to register Samir instead of asking
    // for the guest's name.
    ["Sami", "Samir Khan"],
    ["Hasan", "Hasanali Zaidi"],
    ["Sam", "Samir Khan"],
  ])("%s does not resolve to %s", (ref) => {
    expect(resolvePerson(ref, squad).kind).toBe("unknown");
  });

  it("still resolves a one-or-two-character near miss", () => {
    // "habibi" → "Habib Rahimi" is the real S12 message and must survive.
    const r = resolvePerson("habibi", squad);
    expect(r.kind === "resolved" && r.member.name).toBe("Habib Rahimi");
  });
});

describe("a member named with a relationship prefix is not a new person", () => {
  it("'my dad Najib' resolves to Najib, it does not provision a duplicate", () => {
    // §6.2's own worked example. `firstToken("my dad Najib")` is "my",
    // so every lookup missed and the engine provisioned a second member
    // literally called "my dad Najib" beside the real one.
    const squad = [member("najib", { name: "Najib Ali" }), member("kemal")];
    const r = resolvePerson("my dad Najib", squad);
    expect(r.kind === "resolved" && r.member.name).toBe("Najib Ali");
  });

  it("bails rather than guessing when two tokens both match", () => {
    const squad = [member("najib", { name: "Najib Ali" }), member("ali", { name: "Ali Reza" })];
    expect(resolvePerson("Najib Ali", squad).kind).toBe("resolved");
    expect(resolvePerson("my mate Najib or Ali", squad).kind).toBe("ambiguous");
  });
});

