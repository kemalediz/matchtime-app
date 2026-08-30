/**
 * What the MODEL is actually handed for a format switch.
 *
 * buildMatchContextBlock is the only channel through which format-switch
 * information reaches the LLM. These tests pin the production scenario of
 * 2026-08-30 (8 confirmed, 7-a-side, a 5-a-side alternative): the block
 * must tell the model the switch is not viable and that NOBODY is
 * benched, and must not hand it any name it could turn into a
 * "you're on the bench" sentence.
 */
import { describe, it, expect } from "vitest";
import { buildMatchContextBlock } from "@/lib/message-analyzer";

const SQUAD = [
  "Elvin", "Mustafa Y", "Idris", "Sait",
  "Najib", "Mojib", "Mustafa", "Wasim",
];

const ctx = (names: string[], maxPlayers = 14) =>
  buildMatchContextBlock({
    orgName: "Sutton Football Club",
    match: {
      activity: { name: "Tuesday 7-a-side", venue: "Sim Arena" },
      date: new Date(Date.now() + 3 * 60 * 60 * 1000), // 3h to kickoff
      status: "UPCOMING",
      maxPlayers,
      attendances: names.map((name, i) => ({
        status: "CONFIRMED",
        user: { id: `u${i}`, name, phoneNumber: "+447700900000" },
      })),
    },
    alternatives: [{ sportName: "Football 5-a-side", totalPlayers: 10 }],
  });

describe("format-switch facts in the Match Context", () => {
  it("PRODUCTION CASE — 8 confirmed vs 5-a-side (10): not viable, nobody benched, no names offered", () => {
    const block = ctx(SQUAD);
    expect(block).toContain("Football 5-a-side (10 players total)");
    expect(block).toContain("NOT VIABLE");
    expect(block).toContain("Do NOT propose this switch");
    expect(block).toContain("Bench on switch: NOBODY");
    // The names that were wrongly benched in production must not appear
    // anywhere near the format-switch block.
    const fsBlock = block.slice(block.indexOf("Alternative formats"));
    for (const name of SQUAD) {
      expect(fsBlock, `${name} must not be offered as bench material`).not.toContain(name);
    }
    // And no verbatim proposal line is handed over at all.
    expect(block).not.toContain("VERBATIM");
  });

  it("12 confirmed vs 5-a-side (10): the exact last two, and a verbatim sentence", () => {
    const block = ctx([
      "Elvin", "Mustafa", "Idris", "Sait", "Kemal", "Elnur",
      "Najib", "Wasim", "Aydın", "Habib", "Mauricio", "Ersin",
    ]);
    expect(block).toContain("✅ VIABLE");
    expect(block).toContain("Bench on switch (2, this exact list, this exact order): Mauricio, Ersin");
    expect(block).toContain(
      'If we don\'t find 2 more, we could switch to 5-a-side (10 players) — ' +
        'Mauricio + Ersin go on the bench. Admins can rebook and flip it in the portal.',
    );
  });

  it("10 confirmed vs 5-a-side (10): viable, but the sentence carries NO bench clause", () => {
    const block = ctx([
      "Elvin", "Mustafa", "Idris", "Sait", "Kemal",
      "Elnur", "Najib", "Wasim", "Aydın", "Habib",
    ]);
    expect(block).toContain("✅ VIABLE");
    expect(block).toContain("Bench on switch: NOBODY");
    expect(block).toContain("all 10 of you still play, nobody goes on the bench.");
    expect(block).not.toMatch(/Habib \+/);
  });

  it("always tells the model not to redo the maths", () => {
    expect(ctx(SQUAD)).toMatch(/NEVER recompute/);
  });

  it("omits the block entirely when the org has no alternative format", () => {
    const block = buildMatchContextBlock({
      orgName: "Sutton Football Club",
      match: {
        activity: { name: "Tuesday 7-a-side", venue: "Sim Arena" },
        date: new Date(Date.now() + 3 * 60 * 60 * 1000),
        status: "UPCOMING",
        maxPlayers: 14,
        attendances: SQUAD.map((name, i) => ({
          status: "CONFIRMED",
          user: { id: `u${i}`, name, phoneNumber: "+447700900000" },
        })),
      },
      alternatives: [],
    });
    expect(block).not.toContain("Alternative formats");
    expect(block).not.toContain("Bench on switch");
  });
});
