/**
 * A CONFIRMED PLAYER WITH NO TEAM SLOT IS NAMED UNDER THE TEAM SHEET
 * (review of #604, round 4, 2026-11-16; pre-existing on main).
 *
 * With the teams made, the batch's squad post IS the team sheet. "Ian Innes
 * is in" landed him in the squad with no slot, and the sheet named everyone
 * but him: the group could not tell he was in. The composed team sheet now
 * ends with one line naming who is in the squad but not on a team yet.
 * Made-up people.
 */
import { describe, expect, it } from "vitest";
import { SQUAD_POST_MARKER, composeSquadStateReply, type SquadTruth } from "../group-copy";

const TEAMS: NonNullable<SquadTruth["teams"]> = {
  red: ["Alfie Brook", "Bruno Carr"],
  yellow: ["Cosmo Dale", "Dario Ewing"],
  labels: ["Red", "Yellow"],
  kickoff: "Wed 20:00",
  venue: "The Arena",
};
const base: SquadTruth = {
  confirmed: ["Alfie Brook", "Bruno Carr", "Cosmo Dale", "Dario Ewing", "Ezra Finch"],
  bench: [],
  maxPlayers: 5,
  knownNames: ["Alfie Brook", "Bruno Carr", "Cosmo Dale", "Dario Ewing", "Ezra Finch"],
};

describe("the composed team sheet names who is in but not on a team", () => {
  it("one confirmed player with no slot: one line after the sheet", () => {
    const out = composeSquadStateReply(SQUAD_POST_MARKER, { ...base, teams: { ...TEAMS, unslotted: ["Ezra Finch"] } }, "en");
    expect(out.text).toContain("*Red*:");
    expect(out.text.trimEnd().endsWith("In the squad, not on a team yet: *Ezra Finch*.")).toBe(true);
  });

  it("two: both named, in one line", () => {
    const out = composeSquadStateReply(SQUAD_POST_MARKER, { ...base, teams: { ...TEAMS, unslotted: ["Ezra Finch", "Felix Grant"] } }, "en");
    expect(out.text).toContain("In the squad, not on a team yet: *Ezra Finch* and *Felix Grant*.");
  });

  it("in Turkish", () => {
    const out = composeSquadStateReply(SQUAD_POST_MARKER, { ...base, teams: { ...TEAMS, unslotted: ["Ezra Finch"] } }, "tr");
    expect(out.text).toContain("Kadroda, henüz bir takımda değil: *Ezra Finch*.");
  });

  it("UNCHANGED: everyone on a team, no line", () => {
    const out = composeSquadStateReply(SQUAD_POST_MARKER, { ...base, teams: { ...TEAMS, unslotted: [] } }, "en");
    expect(out.text).not.toContain("not on a team yet");
    const plain = composeSquadStateReply(SQUAD_POST_MARKER, { ...base, teams: TEAMS }, "en");
    expect(plain.text).not.toContain("not on a team yet");
  });
});
