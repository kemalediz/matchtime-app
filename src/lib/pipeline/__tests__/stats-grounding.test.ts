/**
 * THE GROUNDING CHECK (2026-09-23; the unified answer's since 2026-11-10).
 *
 * Wherever a model writes stats text for the group. Kemal's rule: every name and every number in its reply must
 * appear in the tables it was given. A reply that fails is MatchTime's
 * own error, and the group gets the exact table or a safe line instead,
 * never a question about it.
 */
import { describe, expect, it } from "vitest";
import { groundingCheck, membersNamed } from "../stats-grounding";
import type { Member } from "../types";

const m = (userId: string, name: string): Member => ({ userId, name, isAdmin: false, hasPhone: true });
const ROSTER: Member[] = [
  m("u-idris", "Idris Bello"),
  m("u-kemal", "Kemal Ediz"),
  m("u-sait", "Sait Demir"),
  m("u-zeeshan", "Zeeshan Khan"),
  m("u-abid", "Abid Hussain"),
];

/** What a stats context grounds a reply in: the names and the numbers it
 *  printed (the deleted generic stats answer's tables, 2026-09-23; the
 *  unified answer builds the same shape from its whole context). Idris's
 *  nemesis is not in it: it was never supplied. */
const GROUNDING = {
  names: ["Sait Demir", "Idris Bello", "Kemal Ediz"],
  numbers: ["7.8", "7,8", "9", "7.4", "7,4", "6", "4", "1042", "12", "5", "7"],
};
const check = (reply: string, question = "@Match Time who is on fire?") =>
  groundingCheck({ reply, question, grounding: GROUNDING, roster: ROSTER });

describe("a grounded reply passes", () => {
  it("names and numbers copied from the tables", () => {
    expect(check("Sait Demir is top on 7.8 from 9 matches, and has 4 Man of the Match wins.")).toEqual({ ok: true });
  });
  it("a first name alone, and a Turkish suffix on it", () => {
    expect(check("Sait 7,8 ile zirvede, Idris'in ortalaması 7,4.")).toEqual({ ok: true });
  });
  it("a number the question itself asked for", () => {
    expect(check("Here are the top 5: Sait Demir 7.8, Idris Bello 7.4.", "@Match Time top 5 please")).toEqual({ ok: true });
  });
});

describe("an ungrounded reply is rejected", () => {
  it("a number that is not in the tables", () => {
    expect(check("Sait Demir averages 8.1.").ok).toBe(false);
  });
  it("a squad member who is not in the tables", () => {
    const r = check("Abid Hussain is the one to watch.");
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.why).toMatch(/Abid/);
  });
  it("a member mentioned only by a Turkish suffixed first name", () => {
    expect(check("Abid'in formu harika.").ok).toBe(false);
  });
  it("a number written as a word", () => {
    expect(check("Sait Demir has won it four times.").ok).toBe(false);
    expect(check("Sait dört kez maçın adamı oldu.").ok).toBe(false);
  });
  it("another player's nemesis cannot pass, because it was never supplied", () => {
    expect(check("Idris struggles against Zeeshan Khan.", "@Match Time Idris?").ok).toBe(false);
  });
  it("the model's own 'cannot answer' marker", () => {
    expect(check("NO_ANSWER").ok).toBe(false);
  });
  it("an empty reply", () => {
    expect(check("   ").ok).toBe(false);
  });
});

/**
 * UNIFIED_ANSWERS round 2 (2026-11-11). FNF's players' group, "who are on
 * the bench?": the unified answer was refused for the word "once" ("once a
 * place opens"), so the asker got nothing. The check is fixed, not the word:
 * with `numberWords: "check"` a number word is checked as the number it
 * stands for, like a digit. The generic stats answer keeps "refuse".
 */
describe("number words checked as their value (numberWords: check)", () => {
  const grounding = { names: [], numbers: ["1", "3", "11"] };
  const check = (reply: string) => groundingCheck({ reply, question: "", grounding, roster: ROSTER, numberWords: "check" });

  it("passes a number word whose value is in the context, 'once' included", () => {
    expect(check("Once a place opens, the first on the bench moves up.")).toEqual({ ok: true });
    expect(check("Eleven places left.")).toEqual({ ok: true });
    expect(check("Üç kişi yedekte.")).toEqual({ ok: true });
  });

  it("refuses a number word whose value is not, as it refuses a digit", () => {
    const r = check("Twelve places left.");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.why).toMatch(/twelve/i);
    expect(check("12 places left.").ok).toBe(false);
  });

  it("by default a number word is still refused outright (the generic stats answer)", () => {
    const r = groundingCheck({ reply: "Once a place opens.", question: "", grounding, roster: ROSTER });
    expect(r).toMatchObject({ ok: false, why: expect.stringMatching(/number written as a word/) });
  });
});

describe("membersNamed: who a reply names, by full or first name", () => {
  it("full names and unique first names, never a shared first name or a short one", () => {
    const named = membersNamed("Sait and Idris Bello are in, so is Ab.", ROSTER);
    expect([...named].sort()).toEqual(["u-idris", "u-sait"]);
  });
});
