/**
 * Unit tests for the pure team-post formatter.
 *
 * `formatTeamsPost` is the single source of truth for the group message
 * that lists the two teams. It's shared by BOTH the generate path
 * (team-generation.ts) and the "show the teams again" re-post path
 * (analyze route), so its output must be stable and identical for both.
 *
 * Pure (no DB, no network) — safe to import directly under vitest.
 */
import { describe, it, expect } from "vitest";
import { formatTeamsPost } from "@/lib/team-generation";

describe("formatTeamsPost", () => {
  it("renders header, both labels, numbered players, and footer", () => {
    const post = formatTeamsPost({
      redLabel: "Red",
      yellowLabel: "Yellow",
      red: [{ name: "Alice" }, { name: "Bob" }],
      yellow: [{ name: "Carol" }, { name: "Dave" }],
      kickoff: "20:00",
      venue: "Sim Arena",
    });

    // Header line with kickoff + venue.
    expect(post).toContain("⚽ *Teams for tonight* — 20:00 at Sim Arena");
    // Both labels, bolded.
    expect(post).toContain("*Red*:");
    expect(post).toContain("*Yellow*:");
    // Numbered players, 1-based, per side.
    expect(post).toContain("1. Alice");
    expect(post).toContain("2. Bob");
    expect(post).toContain("1. Carol");
    expect(post).toContain("2. Dave");
    // Footer.
    expect(post).toContain("Objections? Reply `swap X Y` — admin will confirm.");
  });

  it("flows custom fun-name labels through to the post", () => {
    const post = formatTeamsPost({
      redLabel: "Falcons",
      yellowLabel: "Sharks",
      red: [{ name: "Alice" }],
      yellow: [{ name: "Bob" }],
      kickoff: "19:30",
      venue: "The Pitch",
    });

    expect(post).toContain("*Falcons*:");
    expect(post).toContain("*Sharks*:");
    expect(post).not.toContain("*Red*:");
    expect(post).not.toContain("*Yellow*:");
  });

  it("produces the exact byte layout the generate post relies on", () => {
    const post = formatTeamsPost({
      redLabel: "Red",
      yellowLabel: "Yellow",
      red: [{ name: "Alice" }, { name: "Bob" }],
      yellow: [{ name: "Carol" }, { name: "Dave" }],
      kickoff: "20:00",
      venue: "Sim Arena",
    });

    const expected =
      "⚽ *Teams for tonight* — 20:00 at Sim Arena\n\n" +
      "*Red*:\n1. Alice\n2. Bob\n\n" +
      "*Yellow*:\n1. Carol\n2. Dave\n\n" +
      "Objections? Reply `swap X Y` — admin will confirm.";
    expect(post).toBe(expected);
  });
});
