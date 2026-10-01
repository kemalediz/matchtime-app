/**
 * Self-join copy approved by Kemal on 2026-10-01:
 *   1. Both organiser DMs say MatchTime stays quiet "until your club is
 *      approved, usually within a day" and messages them "when it's live".
 *   2. The group hello is the full feature intro, modelled on onbIntro,
 *      minus the consent question and the setup questions.
 *   3. The "you're live" DM is a short organiser checklist with a link per
 *      item, the help-by-DM line and "Your first month is free."
 * Pure strings, EN and TR. No DB, no model.
 */
import { describe, expect, it } from "vitest";
import { t } from "@/lib/i18n/t";

const en = t("en");
const tr = t("tr");
const LINKS = {
  scheduleUrl: "https://matchtime.ai/l/sched",
  ratingsUrl: "https://matchtime.ai/l/rate",
  settingsUrl: "https://matchtime.ai/l/set",
};

describe("stay quiet until your club is approved (both organiser DMs, the card)", () => {
  it("EN: the connect reply and the in-group ack share the wording", () => {
    const connected = en.sj_dm_connected({ name: "Ali", club: "Riverside FC" });
    expect(connected.endsWith(
      "I'll stay quiet in the group until your club is approved, usually within a day. I'll message you here when it's live.",
    )).toBe(true);
    expect(en.sj_dm_in_group({ group: "Riverside Tuesday 5s" })).toBe(
      "Thanks, I'm in \"Riverside Tuesday 5s\". I'll stay quiet there until your club is approved, usually within a day. I'll message you here when it's live.",
    );
    expect(en.sj_dm_in_group({ group: null })).toBe(
      "Thanks, I'm in your group. I'll stay quiet there until your club is approved, usually within a day. I'll message you here when it's live.",
    );
    expect(en.sj_card_pending).toMatch(/until your club is approved/);
  });

  it("TR: the same sense in both DMs and on the card", () => {
    const quiet = "Kulübünüz onaylanana kadar";
    expect(tr.sj_dm_connected({ name: "Ayşe", club: "Kartallar" })).toContain(`${quiet} grupta sessiz kalacağım, genellikle bir gün içinde. Yayına geçince size buradan yazacağım.`);
    expect(tr.sj_dm_in_group({ group: "Cuma Halı Saha" })).toBe(
      `Teşekkürler, "Cuma Halı Saha" grubuna katıldım. ${quiet} orada sessiz kalacağım, genellikle bir gün içinde. Yayına geçince size buradan yazacağım.`,
    );
    expect(tr.sj_card_pending).toContain("onaylanana kadar");
  });

  it("no old 'switch you on' phrasing remains", () => {
    for (const s of [en.sj_dm_connected({ name: null, club: "X" }), en.sj_dm_in_group({ group: null }), en.sj_card_pending]) {
      expect(s).not.toMatch(/switch(ed)? (it|you) on/);
    }
  });
});

describe("sj_group_hello: the full intro for an approved group", () => {
  for (const [lang, s, inWord, help] of [
    ["en", en, "*In*", "*@Match Time help*"],
    ["tr", tr, "*VARIM*", "*@Match Time yardım*"],
  ] as const) {
    const named = s.sj_group_hello({ organiser: "Ali" });
    const anon = s.sj_group_hello({ organiser: null });

    it(`${lang}: names who set it up, or reads well without a name`, () => {
      expect(named).toContain("Ali");
      expect(named).toContain("MatchTime");
      expect(anon).not.toContain("null");
    });

    it(`${lang}: one readable WhatsApp message, no dashes, no consent or setup question`, () => {
      for (const h of [named, anon]) {
        expect(h.length).toBeLessThan(1200);
        expect(h).not.toMatch(/[—–]/);
        expect(h).not.toMatch(/\*YES\*|\*EVET\*/);
        expect(h).not.toMatch(/when and where|ne zaman ve nerede/i);
      }
    });

    it(`${lang}: In in bold and the help tag`, () => {
      expect(named).toContain(inWord);
      expect(named).toContain(help);
    });
  }

  it("en: every feature line, and payments only as something the organiser can switch on", () => {
    const h = en.sj_group_hello({ organiser: "Ali" });
    expect(h).toContain("Ali has set me up to run this group's games.");
    for (const f of ["bench", `"@Match Time remind me Thursday"`, "I'll DM you then", "teams", "Man of the Match", "ratings", "stats page"]) {
      expect(h).toContain(f);
    }
    expect(h).toContain("💷 *Match fees:* your organiser can switch on card or bank pay links.");
  });

  it("tr: every feature line, and payments only as something the organiser can switch on", () => {
    const h = tr.sj_group_hello({ organiser: "Ayşe" });
    for (const f of ["Yedekler", `"@Match Time perşembe hatırlat"`, "takımlar", "Maçın oyuncusu", "puanlar", "istatistik"]) {
      expect(h).toContain(f);
    }
    expect(h).toContain("💷 *Maç ücretleri:* organizatörünüz isterse kart ya da banka ile ödeme bağlantılarını açabilir.");
  });
});

describe("sj_dm_approved: the organiser's checklist", () => {
  for (const [lang, s, free, helpWords] of [
    ["en", en, "Your first month is free.", ["*help payments*", "*help badges*"]],
    ["tr", tr, "İlk ayınız ücretsiz.", ["*yardım ödeme*", "*yardım rozetler*"]],
  ] as const) {
    const dm = s.sj_dm_approved({ club: "Riverside FC", group: "Riverside Tuesday 5s", ...LINKS });

    it(`${lang}: each link on its own line, the help line, the one pricing sentence last`, () => {
      for (const url of Object.values(LINKS)) expect(dm).toContain(`\n${url}\n`);
      for (const w of helpWords) expect(dm).toContain(w);
      expect(dm.endsWith(free)).toBe(true);
      expect(dm).not.toMatch(/£|\d+[.,]\d\d|TL|€/);
      expect(dm).not.toMatch(/[—–]/);
      expect(dm).toContain("Riverside FC");
      expect(dm).toContain('"Riverside Tuesday 5s"');
    });

    it(`${lang}: reads well without a group name`, () => {
      const anon = s.sj_dm_approved({ club: "Riverside FC", group: null, ...LINKS });
      expect(anon).not.toContain("null");
      expect(anon).not.toContain('""');
    });
  }

  it("en: the settings line names every switch Kemal listed", () => {
    const dm = en.sj_dm_approved({ club: "Riverside FC", group: null, ...LINKS });
    for (const f of ["payments", "rolling squad", "weekly deadlines", "admin messages", "organiser picks", "badge announcements"]) {
      expect(dm).toContain(f);
    }
    expect(dm).toMatch(/starting ratings/i);
    expect(dm).toMatch(/weekly game/i);
  });
});
