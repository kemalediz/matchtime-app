/**
 * THE PARTNER ASK POST, SHORTER AND CATCHIER (Kemal, 2026-11-16).
 *
 * Four real asks drew no volunteer from the old three-sentence post. The
 * new one reads like a player's own shout in the group, says when the game
 * is relative to the post ("tonight", "today", "tomorrow", the day), and
 * tells players they can REPLY IN to it as well as tap the private link (a
 * quoted reply has always been routed to the ask by the post it quotes; see
 * pipeline/__tests__/engine-partner-ask.test.ts). "need N players", never
 * "N short": the number asked is the organiser's, capped at the open
 * places, so it may be less than the whole gap. The guest fee on its own
 * line whenever there is one, as the old post showed it, so nobody is
 * surprised after saying IN. No phone number but the wa.me link, in English
 * and Turkish.
 */
import { describe, expect, it } from "vitest";
import { t } from "../i18n/t";
import { askPostDay, askPostStale } from "../partner-ask-rules";

// Tue 17 Nov 2026, 21:30 London (GMT in November).
const KICKOFF = new Date("2026-11-17T21:30:00Z");
// The same Tuesday, 10:30 and 16:59 London: a daytime game.
const MORNING = new Date("2026-11-17T10:30:00Z");
const BEFORE_FIVE = new Date("2026-11-17T16:59:00Z");
const AT_FIVE = new Date("2026-11-17T17:00:00Z");
const at = (iso: string) => new Date(iso);
const LINK = "https://wa.me/447700900555?text=IN%20(ref%20PJ7E)";

const base = {
  asker: "Sutton FC",
  day: "Tue 17 Nov, 21:30",
  venue: "Goals North Cheam",
  format: "7-a-side",
  fee: null as string | null,
  link: LINK,
  prefill: "IN (ref PJ7E)",
};

describe("askPostDay: the game's day relative to the post, from the shared proximity helper", () => {
  it("the same London day, kickoff from 17:00: tonight", () => {
    expect(askPostDay("en", KICKOFF, at("2026-11-17T09:00:00Z"))).toEqual({ kind: "tonight" });
    expect(askPostDay("en", AT_FIVE, at("2026-11-17T09:00:00Z"))).toEqual({ kind: "tonight" });
  });
  it("the same London day, kickoff before 17:00: today", () => {
    expect(askPostDay("en", MORNING, at("2026-11-17T07:00:00Z"))).toEqual({ kind: "today" });
    expect(askPostDay("en", BEFORE_FIVE, at("2026-11-17T07:00:00Z"))).toEqual({ kind: "today" });
  });
  it("17:00 is London wall time: a 16:30 kickoff in British Summer Time is today", () => {
    // 15:30 UTC on a July day is 16:30 BST.
    expect(askPostDay("en", at("2026-07-14T15:30:00Z"), at("2026-07-14T07:00:00Z"))).toEqual({ kind: "today" });
    // 16:00 UTC is 17:00 BST: tonight.
    expect(askPostDay("en", at("2026-07-14T16:00:00Z"), at("2026-07-14T07:00:00Z"))).toEqual({ kind: "tonight" });
  });
  it("the day before is tomorrow, even late in the evening, whatever the kickoff hour", () => {
    expect(askPostDay("en", KICKOFF, at("2026-11-16T23:30:00Z"))).toEqual({ kind: "tomorrow" });
    expect(askPostDay("en", MORNING, at("2026-11-16T20:00:00Z"))).toEqual({ kind: "tomorrow" });
  });
  it("later in the week: the weekday, in the club's language", () => {
    expect(askPostDay("en", KICKOFF, at("2026-11-14T10:00:00Z"))).toEqual({ kind: "day", label: "Tuesday" });
    expect(askPostDay("tr", KICKOFF, at("2026-11-14T10:00:00Z"))).toEqual({ kind: "day", label: "Salı" });
  });
  it("a week or more away: the date, never a bare weekday that could be this week's", () => {
    expect(askPostDay("en", KICKOFF, at("2026-11-10T10:00:00Z"))).toEqual({ kind: "day", label: "Tue 17 Nov" });
    expect(askPostDay("tr", KICKOFF, at("2026-11-10T10:00:00Z"))).toEqual({ kind: "day", label: "17 Kasım Salı" });
  });
});

