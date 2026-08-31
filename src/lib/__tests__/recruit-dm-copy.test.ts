/**
 * The recruit invite DM copy — pure builders, no DB.
 *
 * WHY THIS TEST EXISTS (owner, 2026-08-31): the old invite led with a
 * magic link ("Tap to grab a spot: <link>"). Half this club is older and
 * not technical; they do not tap links, they reply. The invite must
 * therefore LEAD with the ask — reply IN, or tap 👍 — and the link is
 * demoted to a trailing optional line.
 *
 * House style (Cressoft): no em dashes, no en dashes as punctuation, no
 * slashes in prose. The magic link obviously contains slashes, so the
 * slash rule is asserted against the message with URLs stripped out.
 *
 * ── THE REACTION INSTRUCTION IS GATED ────────────────────────────────
 * The DM must only instruct players to do things that ACTUALLY WORK.
 * Inbound reaction forwarding is dead on the Pi right now (the bot logs
 * `reaction-forwarding is unavailable` and has never once forwarded a
 * reaction), so telling a player to "tap 👍" would be the exact
 * silent-failure pattern this club has just lost a week to: the bot
 * appears to offer something, the player believes they answered, nothing
 * is recorded. RECRUIT_DM_MENTION_REACTIONS gates the sentence; the
 * handling code behind it stays live either way, so an UNPROMPTED 👍 is
 * still honoured the moment forwarding is repaired.
 */
import { describe, it, expect } from "vitest";
import {
  buildRecruitInviteDm,
  buildRecruitGroupInviteDm,
  RECRUIT_DM_MENTION_REACTIONS,
} from "@/lib/recruit";

const BASE = {
  firstName: "Abid",
  matchName: "Tuesday 7-a-side",
  matchWhen: "Tue 1 Sept, 21:30",
  spotsLeft: 4,
  link: "https://mt.link/aB3xY",
};

/** The message with every URL removed, for punctuation assertions. */
const withoutUrls = (s: string) => s.replace(/https?:\/\/\S+/g, "");

describe("buildRecruitInviteDm — attendance-tracking org", () => {
  it("LEADS with the reply ask, not the link", () => {
    const text = buildRecruitInviteDm(BASE);
    const askAt = text.indexOf("*IN*");
    const linkAt = text.indexOf(BASE.link);
    expect(askAt).toBeGreaterThan(-1);
    expect(linkAt).toBeGreaterThan(-1);
    expect(askAt).toBeLessThan(linkAt);
  });

  it("asks them to reply IN to play", () => {
    expect(buildRecruitInviteDm(BASE)).toContain("*IN*");
  });

  // Owner, 2026-08-31: saying NO must be exactly as easy as saying yes.
  // A parallel chase-up feature DMs everyone who stays silent, so an
  // effortless "no" is what keeps the club from looking naggy.
  it("offers a negative route just as plainly: reply OUT", () => {
    expect(buildRecruitInviteDm(BASE)).toContain("*OUT*");
  });

  it("gives the negative route the same shape as the positive one", () => {
    const text = buildRecruitInviteDm(BASE);
    const yes = text.indexOf("*IN*");
    const no = text.indexOf("*OUT*");
    expect(yes).toBeGreaterThan(-1);
    expect(no).toBeGreaterThan(yes); // yes first, but no is right behind it
    // Neither route is buried after the optional link line.
    expect(no).toBeLessThan(text.indexOf(BASE.link));
  });

  it("keeps the match name, the kick-off and the spots-left context", () => {
    const text = buildRecruitInviteDm(BASE);
    expect(text).toContain("Tuesday 7-a-side");
    expect(text).toContain("Tue 1 Sept, 21:30");
    expect(text).toContain("4 spots left");
  });

  it("singularises a single remaining spot", () => {
    expect(buildRecruitInviteDm({ ...BASE, spotsLeft: 1 })).toContain("1 spot left");
  });

  it("says nothing about spots when the count is suppressed (0)", () => {
    const text = buildRecruitInviteDm({ ...BASE, spotsLeft: 0 });
    expect(text).not.toMatch(/spots? left/);
  });

  it("demotes the link to the FINAL line, flagged as the optional route", () => {
    const lines = buildRecruitInviteDm(BASE).split("\n").filter((l) => l.trim());
    const last = lines[lines.length - 1];
    expect(last).toContain(BASE.link);
    expect(last.toLowerCase()).toContain("app");
  });

  it("omits the link line entirely when there is no link", () => {
    const text = buildRecruitInviteDm({ ...BASE, link: null });
    expect(text).not.toContain("http");
    expect(text).toContain("*IN*");
  });

  it("uses no em dashes and no en dashes", () => {
    const text = buildRecruitInviteDm(BASE);
    expect(text).not.toContain("—");
    expect(text).not.toContain("–");
  });

  it("uses no slashes outside the link", () => {
    expect(withoutUrls(buildRecruitInviteDm(BASE))).not.toContain("/");
  });

  it("stays short — a WhatsApp DM, not a letter", () => {
    expect(buildRecruitInviteDm(BASE).length).toBeLessThan(340);
  });

  it("greets the player by first name", () => {
    expect(buildRecruitInviteDm(BASE)).toContain("Abid");
  });
});

