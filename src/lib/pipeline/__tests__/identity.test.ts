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

  it("a bare near miss resolves nobody: 'habibi' is not Habib Rahman without the club's alias (2026-11-09)", () => {
    // S12's real wording. Since Vets 2026-11-09 ("David" read as Davide De
    // Sousa, who was then benched) a first name a letter off a member's is
    // a different name until something corroborates it.
    expect(resolvePerson("habibi", roster)).toEqual({ kind: "unknown", name: "habibi" });
  });

  it("a nickname the club set as an alias resolves exactly: 'habibi' → Habib Rahman", () => {
    const withAlias = roster.map((m) => (m.userId === "u-habib" ? { ...m, aliases: ["habibi"] } : m));
    const r = resolvePerson("habibi", withAlias);
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

  it("a one-or-two-character near miss resolves only with an agreeing surname (2026-11-09)", () => {
    expect(resolvePerson("habibi", squad).kind).toBe("unknown");
    const r = resolvePerson("habibi Rahimi", squad);
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


// ── Vets sandbox, 2026-11-03 (scenario E) ──────────────────────────────
//
// Kerem said "David Aksoy is IN" for a guest. The near miss read "David" as
// Davide (Davide Russo, already in) and nothing changed. A near miss is a
// guess about a misspelt FIRST name; when the reference also carries a
// surname and the member's surname is a different one, it is somebody else.
describe("a near miss never swallows a reference whose surname is not the member's", () => {
  const vets = [
    member("davide", { name: "Davide Russo" }),
    member("kerem", { name: "Kerem Aksoy" }),
    member("david", { name: "David Stark" }),
    member("habib", { name: "Habib Rahimi" }),
  ];
  const noDavid = vets.filter((m) => m.userId !== "u-david");

  it("'David Aksoy' is not Davide Russo: a new person, the guest, by his full name", () => {
    const r = resolvePerson("David Aksoy", noDavid);
    expect(r).toEqual({ kind: "unknown", name: "David Aksoy" });
  });

  it("'Davide Aksoy' still resolves to Davide Russo: the first name is exact, no near miss is involved", () => {
    // Pinned so the change stays inside the near miss: an exact first name
    // resolves as before, whatever follows it.
    const r = resolvePerson("Davide Aksoy", noDavid);
    expect(r.kind === "resolved" && r.member.name).toBe("Davide Russo");
  });

  it("'habibi Khan' is not Habib Rahimi", () => {
    expect(resolvePerson("habibi Khan", vets).kind).toBe("unknown");
  });

  it("'Dave' is not David Stark (four letters: too short to be a near miss)", () => {
    expect(resolvePerson("Dave", [member("david", { name: "David Stark" })]).kind).toBe("unknown");
  });

  it("'Dave Stark' is not resolved by a near miss either ('david' does not start with 'dave')", () => {
    expect(resolvePerson("Dave Stark", [member("david", { name: "David Stark" })]).kind).toBe("unknown");
  });

  // Typos that SHOULD still match: a surname corroborates them.
  it.each([
    ["habibi Rahimi", "Habib Rahimi"],
    ["Habibi R", "Habib Rahimi"],
    ["habibi rahim", "Habib Rahimi"],
    ["Davidee Russo", "Davide Russo"],
  ])("'%s' still resolves to %s", (ref, name) => {
    const r = resolvePerson(ref, noDavid);
    expect(r.kind === "resolved" && r.member.name).toBe(name);
  });

  it("a member with no surname on record cannot corroborate a near miss: 'habibi Rahimi' is not Habib (2026-11-09)", () => {
    expect(resolvePerson("habibi Rahimi", [member("habib", { name: "Habib" })]).kind).toBe("unknown");
  });

  it("a bare 'habibi' is not Habib either, and is once the club sets the alias", () => {
    expect(resolvePerson("habibi", vets).kind).toBe("unknown");
    const r = resolvePerson("habibi", [member("habib", { name: "Habib", aliases: ["habibi"] })]);
    expect(r.kind === "resolved" && r.member.name).toBe("Habib");
  });
});