describe("askPostStale: a post built earlier is re-rendered when it goes out", () => {
  it("the same London day, within 6 hours: as built", () => {
    expect(askPostStale(at("2026-11-17T09:00:00Z"), at("2026-11-17T14:59:00Z"))).toBe(false);
  });
  it("a different London day: re-rendered, even a minute later", () => {
    expect(askPostStale(at("2026-11-16T23:59:00Z"), at("2026-11-17T00:00:00Z"))).toBe(true);
  });
  it("more than 6 hours later on the same day: re-rendered", () => {
    expect(askPostStale(at("2026-11-17T09:00:00Z"), at("2026-11-17T15:01:00Z"))).toBe(true);
  });
  it("London days, not UTC: 23:30 BST and 00:30 BST the next day are two days", () => {
    expect(askPostStale(at("2026-07-14T22:30:00Z"), at("2026-07-14T23:30:00Z"))).toBe(true);
  });
});

describe("the post in English", () => {
  const en = t("en");

  it("plural, tomorrow: the target shape, line by line", () => {
    expect(en.xask_post({ ...base, places: 6, when: { kind: "tomorrow" } })).toBe(
      [
        "⚽ *Sutton FC* need *6 players* for tomorrow!",
        "🗓 Tue 17 Nov, 21:30",
        "📍 Goals North Cheam, 7-a-side",
        `🙋 Fancy it? Reply *IN* to this message, or tap 👉 ${LINK}`,
        "🔒 MatchTime confirms with you by DM. Your number stays private.",
      ].join("\n"),
    );
  });

  it("singular, tonight", () => {
    expect(en.xask_post({ ...base, places: 1, when: { kind: "tonight" } }).split("\n")[0]).toBe("⚽ *Sutton FC* need *1 player* for tonight!");
  });

  it("a daytime game: today", () => {
    expect(en.xask_post({ ...base, places: 3, when: { kind: "today" } }).split("\n")[0]).toBe("⚽ *Sutton FC* need *3 players* for today!");
  });

  it("a later day names it", () => {
    expect(en.xask_post({ ...base, places: 2, when: { kind: "day", label: "Tuesday" } }).split("\n")[0]).toBe("⚽ *Sutton FC* need *2 players* for Tuesday!");
  });

  it("no format: the venue alone", () => {
    expect(en.xask_post({ ...base, places: 2, format: null, when: { kind: "tomorrow" } }).split("\n")[2]).toBe("📍 Goals North Cheam");
  });

  it("without MatchTime's number: reply IN, or send the coded word privately; no link", () => {
    const text = en.xask_post({ ...base, places: 2, link: null, when: { kind: "tomorrow" } });
    expect(text).toContain("🙋 Fancy it? Reply *IN* to this message, or send MatchTime a private message: *IN (ref PJ7E)*");
    expect(text).not.toContain("wa.me");
  });

  it("a fee: its own line under the venue", () => {
    expect(en.xask_post({ ...base, places: 6, fee: "£5", when: { kind: "tomorrow" } })).toBe(
      [
        "⚽ *Sutton FC* need *6 players* for tomorrow!",
        "🗓 Tue 17 Nov, 21:30",
        "📍 Goals North Cheam, 7-a-side",
        "💷 £5 a game",
        `🙋 Fancy it? Reply *IN* to this message, or tap 👉 ${LINK}`,
        "🔒 MatchTime confirms with you by DM. Your number stays private.",
      ].join("\n"),
    );
    expect(en.xask_post({ ...base, places: 1, fee: "£7.50", when: { kind: "tonight" } })).toContain("\n💷 £7.50 a game\n");
  });

  it("no fee: no money line at all", () => {
    expect(en.xask_post({ ...base, places: 2, when: { kind: "tomorrow" } })).not.toMatch(/💷|£/);
  });

  it("never 'short', never 'bot', never a phone number outside the link", () => {
    const text = en.xask_post({ ...base, places: 3, fee: "£5", when: { kind: "tomorrow" } });
    expect(text).not.toMatch(/\bshort\b|\bbot\b/i);
    expect(text.replace(LINK, "")).not.toMatch(/\d{7,}/);
  });
});

