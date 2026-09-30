/**
 * Unit tests for the autonomous-onboarding messaging copy:
 *   - BOT_ADDED_INTRO: the DESCRIPTIVE full-menu on-add pitch (a single
 *     string carrying the feature pitch + the consent question). It is
 *     intentionally long now (the descriptive menu), but MUST keep the
 *     consent keywords the `introduced` parser depends on, keep an
 *     opt-out, and surface the help commands.
 *   - buildHowToUseMe(): the feature-aware "how to use me" block posted
 *     when setup completes. Only mentions enabled capabilities.
 *   - parseHelpTopic() + buildHelpReply(): the topic-aware help router.
 * No DB, no network.
 */
import { describe, it, expect } from "vitest";
import {
  BOT_ADDED_INTRO,
  buildBotAddedIntro,
  buildHowToUseMe,
  parseHelpTopic,
  buildHelpReply,
  buildAdminMagicLinkDm,
  helpPagesNeeded,
  type HelpTopic,
} from "@/lib/onboarding-conversation";
import { parseBundleReply } from "@/lib/onboarding-parse";

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

describe("BOT_ADDED_INTRO (the short on-add intro, 2026-09-17)", () => {
  it("is a single string: one line on what MatchTime is, one question", () => {
    expect(typeof BOT_ADDED_INTRO).toBe("string");
    expect(BOT_ADDED_INTRO).toContain("\n\n");
  });

  // Kemal, 2026-09-30, replacing the 2026-09-17 "one line" rule: the
  // intro lists what MatchTime does, like the ad for new groups. Still
  // bounded, so it stays one readable WhatsApp message.
  it("lists the features in one readable message", () => {
    expect(BOT_ADDED_INTRO.length).toBeLessThan(1200);
    for (const f of ["In", "bench", "teams", "Man of the Match", "stats", "Match fees"]) {
      expect(BOT_ADDED_INTRO).toContain(f);
    }
    expect(BOT_ADDED_INTRO).not.toMatch(/[—–]/);
  });

  it("identifies MatchTime and keeps the consent keyword the parser needs", () => {
    expect(BOT_ADDED_INTRO).toContain("MatchTime");
    expect(BOT_ADDED_INTRO).toContain("*YES*");
    expect(parseBundleReply("YES")?.choice).toBe("yes");
  });

  it("keeps an opt-out line (falls-open promise)", () => {
    expect(BOT_ADDED_INTRO.toLowerCase()).toMatch(/ignore me|stay quiet/);
  });

  it("carries no feature pitch: that moved to help and the how-to block", () => {
    expect(BOT_ADDED_INTRO).not.toContain("Payment tracking");
    expect(BOT_ADDED_INTRO).not.toMatch(/help teams/);
    expect(buildHelpReply("teams", ALL_ON)).toMatch(/balanced/i);
  });

  it("the Turkish intro keeps the same contract with EVET", () => {
    const tr = buildBotAddedIntro("tr");
    expect(tr).toContain("MatchTime");
    expect(tr).toContain("*EVET*");
    expect(tr.length).toBeLessThan(1300);
    expect(tr).not.toMatch(/[—–]/);
    expect(parseBundleReply("EVET")?.choice).toBe("yes");
  });
});

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
    expect(block).toContain(`⏰ Need a nudge? Say *"@Match Time remind me Thursday"* and I'll DM you then.`);
    expect(buildHowToUseMe(ALL_ON, "tr")).toContain(`⏰ Hatırlatma mı lazım? *"@Match Time perşembe hatırlat"* yazın, o zaman size özelden yazarım.`);
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

