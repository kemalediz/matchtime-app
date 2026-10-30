/**
 * Unit tests for the help copy:
 *   - buildHowToUseMe(): the feature-aware "how to use me" block. Only
 *     mentions enabled capabilities.
 *   - buildHelpReply(): the help for a topic. Which topic was asked about
 *     is the question extractor's (`how_it_works`, its `feature`) since
 *     2026-10-28; the regex reader `parseHelpTopic` is gone.
 * No DB, no network.
 */
import { describe, it, expect } from "vitest";
import {
  buildHowToUseMe,
  buildHelpReply,
  helpPagesNeeded,
  type HelpTopic,
} from "@/lib/onboarding-conversation";

const ALL_ON = {
  attendance: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  statsQa: true,
  reminders: true,
  bench: true,
  paymentTracking: true,
} as const;
/** Payments count as on when the club collects match fees (payment
 *  tracking is hidden, 2026-10-16). */
const FEES_ON = { ...ALL_ON, paymentCollection: true } as const;

describe("buildHowToUseMe — full-feature org", () => {
  const block = buildHowToUseMe(ALL_ON);

  it("teaches In/Out without a tag", () => {
    expect(block).toMatch(/in.*out/i);
    expect(block).toMatch(/tag/i);
  });

  it("teaches the maybe / ~24h DM behaviour", () => {
    expect(block).toMatch(/maybe/i);
    expect(block).toMatch(/24h/i);
  });

  it('explains it "stays quiet" the rest of the time', () => {
    expect(block).toMatch(/quiet/i);
  });

  it("mentions the enabled extras", () => {
    expect(block).toMatch(/team/i);
    expect(block.toLowerCase()).toMatch(/mom|man of the match/);
    expect(block.toLowerCase()).toMatch(/rating/);
    expect(block.toLowerCase()).toMatch(/pa(id|yment)/);
    expect(block.toLowerCase()).toMatch(/remind/);
  });
});

