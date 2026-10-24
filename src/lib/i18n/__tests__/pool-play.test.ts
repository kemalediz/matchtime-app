/**
 * The player pool pages' words (slice L2): house rules, Turkish really
 * translated, the numbers from rules.ts, and a message for every error the
 * validator can name.
 */
import { describe, expect, it } from "vitest";
import { fieldErrorKeys, POOL_PAGE_FACTS, poolPageCopy } from "../../pool/page-copy";
import { POOL_CAPS, POOL_MIN_AGE, POOL_QUIET_HOURS } from "../../pool/rules";
import type { PoolPlayCopy } from "../pool-play";

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
      expect(c.signup.consentLabel).toContain(String(POOL_CAPS.perPlayerPerWeek));
      expect(c.signup.howItWorks.join(" ")).toContain(POOL_QUIET_HOURS.from);
      expect(c.fields.dayNames).toHaveLength(7);
    });
  }
});

describe("every error the validator names has words", () => {
  it("maps each code to a message in both languages", () => {
    const codes = {
      name: ["required"],
      area: ["required", "district", "venues"],
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
