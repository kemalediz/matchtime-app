/**
 * A TEAM SHEET NEVER LISTS A PLAYER WHO IS NOT PLAYING (2026-09-29).
 *
 * Sutton FC re-declared its sheet at 07:57 with Abid Kazmi still on Red,
 * forty minutes after he had said he was out. His slot had not been
 * inherited yet, so the `TeamAssignment` row still carried his id, and
 * every sheet printer read the row's name. `teamSheetNames` is the one
 * rule the database-reading printers share: a holder who is not
 * CONFIRMED is an open slot on the sheet.
 */
import { describe, it, expect } from "vitest";
import { teamSheetNames } from "../group-copy";

const rows = [
  { userId: "mojib", team: "RED" as const, name: "Mojib" },
  { userId: "hamzah", team: "RED" as const, name: "Hamzah" },
  { userId: "abid", team: "RED" as const, name: "Abid Kazmi" },
  { userId: "y1", team: "YELLOW" as const, name: null },
];

describe("teamSheetNames", () => {
  it("prints every CONFIRMED holder by name, in sheet order, and a dropped holder as an open slot", () => {
    const out = teamSheetNames(rows, new Set(["mojib", "hamzah", "y1"]), "en");
    expect(out).toEqual({ red: ["Mojib", "Hamzah", "(open slot)"], yellow: ["(unnamed)"] });
  });

  it("speaks the group's language", () => {
    const out = teamSheetNames(rows, new Set(["mojib", "hamzah"]), "tr");
    expect(out.red[2]).toBe("(boş yer)");
    expect(out.yellow[0]).toBe("(boş yer)");
  });
});