describe("buildHowToUseMe — feature awareness", () => {
  it("teamBalancing off → no teams capability line", () => {
    const block = buildHowToUseMe({ ...ALL_ON, teamBalancing: false });
    expect(block).not.toContain("make / show the teams");
  });

  it("momVoting off → no Man of the Match line", () => {
    const block = buildHowToUseMe({ ...ALL_ON, momVoting: false });
    expect(block).not.toMatch(/man of the match/i);
    expect(block).not.toMatch(/\bMoM\b/);
  });

  it("playerRating off → no rating-link line", () => {
    const block = buildHowToUseMe({ ...ALL_ON, playerRating: false });
    expect(block).not.toMatch(/rating/i);
  });

  it("paymentTracking off → no 'who's paid' line, but a pointer to how fee collection works (2026-09-30)", () => {
    // Payments are off after setup, and nothing told the organiser that
    // match-fee collection exists. The off state now says so.
    const block = buildHowToUseMe({ ...ALL_ON, paymentTracking: false });
    expect(block).not.toMatch(/keep track of who's \*paid\*/i);
    expect(block).toContain(`💷 Want to collect match fees? Ask me: *@Match Time help payments*`);
  });

  it("paymentTracking on → the 'who's paid' line and no pointer", () => {
    const block = buildHowToUseMe(ALL_ON);
    expect(block).toContain(`💳 I keep track of who's *paid*.`);
    expect(block).not.toContain("💷");
  });

  it("the reminders line says what it is for: a personal DM at the time you ask (2026-09-30)", () => {
    const block = buildHowToUseMe(ALL_ON);
    expect(block).toContain(`⏰ Need a nudge? Tag me and say when, in your own words (for example *"@Match Time remind me Thursday"*), and I'll DM you then.`);
    expect(buildHowToUseMe(ALL_ON, "tr")).toContain(`⏰ Hatırlatma mı lazım? Beni etiketleyip ne zaman istediğinizi kendi cümlelerinizle yazın (örneğin *"@Match Time perşembe hatırlat"*), o zaman size özelden yazarım.`);
  });

  it("carries no em or en dash, in either language, in any shape", () => {
    for (const lang of ["en", "tr"] as const) {
      for (const f of [ALL_ON, { ...ALL_ON, attendance: false, paymentTracking: false }]) {
        expect(buildHowToUseMe(f, lang)).not.toMatch(/[—–]/);
      }
    }
  });

  it("reminders off → no reminders line", () => {
    const block = buildHowToUseMe({ ...ALL_ON, reminders: false });
    expect(block).not.toMatch(/remind/i);
  });

  it("statsQa off → no past-stats capability line", () => {
    const block = buildHowToUseMe({ ...ALL_ON, statsQa: false });
    expect(block).not.toMatch(/past stats|won mom last week/i);
  });

  it("attendance off (squad-from-list shape) → leads with reading the squad list, not In/Out", () => {
    const block = buildHowToUseMe({ ...ALL_ON, attendance: false });
    expect(block).not.toMatch(/say \*?"in"/i);
    expect(block.toLowerCase()).toMatch(/squad|list/);
  });
});

describe("buildHelpReply in Turkish lists the Turkish topic words", () => {
  it("bare help names each enabled topic by the word a player types", () => {
    const r = buildHelpReply(null, { ...ALL_ON, paymentTracking: false }, "tr");
    expect(r).toContain("@Match Time yardım takımlar");
    expect(r).toContain("@Match Time yardım kadro");
    expect(r).not.toContain("• *@Match Time yardım ödeme*");
    expect(r).not.toMatch(/[—–]/);
  });
  it("a topic that is off explains itself in Turkish", () => {
    const r = buildHelpReply("payments", { ...ALL_ON, paymentTracking: false }, "tr");
    expect(r).toContain("açık değil");
    expect(r).toContain("Maç ücretleri nasıl çalışır");
  });
});

describe("buildHelpReply — topic explainers (feature ON)", () => {
  it("ratings → the ratings explainer", () => {
    const r = buildHelpReply("ratings", ALL_ON);
    expect(r).toMatch(/rate the other players out of 10/i);
  });
  it("teams → the fair-teams explainer", () => {
    const r = buildHelpReply("teams", ALL_ON);
    expect(r.toLowerCase()).toMatch(/balanced/);
    expect(r.toLowerCase()).toMatch(/form rating|form ratings/);
  });
  it("mom → the Man of the Match explainer", () => {
    const r = buildHelpReply("mom", ALL_ON);
    expect(r).toMatch(/Man of the Match/);
    expect(r.toLowerCase()).toMatch(/vote/);
  });
  it("availability → the squad/availability explainer", () => {
    const r = buildHelpReply("availability", ALL_ON);
    expect(r.toLowerCase()).toMatch(/in.*out/);
    expect(r.toLowerCase()).toMatch(/bench|reserve/);
  });
  it("reminders → the reminders explainer", () => {
    const r = buildHelpReply("reminders", ALL_ON);
    expect(r.toLowerCase()).toMatch(/nudge|remind/);
  });
  it("payments → the payment-tracking explainer", () => {
    const r = buildHelpReply("payments", ALL_ON);
    expect(r.toLowerCase()).toMatch(/match fee|who.*paid|still owe/);
  });
});

describe("buildHelpReply — a topic that is OFF explains itself and how to switch it on (2026-09-30)", () => {
  // It used to decline ("That one isn't switched on for this group"), so
  // an organiser asking "help payments" after setup learned nothing about
  // a feature that is off by default. Now: how it works, then how to turn
  // it on, worded for who is asking.
  const OFF = { ...ALL_ON, paymentTracking: false };
  const URL = "https://matchtime.ai/admin/settings";
  const LINK = "https://matchtime.ai/r/abc123";

  it("payments off, in the group: how fee collection works + the admin page steps", () => {
    const r = buildHelpReply("payments", OFF, "en", { audience: "group", links: { topic: URL } });
    expect(r).toMatch(/isn't switched on for this group yet/);
    expect(r).toMatch(/link to pay their share, by card or bank/);
    expect(r).toMatch(/daily reminder/);
    expect(r).toMatch(/money collector to confirm/);
    expect(r).toContain(URL);
    expect(r).toMatch(/an admin turns on \*Collect match fees\* on the settings page, picks the money collector/);
    expect(r).not.toMatch(/Payment tracking/);
    expect(r).toMatch(/Stripe once/);
    expect(r).toMatch(/DM me \*help payments\*/);
    expect(r).not.toContain(LINK);
  });

  it("payments off, DM from an admin: the steps with a signed-in link", () => {
    const r = buildHelpReply("payments", OFF, "en", { audience: "admin", links: { topic: LINK } });
    expect(r).toMatch(/link to pay their share/);
    expect(r).toMatch(/turn on \*Collect match fees\*, pick the money collector/);
    expect(r).toContain(LINK);
    expect(r).not.toMatch(/DM me/);
  });

  it("payments off, DM from a player: how it works, ask the organiser, no admin link", () => {
    const r = buildHelpReply("payments", OFF, "en", { audience: "player", links: { topic: LINK } });
    expect(r).toMatch(/link to pay their share/);
    expect(r).toMatch(/Your organiser switches this on/);
    expect(r).not.toContain(LINK);
    expect(r).not.toMatch(/Stripe once/);
  });

  it("mom off: the MoM explainer, framed as off, with the setting's name", () => {
    const r = buildHelpReply("mom", { ...ALL_ON, momVoting: false }, "en", { audience: "group", links: { topic: URL } });
    expect(r).toMatch(/isn't switched on for this group yet/);
    expect(r).toMatch(/tally the votes/i);
    expect(r).toMatch(/an admin turns on \*Man of the Match\* on the settings page/);
  });

  it("every topic, off, every audience, both languages: no dash, never the old decline", () => {
    const topics: HelpTopic[] = ["availability", "teams", "mom", "ratings", "reminders", "payments"];
    const NONE = { attendance: false, teamBalancing: false, momVoting: false, playerRating: false, statsQa: false, reminders: false, bench: false, paymentTracking: false };
    for (const lang of ["en", "tr"] as const) {
      for (const audience of ["group", "admin", "player"] as const) {
        for (const tp of topics) {
          const r = buildHelpReply(tp, NONE, lang, { audience, links: { topic: LINK } });
          expect(r, `${lang}/${audience}/${tp}`).not.toMatch(/[—–]/);
          expect(r).not.toMatch(/isn't switched on for this group\. Type/);
        }
      }
    }
  });

  it("Turkish: payments off in the group explains and gives the steps", () => {
    const r = buildHelpReply("payments", OFF, "tr", { audience: "group", links: { topic: URL } });
    expect(r).toContain("henüz açık değil");
    expect(r).toContain("Stripe ile bir kez");
    expect(r).toContain(URL);
    expect(r).toContain("*yardım ödeme*");
  });
});

describe("buildHelpReply — a topic that is ON, by audience", () => {
  const LINK = "https://matchtime.ai/r/abc123";
  it("group and player: the explainer, then that it is on (2026-10-28), no link", () => {
    const before = buildHelpReply("payments", FEES_ON);
    expect(before.endsWith("\n\n✅ It's on for this club.")).toBe(true);
    expect(buildHelpReply("payments", FEES_ON, "en", { audience: "player", links: { topic: LINK } })).toBe(before);
    expect(before).not.toContain(LINK);
  });
  it("admin: the explainer, that it is on, and where to switch it off", () => {
    const r = buildHelpReply("payments", FEES_ON, "en", { audience: "admin", links: { topic: LINK } });
    expect(r).toContain(`✅ It's on for your club. To switch it off or change how it works:\n${LINK}`);
  });
  it("bare help, admin DM: the menu plus the settings link", () => {
    const r = buildHelpReply(null, ALL_ON, "en", { audience: "admin", links: { settings: LINK } });
    expect(r.startsWith(buildHelpReply(null, ALL_ON))).toBe(true);
    expect(r).toContain(LINK);
  });
  it("bare help, player DM: identical to the group's", () => {
    expect(buildHelpReply(null, ALL_ON, "en", { audience: "player", links: { topic: LINK } })).toBe(buildHelpReply(null, ALL_ON));
  });
});

describe("buildHelpReply — bare help (topic null)", () => {
  it("lists only enabled topics + includes the how-to block", () => {
    const feats = { ...ALL_ON, paymentTracking: false };
    const r = buildHelpReply(null, feats);
    // Lead line.
    expect(r).toMatch(/MatchTime help/);
    // Enabled topic present, disabled topic absent.
    expect(r).toMatch(/help ratings/);
    // Not in the topic MENU (it is off). In the players' group the how-to
    // block leaves out the organiser's 💷 fees pointer too (FNF, 2026-10-15);
    // an organiser's DM keeps it.
    expect(r).not.toMatch(/• \*@Match Time help payments\*/);
    expect(r).not.toMatch(/help payments/);
    // The feature-aware how-to block is appended.
    expect(r).toContain(buildHowToUseMe({ ...feats, feesNudge: false }));
    expect(buildHelpReply(null, feats, "en", { audience: "admin" })).toContain(buildHowToUseMe(feats));
  });

  it("with payments ON the payments topic IS listed", () => {
    const r = buildHelpReply(null, FEES_ON);
    expect(r).toMatch(/help payments/);
  });
});

describe("help schedule (2026-09-30)", () => {
  // Kemal: schedule changes are made in the admin screens, not by WhatsApp
  // command (no extra model cost). "help schedule" is the clear guide.
  const LINKS = {
    activities: "https://mt.example/r/act",
    blockBookings: "https://mt.example/r/blocks",
    bulk: "https://mt.example/r/bulk",
    matches: "https://mt.example/r/matches",
  };

  it("admin DM: step by step, each with its signed-in link, and what the group is told", () => {
    const r = buildHelpReply("schedule", ALL_ON, "en", { audience: "admin", links: LINKS });
    for (const url of Object.values(LINKS)) expect(r).toContain(url);
    expect(r).toMatch(/\*Edit\*.*\*Save changes\*/);
    expect(r).toMatch(/\*New block booking\*/);
    expect(r).toMatch(/\*Preview dates\*/);
    expect(r).toMatch(/\*Bulk cancel \/ restore\*/);
    expect(r).toMatch(/\*Find matches\*/);
    expect(r).toMatch(/\*Switch format\*.*\*Confirm switch\*/);
    expect(r).toMatch(/group isn't told/i);
    expect(r).not.toMatch(/DM me/);
    expect(r).not.toMatch(/[—–]/);
  });

  it("group: the same steps with public URLs, and a pointer to DM for signed-in links", () => {
    const r = buildHelpReply("schedule", ALL_ON, "en", { audience: "group" });
    expect(r).toContain("https://matchtime.ai/admin/activities");
    expect(r).toContain("https://matchtime.ai/admin/block-bookings");
    expect(r).toContain("https://matchtime.ai/admin/matches/bulk");
    expect(r).toContain("https://matchtime.ai/matches");
    expect(r).toMatch(/DM me \*help schedule\*/);
    expect(r).not.toContain("/r/");
  });

  it("player DM: one line, ask the organiser, no link", () => {
    const r = buildHelpReply("schedule", ALL_ON, "en", { audience: "player", links: LINKS });
    expect(r).toMatch(/organiser/);
    expect(r).not.toMatch(/https?:\/\//);
    expect(r.split("\n").length).toBeLessThanOrEqual(2);
  });

  it("Turkish, all three audiences, no dash; the screens' English labels are kept", () => {
    for (const audience of ["group", "admin", "player"] as const) {
      const r = buildHelpReply("schedule", ALL_ON, "tr", { audience, links: LINKS });
      expect(r).not.toMatch(/[—–]/);
      if (audience !== "player") expect(r).toMatch(/\*New block booking\*/);
    }
  });

  it("bare help lists the schedule topic, whatever is switched on", () => {
    const NONE = { attendance: false, teamBalancing: false, momVoting: false, playerRating: false, statsQa: false, reminders: false, bench: false, paymentTracking: false };
    expect(buildHelpReply(null, NONE)).toMatch(/• \*@Match Time help schedule\*/);
    expect(buildHelpReply(null, NONE, "tr")).toMatch(/• \*@Match Time yardım program\*/);
  });

  it("helpPagesNeeded: schedule needs its four pages, a topic its own card, bare help the settings page", () => {
    expect(helpPagesNeeded("schedule", "admin").sort()).toEqual(["activities", "blockBookings", "bulk", "matches"]);
    expect(helpPagesNeeded("payments", "admin")).toEqual(["topic"]);
    expect(helpPagesNeeded("pool", "admin")).toEqual(["topic"]);
    expect(helpPagesNeeded(null, "admin")).toEqual(["settings"]);
    expect(helpPagesNeeded("schedule", "player")).toEqual([]);
  });
});
