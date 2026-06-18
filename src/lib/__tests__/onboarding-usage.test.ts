/**
 * Unit tests for the autonomous-onboarding messaging copy:
 *   - BOT_ADDED_INTRO: the SHORT on-add intro (what MatchTime is + a
 *     tight consent line). Must stay short, keep the consent keywords
 *     the `introduced` parser depends on, and NOT dump the usage rules.
 *   - buildHowToUseMe(): the feature-aware "how to use me" block posted
 *     when setup completes. Only mentions enabled capabilities.
 * No DB, no network.
 */
import { describe, it, expect } from "vitest";
import { BOT_ADDED_INTRO, buildHowToUseMe } from "@/lib/onboarding-conversation";

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

describe("BOT_ADDED_INTRO (short on-add intro)", () => {
  it("is short — a tight intro, not a feature dump", () => {
    expect(BOT_ADDED_INTRO.length).toBeLessThan(700);
  });

  it("identifies MatchTime and keeps the consent keywords the parser needs", () => {
    expect(BOT_ADDED_INTRO).toContain("MatchTime");
    expect(BOT_ADDED_INTRO).toContain("YES");
    expect(BOT_ADDED_INTRO).toContain("EVERYTHING");
  });

  it("keeps an opt-out line (falls-open promise)", () => {
    expect(BOT_ADDED_INTRO.toLowerCase()).toMatch(/ignore me|stay quiet/);
  });

  it("does NOT carry the full usage rules block (that comes at completion)", () => {
    expect(BOT_ADDED_INTRO).not.toMatch(/how to use me/i);
    // The "stays quiet rest of the time / banter is safe" rules line is a
    // completion-only marker — the opt-out "ignore me and I'll stay quiet"
    // is allowed, but the banter rules must not appear here.
    expect(BOT_ADDED_INTRO).not.toMatch(/banter/i);
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
