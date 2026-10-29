/**
 * Monthly squad set-up copy (2026-10-29): both languages, every key, and
 * the house rules, for every string and every rendering of every builder.
 */
import { describe, expect, it } from "vitest";
import { monthSetupEn } from "../month-setup.en";
import { MONTH_SETUP_TABLES, monthSetupCopy } from "../month-setup";

const KEYS = Object.keys(monthSetupEn) as Array<keyof typeof monthSetupEn>;

/** Every rendering a page or a message can show. */
function renderings(table: (typeof MONTH_SETUP_TABLES)["en"]): string[] {
  const out: string[] = [];
  const P = {
    month: "November",
    link: "https://matchtime.example/admin/months",
    games: 4,
    of: 5,
    count: 2,
    names: "Davide, Steff",
    unknown: "Zed",
    day: "Mon 2 Nov",
  };
  for (const k of KEYS) {
    const v = table[k] as unknown;
    if (typeof v === "string") out.push(v);
    else if (typeof v === "function") {
      const f = v as (p: Record<string, unknown>) => string;
      for (const extra of [{ inGroup: true }, { inGroup: false }, { unknown: null }, { count: 1 }]) {
        for (const key of ["more-than-the-month", "bad-games", "locked", "not-a-regular", "month-exists", "bad-months", "already-started", "failed"]) {
          out.push(f({ ...P, ...extra, key }));
        }
      }
    }
  }
  return out;
}

describe("month set-up copy", () => {
  it("every key in every table", () => {
    for (const table of Object.values(MONTH_SETUP_TABLES)) expect(Object.keys(table).sort()).toEqual([...KEYS].sort());
  });

  it("Turkish is never the English", () => {
    const en = renderings(MONTH_SETUP_TABLES.en);
    const tr = renderings(MONTH_SETUP_TABLES.tr);
    expect(tr.filter((s, i) => s === en[i] && s.length > 3)).toEqual([]);
  });

  it("house rules: no em or en dash, no slash between words, no waiting list", () => {
    for (const table of Object.values(MONTH_SETUP_TABLES)) {
      for (const s of renderings(table)) {
        expect(s).not.toMatch(/[–—]/);
        // A link is the only slash.
        expect(s.replace(/https?:\/\/\S+/g, "")).not.toMatch(/\//);
        expect(s).not.toMatch(/waiting list|bekleme listesi/i);
      }
    }
  });

  it("the held notice says what to do, and offers the admin group only where it is read", () => {
    const en = monthSetupCopy("en").held_notice({ month: "November", link: "L", inGroup: true });
    expect(en).toContain("Start November from your group's list here: L");
    expect(en).toContain("paste the list in this group");
    expect(monthSetupCopy("en").held_notice({ month: "November", link: "L", inGroup: false })).not.toContain("this group");
    expect(monthSetupCopy("tr").held_notice({ month: "Kasım", link: "L", inGroup: true })).toContain("Kasım ayını grubunuzun listesiyle buradan başlatın: L");
  });

  it("anything unknown is English", () => {
    expect(monthSetupCopy("de")).toBe(monthSetupEn);
    expect(monthSetupCopy("TR")).toBe(MONTH_SETUP_TABLES.tr);
  });
});