describe("the reaction instruction is gated on RECRUIT_DM_MENTION_REACTIONS", () => {
  it("is OFF right now — inbound reaction forwarding is dead on the Pi", () => {
    expect(RECRUIT_DM_MENTION_REACTIONS).toBe(false);
  });

  it("NEVER tells a player to tap an emoji while the flag is false", () => {
    const text = buildRecruitInviteDm({ ...BASE, mentionReactions: false });
    // The instruction, in any shape we might reach for.
    expect(text).not.toMatch(/\btap\b/i);
    expect(text).not.toMatch(/\breact\b/i);
    expect(text).not.toContain("👍");
    expect(text).not.toContain("👎");
    // …but the message still works: both routes are still offered.
    expect(text).toContain("*IN*");
    expect(text).toContain("*OUT*");
  });

  it("defaults to the flag, so production copy cannot drift from it", () => {
    expect(buildRecruitInviteDm(BASE)).toBe(
      buildRecruitInviteDm({ ...BASE, mentionReactions: RECRUIT_DM_MENTION_REACTIONS }),
    );
  });

  it("offers 👍 and 👎 symmetrically once the flag is flipped back on", () => {
    const text = buildRecruitInviteDm({ ...BASE, mentionReactions: true });
    expect(text).toContain("👍");
    expect(text).toContain("👎");
    expect(text).toContain("*IN*");
    expect(text).toContain("*OUT*");
    // Still house style, still the same shape.
    expect(text).not.toContain("—");
    expect(withoutUrls(text)).not.toContain("/");
    expect(text.trim().split("\n").at(-1)).toContain(BASE.link);
  });

  it("decorative emoji are fine — only INSTRUCTIONS to react are gated", () => {
    // The sign-off 🙌 is decoration, not a thing we ask them to do.
    expect(buildRecruitInviteDm(BASE)).toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("buildRecruitGroupInviteDm — MoM/ratings-only org", () => {
  const g = { firstName: "Abid", matchName: "Tuesday 7-a-side", matchWhen: "Tue 1 Sept, 21:30" };

  it("still points them at the GROUP, which is where they join", () => {
    const text = buildRecruitGroupInviteDm(g);
    expect(text).toContain("*IN*");
    expect(text.toLowerCase()).toContain("group");
    expect(text).not.toContain("http");
  });

  it("uses no em dashes, en dashes or slashes", () => {
    const text = buildRecruitGroupInviteDm(g);
    expect(text).not.toContain("—");
    expect(text).not.toContain("–");
    expect(withoutUrls(text)).not.toContain("/");
  });
});
