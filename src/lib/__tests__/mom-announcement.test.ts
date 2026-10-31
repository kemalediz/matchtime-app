/**
 * Unit tests for the MAN-OF-THE-MATCH result announcement text builder.
 *
 * Pure logic — no DB, no clock. The bot posts this to the group once MoM
 * voting is settled. Covers:
 *   - the header (trophy emoji + mvpLabel + activity name);
 *   - the single-winner congrats line and vote fraction;
 *   - the shared-winner line;
 *   - the per-player vote breakdown;
 *   - no closing perk line: the drink offer went 2026-07-06, the trophy line
 *     2026-10-31 (Kemal). The post ends on its last block, no trailing blank line.
 */
import { describe, it, expect } from "vitest";
import { buildMomAnnouncement } from "@/lib/mom-announcement";

describe("buildMomAnnouncement", () => {
  it("has no trophy line in English or Turkish, and ends on the vote breakdown", () => {
    const args = {
      mvpLabel: "Man of the Match",
      activityName: "Tuesday 7-a-side",
      tally: [
        { name: "Alice", votes: 3 },
        { name: "Bob", votes: 1 },
      ],
    };
    for (const lang of ["en", "tr"] as const) {
      const text = buildMomAnnouncement({ ...args, lang });
      expect(text).not.toMatch(/trophy|drink|Kupa/i);
      // last line is Bob's vote row: "• Bob (1)" in English, "• Bob: 1" in Turkish
      expect(text.split("\n").pop()).toMatch(/^• Bob\W+1\)?$/);
    }
    expect(buildMomAnnouncement({ ...args, lang: "tr" })).not.toContain("Kupa gelecek maçta sahibini bekliyor.");
  });

  it("builds the single-winner announcement with header, congrats and breakdown", () => {
    const text = buildMomAnnouncement({
      mvpLabel: "Man of the Match",
      activityName: "Tuesday 7-a-side",
      tally: [
        { name: "Alice", votes: 3 },
        { name: "Bob", votes: 1 },
      ],
    });
    expect(text).toBe(
      "🏆 *Man of the Match: Tuesday 7-a-side*\n\n" +
        "Congrats *Alice* (3/4 votes) 🎉\n\n" +
        "Votes:\n• Alice (3)\n• Bob (1)",
    );
  });

  it("handles a single total vote with singular grammar", () => {
    const text = buildMomAnnouncement({
      mvpLabel: "Player of the Match",
      activityName: "Friday 5s",
      tally: [{ name: "Cara", votes: 1 }],
    });
    expect(text).toContain("Congrats *Cara* (1/1 vote) 🎉");
    expect(text).not.toContain("drink");
    expect(text.endsWith("• Cara (1)")).toBe(true);
  });

  it("builds a shared-winner announcement between two players", () => {
    const text = buildMomAnnouncement({
      mvpLabel: "Man of the Match",
      activityName: "Sunday League",
      tally: [
        { name: "Alice", votes: 2 },
        { name: "Bob", votes: 2 },
        { name: "Cara", votes: 1 },
      ],
    });
    expect(text).toContain("Shared between *Alice & Bob* (2 votes each, 5 total) 🎉");
    expect(text).toContain("Votes:\n• Alice (2)\n• Bob (2)\n• Cara (1)");
    expect(text).not.toContain("drink");
    expect(text.endsWith("• Cara (1)")).toBe(true);
  });

  it("joins three or more shared winners with commas and an ampersand", () => {
    const text = buildMomAnnouncement({
      mvpLabel: "Man of the Match",
      activityName: "Sunday League",
      tally: [
        { name: "Alice", votes: 1 },
        { name: "Bob", votes: 1 },
        { name: "Cara", votes: 1 },
      ],
    });
    expect(text).toContain("Shared between *Alice, Bob & Cara* (1 vote each, 3 total) 🎉");
  });
});
