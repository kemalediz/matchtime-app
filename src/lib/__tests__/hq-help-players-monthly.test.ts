/**
 * "@Match Time help players" in a MONTHLY club's admin group (review
 * 2026-11-15). The HQ "Finding players" lines are the weekly squad's
 * commands, so a monthly club with no organiser picks got only the way
 * back to the menu. It now says how players join the month, from facts the
 * code already has, each only while it is true for the club:
 *   - an organiser's tagged add to this month's list (month-newcomers.ts,
 *     `applyMonthAdd`: the organisers' group is one of its doors);
 *   - pay as you go, IN in the players' group (the monthly availability
 *     explainer's own rule), while attendance is on;
 *   - the friend link, which works only while attendance is on
 *     (`decideThirdPartyIn`) and prices a monthly week as PAYG
 *     (friend-link/facts.ts);
 *   - the player pool, asked from the match page (`pool/ask-round.ts`,
 *     which a monthly week reaches through monthly-week-asks.ts), while
 *     the pool is open for the club.
 */
import { describe, expect, it } from "vitest";
import { buildHqHelp, hqHelpTopicReply } from "@/lib/admin-group-help";
import { helpFeaturesFrom } from "@/lib/onboarding-conversation";
import type { OrgFeatures } from "@/lib/org-features";
import type { HelpClubFacts } from "@/lib/help-club-facts";

function orgFeatures(over: Partial<OrgFeatures> = {}): OrgFeatures {
  return {
    botEnabled: true,
    attendance: true,
    bench: true,
    teamBalancing: true,
    momVoting: true,
    playerRating: true,
    reminders: true,
    statsQa: true,
    paymentTracking: true,
    paymentCollection: false,
    language: "en",
    benchPickMode: "first-come",
    squadMode: "monthly",
    ...over,
  } as OrgFeatures;
}

const MONTHLY_GATES = { squad: false, graphics: true, picks: false, paid: true, free: true, pool: false };
const POOL_OPEN: HelpClubFacts = { pool: { open: true, platformOpen: true, clubFlag: true }, partners: { active: 0 } };
const POOL_SHUT: HelpClubFacts = { pool: { open: false, platformOpen: true, clubFlag: false }, partners: { active: 0 } };

const ask = (lang: string, features: OrgFeatures, club: HelpClubFacts, gates = MONTHLY_GATES) =>
  hqHelpTopicReply({ orgId: "org-vets", lang, gates, req: { topic: "find_players" }, features: { ...features, language: lang } as OrgFeatures, club });

// Review of #605: the HQ menu lists only topics with lines of their own, so
// a monthly club without organiser picks never saw "players" and could not
// find the answer above.
describe("the HQ menu of a monthly club lists the players topic", () => {
  const helpFeats = (over: Partial<OrgFeatures> = {}) => helpFeaturesFrom(orgFeatures(over), POOL_SHUT);
  const wordsOf = (menu: string) => [...menu.matchAll(/^\S+ \*([^*]+)\*: /gmu)].map((m) => m[1]);

  it("no organiser picks: listed, as how players join the month", () => {
    const menu = buildHqHelp({ lang: "en", ...MONTHLY_GATES, features: helpFeats() });
    expect(wordsOf(menu)).toContain("players");
    expect(menu).toContain(`📣 *players*: how players join your monthly squad\n`);
  });

  it("Turkish", () => {
    const menu = buildHqHelp({ lang: "tr", ...MONTHLY_GATES, features: helpFeats({ language: "tr" }) });
    expect(menu).toContain(`*oyuncu bulma*: oyuncular aylık kadronuza nasıl katılır\n`);
  });

  it("its settings unread: still listed (the answer always has the add line)", () => {
    expect(wordsOf(buildHqHelp({ lang: "en", ...MONTHLY_GATES }))).toContain("players");
  });

  it("a weekly club's menu is as before", () => {
    const menu = buildHqHelp({ lang: "en", ...MONTHLY_GATES, squad: true, paid: false, features: helpFeats({ squadMode: "weekly" }) });
    expect(menu).toContain(`📣 *players*: finding players when you're short\n`);
  });
});

describe("help players in a monthly club's admin group", () => {
  it("says how players join, not only the way back to the menu", async () => {
    const reply = await ask("en", orgFeatures(), POOL_SHUT);
    expect(reply).not.toBe(`↩️ *@Match Time help* for the menu.`);
    expect(reply).toContain(`👥 *How players join your monthly squad*`);
    expect(reply).toContain(`*"@Match Time add Tom to the November list, he's paid"*`);
    expect(reply).toContain(`say *In* in the players' group`);
    expect(reply).toContain(`bring a friend`);
    expect(reply).not.toContain(`player pool`);
    expect(reply.split("\n").at(-1)).toBe(`↩️ *@Match Time help* for the menu.`);
  });

  it("names the player pool only while it is open for the club", async () => {
    expect(await ask("en", orgFeatures(), POOL_OPEN)).toContain(`MatchTime player pool from the match page`);
  });

  it("attendance off: no IN and no friend link, which need it", async () => {
    const reply = await ask("en", orgFeatures({ attendance: false }), POOL_SHUT);
    expect(reply).toContain(`add Tom to the November list`);
    expect(reply).not.toContain(`*In*`);
    expect(reply).not.toContain(`friend`);
  });

  it("organiser picks: the pick line stays, with how players join", async () => {
    const reply = await ask("en", orgFeatures({ benchPickMode: "organiser" }), POOL_SHUT, { ...MONTHLY_GATES, picks: true });
    expect(reply).toContain(`When I ask you to pick who plays`);
    expect(reply).toContain(`How players join your monthly squad`);
  });

  it("Turkish", async () => {
    const reply = await ask("tr", orgFeatures(), POOL_OPEN);
    expect(reply).toContain(`👥 *Oyuncular aylık kadronuza nasıl katılır*`);
    expect(reply).toContain(`*"@Match Time Tom'u Kasım listesine ekle, ödedi"*`);
    expect(reply).toContain(`*varım*`);
    expect(reply).toContain(`MatchTime oyuncu havuzu`);
    expect(reply).not.toMatch(/[—–]/);
  });

  it("a weekly club's answer is as before (no monthly block)", async () => {
    const reply = await ask("en", orgFeatures({ squadMode: "weekly" }), POOL_SHUT, { ...MONTHLY_GATES, squad: true, paid: false });
    expect(reply).toContain(`ask the group if anyone can play`);
    expect(reply).not.toContain(`monthly squad`);
  });
});
