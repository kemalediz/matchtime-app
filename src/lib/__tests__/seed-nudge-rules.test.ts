/**
 * The seed-rating nudge's decision rule, keys, timing and text
 * (seed-nudge-rules.ts, seed-nudge-copy.ts). Pure: no Prisma, no model.
 */
import { describe, it, expect } from "vitest";
import {
  MANUAL_SEED_NUDGE_MARKER,
  decideSeedNudge,
  joinAdminNames,
  ratingMinutes,
  seedNudgeAlreadySent,
  seedNudgeBaseKey,
  seedNudgeDueFrom,
  seedNudgeKey,
  type SeedNudgeInput,
} from "../seed-nudge-rules";
import { buildSeedNudgeNotice } from "../seed-nudge-copy";

const ORG = "org-fnf";
// FNF: went live on Wednesday 14 Oct 2026 at 20:00 London, plays Friday 16 Oct 21:00.
const LIVE_AT = new Date("2026-10-14T19:00:00.000Z");
const MATCH = new Date("2026-10-16T20:00:00.000Z");
const THU_0930 = new Date("2026-10-15T08:30:00.000Z");

function input(over: Partial<SeedNudgeInput> = {}): SeedNudgeInput {
  return {
    now: THU_0930,
    live: true,
    squadMode: "weekly",
    teamBalancing: true,
    liveAt: LIVE_AT,
    alreadyNudged: false,
    match: { date: MATCH, status: "UPCOMING" },
    confirmed: { total: 18, seeded: 0 },
    active: { total: 24, seeded: 0 },
    clubHasPeerRatings: false,
    ...over,
  };
}

describe("seed nudge keys", () => {
  it("one club-wide claim, and one key per recipient under it", () => {
    expect(seedNudgeBaseKey(ORG)).toBe("org-org-fnf:seed-nudge");
    expect(seedNudgeKey(ORG, "admin-group")).toBe("org-org-fnf:seed-nudge:admin-group");
    expect(seedNudgeKey(ORG, "user-1")).toBe("org-org-fnf:seed-nudge:user-1");
  });

  it("the club counts as nudged once the claim or any recipient's key is sent", () => {
    expect(seedNudgeAlreadySent(ORG, new Set())).toBe(false);
    expect(seedNudgeAlreadySent(ORG, new Set(["org-org-fnf:seed-nudge"]))).toBe(true);
    expect(seedNudgeAlreadySent(ORG, new Set(["org-org-fnf:seed-nudge:user-1"]))).toBe(true);
    expect(seedNudgeAlreadySent(ORG, new Set(["org-org-fnf:seed-nudge:admin-group"]))).toBe(true);
    // another club's claim, or a look-alike key, does not count
    expect(seedNudgeAlreadySent(ORG, new Set(["org-org-other:seed-nudge"]))).toBe(false);
    expect(seedNudgeAlreadySent(ORG, new Set(["org-org-fnf:seed-nudgex"]))).toBe(false);
  });

  it("the manual message's marker is the phrase both texts share", () => {
    expect(MANUAL_SEED_NUDGE_MARKER).toBe("rough rating from 1 to 10");
  });
});

describe("seedNudgeDueFrom: the morning after go-live or the day before the match, whichever first", () => {
  it("live Wednesday, match Friday: Thursday 09:00 (both rules agree)", () => {
    expect(seedNudgeDueFrom({ liveAt: LIVE_AT, matchDate: MATCH }).toISOString()).toBe("2026-10-15T08:00:00.000Z");
  });

  it("live Monday, match Friday: Tuesday 09:00, the morning after go-live", () => {
    const liveAt = new Date("2026-10-12T21:30:00.000Z"); // Mon 22:30 BST
    expect(seedNudgeDueFrom({ liveAt, matchDate: MATCH }).toISOString()).toBe("2026-10-13T08:00:00.000Z");
  });

  it("live Thursday evening, match Friday: Thursday 09:00 has passed, so due at once", () => {
    const liveAt = new Date("2026-10-15T18:00:00.000Z");
    expect(seedNudgeDueFrom({ liveAt, matchDate: MATCH }).toISOString()).toBe("2026-10-15T08:00:00.000Z");
  });

  it("never through go-live: the day before the match", () => {
    expect(seedNudgeDueFrom({ liveAt: null, matchDate: MATCH }).toISOString()).toBe("2026-10-15T08:00:00.000Z");
  });

  it("is on London's clock across the clocks going back (25 Oct 2026)", () => {
    // Live Sat 24 Oct 23:30 BST; Sunday is 25 hours long; Monday 09:00 is GMT.
    const liveAt = new Date("2026-10-24T22:30:00.000Z");
    const matchDate = new Date("2026-10-30T21:00:00.000Z");
    expect(seedNudgeDueFrom({ liveAt, matchDate }).toISOString()).toBe("2026-10-25T09:00:00.000Z");
  });
});

