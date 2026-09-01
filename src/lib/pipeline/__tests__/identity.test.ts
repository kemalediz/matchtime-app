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

  it("refuses a relationship (2026-08-30, 'Amir's brother' 6/6)", () => {
    for (const ref of ["my brother", "Amir's brother", "2 of my guys", "someone"]) {
      expect(resolvePerson(ref, roster).kind, ref).toBe("not-a-person");
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
