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
  buildHowToUseMe,
  parseHelpTopic,
  buildHelpReply,
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

describe("BOT_ADDED_INTRO (descriptive on-add pitch)", () => {
  it("is a single string carrying both message blocks", () => {
    expect(typeof BOT_ADDED_INTRO).toBe("string");
    // Two blocks joined by a blank line.
    expect(BOT_ADDED_INTRO).toContain("\n\n");
  });

  it("describes the headline features", () => {
    expect(BOT_ADDED_INTRO).toContain("Squad list");
    expect(BOT_ADDED_INTRO.toLowerCase()).toMatch(/maybe/);
    expect(BOT_ADDED_INTRO).toContain("Fair teams");
    expect(BOT_ADDED_INTRO).toContain("Man of the Match");
    expect(BOT_ADDED_INTRO).toContain("Player ratings");
    expect(BOT_ADDED_INTRO).toContain("Reminders");
    expect(BOT_ADDED_INTRO).toContain("Payment tracking");
  });

  it("identifies MatchTime and keeps the consent keywords the parser needs", () => {
    expect(BOT_ADDED_INTRO).toContain("MatchTime");
    expect(BOT_ADDED_INTRO).toContain("YES");
    expect(BOT_ADDED_INTRO).toContain("EVERYTHING");
  });

  it("keeps an opt-out line (falls-open promise)", () => {
    expect(BOT_ADDED_INTRO.toLowerCase()).toMatch(/ignore me|stay quiet/);
  });

  it("mentions the help commands so players can dig deeper", () => {
    expect(BOT_ADDED_INTRO).toMatch(/help teams/);
    expect(BOT_ADDED_INTRO).toMatch(/help ratings/);
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

  it("paymentTracking off → no payments line", () => {
    const block = buildHowToUseMe({ ...ALL_ON, paymentTracking: false });
    expect(block).not.toMatch(/paid|payment/i);
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

describe("buildHelpReply — feature OFF → decline (not the explainer)", () => {
  it("payments off → decline, not the payments explainer", () => {
    const r = buildHelpReply("payments", { ...ALL_ON, paymentTracking: false });
    expect(r.toLowerCase()).toMatch(/isn't switched on|isn.t switched on/);
    expect(r).not.toMatch(/match fee/i);
  });
  it("mom off → decline, not the MoM explainer", () => {
    const r = buildHelpReply("mom", { ...ALL_ON, momVoting: false });
    expect(r.toLowerCase()).toMatch(/isn't switched on|isn.t switched on/);
    expect(r).not.toMatch(/tally the votes/i);
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
    expect(r).not.toMatch(/help payments/);
    // The feature-aware how-to block is appended.
    expect(r).toContain(buildHowToUseMe(feats));
  });

  it("with payments ON the payments topic IS listed", () => {
    const r = buildHelpReply(null, ALL_ON);
    expect(r).toMatch(/help payments/);
  });
});
