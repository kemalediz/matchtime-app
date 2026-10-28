/**
 * "Find a setting" on /admin/settings (2026-10-28): a static index of the
 * cards, searched by title and keywords in English and Turkish, whatever
 * the club's language. It searches settings, never anybody's messages.
 */
import { describe, expect, it } from "vitest";
import { SETTINGS_CARDS } from "../settings-anchors";
import { SETTINGS_INDEX, foldForSearch, searchSettings } from "../settings-search";

const ids = (q: string, lang = "en") => searchSettings(q, lang).map((r) => r.id);

describe("the settings index", () => {
  it("has every card once, with a title in both languages", () => {
    expect(SETTINGS_INDEX.map((e) => e.id).sort()).toEqual(SETTINGS_CARDS.map((c) => c.id).sort());
    for (const e of SETTINGS_INDEX) {
      expect(e.title.en, e.id).toBeTruthy();
      expect(e.title.tr, e.id).toBeTruthy();
      expect(e.title.tr, e.id).not.toBe(e.title.en);
    }
  });
});

describe("searchSettings", () => {
  it("'pool' and 'havuz' find Player pool first, in either language", () => {
    expect(ids("pool")[0]).toBe("player-pool");
    expect(ids("havuz")[0]).toBe("player-pool");
    expect(ids("pool", "tr")[0]).toBe("player-pool");
    expect(ids("havuz", "tr")[0]).toBe("player-pool");
    // The other pool cards come too.
    expect(ids("pool")).toEqual(expect.arrayContaining(["pool-auto-ask", "pool-club-share"]));
  });

  it("finds by keyword as well as title", () => {
    expect(ids("quiet")).toContain("quiet-hours");
    expect(ids("sessiz")).toContain("quiet-hours");
    expect(ids("stripe")).toContain("payments");
    expect(ids("bank")).toContain("payments");
    expect(ids("rolling squad")).toContain("weekly-routine");
    expect(ids("kadro devam")).toContain("weekly-routine");
    expect(ids("bench")[0]).toBe("bench");
    expect(ids("yedek")[0]).toBe("bench");
    expect(ids("motm")).toContain("mom");
    expect(ids("poster")[0]).toBe("posters");
    expect(ids("admin group")[0]).toBe("admin-group");
  });

  it("Turkish letters typed without their marks still match, and case does not matter", () => {
    expect(ids("SESSIZ SAATLER")).toContain("quiet-hours");
    expect(ids("odemeler")).toContain("payments");
    expect(foldForSearch("Işık İĞÜŞÖÇ")).toBe("isik igusoc");
  });

  it("every word must match; nothing for nonsense or an empty box", () => {
    expect(ids("pool zzzz")).toEqual([]);
    expect(ids("zzzz")).toEqual([]);
    expect(ids("")).toEqual([]);
    expect(ids("   ")).toEqual([]);
  });

  it("a result carries its tab and its title in the club's language", () => {
    const [first] = searchSettings("pool", "tr");
    expect(first).toMatchObject({ id: "player-pool", tab: "finding", title: "Oyuncu havuzu" });
    expect(searchSettings("pool", "en")[0].title).toBe("Player pool");
  });

  it("only cards that are on the page, when told which are", () => {
    expect(searchSettings("pool", "en", new Set(["pool-auto-ask"])).map((r) => r.id)).toEqual(["pool-auto-ask"]);
  });
});