describe("decideSeedNudge: every condition", () => {
  it("FNF on Thursday morning: due, counting the match's confirmed players", () => {
    expect(decideSeedNudge(input())).toEqual({ due: true, pool: "confirmed", total: 18, unseeded: 18 });
  });

  it("not a live club (still setting up)", () => {
    expect(decideSeedNudge(input({ live: false }))).toMatchObject({ due: false, reason: "not-live" });
  });

  it("monthly squad mode", () => {
    expect(decideSeedNudge(input({ squadMode: "monthly" }))).toMatchObject({ due: false, reason: "not-weekly" });
  });

  it("team balancing off", () => {
    expect(decideSeedNudge(input({ teamBalancing: false }))).toMatchObject({ due: false, reason: "no-team-balancing" });
  });

  it("already nudged (the claim, a sent nudge, or the manual message)", () => {
    expect(decideSeedNudge(input({ alreadyNudged: true }))).toMatchObject({ due: false, reason: "already" });
  });

  it("no upcoming match", () => {
    expect(decideSeedNudge(input({ match: null }))).toMatchObject({ due: false, reason: "no-match" });
  });

  it("teams already generated or published for the match", () => {
    expect(decideSeedNudge(input({ match: { date: MATCH, status: "TEAMS_GENERATED" } }))).toMatchObject({
      due: false,
      reason: "teams-made",
    });
    expect(decideSeedNudge(input({ match: { date: MATCH, status: "TEAMS_PUBLISHED" } }))).toMatchObject({
      due: false,
      reason: "teams-made",
    });
  });

  it("the match has kicked off", () => {
    expect(decideSeedNudge(input({ now: new Date(MATCH.getTime() + 60_000) }))).toMatchObject({ due: false, reason: "no-match" });
  });

  it("the club already has peer ratings from a played game", () => {
    expect(decideSeedNudge(input({ clubHasPeerRatings: true }))).toMatchObject({ due: false, reason: "has-peer-ratings" });
  });

  it("half or more of the confirmed players have a seed: not due", () => {
    expect(decideSeedNudge(input({ confirmed: { total: 18, seeded: 9 } }))).toMatchObject({ due: false, reason: "mostly-seeded" });
    expect(decideSeedNudge(input({ confirmed: { total: 18, seeded: 8 } }))).toEqual({
      due: true,
      pool: "confirmed",
      total: 18,
      unseeded: 10,
    });
  });

  it("no confirmed players yet: counts the club's active members instead", () => {
    expect(decideSeedNudge(input({ confirmed: { total: 0, seeded: 0 }, active: { total: 24, seeded: 3 } }))).toEqual({
      due: true,
      pool: "members",
      total: 24,
      unseeded: 21,
    });
    expect(decideSeedNudge(input({ confirmed: { total: 0, seeded: 0 }, active: { total: 24, seeded: 12 } }))).toMatchObject({
      due: false,
      reason: "mostly-seeded",
    });
  });

  it("nobody to rate at all", () => {
    expect(decideSeedNudge(input({ confirmed: { total: 0, seeded: 0 }, active: { total: 0, seeded: 0 } }))).toMatchObject({
      due: false,
      reason: "no-players",
    });
  });

  it("too early: before the morning after go-live and the day before the match", () => {
    const liveAt = new Date("2026-10-12T21:30:00.000Z"); // Monday night
    expect(decideSeedNudge(input({ liveAt, now: new Date("2026-10-13T07:30:00.000Z") }))).toMatchObject({
      due: false,
      reason: "too-early",
    });
    expect(decideSeedNudge(input({ liveAt, now: new Date("2026-10-13T08:00:00.000Z") }))).toMatchObject({ due: true });
  });

  it("outside message hours (23:00 to 08:59 London): waits", () => {
    expect(decideSeedNudge(input({ now: new Date("2026-10-15T22:30:00.000Z") }))).toMatchObject({
      due: false,
      reason: "outside-hours",
    });
    expect(decideSeedNudge(input({ now: new Date("2026-10-15T21:59:00.000Z") }))).toMatchObject({ due: true });
  });
});

describe("helpers", () => {
  it("names the admins the way the manual text did", () => {
    expect(joinAdminNames([], "en")).toBe("");
    expect(joinAdminNames(["Hamzah Khan"], "en")).toBe("Hamzah");
    expect(joinAdminNames(["Hamzah Khan", "Raihan Ahmed"], "en")).toBe("Hamzah or Raihan");
    expect(joinAdminNames(["Hamzah", "Raihan", "Ali"], "en")).toBe("Hamzah, Raihan or Ali");
    expect(joinAdminNames(["Hamzah", "Raihan"], "tr")).toBe("Hamzah ya da Raihan");
    // a duplicate first name or a blank is said once
    expect(joinAdminNames(["Hamzah", "Hamzah Khan", "  "], "en")).toBe("Hamzah");
  });

  it("about 15 seconds a player, never under 2 minutes", () => {
    expect(ratingMinutes(18)).toBe(5);
    expect(ratingMinutes(24)).toBe(6);
    expect(ratingMinutes(3)).toBe(2);
  });
});

