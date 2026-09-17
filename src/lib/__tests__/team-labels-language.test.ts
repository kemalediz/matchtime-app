/**
 * The Turkish team-label default.
 *
 * `resolveTeamLabels` falls through match, org and sport to a hard
 * default. For an English org that default is "Red" / "Yellow" and
 * nothing here changes it. For a Turkish org (`Organisation.language =
 * "tr"`) with no label of its own, the default is "Kırmızı" / "Sarı".
 *
 * The one judgement call: the sport preset library is English
 * (`sport-presets.ts` copies "Red" / "Yellow" into every new org's
 * football sports), so a Turkish org whose sport carries the English
 * hard default did not CHOOSE those words. That sport-level label is
 * treated as unset for a non-English org. An org-level or match-level
 * label is always respected: an admin typed it.
 */
import { describe, it, expect } from "vitest";
import { resolveTeamLabels, DEFAULT_TEAM_LABELS, DEFAULT_TEAM_LABELS_BY_LANG } from "@/lib/team-labels";

describe("resolveTeamLabels with a language", () => {
  it("English is unchanged: the fourth argument defaults to 'en'", () => {
    expect(resolveTeamLabels(null, null, null)).toEqual(["Red", "Yellow"]);
    expect(resolveTeamLabels(null, null, null, "en")).toEqual(["Red", "Yellow"]);
    expect(resolveTeamLabels(null, null, { teamLabels: ["Red", "Yellow"] }, "en")).toEqual(["Red", "Yellow"]);
    expect(DEFAULT_TEAM_LABELS_BY_LANG.en).toEqual([...DEFAULT_TEAM_LABELS]);
  });

  it("Turkish with no labels anywhere: Kırmızı / Sarı", () => {
    expect(resolveTeamLabels(null, null, null, "tr")).toEqual(["Kırmızı", "Sarı"]);
    expect(resolveTeamLabels({ teamLabels: [] }, { teamLabels: [] }, { teamLabels: [] }, "tr")).toEqual([
      "Kırmızı",
      "Sarı",
    ]);
  });

  it("Turkish with the sport preset's English default: still Kırmızı / Sarı", () => {
    expect(resolveTeamLabels(null, null, { teamLabels: ["Red", "Yellow"] }, "tr")).toEqual(["Kırmızı", "Sarı"]);
    expect(resolveTeamLabels(null, null, { teamLabels: ["red", " yellow "] }, "tr")).toEqual(["Kırmızı", "Sarı"]);
  });

  it("Turkish with a real sport label keeps it (Home / Away)", () => {
    expect(resolveTeamLabels(null, null, { teamLabels: ["Home", "Away"] }, "tr")).toEqual(["Home", "Away"]);
  });

  it("an org-level label always wins, even when it is the English words", () => {
    expect(resolveTeamLabels(null, { teamLabels: ["Red", "Yellow"] }, null, "tr")).toEqual(["Red", "Yellow"]);
    expect(resolveTeamLabels(null, { teamLabels: ["Aslanlar", "Kartallar"] }, null, "tr")).toEqual([
      "Aslanlar",
      "Kartallar",
    ]);
  });

  it("a match-level label wins over everything", () => {
    expect(
      resolveTeamLabels({ teamLabels: ["Falcons", "Sharks"] }, { teamLabels: ["Aslanlar", "Kartallar"] }, null, "tr"),
    ).toEqual(["Falcons", "Sharks"]);
  });

  it("falls through per slot", () => {
    expect(resolveTeamLabels({ teamLabels: ["Aslanlar", ""] }, null, null, "tr")).toEqual(["Aslanlar", "Sarı"]);
    expect(resolveTeamLabels(null, { teamLabels: ["", "Kartallar"] }, { teamLabels: ["Red", "Yellow"] }, "tr")).toEqual([
      "Kırmızı",
      "Kartallar",
    ]);
  });

  it("an unknown language is English", () => {
    expect(resolveTeamLabels(null, null, null, "fr")).toEqual(["Red", "Yellow"]);
  });
});