describe("the post in Turkish", () => {
  const tr = t("tr");
  const trBase = { ...base, day: "17 Kasım Salı 21:30", format: "7'ye 7", prefill: "VARIM (ref PJ7E)" };

  it("plural, tomorrow: the same shape, natural Turkish", () => {
    expect(tr.xask_post({ ...trBase, places: 6, when: { kind: "tomorrow" } })).toBe(
      [
        "⚽ *Sutton FC* yarın için *6 oyuncu* arıyor!",
        "🗓 17 Kasım Salı 21:30",
        "📍 Goals North Cheam, 7'ye 7",
        `🙋 Oynamak ister misin? Bu mesajı yanıtlayıp *VARIM* yaz ya da dokun 👉 ${LINK}`,
        "🔒 MatchTime sana özelden dönecek. Numaran gizli kalır.",
      ].join("\n"),
    );
  });

  it("singular, tonight", () => {
    expect(tr.xask_post({ ...trBase, places: 1, when: { kind: "tonight" } }).split("\n")[0]).toBe("⚽ *Sutton FC* bu akşamki maç için *1 oyuncu* arıyor!");
  });

  it("a daytime game: today", () => {
    expect(tr.xask_post({ ...trBase, places: 3, when: { kind: "today" } }).split("\n")[0]).toBe("⚽ *Sutton FC* bugünkü maç için *3 oyuncu* arıyor!");
  });

  it("a later day names it", () => {
    expect(tr.xask_post({ ...trBase, places: 2, when: { kind: "day", label: "Salı" } }).split("\n")[0]).toBe("⚽ *Sutton FC* Salı günü için *2 oyuncu* arıyor!");
  });

  it("a fee: its own line under the venue", () => {
    expect(tr.xask_post({ ...trBase, places: 6, fee: "£5", when: { kind: "tomorrow" } }).split("\n").slice(2, 4)).toEqual([
      "📍 Goals North Cheam, 7'ye 7",
      "💷 Maç başı £5",
    ]);
    expect(tr.xask_post({ ...trBase, places: 6, when: { kind: "tomorrow" } })).not.toMatch(/💷|£/);
  });

  it("without MatchTime's number: the coded word to send privately", () => {
    const text = tr.xask_post({ ...trBase, places: 2, link: null, when: { kind: "tomorrow" } });
    expect(text).toContain("ya da MatchTime'a özelden yaz: *VARIM (ref PJ7E)*");
    expect(text).not.toContain("wa.me");
  });
});


describe("the follow-up lines in the partner's group, in the same style", () => {
  it("English", () => {
    const en = t("en");
    expect(en.xask_filled_line({ asker: "Sutton FC" })).toBe("✅ *Sutton FC*'s place is filled, thanks all 🙌");
    expect(en.xask_off_line({ asker: "Sutton FC", day: "Tue 17 Nov, 21:30" })).toBe("👋 *Sutton FC*'s ask for Tue 17 Nov, 21:30 is closed now, thanks all.");
    expect(en.xask_not_needed_line({ asker: "Sutton FC" })).toBe("👍 *Sutton FC* no longer need a player, thanks all.");
  });
  it("Turkish", () => {
    const tr = t("tr");
    expect(tr.xask_off_line({ asker: "Sutton FC", day: "17 Kasım Salı 21:30" })).toBe("👋 *Sutton FC* kulübünün 17 Kasım Salı 21:30 isteği artık kapandı, herkese teşekkürler.");
    expect(tr.xask_not_needed_line({ asker: "Sutton FC" })).toBe("👍 *Sutton FC* için artık oyuncuya gerek yok, herkese teşekkürler.");
  });
});

describe("@Match Time help partners tells players they can reply IN or tap the link", () => {
  for (const audience of ["group", "player"] as const) {
    it(`English, ${audience}`, () => {
      const text = t("en").onbHelpPartners({ audience, active: 1, url: "URL" });
      expect(text).toContain("reply IN to that post or tap its link, and MatchTime confirms with you by DM");
      expect(text).toContain("An IN that isn't a reply to the ask is for our own game.");
    });
    it(`Turkish, ${audience}`, () => {
      const text = t("tr").onbHelpPartners({ audience, active: 1, url: "URL" });
      expect(text).toContain("o mesajı yanıtlayıp VARIM yaz ya da bağlantısına dokun, MatchTime sana özelden döner");
      expect(text).toContain("İsteğe yanıt olmayan bir VARIM bizim kendi maçımız içindir.");
    });
  }
});
