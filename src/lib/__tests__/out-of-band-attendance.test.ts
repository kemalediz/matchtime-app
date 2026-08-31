/**
 * Out-of-band attendance announcements — PURE copy + guards.
 *
 * WHY (owner, 2026-08-31): the WhatsApp group is the social source of
 * truth. A player who signs up by DM reply or through the web app is
 * invisible to everybody else, so the group keeps recruiting or never
 * realises the squad filled. MatchTime now posts one short line to the
 * group for those two OUT-OF-BAND paths only. Registrations made IN the
 * group are NOT announced — the group already saw them.
 *
 * Guards pinned here:
 *   - announce only on a real state change (a repeat IN changes nothing);
 *   - the squad count is computed in code, never by an LLM;
 *   - a per-hour cap keeps a burst of DM replies from eating the org's
 *     10-group-messages-per-hour circuit-breaker budget
 *     (src/lib/dispatch-claim.ts) and starving the roster post.
 */
import { describe, it, expect } from "vitest";
import {
  shouldAnnounceAttendanceChange,
  buildOutOfBandAttendanceLine,
  withinOutOfBandAnnouncementCap,
  MAX_OUT_OF_BAND_ANNOUNCEMENTS_PER_HOUR,
} from "@/lib/out-of-band-attendance";

describe("shouldAnnounceAttendanceChange", () => {
  it("announces a brand-new confirm", () => {
    expect(shouldAnnounceAttendanceChange(null, "CONFIRMED")).toBe(true);
  });

  it("announces a brand-new bench placement", () => {
    expect(shouldAnnounceAttendanceChange(null, "BENCH")).toBe(true);
  });

  it("does NOT announce a repeat IN from an already-confirmed player", () => {
    expect(shouldAnnounceAttendanceChange("CONFIRMED", "CONFIRMED")).toBe(false);
  });

  it("does NOT announce a repeat IN from an already-benched player", () => {
    expect(shouldAnnounceAttendanceChange("BENCH", "BENCH")).toBe(false);
  });

  it("announces a bench player promoted into the squad", () => {
    expect(shouldAnnounceAttendanceChange("BENCH", "CONFIRMED")).toBe(true);
  });

  it("announces a confirmed player dropping out", () => {
    expect(shouldAnnounceAttendanceChange("CONFIRMED", "DROPPED")).toBe(true);
  });

  it("does NOT announce a repeat OUT", () => {
    expect(shouldAnnounceAttendanceChange("DROPPED", "DROPPED")).toBe(false);
  });

  it("does NOT announce when there is no resulting state", () => {
    expect(shouldAnnounceAttendanceChange("CONFIRMED", null)).toBe(false);
  });
});

describe("buildOutOfBandAttendanceLine", () => {
  it("names the player, the source and the code-computed count for a DM IN", () => {
    const line = buildOutOfBandAttendanceLine({
      playerName: "Mauricio Silva",
      status: "CONFIRMED",
      source: "dm",
      confirmedCount: 11,
      maxPlayers: 14,
    });
    expect(line).toBe("✅ *Mauricio Silva* is IN (replied by DM). Squad *11/14*.");
  });

  it("says the player is on the bench when the squad was full", () => {
    const line = buildOutOfBandAttendanceLine({
      playerName: "Zara Zest",
      status: "BENCH",
      source: "dm",
      confirmedCount: 14,
      maxPlayers: 14,
    });
    expect(line).toBe(
      "📋 *Zara Zest* replied IN by DM and goes to the bench. Squad *14/14*.",
    );
  });

  it("labels the app source differently", () => {
    const line = buildOutOfBandAttendanceLine({
      playerName: "Mauricio Silva",
      status: "CONFIRMED",
      source: "app",
      confirmedCount: 11,
      maxPlayers: 14,
    });
    expect(line).toBe("✅ *Mauricio Silva* is IN (from the app). Squad *11/14*.");
  });

  it("announces an OUT with the count after the drop", () => {
    const line = buildOutOfBandAttendanceLine({
      playerName: "Pat Player",
      status: "DROPPED",
      source: "dm",
      confirmedCount: 10,
      maxPlayers: 14,
    });
    expect(line).toBe("❌ *Pat Player* is OUT (replied by DM). Squad *10/14*.");
  });

  it("falls back to a neutral label when the player has no name", () => {
    const line = buildOutOfBandAttendanceLine({
      playerName: null,
      status: "CONFIRMED",
      source: "dm",
      confirmedCount: 1,
      maxPlayers: 14,
    });
    expect(line).toContain("*A player*");
  });

  it("never uses an em dash (house style)", () => {
    const line = buildOutOfBandAttendanceLine({
      playerName: "Mauricio Silva",
      status: "CONFIRMED",
      source: "dm",
      confirmedCount: 11,
      maxPlayers: 14,
    });
    expect(line).not.toContain("—");
    expect(line).not.toContain("–");
  });
});

describe("withinOutOfBandAnnouncementCap", () => {
  it("allows posts below the cap", () => {
    expect(withinOutOfBandAnnouncementCap(0)).toBe(true);
    expect(withinOutOfBandAnnouncementCap(MAX_OUT_OF_BAND_ANNOUNCEMENTS_PER_HOUR - 1)).toBe(true);
  });

  it("suppresses once the cap is reached, so scheduled group posts keep their budget", () => {
    expect(withinOutOfBandAnnouncementCap(MAX_OUT_OF_BAND_ANNOUNCEMENTS_PER_HOUR)).toBe(false);
    expect(withinOutOfBandAnnouncementCap(MAX_OUT_OF_BAND_ANNOUNCEMENTS_PER_HOUR + 5)).toBe(false);
  });

  it("stays well under the org circuit-breaker budget of 10 group posts/hour", () => {
    expect(MAX_OUT_OF_BAND_ANNOUNCEMENTS_PER_HOUR).toBeLessThan(10);
  });
});
