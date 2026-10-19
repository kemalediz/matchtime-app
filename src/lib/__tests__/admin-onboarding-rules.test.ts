/**
 * THE STANDARD WELCOME NOTICES TO A CLUB'S ADMINS (2026-10-15), pure rules
 * and text (admin-onboarding-rules.ts). No database, no model.
 *
 *   A "Getting <club> ready"   at GO, built from what is still not done;
 *   B "Teams for <weekday>"    once the squad is first set for the club's
 *                              first proposed teams.
 *
 * FNF-like: organisers announce, organiser pick, rolling, admin group
 * linked, plays Friday 21:00, Teams ready 10:00 (the organisers default).
 * Default club: MatchTime announces, first-come, no Teams ready time.
 */
import { describe, it, expect } from "vitest";
import {
  adminOnboardingClaimKeys,
  buildFirstTeamsNotice,
  buildGettingReady,
  decideFirstTeams,
  firstTeamsAlreadySent,
  firstTeamsKey,
  gettingReadyItems,
  gettingReadyKey,
  type FirstTeamsInput,
  type GettingReadyClub,
} from "../admin-onboarding-rules";
import { seedNudgeAlreadySent } from "../seed-nudge-rules";
import { en } from "../i18n/strings.en";
import { tr } from "../i18n/strings.tr";

const ORG = "org-fnf";
const KICKOFF = new Date("2026-10-16T20:00:00.000Z"); // Fri 21:00 London
const READY_AT = new Date("2026-10-16T09:00:00.000Z"); // Fri 10:00 London
const THU_2000 = new Date("2026-10-15T19:00:00.000Z");
const LINK = "https://matchtime.example/admin/settings";

const FNF: GettingReadyClub = {
  name: "FNF",
  language: "en",
  squadMode: "weekly",
  featureAttendance: true,
  listAnnouncer: "organisers",
  benchPickMode: "organiser",
  paymentCollectionEnabled: false,
  paymentHolderId: null,
};
const DEFAULT_CLUB: GettingReadyClub = {
  name: "Harbour FC",
  language: "en",
  squadMode: "weekly",
  featureAttendance: true,
  listAnnouncer: "matchtime",
  benchPickMode: "first-come",
  paymentCollectionEnabled: false,
  paymentHolderId: null,
};

const ready = (club: GettingReadyClub, over: Partial<Parameters<typeof buildGettingReady>[0]> = {}) =>
  buildGettingReady({ club, audience: "group", nextMatchDate: KICKOFF, activityDays: [5], link: LINK, ...over });

describe("keys: once per club, and the first-teams notice that carries the seed line counts as the seed nudge", () => {
  it("names", () => {
    expect(gettingReadyKey(ORG)).toBe(`org-${ORG}:getting-ready`);
    expect(firstTeamsKey(ORG, "admin-group", false)).toBe(`org-${ORG}:first-teams:admin-group`);
    expect(firstTeamsKey(ORG, "admin-group", true)).toBe(`org-${ORG}:seed-nudge:first-teams:admin-group`);
    expect(adminOnboardingClaimKeys(ORG)).toEqual([`org-${ORG}:getting-ready`, `org-${ORG}:first-teams`]);
  });
  it("first-teams sent: the bare claim, either delivery key, nothing else", () => {
    expect(firstTeamsAlreadySent(ORG, new Set())).toBe(false);
    expect(firstTeamsAlreadySent(ORG, new Set([`org-${ORG}:first-teams`]))).toBe(true);
    expect(firstTeamsAlreadySent(ORG, new Set([`org-${ORG}:first-teams:u1`]))).toBe(true);
    expect(firstTeamsAlreadySent(ORG, new Set([`org-${ORG}:seed-nudge:first-teams:admin-group`]))).toBe(true);
    expect(firstTeamsAlreadySent(ORG, new Set([`org-${ORG}:seed-nudge:admin-group`]))).toBe(false);
    expect(firstTeamsAlreadySent(ORG, new Set([`org-other:first-teams`]))).toBe(false);
  });
  it("a delivered first-teams notice with the seed line stops the seed nudge", () => {
    expect(seedNudgeAlreadySent(ORG, new Set([firstTeamsKey(ORG, "admin-group", true)]))).toBe(true);
    expect(seedNudgeAlreadySent(ORG, new Set([firstTeamsKey(ORG, "admin-group", false)]))).toBe(false);
  });
});

