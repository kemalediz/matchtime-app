/**
 * Unit tests for the pure team-label resolution + sanitisation helpers.
 *
 *   - resolveTeamLabels(match, org, sport): per-slot precedence
 *       match → org → sport → ["Red","Yellow"] default.
 *   - sanitiseTeamNames(input): turns an LLM-proposed name pair into a
 *       safe [red, yellow] tuple or null.
 *
 * Both are pure (no DB, no network) — safe to import directly under vitest.
 */
import { describe, it, expect } from "vitest";
import { resolveTeamLabels, DEFAULT_TEAM_LABELS } from "@/lib/team-labels";
import { sanitiseTeamNames } from "@/lib/message-analyzer";

describe("resolveTeamLabels precedence", () => {
  it("falls through to the hard default when no source has labels", () => {
    expect(resolveTeamLabels(null, null, null)).toEqual(["Red", "Yellow"]);
    expect(resolveTeamLabels(undefined, undefined, undefined)).toEqual([
      ...DEFAULT_TEAM_LABELS,
    ]);
    expect(resolveTeamLabels({ teamLabels: [] }, { teamLabels: [] }, { teamLabels: [] })).toEqual([
      "Red",
      "Yellow",
    ]);
  });

  it("uses sport labels when no org/match override", () => {
    expect(
      resolveTeamLabels(null, null, { teamLabels: ["Home", "Away"] }),
    ).toEqual(["Home", "Away"]);
  });

  it("org overrides sport", () => {
    expect(
      resolveTeamLabels(
        null,
        { teamLabels: ["Lions", "Tigers"] },
        { teamLabels: ["Home", "Away"] },
      ),
    ).toEqual(["Lions", "Tigers"]);
  });

  it("match override wins over both org and sport", () => {
    expect(
      resolveTeamLabels(
        { teamLabels: ["Falcons", "Sharks"] },
        { teamLabels: ["Lions", "Tigers"] },
        { teamLabels: ["Home", "Away"] },
      ),
    ).toEqual(["Falcons", "Sharks"]);
  });

  it("partial match labels (one empty slot) fall through per-slot", () => {
    // RED slot from the match, YELLOW slot falls through to org.
    expect(
      resolveTeamLabels(
        { teamLabels: ["Dragons", ""] },
        { teamLabels: ["Lions", "Tigers"] },
        { teamLabels: ["Home", "Away"] },
      ),
    ).toEqual(["Dragons", "Tigers"]);
    // YELLOW slot from the match, RED slot falls through to sport (no org).
    expect(
      resolveTeamLabels(
        { teamLabels: ["", "Phoenixes"] },
        null,
        { teamLabels: ["Home", "Away"] },
      ),
    ).toEqual(["Home", "Phoenixes"]);
  });

  it("empty match array falls through entirely to org", () => {
    expect(
      resolveTeamLabels(
        { teamLabels: [] },
        { teamLabels: ["Lions", "Tigers"] },
        { teamLabels: ["Home", "Away"] },
      ),
    ).toEqual(["Lions", "Tigers"]);
  });

  it("partial org labels fall through per-slot to sport", () => {
    expect(
      resolveTeamLabels(
        null,
        { teamLabels: ["Lions", ""] },
        { teamLabels: ["Home", "Away"] },
      ),
    ).toEqual(["Lions", "Away"]);
  });

  it("trims whitespace-padded labels", () => {
    expect(
      resolveTeamLabels({ teamLabels: ["  Wolves  ", " Hawks "] }, null, null),
    ).toEqual(["Wolves", "Hawks"]);
  });
});

describe("sanitiseTeamNames", () => {
  it("accepts a valid distinct pair", () => {
    expect(sanitiseTeamNames(["Falcons", "Sharks"])).toEqual([
      "Falcons",
      "Sharks",
    ]);
  });

  it("trims each element", () => {
    expect(sanitiseTeamNames(["  Lions ", " Tigers "])).toEqual([
      "Lions",
      "Tigers",
    ]);
  });

  it("caps each element to 24 chars", () => {
    const long = "X".repeat(40);
    const out = sanitiseTeamNames([long, "Sharks"]);
    expect(out).not.toBeNull();
    expect(out![0]).toHaveLength(24);
    expect(out![1]).toBe("Sharks");
  });

  it("rejects a case-insensitively identical pair", () => {
    expect(sanitiseTeamNames(["Lions", "lions"])).toBeNull();
    expect(sanitiseTeamNames(["Lions", "LIONS"])).toBeNull();
    expect(sanitiseTeamNames(["Lions", "Lions"])).toBeNull();
  });

  it("rejects an empty / whitespace-only element", () => {
    expect(sanitiseTeamNames(["", "Sharks"])).toBeNull();
    expect(sanitiseTeamNames(["Falcons", "   "])).toBeNull();
  });

  it("rejects a purely-punctuation element", () => {
    expect(sanitiseTeamNames(["!!!", "Sharks"])).toBeNull();
    expect(sanitiseTeamNames(["Falcons", "---"])).toBeNull();
  });

  it("rejects elements containing control characters", () => {
    expect(sanitiseTeamNames(["Fal\ncons", "Sharks"])).toBeNull();
    expect(sanitiseTeamNames(["Falcons", "Shar\tks"])).toBeNull();
  });

  it("rejects non-array / wrong-length / non-string inputs → null", () => {
    expect(sanitiseTeamNames(null)).toBeNull();
    expect(sanitiseTeamNames(undefined)).toBeNull();
    expect(sanitiseTeamNames("Falcons")).toBeNull();
    expect(sanitiseTeamNames(["OnlyOne"])).toBeNull();
    expect(sanitiseTeamNames(["A", "B", "C"])).toBeNull();
    expect(sanitiseTeamNames([1, 2])).toBeNull();
    expect(sanitiseTeamNames(["Falcons", 7])).toBeNull();
    expect(sanitiseTeamNames({})).toBeNull();
  });
});
