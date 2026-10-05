/**
 * F1 (2026-10-05): the organiser ⓘ popups' copy, and the finish-setup
 * wording fix ("low" read as a low-rated player).
 */
import { describe, it, expect } from "vitest";
import { en } from "../i18n/strings.en";
import { tr } from "../i18n/strings.tr";
import { FEATURE_META } from "../org-features-meta";
import { allInfoKeys, infoCopy, FEATURE_INFO, confidenceBadge, displayEvidence } from "../info-copy";

const DASH = /[—–]/;

describe("info popup copy", () => {
  const keys = allInfoKeys();

  it("defines a healthy number of popups", () => {
    expect(keys.length).toBeGreaterThanOrEqual(60);
  });

  it("every title has a body and every body has a title, in both tables", () => {
    for (const table of [en, tr] as const) {
      const rec = table as unknown as Record<string, unknown>;
      for (const k of Object.keys(rec).filter((x) => /^info_.+_(title|body)$/.test(x))) {
        const twin = k.endsWith("_title") ? k.replace(/_title$/, "_body") : k.replace(/_body$/, "_title");
        expect(rec[twin], `${k} has no ${twin}`).toBeTypeOf("string");
      }
    }
  });

  for (const lang of ["en", "tr"] as const) {
    it(`${lang}: every popup has a title and at least one paragraph, with no em or en dash`, () => {
      for (const k of keys) {
        const { title, paragraphs } = infoCopy(lang, k);
        expect(title.trim(), `${lang}.${k} title`).not.toBe("");
        expect(paragraphs.length, `${lang}.${k} body`).toBeGreaterThan(0);
        expect(title, `${lang}.${k} title`).not.toMatch(DASH);
        for (const p of paragraphs) expect(p, `${lang}.${k} body`).not.toMatch(DASH);
      }
    });

    it(`${lang}: popups stay short (a few sentences)`, () => {
      for (const k of keys) {
        const words = infoCopy(lang, k).paragraphs.join(" ").split(/\s+/).length;
        expect(words, `${lang}.${k}`).toBeLessThanOrEqual(90);
      }
    });
  }

  it("the Turkish body of every popup is translated", () => {
    for (const k of keys) {
      expect(infoCopy("tr", k).paragraphs.join(" "), k).not.toBe(infoCopy("en", k).paragraphs.join(" "));
    }
  });

  it("splits a body on blank lines into paragraphs", () => {
    expect(infoCopy("en", "st_bank").paragraphs).toHaveLength(2);
    expect(infoCopy("en", "fs_seed").paragraphs).toHaveLength(1);
  });

  it("every Bot features switch, including Badge announcements, has a popup", () => {
    for (const m of FEATURE_META) expect(FEATURE_INFO[m.key], m.key).toBeTruthy();
    expect(FEATURE_INFO.badgeAnnouncements).toBe("feat_badges");
    for (const k of Object.values(FEATURE_INFO)) expect(keys).toContain(k);
  });

  it("the seed rating copy says players never see it and that it fades as real ratings come in", () => {
    const body = infoCopy("en", "pl_seed").paragraphs.join(" ");
    expect(body).toMatch(/1 to 10/);
    expect(body).toMatch(/Players never see it/);
    expect(body).toMatch(/real ratings take over/);
  });

  it("the sign-ups close copy does not claim IN stops at the deadline", () => {
    expect(infoCopy("en", "act_deadline").paragraphs.join(" ")).toMatch(/can still say IN or OUT right up to kick-off/);
  });

  it("bulk cancel copy says cancelling is silent unless announced", () => {
    expect(infoCopy("en", "bulk_page").paragraphs.join(" ")).toMatch(/posts nothing in the group unless you tick the announce box/);
  });
});

describe("finish-setup confidence badge", () => {
  it("high, fairly sure and a guess at the existing thresholds", () => {
    expect(confidenceBadge(0.8, "en")).toMatchObject({ level: "high", label: "Confident" });
    expect(confidenceBadge(0.66, "en").level).toBe("high");
    expect(confidenceBadge(0.5, "en")).toMatchObject({ level: "med", label: "Fairly sure" });
    expect(confidenceBadge(0.33, "en").level).toBe("med");
    expect(confidenceBadge(0.1, "en")).toMatchObject({ level: "low", label: "Guess: please check" });
    expect(confidenceBadge(0, "en").level).toBe("low");
  });

  it("never shows the bare word 'low' (it read as a low-rated player)", () => {
    for (const c of [0, 0.2, 0.32]) {
      expect(confidenceBadge(c, "en").label.toLowerCase()).not.toBe("low");
      expect(confidenceBadge(c, "en").label).toMatch(/Guess/);
    }
  });

  it("reads in Turkish for a Turkish club", () => {
    expect(confidenceBadge(0.1, "tr").label).toBe("Tahmin: lütfen kontrol edin");
    expect(confidenceBadge(0.9, "tr").label).toBe("Emin");
  });

  it("is not red for a guess", () => {
    expect(confidenceBadge(0, "en").cls).not.toMatch(/red/);
  });
});

describe("finish-setup evidence note", () => {
  const NEW = "Nothing in the chat about this player, so I've set a neutral starting point.";

  it("replaces the analyser's 'no clear signal' note, whatever the dash", () => {
    expect(displayEvidence("No clear signal in chat — defaulting to neutral", "en")).toBe(NEW);
    expect(displayEvidence("No clear signal in chat - defaulting to neutral", "en")).toBe(NEW);
    expect(displayEvidence("no clear signal in the chat, defaulting to neutral.", "en")).toBe(NEW);
    expect(displayEvidence("", "en")).toBe(NEW);
    expect(displayEvidence(null, "en")).toBe(NEW);
  });

  it("keeps a real quote from the chat as written", () => {
    expect(displayEvidence("scored twice in the chat", "en")).toBe("scored twice in the chat");
  });

  it("reads in Turkish for a Turkish club", () => {
    expect(displayEvidence("No clear signal in chat — defaulting to neutral", "tr")).toBe(
      "Sohbette bu oyuncuyla ilgili bir şey yok, bu yüzden nötr bir başlangıç noktası belirledim.",
    );
  });
});
