/**
 * Which teams link an organiser sees on the match page (Kemal, 2026-11-09).
 *
 * Kemal needed to put Luca in for CJ on the Bibs after tonight's game had
 * kicked off. The match had gone COMPLETED at kickoff and the match page
 * stopped linking to the teams page, so there was no way in by clicking.
 * The teams page and its actions work on a COMPLETED match; the link now
 * stays for a COMPLETED match that has teams. Never for a CANCELLED one.
 */
import { describe, it, expect } from "vitest";
import { teamsLinkAction } from "../match-teams-link";

const at = (status: string, isPastDeadline: boolean, hasTeams: boolean) =>
  teamsLinkAction({ status, isPastDeadline, hasTeams });

describe("teamsLinkAction", () => {
  it("a COMPLETED match with teams offers Manage teams (the Bibs change after kickoff)", () => {
    expect(at("COMPLETED", true, true)).toBe("manage");
  });

  it("a COMPLETED match with no teams offers nothing", () => {
    expect(at("COMPLETED", true, false)).toBeNull();
  });

  it("a CANCELLED match never offers a teams link, teams or not", () => {
    expect(at("CANCELLED", true, true)).toBeNull();
    expect(at("CANCELLED", false, false)).toBeNull();
  });

  it("TEAMS_GENERATED and TEAMS_PUBLISHED offer Manage teams, as before", () => {
    for (const s of ["TEAMS_GENERATED", "TEAMS_PUBLISHED"]) {
      expect(at(s, false, true), s).toBe("manage");
      expect(at(s, true, true), s).toBe("manage");
    }
  });

  it("an UPCOMING match past its deadline offers Generate teams, as before", () => {
    expect(at("UPCOMING", true, false)).toBe("generate");
  });

  it("an UPCOMING match before its deadline offers nothing, as before", () => {
    expect(at("UPCOMING", false, false)).toBeNull();
  });
});
