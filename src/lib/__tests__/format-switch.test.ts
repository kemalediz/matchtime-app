/**
 * FORMAT-SWITCH BENCH ARITHMETIC — pure unit tests.
 *
 * Regression net for the 2026-08-30 production incident: the bot told a
 * real customer group
 *
 *   "If we don't find 6 more, we could switch to 5-a-side (10 players)
 *    — Najib + Mojib + Mustafa go on the bench."
 *
 * with EIGHT confirmed players. 5-a-side fields 10 in total, so nobody
 * would have been benched — three real people were told they were losing
 * their place. The LLM had done `8 - 5` (players per TEAM) instead of
 * `8 - 10` (the format TOTAL), and then picked three names itself.
 *
 * Who is benched by a format switch is a deterministic fact of squad size
 * and format capacity. It belongs in code — "LLM extracts, code decides".
 */
import { describe, it, expect } from "vitest";
import {
  totalPlayersFor,
  benchedOnFormatSwitch,
  buildFormatSwitchFacts,
  renderFormatSwitchContext,
} from "@/lib/format-switch";

const NAMES = (n: number) =>
  Array.from({ length: n }, (_, i) => `P${i + 1}`);

describe("totalPlayersFor", () => {
  it("is players-per-team x 2 — the Match.maxPlayers semantics", () => {
    expect(totalPlayersFor(5)).toBe(10);
    expect(totalPlayersFor(7)).toBe(14);
    expect(totalPlayersFor(11)).toBe(22);
  });
});

describe("benchedOnFormatSwitch", () => {
  it("THE PRODUCTION BUG: 8 confirmed vs a 10-total format benches NOBODY", () => {
    const confirmed = [
      "Elvin", "Mustafa Y", "Idris", "Sait",
      "Najib", "Mojib", "Mustafa", "Wasim",
    ];
    expect(benchedOnFormatSwitch(confirmed, 10)).toEqual([]);
  });

  it("12 confirmed vs a 10-total format benches the LAST 2, in position order", () => {
    const confirmed = [
      "Elvin", "Mustafa", "Idris", "Sait", "Kemal", "Elnur",
      "Najib", "Wasim", "Aydın", "Habib", "Mauricio", "Ersin",
    ];
    expect(benchedOnFormatSwitch(confirmed, 10)).toEqual(["Mauricio", "Ersin"]);
  });

  it("exactly at capacity (10 vs 10) benches nobody", () => {
    expect(benchedOnFormatSwitch(NAMES(10), 10)).toEqual([]);
  });

  it("an empty squad benches nobody", () => {
    expect(benchedOnFormatSwitch([], 10)).toEqual([]);
  });

  it("one over capacity benches exactly the last one", () => {
    expect(benchedOnFormatSwitch(NAMES(11), 10)).toEqual(["P11"]);
  });

  it("preserves position order, never re-sorts", () => {
    const confirmed = ["Zoe", "Adam", "Yusuf", "Bea", "Xander", "Cara"];
    expect(benchedOnFormatSwitch(confirmed, 4)).toEqual(["Xander", "Cara"]);
  });

  it("never returns more names than the squad has", () => {
    expect(benchedOnFormatSwitch(NAMES(3), 0)).toEqual(["P1", "P2", "P3"]);
  });

  it("treats a nonsense capacity as zero rather than throwing", () => {
    expect(benchedOnFormatSwitch(NAMES(3), -5)).toEqual(["P1", "P2", "P3"]);
    expect(benchedOnFormatSwitch(NAMES(3), Number.NaN)).toEqual(["P1", "P2", "P3"]);
  });

  it("returns a fresh array — callers cannot mutate the input roster", () => {
    const confirmed = NAMES(12);
    const out = benchedOnFormatSwitch(confirmed, 10);
    out.push("intruder");
    expect(confirmed).toHaveLength(12);
  });
});

