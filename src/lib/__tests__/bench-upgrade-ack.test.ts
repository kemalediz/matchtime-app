/**
 * When a BENCH-shaped verdict lands as a CONFIRMED write, the LLM's reply
 * is already wrong — it was composed before the server knew the squad had
 * room. Same house rule as lib/attendance-write-outcome.ts: never tell a
 * player something that didn't happen.
 */
import { describe, it, expect } from "vitest";
import { buildBenchUpgradeReply } from "../bench-upgrade-ack";

describe("buildBenchUpgradeReply", () => {
  it("says they are IN the squad, never on the bench", () => {
    const reply = buildBenchUpgradeReply({
      name: "Amir Khan",
      confirmedCount: 11,
      maxPlayers: 14,
    });
    expect(reply).toContain("Amir");
    expect(reply).toContain("11/14");
    expect(reply.toLowerCase()).not.toContain("bench");
  });

  it("uses the first name only", () => {
    const reply = buildBenchUpgradeReply({
      name: "Erdal Yilmaz",
      confirmedCount: 11,
      maxPlayers: 14,
    });
    expect(reply).toContain("Erdal");
    expect(reply).not.toContain("Yilmaz");
  });

  it("works with no name at all", () => {
    const reply = buildBenchUpgradeReply({
      name: null,
      confirmedCount: 11,
      maxPlayers: 14,
    });
    expect(reply).toContain("11/14");
    expect(reply.toLowerCase()).not.toContain("bench");
    expect(reply).not.toContain("undefined");
    expect(reply).not.toContain("null");
  });

  it("does not claim spare room when their confirm filled the squad", () => {
    const reply = buildBenchUpgradeReply({
      name: "Amir",
      confirmedCount: 14,
      maxPlayers: 14,
    });
    expect(reply).toContain("14/14");
    expect(reply.toLowerCase()).not.toContain("bench");
    expect(reply.toLowerCase()).not.toContain("space");
  });

  it("never uses an em dash or en dash (house style)", () => {
    for (const n of [11, 14]) {
      const reply = buildBenchUpgradeReply({
        name: "Amir",
        confirmedCount: n,
        maxPlayers: 14,
      });
      expect(reply).not.toMatch(/[–—]/);
    }
  });
});
