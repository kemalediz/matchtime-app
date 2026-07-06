/**
 * Unit tests for the MAN-OF-THE-MATCH result announcement text builder.
 *
 * Pure logic — no DB, no clock. The bot posts this to the group once MoM
 * voting is settled. Covers:
 *   - the header (trophy emoji + mvpLabel + activity name);
 *   - the single-winner congrats line and vote fraction;
 *   - the shared-winner line;
 *   - the per-player vote breakdown;
 *   - the closing line: trophy only, NO drink offer (removed 2026-07-06).
 */
import { describe, it, expect } from "vitest";
import { buildMomAnnouncement } from "@/lib/mom-announcement";

describe("buildMomAnnouncement", () => {
  it("no longer offers a drink and closes with the trophy-only line", () => {
    const text = buildMomAnnouncement({
      mvpLabel: "Man of the Match",
      activityName: "Tuesday 7-a-side",
      tally: [
        { name: "Alice", votes: 3 },
        { name: "Bob", votes: 1 },
      ],
    });
    expect(text).not.toContain("drink");
    expect(text).toContain("Your trophy awaits next match.");
    // the perk line must be exactly the trophy-only copy
    expect(text).toContain("Your trophy awaits next match.");
    expect(text).not.toContain("Your trophy & drink awaits next match.");
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
      "🏆 *Man of the Match — Tuesday 7-a-side*\n\n" +
        "Congrats *Alice* (3/4 votes) 🎉\n\n" +
        "Votes:\n• Alice — 3\n• Bob — 1\n\n" +
        "Your trophy awaits next match.",
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
    expect(text.endsWith("Your trophy awaits next match.")).toBe(true);
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
    expect(text).toContain("Votes:\n• Alice — 2\n• Bob — 2\n• Cara — 1");
    expect(text).not.toContain("drink");
    expect(text.endsWith("Your trophy awaits next match.")).toBe(true);
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
