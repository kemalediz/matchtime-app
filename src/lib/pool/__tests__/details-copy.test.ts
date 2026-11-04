/**
 * The words of the pool's question about his times and formats (2026-11-04):
 * the welcome's question, the one later question, the saved line and the
 * re-ask, in English and Turkish, with the house rules. Pure.
 */
import { describe, expect, it } from "vitest";
import { poolDetailsCopy, type PoolDetailsCopy } from "@/lib/i18n/pool-details";
import { poolDetailsAskText, poolDetailsQuestion, poolDetailsReaskText, poolDetailsSavedText, poolWelcomeText } from "../copy";

const LINK = "https://matchtime.ai/r/MANAGE";

describe("the house rules, both languages", () => {
  const all = (lang: "en" | "tr") => {
    const c: PoolDetailsCopy = poolDetailsCopy(lang);
    return [
      c.question({ days: "D", formats: "F" }),
      c.ask({ name: "Ali", days: "D", formats: "F", manageLink: LINK }),
      c.ask({ name: null, days: "D", formats: "F", manageLink: LINK }),
      c.saved({ days: "D", formats: "F", manageLink: LINK }),
      c.reask({ manageLink: LINK }),
      c.dayAnyTime("X"),
      c.dayRanges("X", "R"),
      c.range("19:00", "22:00", false),
      c.range("19:00", "24:00", true),
      c.formatsSaved("5"),
      c.anyFormat,
      c.formatsChoice("5"),
    ];
  };
  it("no em or en dash, no slash as a separator, never waiting list, no greeting", () => {
    for (const lang of ["en", "tr"] as const) {
      for (const s of all(lang)) {
        expect(s).not.toMatch(/[—–]/);
        expect(s.replace(/https?:\/\/\S+/g, "")).not.toMatch(/\//);
        expect(s.toLowerCase()).not.toMatch(/waiting list|bekleme listesi/);
        expect(s).not.toMatch(/^(hi|hello|hey|merhaba|selam)\b/i);
      }
    }
  });
  it("Turkish is never the English", () => {
    const en = all("en");
    all("tr").forEach((s, i) => {
      if (!["X R"].includes(s)) expect(s).not.toBe(en[i]);
    });
  });
});

describe("the question in the welcome", () => {
  it("names his days, Monday first, and the formats football has", () => {
    const en = poolDetailsQuestion("en", [6, 2]);
    expect(en).toContain("what times can you play on Tuesday and Saturday?");
    expect(en).toContain("5, 7, 8, 9 or 11-a-side");
    expect(en).toContain("any time on those days and any format counts as fine");
    const tr = poolDetailsQuestion("tr", [6, 2]);
    expect(tr).toContain("Salı ve Cumartesi günleri hangi saatlerde oynayabilirsin?");
    expect(tr).toContain("5, 7, 8, 9 ya da 11 kişilik");
  });
  it("goes in the welcome after its first paragraph, only when given", () => {
    const q = poolDetailsQuestion("en", [2]);
    const with_ = poolWelcomeText("en", { displayName: "Ali Kaya", earlyList: false, manageLink: LINK, details: q });
    const paras = with_.split("\n\n");
    expect(paras[0]).toMatch(/^✅ Thanks Ali, you're in the MatchTime player pool/);
    expect(paras[1]).toBe(q);
    expect(paras[2]).toMatch(/^Stay safe/);
    expect(poolWelcomeText("en", { displayName: "Ali", earlyList: false, manageLink: LINK })).not.toContain("what times");
    const early = poolWelcomeText("tr", { displayName: "Ali", earlyList: true, manageLink: LINK, details: poolDetailsQuestion("tr", [2]) });
    expect(early.split("\n\n")[1]).toMatch(/^Sana uygun maçları/);
  });
});

describe("the one later question", () => {
  it("names him and his days, says he need not answer, and carries his link", () => {
    const en = poolDetailsAskText("en", { displayName: "Ali Kaya", days: [2, 6], manageLink: LINK });
    expect(en).toMatch(/^Ali, one quick question/);
    expect(en).toContain("Tuesday and Saturday");
    expect(en).toContain("I won't ask again");
    expect(en).toContain(LINK);
    expect(poolDetailsAskText("tr", { displayName: "", days: [2], manageLink: LINK })).toMatch(/^Sana uygun maçları göndermem için kısa bir soru: Salı günleri/);
  });
});

describe("the saved line", () => {
  it("says what is saved, Monday first, in plain words", () => {
    const summary = {
      days: [
        { day: 2, any: false, ranges: [{ from: "19:00", to: "24:00" }] },
        { day: 4, any: false, ranges: [{ from: "18:00", to: "22:00" }] },
        { day: 6, any: true, ranges: [] },
      ],
      formats: [5, 7],
    };
    expect(poolDetailsSavedText("en", summary, LINK)).toBe(
      `✅ Got it, saved: Tuesday from 19:00, Thursday 18:00 to 22:00 and Saturday any time. Formats: 5 and 7-a-side.\n\nTo change them, just message me here in your own words, or use your page: ${LINK}`,
    );
    expect(poolDetailsSavedText("tr", summary, LINK)).toContain("Salı 19:00 ve sonrası, Perşembe 18:00 ile 22:00 arası ve Cumartesi her saat. Formatlar: 5 ve 7 kişilik.");
  });
  it("no formats is any format", () => {
    expect(poolDetailsSavedText("en", { days: [{ day: 2, any: true, ranges: [] }], formats: [] }, LINK)).toContain("Formats: any format.");
  });
});

describe("the re-ask", () => {
  it("is one line with an example and his link", () => {
    expect(poolDetailsReaskText("en", LINK)).toMatch(/^Sorry, I didn't quite get that\./);
    expect(poolDetailsReaskText("tr", LINK)).toMatch(/^Kusura bakma/);
  });
});
