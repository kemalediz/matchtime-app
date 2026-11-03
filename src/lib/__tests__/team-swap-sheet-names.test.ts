/**
 * The team sheet a swap reply ends with prints the name MatchTime holds
 * for a player (`loadPlayerNames`: an alias, the WhatsApp name he posts
 * under), not "(unnamed)" for a member imported with no name (2026-11-03,
 * the Vets sandbox: 9 of 14 "(unnamed)" on the posted sheet).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    teamAssignment: {
      findMany: async () => [
        { userId: "u-shane", team: "RED", user: { name: "Shane Walton" } },
        { userId: "u-nabz", team: "RED", user: { name: null } },
        { userId: "u-anon", team: "YELLOW", user: { name: null } },
      ],
    },
    attendance: { findMany: async () => [{ userId: "u-shane" }, { userId: "u-nabz" }, { userId: "u-anon" }] },
  },
}));
const loadPlayerNames = vi.fn(async () => new Map([
  ["u-shane", { name: "Shane Walton", display: "Shane Walton" }],
  ["u-nabz", { name: "Nabz", display: "Nabz" }],
  ["u-anon", { name: null, display: "(unnamed)" }],
]));
vi.mock("@/lib/player-display-name", () => ({ loadPlayerNames: (...a: unknown[]) => loadPlayerNames(...(a as [])) }));

import { teamSheetNamesFor } from "@/lib/team-swap-apply";

describe("teamSheetNamesFor", () => {
  it("prints the club's name for each player", async () => {
    expect(await teamSheetNamesFor("m1", "org-vets", "en")).toEqual({ red: ["Shane Walton", "Nabz"], yellow: ["(unnamed)"] });
    expect(loadPlayerNames).toHaveBeenCalledWith("org-vets", ["u-shane", "u-nabz", "u-anon"], "en");
  });
});
