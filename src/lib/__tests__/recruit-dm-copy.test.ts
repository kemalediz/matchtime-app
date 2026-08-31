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
 */
import { describe, it, expect } from "vitest";
import { buildRecruitInviteDm, buildRecruitGroupInviteDm } from "@/lib/recruit";

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

  it("offers BOTH ways to say yes: reply IN and a 👍 reaction", () => {
    const text = buildRecruitInviteDm(BASE);
    expect(text).toContain("*IN*");
    expect(text).toContain("👍");
  });

  // Owner, 2026-08-31: saying NO must be exactly as easy as saying yes.
  // A parallel chase-up feature DMs everyone who stays silent, so an
  // effortless "no" is what keeps the club from looking naggy.
  it("offers BOTH ways to say no, symmetrically: reply OUT and a 👎 reaction", () => {
    const text = buildRecruitInviteDm(BASE);
    expect(text).toContain("*OUT*");
    expect(text).toContain("👎");
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
