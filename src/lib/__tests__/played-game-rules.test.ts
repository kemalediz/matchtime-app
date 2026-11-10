/**
 * A TEAM CHANGE AFTER KICKOFF FIXES THE GAME JUST PLAYED (Kemal,
 * 2026-11-10). Mon 9 Nov, Vets, kickoff 20:15: Luca played for CJ on Bibs,
 * and once the game was over every WhatsApp team path looked only at games
 * not yet played, so a change aimed at next week's game or said "no teams
 * yet". The pure rules: which game a team change is for, which team
 * commands may fix a played game, and which HQ squad readings are a
 * line-up fix of it (a replacement for a player on its teams).
 */
import { describe, expect, it } from "vitest";
import { justPlayedMatch, playedGameReplacements, teamCommandFixesPlayedGame, type PlayedCandidate } from "../played-game-rules";
import type { HqSquadChange } from "../hq-squad-reader-prompt";

const at = (iso: string) => new Date(iso);
// Mon 9 Nov 2026, kickoff 20:15 London (GMT, so 20:15 UTC).
const KICKOFF = at("2026-11-09T20:15:00Z");
const played = (over: Partial<PlayedCandidate> = {}): PlayedCandidate => ({ id: "tonight", date: KICKOFF, status: "COMPLETED", hasTeams: true, ...over });
const nextWeek: PlayedCandidate = { id: "next", date: at("2026-11-16T20:15:00Z"), status: "UPCOMING", hasTeams: false };

describe("justPlayedMatch: which game a team change after kickoff is for", () => {
  it("today, after kickoff, a completed game with teams: that game", () => {
    expect(justPlayedMatch([played(), nextWeek], at("2026-11-09T22:30:00Z"))?.id).toBe("tonight");
  });

  it("a minute before midnight London is still the same day", () => {
    expect(justPlayedMatch([played(), nextWeek], at("2026-11-09T23:59:00Z"))?.id).toBe("tonight");
  });

  it("the next day (London): none, so the next game as before", () => {
    expect(justPlayedMatch([played(), nextWeek], at("2026-11-10T00:01:00Z"))).toBeNull();
  });

  it("London day, not UTC: in summer the day ends at 23:00 UTC", () => {
    // Thu 18 Jun 2026, BST: a 21:30 London kickoff is 20:30 UTC. 23:50
    // London is 22:50 UTC; 00:10 London on the 19th is still the 18th in UTC.
    const summer = played({ date: at("2026-06-18T20:30:00Z") });
    expect(justPlayedMatch([summer], at("2026-06-18T22:50:00Z"))?.id).toBe("tonight");
    expect(justPlayedMatch([summer], at("2026-06-18T23:10:00Z"))).toBeNull();
  });

  it("before kickoff: none (the upcoming game, as now)", () => {
    expect(justPlayedMatch([played({ status: "TEAMS_PUBLISHED" }), nextWeek], at("2026-11-09T19:00:00Z"))).toBeNull();
  });

  it("kicked off but not completed yet: none (the registration match is still that game)", () => {
    expect(justPlayedMatch([played({ status: "TEAMS_PUBLISHED" }), nextWeek], at("2026-11-09T20:30:00Z"))).toBeNull();
  });

  it("a cancelled game is never the target", () => {
    expect(justPlayedMatch([played({ status: "CANCELLED" }), nextWeek], at("2026-11-09T22:30:00Z"))).toBeNull();
  });

  it("no teams: none, so the next game as before", () => {
    expect(justPlayedMatch([played({ hasTeams: false }), nextWeek], at("2026-11-09T22:30:00Z"))).toBeNull();
  });

  it("a later game the same day still to kick off wins: none", () => {
    const early = played({ id: "early", date: at("2026-11-09T10:00:00Z") });
    const late: PlayedCandidate = { id: "late", date: at("2026-11-09T20:00:00Z"), status: "UPCOMING", hasTeams: false };
    expect(justPlayedMatch([early, late, nextWeek], at("2026-11-09T12:00:00Z"))).toBeNull();
  });

  it("two games today, both played: the later one is the game just played", () => {
    const early = played({ id: "early", date: at("2026-11-09T10:00:00Z") });
    const late = played({ id: "late", date: at("2026-11-09T18:00:00Z") });
    expect(justPlayedMatch([early, late, nextWeek], at("2026-11-09T21:00:00Z"))?.id).toBe("late");
  });

  it("the later game today has no teams: none, never the earlier one", () => {
    const early = played({ id: "early", date: at("2026-11-09T10:00:00Z") });
    const late = played({ id: "late", date: at("2026-11-09T18:00:00Z"), hasTeams: false });
    expect(justPlayedMatch([early, late], at("2026-11-09T21:00:00Z"))).toBeNull();
  });

  it("a later game today that was cancelled does not count", () => {
    const late: PlayedCandidate = { id: "late", date: at("2026-11-09T22:00:00Z"), status: "CANCELLED", hasTeams: false };
    expect(justPlayedMatch([played(), late], at("2026-11-09T21:00:00Z"))?.id).toBe("tonight");
  });

  it("yesterday's game: none", () => {
    expect(justPlayedMatch([played({ date: at("2026-11-08T20:15:00Z") })], at("2026-11-09T09:00:00Z"))).toBeNull();
  });
});

