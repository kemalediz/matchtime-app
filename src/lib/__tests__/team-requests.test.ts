/**
 * The two deterministic readings that decide whether MatchTime touches
 * the team sheet at all (2026-09-29, after the Sutton FC incident of
 * Thu 24 Sep 22:51 BST).
 *
 *   22:51  "@Match Time put me in the same team with these guys in the
 *           match 😀"   (a joke, after a chemistry table)
 *          → routed `balancer`, extracted `generate` with a pairing,
 *            and the balancer BUILT the teams for Tue 29 Sep, five days
 *            early.
 *   22:52  "@Match Time delete these teams, early to form them, there
 *           is still 5 days"
 *          → routed `admin_ops`, extracted `other`, nothing happened
 *            and nobody was told.
 *
 * Kemal's rule: teams are built only when somebody CLEARLY asks for them
 * to be built, and only on match day; an admin can clear them. Both
 * readings are made here on the raw text, in code, so a model's reading
 * of a joke can never again be the thing that runs the balancer.
 */
import { describe, expect, it } from "vitest";
import {
  isClearTeamsRequest,
  isExplicitTeamBuildRequest,
  isMatchDay,
  londonDateKey,
} from "../team-requests";

describe("isExplicitTeamBuildRequest: the incident", () => {
  it("a pairing joke is NOT a request to build the teams", () => {
    expect(
      isExplicitTeamBuildRequest("@Match Time put me in the same team with these guys in the match 😀"),
    ).toBe(false);
  });

  it("the delete request is not a build request either", () => {
    expect(
      isExplicitTeamBuildRequest("@Match Time delete these teams, early to form them, there is still 5 days"),
    ).toBe(false);
  });
});

describe("isExplicitTeamBuildRequest: English asks the club really makes", () => {
  // The measured production corpus (team-ops-engine-batch.ts header),
  // plus the obvious neighbours.
  const yes = [
    "@Match Time generate the teams",
    "@Match Time generate teams",
    "@Match Time generate the teams, put me and Sait to the same team",
    "@Match Time regenerate the teams once more with Erdal's rating updated",
    "now setup the teams again @Match Time",
    "@Match Time set up the teams",
    "Make the teams",
    "@Match Time make teams please",
    "@Match Time can you build the teams",
    "@Match Time balance the teams",
    "@Match Time rebalance the teams",
    "@Match Time create the teams",
    "@Match Time pick the teams",
    "@Match Time sort out the teams",
    "@Match Time shuffle the teams",
    "@Match Time reshuffle the teams",
    "@Match Time generate the teams now, come up with fun team names",
    "@Match Time generate the teams as Sharks and Wolves",
    "@Match Time some are not happy with the teams, could you please come with an alternative?",
    "@Match Time generate new teams",
    "@Match Time make 2 teams",
    "@Match Time generate the line-ups",
    "@Match Time GENERATE THE TEAMS",
    // The coordinator's pre-merge list (2026-09-29).
    "@Match Time teams please",
    "@Match Time teams pls",
    "@Match Time can you do the teams",
    "@Match Time do the teams please",
    "@Match Time sort the teams",
    "@Match Time create teams",
    "@Match Time regenerate the teams",
  ];
  for (const body of yes) {
    it(`builds: ${body}`, () => expect(isExplicitTeamBuildRequest(body)).toBe(true));
  }

  const no = [
    "@Match Time put me in the same team with these guys in the match 😀",
    "@Match Time put me with Sait",
    "@Match Time I want to be in the same team as Elvin",
    "@Match Time make sure I'm in the same team as Elvin",
    "@Match Time show the teams",
    "@Match Time what are the teams?",
    "@Match Time do not regenerate the teams. Instead swap Elvin with Raihan and share us the teams",
    "@Match Time don't generate the teams yet",
    "@Match Time no need to make the teams",
    "@Match Time who is playing?",
    "the teams were great last week",
    "@Match Time swap Kemal and Sait",
    "@Match Time rename the teams to Sharks and Wolves",
    // "do" is deliberately not a build verb: a question about the sheet
    // must never regenerate it.
    "@Match Time do these teams look fair?",
    "@Match Time put me in the same team with these guys",
    "@Match Time who is in my team",
    "@Match Time delete these teams",
    "@Match Time don't do the teams yet",
    "@Match Time teams were unfair last week",
  ];
  for (const body of no) {
    it(`does not build: ${body}`, () => expect(isExplicitTeamBuildRequest(body)).toBe(false));
  }
});