describe("parseHelpTopic", () => {
  const cases: Array<[string, HelpTopic | null]> = [
    ["@Match Time help ratings", "ratings"],
    ["matchtime help teams", "teams"],
    ["help mom", "mom"],
    ["@Match Time help availability", "availability"],
    ["help reminders", "reminders"],
    ["@MT help payments", "payments"],
    ["@Match Time help", null], // bare help → no topic
    ["help", null],
    ["help unicorns", null], // unknown topic word
    ["", null],
  ];
  for (const [raw, expected] of cases) {
    it(`"${raw}" → ${expected}`, () => {
      expect(parseHelpTopic(raw)).toBe(expected);
    });
  }

  it("recognises a few aliases (man of the match, player ratings)", () => {
    expect(parseHelpTopic("@Match Time help man of the match")).toBe("mom");
    expect(parseHelpTopic("help player ratings")).toBe("ratings");
  });

  it("all-caps English still parses (the Turkish lower-casing would dot the I)", () => {
    expect(parseHelpTopic("@MATCH TIME HELP RATINGS")).toBe("ratings");
    expect(parseHelpTopic("HELP AVAILABILITY")).toBe("availability");
    expect(parseHelpTopic("@MATCH TIME YARDIM PUANLAMA")).toBe("ratings");
  });

  it("reads the Turkish keyword and topic words (2026-09-17)", () => {
    expect(parseHelpTopic("@Match Time yardım takımlar")).toBe("teams");
    expect(parseHelpTopic("@Match Time yardim takim")).toBe("teams");
    expect(parseHelpTopic("@Match Time yardım kadro")).toBe("availability");
    expect(parseHelpTopic("@Match Time YARDIM maçın adamı")).toBe("mom");
    expect(parseHelpTopic("@Match Time yardım puanlama")).toBe("ratings");
    expect(parseHelpTopic("@Match Time yardım hatırlatma")).toBe("reminders");
    expect(parseHelpTopic("@Match Time yardım ödeme")).toBe("payments");
    expect(parseHelpTopic("@Match Time yardım")).toBeNull();
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
    const r = buildHelpReply("payments", OFF, "en", { audience: "group", links: { settings: URL } });
    expect(r).toMatch(/isn't switched on for this group yet/);
    expect(r).toMatch(/link to pay their share, by card or bank/);
    expect(r).toMatch(/daily reminder/);
    expect(r).toMatch(/money collector to confirm/);
    expect(r).toContain(URL);
    expect(r).toMatch(/\*Payment tracking\* and \*Collect match fees\*/);
    expect(r).toMatch(/Stripe once/);
    expect(r).toMatch(/DM me \*help payments\*/);
    expect(r).not.toContain(LINK);
  });

  it("payments off, DM from an admin: the steps with a signed-in link", () => {
    const r = buildHelpReply("payments", OFF, "en", { audience: "admin", links: { settings: LINK } });
    expect(r).toMatch(/link to pay their share/);
    expect(r).toMatch(/open \*Settings\* on your admin page/);
    expect(r).toContain(LINK);
    expect(r).not.toMatch(/DM me/);
  });

  it("payments off, DM from a player: how it works, ask the organiser, no admin link", () => {
    const r = buildHelpReply("payments", OFF, "en", { audience: "player", links: { settings: LINK } });
    expect(r).toMatch(/link to pay their share/);
    expect(r).toMatch(/Your organiser switches this on/);
    expect(r).not.toContain(LINK);
    expect(r).not.toMatch(/Stripe once/);
  });

  it("mom off: the MoM explainer, framed as off, with the setting's name", () => {
    const r = buildHelpReply("mom", { ...ALL_ON, momVoting: false }, "en", { audience: "group", links: { settings: URL } });
    expect(r).toMatch(/isn't switched on for this group yet/);
    expect(r).toMatch(/tally the votes/i);
    expect(r).toMatch(/turns on \*Man of the Match\* under Bot features/);
  });

  it("every topic, off, every audience, both languages: no dash, never the old decline", () => {
    const topics: HelpTopic[] = ["availability", "teams", "mom", "ratings", "reminders", "payments"];
    const NONE = { attendance: false, teamBalancing: false, momVoting: false, playerRating: false, statsQa: false, reminders: false, bench: false, paymentTracking: false };
    for (const lang of ["en", "tr"] as const) {
      for (const audience of ["group", "admin", "player"] as const) {
        for (const tp of topics) {
          const r = buildHelpReply(tp, NONE, lang, { audience, links: { settings: LINK } });
          expect(r, `${lang}/${audience}/${tp}`).not.toMatch(/[—–]/);
          expect(r).not.toMatch(/isn't switched on for this group\. Type/);
        }
      }
    }
  });

  it("Turkish: payments off in the group explains and gives the steps", () => {
    const r = buildHelpReply("payments", OFF, "tr", { audience: "group", links: { settings: URL } });
    expect(r).toContain("henüz açık değil");
    expect(r).toContain("Stripe ile bir kez");
    expect(r).toContain(URL);
    expect(r).toContain("*yardım ödeme*");
  });
});

describe("buildHelpReply — a topic that is ON, by audience", () => {
  const LINK = "https://matchtime.ai/r/abc123";
  it("group and player: the explainer, byte for byte as before", () => {
    const before = buildHelpReply("payments", ALL_ON);
    expect(buildHelpReply("payments", ALL_ON, "en", { audience: "player", links: { settings: LINK } })).toBe(before);
    expect(before).not.toContain(LINK);
  });
  it("admin DM: the explainer plus where its settings live", () => {
    const r = buildHelpReply("payments", ALL_ON, "en", { audience: "admin", links: { settings: LINK } });
    expect(r.startsWith(buildHelpReply("payments", ALL_ON))).toBe(true);
    expect(r).toContain(`⚙️ Its settings are on your admin page:\n${LINK}`);
  });
  it("bare help, admin DM: the menu plus the settings link", () => {
    const r = buildHelpReply(null, ALL_ON, "en", { audience: "admin", links: { settings: LINK } });
    expect(r.startsWith(buildHelpReply(null, ALL_ON))).toBe(true);
    expect(r).toContain(LINK);
  });
  it("bare help, player DM: identical to the group's", () => {
    expect(buildHelpReply(null, ALL_ON, "en", { audience: "player", links: { settings: LINK } })).toBe(buildHelpReply(null, ALL_ON));
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
    // Not in the topic MENU (it is off); the how-to block's 💷 line
    // still points at it.
    expect(r).not.toMatch(/• \*@Match Time help payments\*/);
    // The feature-aware how-to block is appended.
    expect(r).toContain(buildHowToUseMe(feats));
  });

  it("with payments ON the payments topic IS listed", () => {
    const r = buildHelpReply(null, ALL_ON);
    expect(r).toMatch(/help payments/);
  });
});

describe("buildAdminMagicLinkDm: the organiser's setup DM (2026-09-30)", () => {
  // Kemal, first real self-setup: the DM never mentioned starting (seed)
  // ratings, though the club-scoped ratings design decided a new club's
  // admin is offered the seed editor at setup. It now links straight to
  // it, signed in, and says why. Schedule changes live in the admin
  // screens, not WhatsApp commands, so it also links block bookings and
  // the match list.
  const base = {
    groupName: "MT Test",
    url: "https://mt.example/r/admin",
    payments: false,
    seedUrl: "https://mt.example/r/seeds",
    blockBookingsUrl: "https://mt.example/r/blocks",
    matchesUrl: "https://mt.example/r/matches",
  };

  it("EN: offers the seed editor with the reason, then block bookings, then the match list", () => {
    const dm = buildAdminMagicLinkDm(base, "en");
    const seed = dm.indexOf("https://mt.example/r/seeds");
    const blocks = dm.indexOf("https://mt.example/r/blocks");
    const matches = dm.indexOf("https://mt.example/r/matches");
    expect(seed).toBeGreaterThan(dm.indexOf("https://mt.example/r/admin"));
    expect(blocks).toBeGreaterThan(seed);
    expect(matches).toBeGreaterThan(blocks);
    expect(dm).toMatch(/starting ratings/i);
    expect(dm).toMatch(/first teams are balanced/);
    expect(dm).toMatch(/Players never see these/);
    expect(dm).toMatch(/block booking/i);
    expect(dm).toMatch(/cancel one week or switch its format/);
    expect(dm).not.toMatch(/[—–]/);
  });

  it("TR: the same lines in Turkish, no dash", () => {
    const dm = buildAdminMagicLinkDm(base, "tr");
    expect(dm).toContain("https://mt.example/r/seeds");
    expect(dm).toMatch(/Başlangıç puanları/);
    expect(dm).toMatch(/blok rezervasyon/);
    expect(dm).toContain("https://mt.example/r/matches");
    expect(dm).not.toMatch(/[—–]/);
  });

  it("no seed line when there is no seed link (team generation off)", () => {
    const dm = buildAdminMagicLinkDm({ ...base, seedUrl: null }, "en");
    expect(dm).not.toMatch(/starting ratings/i);
    expect(dm).toContain("https://mt.example/r/blocks");
  });
});

describe("help schedule (2026-09-30)", () => {
  // Kemal: schedule changes are made in the admin screens, not by WhatsApp
  // command (no extra model cost). "help schedule" is the clear guide.
  it.each([
    ["@Match Time help schedule", "schedule"],
    ["@Match Time help block booking", "schedule"],
    ["@Match Time help block bookings", "schedule"],
    ["@Match Time help cancel", "schedule"],
    ["@Match Time help reschedule", "schedule"],
    ["@Match Time help kick-off time", "schedule"],
    ["@Match Time help kickoff", "schedule"],
    ["@Match Time help format", "schedule"],
    ["@Match Time yardım program", "schedule"],
    ["@Match Time yardım blok rezervasyon", "schedule"],
    ["@Match Time yardım iptal", "schedule"],
    ["@Match Time yardım saat", "schedule"],
    ["@Match Time yardım format", "schedule"],
  ])("%j → %s", (raw, topic) => {
    expect(parseHelpTopic(raw)).toBe(topic);
  });

  it("the existing topics still win their own words", () => {
    expect(parseHelpTopic("@Match Time help teams")).toBe("teams");
    expect(parseHelpTopic("@Match Time help payments")).toBe("payments");
    expect(parseHelpTopic("@Match Time help reminders")).toBe("reminders");
  });

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

  it("helpPagesNeeded: schedule needs its four pages, everything else the settings page", () => {
    expect(helpPagesNeeded("schedule", "admin").sort()).toEqual(["activities", "blockBookings", "bulk", "matches"]);
    expect(helpPagesNeeded("payments", "admin")).toEqual(["settings"]);
    expect(helpPagesNeeded(null, "admin")).toEqual(["settings"]);
    expect(helpPagesNeeded("schedule", "player")).toEqual([]);
  });
});