describe("A: Getting <club> ready", () => {
  it("FNF in its admin group: paste now, no need to tag, help; no collector line (fees off)", () => {
    const text = ready(FNF)!;
    expect(text).toBe(
      [
        "🧰 *Getting FNF ready*",
        "📋 Paste the squad list for Friday's game here now. I'll show you what it changes, and *YES* within 30 minutes applies it.",
        "💬 No need to tag me here. I read every message from an admin in this group, so just say what you need in your own words. Your normal chat is fine too, I only act on clear instructions. In the main chat, players say IN or OUT without tagging me, and tag me only to ask me something.",
        "Ask me here any time what I can do, in your own words (for example *what can you do?*).",
      ].join("\n\n"),
    );
  });

  it("no game yet but an active one: paste from tomorrow, when the game is added", () => {
    const text = ready(FNF, { nextMatchDate: null })!;
    expect(text).toContain("📋 Friday's game is added overnight. From tomorrow, paste its squad list here: I'll show you what it changes, and *YES* within 30 minutes applies it.");
    expect(ready(FNF, { nextMatchDate: null, activityDays: [2, 5] })).toContain("📋 Your next game is added overnight.");
    expect(ready(FNF, { nextMatchDate: null, activityDays: [] })).not.toContain("📋");
  });

  it("the money collector, only while Collect match fees is on and nobody is set", () => {
    const fees = { ...FNF, paymentCollectionEnabled: true };
    expect(ready(fees)).toContain(`💷 Pick your *Money collector* in Settings, so I know who to ask how much each player owes after a match:\n${LINK}`);
    expect(ready({ ...fees, paymentHolderId: "u1" })).not.toContain("Money collector");
    expect(ready(FNF)).not.toContain("Money collector");
  });

  it("a club MatchTime announces for, first-come: no paste line (its players' In makes the list)", () => {
    const items = gettingReadyItems({ club: DEFAULT_CLUB, audience: "group", nextMatchDate: KICKOFF, activityDays: [5], link: LINK });
    expect(items.map((i) => i.kind)).toEqual(["no-tag", "help"]);
    // Organiser pick alone (MatchTime announces): an In goes on the bench, so the paste line is there.
    const pick = gettingReadyItems({ club: { ...DEFAULT_CLUB, benchPickMode: "organiser" }, audience: "group", nextMatchDate: KICKOFF, activityDays: [5], link: LINK });
    expect(pick.map((i) => i.kind)).toEqual(["paste-now", "no-tag", "help"]);
  });

  it("a monthly club: no paste line, and the no-tag line does not claim every message is read", () => {
    const text = ready({ ...FNF, squadMode: "monthly" })!;
    expect(text).not.toContain("📋");
    expect(text).toContain("💬 No need to tag me here: just say what you need in your own words. Your normal chat is fine too, I only act on clear instructions.");
    expect(text).not.toContain("I read every message");
  });

  it("attendance off: no main-chat IN or OUT sentence", () => {
    const text = ready({ ...FNF, featureAttendance: false })!;
    expect(text).not.toContain("IN or OUT");
    expect(text).not.toContain("📋");
  });

  it("by DM (no admin group): no 'here', no paste; sent only when there is something to do", () => {
    const fees = { ...DEFAULT_CLUB, paymentCollectionEnabled: true };
    const text = ready(fees, { audience: "dm" })!;
    expect(text).toBe(
      [
        "🧰 *Getting Harbour FC ready*",
        `💷 Pick your *Money collector* in Settings, so I know who to ask how much each player owes after a match:\n${LINK}`,
        "💬 In the main chat, players say IN or OUT without tagging me, and tag me only to ask me something.",
        "Message me *help* any time to see what I can do.",
      ].join("\n\n"),
    );
    expect(text).not.toContain("here");
    // Nothing to do by DM: no message at all.
    expect(ready(DEFAULT_CLUB, { audience: "dm" })).toBeNull();
    expect(ready(FNF, { audience: "dm" })).toBeNull();
  });

  it("in Turkish", () => {
    const text = ready({ ...FNF, language: "tr", paymentCollectionEnabled: true })!;
    expect(text).toContain("🧰 *FNF kulübünü hazırlayalım*");
    expect(text).toContain("Cuma");
    expect(text).toContain("*EVET*");
    expect(text).toContain("*VARIM* ya da *YOKUM*");
    expect(text).toContain("*neler yapabilirsin?*");
    expect(text).not.toMatch(/\bYES\b|\bhelp\b/);
  });

  it("no dashes, no greeting, no phone number, in either language", () => {
    for (const club of [FNF, { ...FNF, language: "tr" }]) {
      for (const audience of ["group", "dm"] as const) {
        const text = ready({ ...club, paymentCollectionEnabled: true }, { audience })!;
        expect(text).not.toMatch(/[–—]/);
        expect(text).not.toMatch(/good (morning|afternoon|evening)|günaydın|iyi akşamlar/i);
        expect(text).not.toMatch(/\+?44\s?7\d{3}/);
      }
    }
  });
});