describe("buildFormatSwitchFacts", () => {
  it("THE PRODUCTION CASE: 8 confirmed, 7-a-side, 5-a-side alternative → not viable, no proposal, nobody benched", () => {
    const [fact] = buildFormatSwitchFacts({
      confirmedNames: ["Elvin", "Mustafa Y", "Idris", "Sait", "Najib", "Mojib", "Mustafa", "Wasim"],
      currentMaxPlayers: 14,
      alternatives: [{ sportName: "Football 5-a-side", totalPlayers: 10 }],
    });
    expect(fact.fills).toBe(false);
    expect(fact.benched).toEqual([]);
    expect(fact.proposal).toBeNull();
  });

  it("12 confirmed, 7-a-side → viable, proposal names EXACTLY the last two", () => {
    const [fact] = buildFormatSwitchFacts({
      confirmedNames: [
        "Elvin", "Mustafa", "Idris", "Sait", "Kemal", "Elnur",
        "Najib", "Wasim", "Aydın", "Habib", "Mauricio", "Ersin",
      ],
      currentMaxPlayers: 14,
      alternatives: [{ sportName: "Football 5-a-side", totalPlayers: 10 }],
    });
    expect(fact.fills).toBe(true);
    expect(fact.benched).toEqual(["Mauricio", "Ersin"]);
    expect(fact.proposal).toBe(
      "If we don't find 2 more, we could switch to 5-a-side (10 players) — " +
        "Mauricio + Ersin go on the bench. Admins can rebook and flip it in the portal.",
    );
  });

  it("11 confirmed → singular 'goes on the bench' for the single overflow player", () => {
    const [fact] = buildFormatSwitchFacts({
      confirmedNames: [...NAMES(10), "Lastman"],
      currentMaxPlayers: 14,
      alternatives: [{ sportName: "Football 5-a-side", totalPlayers: 10 }],
    });
    expect(fact.benched).toEqual(["Lastman"]);
    expect(fact.proposal).toContain("Lastman goes on the bench");
    expect(fact.proposal).not.toContain("go on the bench.");
  });

  it("10 confirmed vs a 10-total format → viable, and the sentence has NO bench clause", () => {
    const [fact] = buildFormatSwitchFacts({
      confirmedNames: NAMES(10),
      currentMaxPlayers: 14,
      alternatives: [{ sportName: "Football 5-a-side", totalPlayers: 10 }],
    });
    expect(fact.fills).toBe(true);
    expect(fact.benched).toEqual([]);
    expect(fact.proposal).toBe(
      "If we don't find 4 more, we could switch to 5-a-side (10 players) — " +
        "all 10 of you still play, nobody goes on the bench. " +
        "Admins can rebook and flip it in the portal.",
    );
    expect(fact.proposal).not.toMatch(/\bP\d+\b/); // no player named
  });

  it("a FULL squad gets no proposal at all — there is nothing to solve", () => {
    const [fact] = buildFormatSwitchFacts({
      confirmedNames: NAMES(14),
      currentMaxPlayers: 14,
      alternatives: [{ sportName: "Football 5-a-side", totalPlayers: 10 }],
    });
    expect(fact.proposal).toBeNull();
    // The overflow is still reported truthfully for any direct question.
    expect(fact.benched).toEqual(["P11", "P12", "P13", "P14"]);
  });

  it("keeps one fact per alternative, in the order given", () => {
    const facts = buildFormatSwitchFacts({
      confirmedNames: NAMES(11),
      currentMaxPlayers: 22,
      alternatives: [
        { sportName: "Football 7-a-side", totalPlayers: 14 },
        { sportName: "Football 5-a-side", totalPlayers: 10 },
      ],
    });
    expect(facts.map((f) => f.sportName)).toEqual([
      "Football 7-a-side",
      "Football 5-a-side",
    ]);
    expect(facts[0].fills).toBe(false);
    expect(facts[0].benched).toEqual([]);
    expect(facts[1].fills).toBe(true);
    expect(facts[1].benched).toEqual(["P11"]);
  });

  it("returns nothing when there are no alternatives", () => {
    expect(
      buildFormatSwitchFacts({
        confirmedNames: NAMES(8),
        currentMaxPlayers: 14,
        alternatives: [],
      }),
    ).toEqual([]);
  });
});

describe("renderFormatSwitchContext (what the model is handed)", () => {
  it("marks a non-viable format NOT VIABLE and never names a bench player", () => {
    const block = renderFormatSwitchContext(
      buildFormatSwitchFacts({
        confirmedNames: ["Elvin", "Mustafa Y", "Idris", "Sait", "Najib", "Mojib", "Mustafa", "Wasim"],
        currentMaxPlayers: 14,
        alternatives: [{ sportName: "Football 5-a-side", totalPlayers: 10 }],
      }),
    ).join("\n");
    expect(block).toContain("NOT VIABLE");
    expect(block).toContain("Do NOT propose");
    expect(block).toMatch(/bench on switch: NOBODY/i);
    expect(block).not.toContain("Najib");
    expect(block).not.toContain("Mojib");
    // The model must be told, in the block itself, not to redo the maths.
    expect(block).toMatch(/never recompute/i);
  });

  it("hands over the verbatim sentence and the exact bench names when viable", () => {
    const block = renderFormatSwitchContext(
      buildFormatSwitchFacts({
        confirmedNames: [
          "Elvin", "Mustafa", "Idris", "Sait", "Kemal", "Elnur",
          "Najib", "Wasim", "Aydın", "Habib", "Mauricio", "Ersin",
        ],
        currentMaxPlayers: 14,
        alternatives: [{ sportName: "Football 5-a-side", totalPlayers: 10 }],
      }),
    ).join("\n");
    expect(block).toContain("Mauricio, Ersin");
    expect(block).toContain("VERBATIM");
    expect(block).toContain(
      "If we don't find 2 more, we could switch to 5-a-side (10 players) — " +
        "Mauricio + Ersin go on the bench. Admins can rebook and flip it in the portal.",
    );
    // Nobody else from the squad is offered up as bench material.
    expect(block).not.toContain("Habib,");
  });

  it("is empty when there is nothing to say", () => {
    expect(renderFormatSwitchContext([])).toEqual([]);
  });
});
