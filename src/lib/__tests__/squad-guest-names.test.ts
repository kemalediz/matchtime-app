/**
 * The squad post prints partner guests by name and club (2026-10-22).
 *
 * Prod, MT Test, Wed 28 Oct: "6. C1 / 7. (unnamed)". C1 and C2 are guests
 * from Friday MT Community, C2 with an empty `User.name`. The post must
 * print "C1 (Friday MT Community)", and the club suffix is PRINT-ONLY: the
 * check that decides whether a model reply contradicts the database still
 * matches the plain names, so "C1 is in" is still true.
 */
import { describe, it, expect } from "vitest";
import { composeSquadStateReply, composeSquadStatusPost, teamSheetNames, type SquadTruth } from "@/lib/group-copy";
import { en } from "@/lib/i18n/strings.en";
import { tr } from "@/lib/i18n/strings.tr";

const confirmed = ["Elvin", "Mustafa Cayir", "Aytekin Y", "Baki", "Zair", "C1", en.unnamed];
const truth: SquadTruth = {
  confirmed,
  confirmedDisplay: [
    "Elvin",
    "Mustafa Cayir",
    "Aytekin Y",
    "Baki",
    "Zair",
    "C1 (Friday MT Community)",
    `${en.unnamed} (Friday MT Community)`,
  ],
  bench: ["Kemal"],
  benchDisplay: ["Kemal (Friday MT Community)"],
  maxPlayers: 14,
  knownNames: ["Elvin", "Mustafa Cayir", "Aytekin Y", "Baki", "Zair", "C1", "Kemal"],
  teams: null,
};

describe("squad post with partner guests", () => {
  it("prints guests with their club, on the squad and on the bench", () => {
    const { text, composed } = composeSquadStateReply("[SQUAD]", truth, "en");
    expect(composed).toBe(true);
    expect(text).toContain("6. C1 (Friday MT Community)");
    expect(text).toContain(`7. ${en.unnamed} (Friday MT Community)`);
    expect(text).toContain("1. Kemal (Friday MT Community)");
    expect(text).toContain("7/14");
    expect(text).not.toMatch(/\d{6,}/);
  });

  it("Turkish group: the same shape", () => {
    const trTruth = { ...truth, confirmedDisplay: truth.confirmedDisplay!.map((n) => n.replace(en.unnamed, tr.unnamed)) };
    const { text } = composeSquadStateReply("[SQUAD]", trTruth, "tr");
    expect(text).toContain("6. C1 (Friday MT Community)");
    expect(text).toContain(`7. ${tr.unnamed} (Friday MT Community)`);
    expect(text).not.toContain("(unnamed)");
  });

  it("the club suffix does not make a true claim look false", () => {
    // "C1 is in" is true; it must not trigger a re-compose.
    const reply = "Great, C1 is in for Wednesday 👍";
    expect(composeSquadStateReply(reply, truth, "en")).toEqual({ text: reply, composed: false });
  });

  it("without display lists, the plain names print exactly as before", () => {
    const plain = { ...truth, confirmedDisplay: undefined, benchDisplay: undefined };
    const { text } = composeSquadStateReply("[SQUAD]", plain, "en");
    expect(text).toBe(composeSquadStatusPost({ confirmed, bench: ["Kemal"], maxPlayers: 14, lang: "en" }));
  });

  it("the team sheet prints the names it is handed, open slots unchanged", () => {
    const sheet = teamSheetNames(
      [
        { userId: "c1", team: "RED", name: "C1 (Friday MT Community)" },
        { userId: "gone", team: "YELLOW", name: "Gone" },
      ],
      new Set(["c1"]),
      "en",
    );
    expect(sheet).toEqual({ red: ["C1 (Friday MT Community)"], yellow: [en.team_sheet_open_slot] });
  });
});