const B: FirstTeamsInput = {
  now: THU_2000,
  live: true,
  squadMode: "weekly",
  attendance: true,
  adminGroupLinked: true,
  billingPaused: false,
  readyTime: "10:00",
  alreadySent: false,
  match: { date: KICKOFF, status: "UPCOMING", confirmed: 18, maxPlayers: 18 },
  pasteApplied: false,
  anyProposal: false,
};

describe("B: decideFirstTeams", () => {
  it("due once the squad is full, before the Teams ready time, for the club's first teams", () => {
    expect(decideFirstTeams(B)).toEqual({ due: true, readyAt: READY_AT });
  });
  it("a pasted list applied for the match sets the squad even when short", () => {
    const short = { ...B, match: { ...B.match!, confirmed: 15 } };
    expect(decideFirstTeams(short)).toEqual({ due: false, reason: "squad-not-set" });
    expect(decideFirstTeams({ ...short, pasteApplied: true })).toEqual({ due: true, readyAt: READY_AT });
  });
  it("not due", () => {
    const cases: Array<[Partial<FirstTeamsInput>, string]> = [
      [{ live: false }, "not-live"],
      [{ squadMode: "monthly" }, "not-weekly"],
      [{ attendance: false }, "no-attendance"],
      [{ adminGroupLinked: false }, "no-admin-group"],
      [{ billingPaused: true }, "billing-paused"],
      [{ readyTime: "off" }, "no-teams-ready"],
      [{ alreadySent: true }, "already"],
      [{ match: null }, "no-match"],
      [{ match: { ...B.match!, status: "TEAMS_GENERATED" } }, "teams-made"],
      [{ now: READY_AT }, "past-teams-ready"],
      // A ready time at or after kickoff never proposes (isProposalDue).
      [{ readyTime: "21:30" }, "no-teams-ready"],
      [{ anyProposal: true }, "not-first"],
    ];
    for (const [over, reason] of cases) expect(decideFirstTeams({ ...B, ...over })).toEqual({ due: false, reason });
  });
});

describe("B: the text", () => {
  const base = { lang: "en", matchDate: KICKOFF, readyTime: "10:00", confirmed: 18, maxPlayers: 18 };
  it("FNF (organisers share): post here, YES, the team sheet to share", () => {
    expect(buildFirstTeamsNotice({ ...base, organisers: true, seed: null })).toBe(
      [
        "🟥🟦 *Teams for Friday*",
        "The squad is set, 18 of 18. At 10:00 on Friday I'll build two balanced teams and post them here for you to check.",
        "Reply *YES* to make them final, or say *swap*, *move* or *reshuffle* if you want changes. Once they're final I send the team sheet here, a graphic to share with the players, and *team sheet* sends it again any time.",
      ].join("\n\n"),
    );
  });
  it("a club MatchTime announces for: YES posts them in the main chat", () => {
    const text = buildFirstTeamsNotice({ ...base, organisers: false, seed: null });
    expect(text).toContain("Reply *YES* to make them final and I'll post them in the main chat, or say *swap*, *move* or *reshuffle* if you want changes.");
    expect(text).not.toContain("share with the players");
  });
  it("the seed line, when nobody (or most) of the squad has a rating", () => {
    const none = buildFirstTeamsNotice({ ...base, organisers: true, seed: { anySeeded: false, link: "https://x.example/admin/players/ratings" } });
    expect(none).toContain(
      "⭐ No one in this squad has a rating yet, so the teams could come out lopsided. Before 10:00 on Friday, give each player a rough rating from 1 to 10 here:\nhttps://x.example/admin/players/ratings\nPlayers never see these.",
    );
    const most = buildFirstTeamsNotice({ ...base, organisers: true, seed: { anySeeded: true, link: "L" } });
    expect(most).toContain("⭐ Most of this squad have no rating yet");
  });
  it("in Turkish", () => {
    const text = buildFirstTeamsNotice({ ...base, lang: "tr", organisers: true, seed: { anySeeded: false, link: "L" } });
    expect(text).toContain("Cuma");
    expect(text).toContain("*EVET*");
    expect(text).toContain("*takım listesi*");
    expect(text).not.toMatch(/\bYES\b|\bswap\b|\bteam sheet\b/);
    expect(text).not.toMatch(/[–—]/);
  });
});

describe("string tables", () => {
  it("every new key exists in both languages", () => {
    for (const k of Object.keys(en).filter((k) => k.startsWith("ao_"))) expect(tr).toHaveProperty(k);
  });
});