describe("the text", () => {
  const LINK = "https://matchtime.ai/admin/players/ratings";

  it("English, for a club like FNF", () => {
    expect(
      buildSeedNudgeNotice({
        lang: "en",
        matchDate: MATCH,
        adminNames: ["Hamzah Khan", "Raihan Ahmed"],
        pool: "confirmed",
        total: 18,
        unseeded: 18,
        anySeeded: false,
        peerRatingsOn: true,
        link: LINK,
      }),
    ).toBe(
      "⭐ *One thing before Friday's teams*\n\n" +
        "I don't know anyone's level yet, so for now I'd treat every player the same and the teams could come out lopsided.\n\n" +
        "Hamzah or Raihan: give each player a rough rating from 1 to 10 here:\n" +
        LINK +
        "\n\n" +
        "Players never see these, they only help me balance the sides. Rating just the 18 players in Friday's squad is enough, about 5 minutes.\n\n" +
        "After that I learn from the ratings players give each other after every game, so this is only needed once.",
    );
  });

  it("Turkish, for a club like FNF", () => {
    expect(
      buildSeedNudgeNotice({
        lang: "tr",
        matchDate: MATCH,
        adminNames: ["Hamzah Khan", "Raihan Ahmed"],
        pool: "confirmed",
        total: 18,
        unseeded: 18,
        anySeeded: false,
        peerRatingsOn: true,
        link: LINK,
      }),
    ).toBe(
      "⭐ *Cuma günkü takımlardan önce bir şey*\n\n" +
        "Henüz kimsenin seviyesini bilmiyorum, bu yüzden şimdilik her oyuncuyu aynı sayarım ve takımlar dengesiz çıkabilir.\n\n" +
        "Hamzah ya da Raihan: her oyuncuya 1 ile 10 arasında kabaca bir puan verin:\n" +
        LINK +
        "\n\n" +
        "Oyuncular bu puanları hiç görmez, yalnızca takımları dengelememe yardım ederler. Yalnızca Cuma günkü kadrodaki 18 oyuncuyu puanlamanız yeterli, yaklaşık 5 dakika sürer.\n\n" +
        "Sonrasında her maçtan sonra oyuncuların birbirine verdiği puanlardan öğrenirim, yani bu yalnızca bir kez gerekir.",
    );
  });

  it("some players seeded, no confirmed players, no admin names, peer ratings off", () => {
    const out = buildSeedNudgeNotice({
      lang: "en",
      matchDate: MATCH,
      adminNames: [],
      pool: "members",
      total: 24,
      unseeded: 21,
      anySeeded: true,
      peerRatingsOn: false,
      link: LINK,
    });
    expect(out).toContain("I don't know most players' level yet");
    expect(out).toContain("\n\nGive each player a rough rating from 1 to 10 here:\n");
    expect(out).toContain("Rating the 21 players with no rating yet takes about 6 minutes.");
    expect(out).toContain("You can change them any time on the same page.");
    expect(out).not.toContain("After that I learn");
  });

  it("names the players and the match day, one player or many (Kemal, 2026-10-21)", () => {
    const base = {
      matchDate: MATCH,
      adminNames: [],
      anySeeded: false,
      peerRatingsOn: true,
      link: LINK,
    };
    const week = (lang: string, n: number) =>
      buildSeedNudgeNotice({ ...base, lang, pool: "confirmed", total: n, unseeded: n });
    const club = (lang: string, n: number) =>
      buildSeedNudgeNotice({ ...base, lang, pool: "members", total: n + 3, unseeded: n });
    expect(week("en", 1)).toContain("Rating just the 1 player in Friday's squad is enough, about 2 minutes.");
    expect(week("en", 8)).toContain("Rating just the 8 players in Friday's squad is enough, about 2 minutes.");
    expect(club("en", 1)).toContain("Rating the 1 player with no rating yet takes about 2 minutes.");
    expect(club("en", 8)).toContain("Rating the 8 players with no rating yet takes about 2 minutes.");
    expect(week("tr", 1)).toContain("Yalnızca Cuma günkü kadrodaki 1 oyuncuyu puanlamanız yeterli, yaklaşık 2 dakika sürer.");
    expect(week("tr", 8)).toContain("Yalnızca Cuma günkü kadrodaki 8 oyuncuyu puanlamanız yeterli, yaklaşık 2 dakika sürer.");
    expect(club("tr", 1)).toContain("Henüz puanı olmayan 1 oyuncuyu puanlamak yaklaşık 2 dakika sürer.");
    expect(club("tr", 8)).toContain("Henüz puanı olmayan 8 oyuncuyu puanlamak yaklaşık 2 dakika sürer.");
  });

  it("never a dash or a greeting", () => {
    for (const lang of ["en", "tr"] as const) {
      const out = buildSeedNudgeNotice({
        lang,
        matchDate: MATCH,
        adminNames: ["A"],
        pool: "members",
        total: 5,
        unseeded: 5,
        anySeeded: false,
        peerRatingsOn: true,
        link: LINK,
      });
      expect(out).not.toMatch(/[—–]/);
      expect(out).not.toMatch(/good (morning|afternoon|evening)|günaydın/i);
    }
  });
});
