/**
 * The player pool pages' words (slice L2): house rules, Turkish really
 * translated, the numbers from rules.ts, and a message for every error the
 * validator can name.
 */
import { describe, expect, it } from "vitest";
import { fieldErrorKeys, POOL_PAGE_FACTS, poolPageCopy } from "../../pool/page-copy";
import { POOL_CAPS, POOL_MIN_AGE, POOL_QUIET_HOURS } from "../../pool/rules";
import type { PoolPlayCopy } from "../pool-play";
import { perWeekEn } from "../pool-play.en";
import { perWeekTr } from "../pool-play.tr";

/** Every rendered line, by path (functions called with sample values). */
function leaves(v: unknown, path = ""): Array<{ path: string; text: string }> {
  if (typeof v === "string") return [{ path, text: v }];
  if (typeof v === "function") return [{ path, text: String((v as (...a: unknown[]) => string)("Sampleword", 7)) }];
  if (Array.isArray(v)) return v.flatMap((x, i) => leaves(x, `${path}[${i}]`));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => leaves(x, path ? `${path}.${k}` : k));
  return [];
}

const EN = poolPageCopy("en");
const TR = poolPageCopy("tr");
const ALL = [...leaves(EN).map((l) => ({ ...l, lang: "en" })), ...leaves(TR).map((l) => ({ ...l, lang: "tr" }))];

describe("house rules, both languages", () => {
  it("has copy", () => expect(ALL.length).toBeGreaterThan(150));
  it("no em or en dash", () => expect(ALL.filter((l) => /[—–]/.test(l.text))).toEqual([]));
  it("no slash as a separator", () => expect(ALL.filter((l) => /\//.test(l.text))).toEqual([]));
  it("early sign-up list, never a waiting list", () => {
    expect(ALL.filter((l) => /waiting list|bekleme listesi/i.test(l.text))).toEqual([]);
    expect(EN.signup.earlyNote).toContain("early sign-up list");
    expect(TR.signup.earlyNote).toContain("erken kayıt listesi");
  });
  it("the open pool's note never mentions the early sign-up list", () => {
    expect(EN.signup.openNote).toBe("The pool is opening town by town. Sign up now and MatchTime can message you when a club near you needs a player.");
    expect(TR.signup.openNote).not.toMatch(/erken/i);
    expect(EN.signup.openNote).not.toMatch(/early/i);
  });
  it("never empty", () => expect(ALL.filter((l) => !l.text.trim())).toEqual([]));
});

describe("Turkish is translated, line by line", () => {
  it("no Turkish line is the English line", () => {
    const en = new Map(leaves(EN).map((l) => [l.path, l.text]));
    const same = leaves(TR).filter((l) => en.get(l.path) === l.text && !/^\d|^Sampleword$/.test(l.text));
    expect(same).toEqual([]);
  });
  it("the same shape in both", () => {
    expect(leaves(TR).map((l) => l.path)).toEqual(leaves(EN).map((l) => l.path));
  });
});

describe("the numbers come from rules.ts", () => {
  it("the facts", () => {
    expect(POOL_PAGE_FACTS).toMatchObject({ minAge: POOL_MIN_AGE, perWeek: POOL_CAPS.perPlayerPerWeek, quietFrom: POOL_QUIET_HOURS.from });
  });
  for (const [lang, c] of [["en", EN], ["tr", TR]] as Array<[string, PoolPlayCopy]>) {
    it(`${lang}: the age, the weekly cap and the quiet hours`, () => {
      expect(c.signup.adultLabel).toContain(String(POOL_MIN_AGE));
      expect(c.signup.consentLabel).toContain(lang === "en" ? perWeekEn(POOL_CAPS.perPlayerPerWeek) : perWeekTr(POOL_CAPS.perPlayerPerWeek));
      expect(c.fields.dayNames).toHaveLength(7);
    });
  }
});

describe("every error the validator names has words", () => {
  it("maps each code to a message in both languages", () => {
    const codes = {
      name: ["required"],
      area: ["required", "district"],
      maxMiles: ["invalid"],
      availability: ["none", "bad-day", "bad-time", "bad-range", "too-many"],
      sports: ["none", "bad-sport", "other-needs-name", "bad-format", "bad-level", "duplicate", "too-many"],
      adult: ["required"],
      consent: ["required"],
    } as const;
    for (const [field, list] of Object.entries(codes)) {
      for (const code of list) {
        const key = fieldErrorKeys({ [field]: code } as never)[field as keyof typeof codes];
        expect(key, `${field}:${code}`).toBeTruthy();
        expect(EN.errors[key!], `${field}:${code}`).toBeTruthy();
        expect(TR.errors[key!], `${field}:${code}`).toBeTruthy();
      }
    }
  });
});

/**
 * /play is short before the first field (Kemal, 2026-10-27): a headline,
 * three very short lines, then the form. The weekly limit lives in the
 * consent tick only, said in words ("twice a week"); the "never your number
 * here" line and the quiet hours are not on the page.
 */
describe("/play gets to the first field fast", () => {
  it("the weekly limit in words", () => {
    expect(perWeekEn(1)).toBe("once a week");
    expect(perWeekEn(2)).toBe("twice a week");
    expect(perWeekEn(3)).toBe("3 times a week");
    expect(perWeekTr(1)).toBe("haftada en fazla bir kez");
    expect(perWeekTr(2)).toBe("haftada en fazla iki kez");
    expect(perWeekTr(5)).toBe("haftada en fazla 5 kez");
  });
  it("the consent tick says it, in English as Kemal asked", () => {
    expect(POOL_CAPS.perPlayerPerWeek).toBe(2);
    expect(EN.signup.consentLabel).toBe("MatchTime may message me on WhatsApp about games near me, at most twice a week. I can stop this at any time.");
    expect(TR.signup.consentLabel).toBe("MatchTime yakınımdaki maçlar hakkında bana WhatsApp'tan, haftada en fazla iki kez yazabilir. Bunu istediğim zaman durdurabilirim.");
    expect(EN.manage.restartConsent).toBe(EN.signup.consentLabel);
    expect(TR.manage.restartConsent).toBe(TR.signup.consentLabel);
  });
  for (const [lang, c] of [["en", EN], ["tr", TR]] as Array<[string, PoolPlayCopy]>) {
    const above = [c.signup.heading, ...c.signup.howItWorks, c.signup.earlyShort].join(" ");
    it(`${lang}: nothing above the form repeats the limit, the quiet hours or the number line`, () => {
      expect(above).not.toContain(String(POOL_CAPS.perPlayerPerWeek));
      expect(above).not.toMatch(/twice|a week|haftada/i);
      expect(above).not.toContain(POOL_QUIET_HOURS.from);
      expect(above).not.toContain(POOL_QUIET_HOURS.to);
      expect(above).not.toMatch(/phone number|never ask|telefon numaran|asla sormay/i);
    });
    it(`${lang}: a short headline and at most three very short lines`, () => {
      expect(c.signup.heading.length).toBeLessThanOrEqual(30);
      expect(c.signup.howItWorks.length).toBeLessThanOrEqual(3);
      for (const line of c.signup.howItWorks) expect(line.length).toBeLessThanOrEqual(90);
      expect(c.signup.earlyShort.length).toBeLessThanOrEqual(110);
    });
  }
  it("the word free is never on the page", () => {
    expect(ALL.filter((l) => /\bfree\b|ücretsiz|bedava/i.test(l.text))).toEqual([]);
  });
});