describe("isExplicitTeamBuildRequest: Turkish", () => {
  const yes = [
    "@Match Time takımları kur",
    "@Match Time takımları kurar mısın",
    "@Match Time takımları oluştur",
    "@Match Time takımları yeniden oluştur",
    "@Match Time takımları yap",
    "@Match Time takımları ayarla lütfen",
    "@Match Time takımları dengele",
    "@Match Time TAKIMLARI KUR",
    "@Match Time takım yap",
  ];
  for (const body of yes) {
    it(`builds: ${body}`, () => expect(isExplicitTeamBuildRequest(body)).toBe(true));
  }

  const no = [
    "@Match Time beni Sait ile aynı takıma koy",
    "@Match Time takımları göster",
    "@Match Time takımları kurma",
    "@Match Time takımları henüz oluşturma",
    "@Match Time takımları sil",
  ];
  for (const body of no) {
    it(`does not build: ${body}`, () => expect(isExplicitTeamBuildRequest(body)).toBe(false));
  }
});

describe("isClearTeamsRequest", () => {
  it("THE INCIDENT MESSAGE is a clear request", () => {
    expect(
      isClearTeamsRequest("@Match Time delete these teams, early to form them, there is still 5 days"),
    ).toBe(true);
  });

  const yes = [
    "@Match Time delete the teams",
    "@Match Time clear the teams",
    "@Match Time scrap the teams",
    "@Match Time scrap these teams",
    "@Match Time remove the teams",
    "@Match Time cancel the teams",
    "@Match Time reset the teams",
    "@Match Time wipe the teams",
    "@Match Time clear the team sheet",
    "@Match Time please delete the current teams",
    "@Match Time takımları sil",
    "@Match Time takımları silebilir misin",
    "@Match Time takımları iptal et",
    "@Match Time takımları temizle",
    "@Match Time takımları kaldır",
    "@Match Time takımları boz",
  ];
  for (const body of yes) {
    it(`clears: ${body}`, () => expect(isClearTeamsRequest(body)).toBe(true));
  }

  const no = [
    "@Match Time generate the teams",
    "@Match Time show the teams",
    "@Match Time remove me from the teams",
    "@Match Time don't delete the teams",
    "@Match Time do not clear the teams",
    "@Match Time put me in the same team with these guys in the match 😀",
    "@Match Time delete my rating",
    "@Match Time takımları kur",
    "@Match Time takımları silme",
    "@Match Time takımları iptal etme",
    "@Match Time I'm out, remove me",
  ];
  for (const body of no) {
    it(`does not clear: ${body}`, () => expect(isClearTeamsRequest(body)).toBe(false));
  }

  it("a message that also asks to BUILD is left to the build path, which replaces the sheet", () => {
    expect(isClearTeamsRequest("@Match Time scrap the teams and generate new teams")).toBe(false);
  });
});

describe("match day is the London calendar date of the match", () => {
  it("Thursday 22:51 BST is not match day for a Tuesday match", () => {
    const now = new Date("2026-09-24T21:51:00Z"); // Thu 22:51 BST
    const kickoff = new Date("2026-09-29T19:30:00Z"); // Tue 20:30 BST
    expect(isMatchDay(kickoff, now)).toBe(false);
  });

  it("Tuesday morning is match day for a Tuesday evening match", () => {
    const now = new Date("2026-09-29T07:00:00Z"); // Tue 08:00 BST
    const kickoff = new Date("2026-09-29T19:30:00Z");
    expect(isMatchDay(kickoff, now)).toBe(true);
  });

  it("uses LONDON dates, not UTC: 00:30 BST is already the next day in London", () => {
    // 23:30 UTC on Mon 28 Sep is 00:30 BST on Tue 29 Sep.
    const now = new Date("2026-09-28T23:30:00Z");
    const kickoff = new Date("2026-09-29T19:30:00Z");
    expect(londonDateKey(now)).toBe("2026-09-29");
    expect(isMatchDay(kickoff, now)).toBe(true);
  });

  it("the day after is not match day", () => {
    const now = new Date("2026-09-30T09:00:00Z");
    const kickoff = new Date("2026-09-29T19:30:00Z");
    expect(isMatchDay(kickoff, now)).toBe(false);
  });
});