describe("teamCommandFixesPlayedGame: which team commands may change a played game", () => {
  it("show, a change and a suggestion: yes", () => {
    expect(teamCommandFixesPlayedGame({ kind: "show" })).toBe(true);
    expect(teamCommandFixesPlayedGame({ kind: "suggest" })).toBe(true);
    expect(teamCommandFixesPlayedGame({ kind: "change", swapSides: false, moves: ["A", "B"], sides: [], together: [] })).toBe(true);
  });

  it("new teams, an earlier sheet or a pasted sheet: no (they ask for YES, for a game to come)", () => {
    expect(teamCommandFixesPlayedGame({ kind: "reshuffle", sides: [], together: [] })).toBe(false);
    expect(teamCommandFixesPlayedGame({ kind: "restore" })).toBe(false);
    expect(teamCommandFixesPlayedGame({ kind: "set", red: ["A"], yellow: ["B"] })).toBe(false);
  });
});

describe("playedGameReplacements: an HQ squad reading that fixes the played game's line-up", () => {
  const SLOTS = new Set(["u-cj", "u-ali", "u-bob"]);
  const change = (over: Partial<HqSquadChange>): HqSquadChange => ({ name: "Luca", written: "Luca", userId: "u-luca", to: "in", replaces: "", ...over });

  it("Luca in for CJ, CJ out: one replacement", () => {
    const r = playedGameReplacements(
      [change({ replaces: "CJ", replacesUserId: "u-cj" }), change({ name: "CJ", written: "CJ", userId: "u-cj", to: "out" })],
      SLOTS,
    );
    expect(r).toEqual({ kind: "fix", fixes: [{ inUserId: "u-luca", inName: "Luca", outUserId: "u-cj" }] });
  });

  it("the arrival alone, with who he replaces: one replacement", () => {
    expect(playedGameReplacements([change({ replaces: "CJ", replacesUserId: "u-cj" })], SLOTS)).toEqual({
      kind: "fix",
      fixes: [{ inUserId: "u-luca", inName: "Luca", outUserId: "u-cj" }],
    });
  });

  it("a new person nobody in the club is: the fix keeps his name to add him", () => {
    expect(playedGameReplacements([change({ userId: null, replaces: "CJ", replacesUserId: "u-cj" })], SLOTS)).toEqual({
      kind: "fix",
      fixes: [{ inUserId: null, inName: "Luca", outUserId: "u-cj" }],
    });
  });

  it("the replaced player is not on the played game's teams: not a fix", () => {
    expect(playedGameReplacements([change({ replaces: "Zed", replacesUserId: "u-zed" })], SLOTS)).toEqual({ kind: "none" });
  });

  it("a plain squad change (Ben out, Tom in, Sam to the bench): not a fix, it stays with the next game", () => {
    expect(playedGameReplacements([change({ name: "Ben", userId: "u-ben", to: "out" })], SLOTS)).toEqual({ kind: "none" });
    expect(playedGameReplacements([change({})], SLOTS)).toEqual({ kind: "none" });
    expect(playedGameReplacements([change({ name: "Ali", userId: "u-ali", to: "out" })], SLOTS)).toEqual({ kind: "none" });
  });

  it("a replacement mixed with another squad change: not a fix (nothing is split)", () => {
    expect(
      playedGameReplacements([change({ replaces: "CJ", replacesUserId: "u-cj" }), change({ name: "Ben", userId: "u-ben", to: "out" })], SLOTS),
    ).toEqual({ kind: "none" });
  });

  it("an arrival who-is-who could not place: asked about, never written", () => {
    expect(playedGameReplacements([change({ unclear: true, replaces: "CJ", replacesUserId: "u-cj" })], SLOTS)).toEqual({
      kind: "unclear",
      names: ["Luca"],
    });
  });

  it("two arrivals for one player, or one arrival twice: not a fix", () => {
    expect(
      playedGameReplacements(
        [change({ replaces: "CJ", replacesUserId: "u-cj" }), change({ name: "Mo", written: "Mo", userId: "u-mo", replaces: "CJ", replacesUserId: "u-cj" })],
        SLOTS,
      ),
    ).toEqual({ kind: "none" });
    expect(
      playedGameReplacements([change({ replaces: "CJ", replacesUserId: "u-cj" }), change({ replaces: "Ali", replacesUserId: "u-ali" })], SLOTS),
    ).toEqual({ kind: "none" });
  });

  it("a player in for himself: not a fix", () => {
    expect(playedGameReplacements([change({ userId: "u-cj", replaces: "CJ", replacesUserId: "u-cj" })], SLOTS)).toEqual({ kind: "none" });
  });

  it("two replacements at once: both", () => {
    const r = playedGameReplacements(
      [change({ replaces: "CJ", replacesUserId: "u-cj" }), change({ name: "Mo", written: "Mo", userId: "u-mo", replaces: "Ali", replacesUserId: "u-ali" })],
      SLOTS,
    );
    expect(r).toEqual({
      kind: "fix",
      fixes: [
        { inUserId: "u-luca", inName: "Luca", outUserId: "u-cj" },
        { inUserId: "u-mo", inName: "Mo", outUserId: "u-ali" },
      ],
    });
  });
});
