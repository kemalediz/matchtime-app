/**
 * THE SCORE EXTRACTOR READS THE GAME (2026-11-17, Vets). What is free to
 * prove about the extractor: the field it gained, how its answer is
 * parsed, and that THE GAME reaches its turn and no other extractor's.
 */
import { describe, it, expect } from "vitest";
import { EXTRACTOR_PROMPTS, extractForRoute, factsSchemaFor, parseFacts } from "../extractors";
import type { ModelRequest, PipelineModel } from "../llm";

const wire = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    hasScore: true,
    first: 9,
    second: 4,
    firstTeam: "bibs",
    secondTeam: "no bibs",
    winner: "",
    loser: "",
    teamSides: [],
    momRef: "",
    correction: false,
    swapped: false,
    otherGame: false,
    ...over,
  });

describe("teamSides, parsed", () => {
  it("red and yellow are kept as the sides; unknown is dropped", () => {
    const { facts, degradations } = parseFacts(
      "score",
      wire({
        teamSides: [
          { team: "bibs", side: "red" },
          { team: "no bibs", side: "unknown" },
          { team: "Dan's team", side: "yellow" },
        ],
      }),
      "m1",
    );
    expect(degradations).toEqual([]);
    expect(facts).toMatchObject({
      kind: "score",
      teamSides: [
        { team: "bibs", side: "RED" },
        { team: "Dan's team", side: "YELLOW" },
      ],
    });
  });

  it("a player is carried with or without a side; the schema requires it", () => {
    const { facts } = parseFacts(
      "score",
      wire({ teamSides: [{ team: "Dan's team", side: "unknown", player: "Dan Hale" }, { team: "bibs", side: "red", player: "" }] }),
      "m1",
    );
    expect(facts).toMatchObject({
      teamSides: [
        { team: "Dan's team", player: "Dan Hale" },
        { team: "bibs", side: "RED" },
      ],
    });
    const schema = factsSchemaFor("score") as { properties: { teamSides: { items: { required: string[] } } } };
    expect(schema.properties.teamSides.items.required).toEqual(["team", "side", "player"]);
  });

  it("all unknown, drifted values and empty names leave no teamSides at all", () => {
    const { facts } = parseFacts(
      "score",
      wire({ teamSides: [{ team: "bibs", side: "unknown" }, { team: "", side: "red" }, { team: "x", side: "blue" }, "junk"] }),
      "m1",
    );
    expect(facts.kind === "score" && facts.teamSides).toBeUndefined();
  });

  it("an older answer with no teamSides still parses", () => {
    const raw = JSON.parse(wire());
    delete raw.teamSides;
    const { facts, degradations } = parseFacts("score", JSON.stringify(raw), "m1");
    expect(degradations).toEqual([]);
    expect(facts).toMatchObject({ kind: "score", first: 9, second: 4, firstTeam: "bibs" });
  });
});

describe("the schema and the prompt", () => {
  it("teamSides is required, an array of {team, side} with a closed side list", () => {
    const schema = factsSchemaFor("score") as {
      properties: Record<string, { items?: { properties: Record<string, { enum?: string[] }> } }>;
      required: string[];
    };
    expect(schema.required).toContain("teamSides");
    expect(schema.properties.teamSides.items?.properties.side.enum).toEqual(["red", "yellow", "unknown"]);
  });

  it("the prompt defines THE GAME and teamSides once, and never lets a guess place a side", () => {
    const p = EXTRACTOR_PROMPTS.score;
    expect(p.match(/^teamSides$/gm)).toHaveLength(1);
    expect(p).toContain("THE GAME");
    expect(p).toMatch(/never guess which side wore the bibs/);
    // The incident's own words are held out of the examples (the live check uses them).
    expect(p).not.toContain("bibs 9, no bibs 4");
    // No em or en dashes as punctuation.
    expect(p).not.toMatch(/[–—]/);
  });
});

describe("THE GAME reaches the score extractor's turn, and only it", () => {
  function recording() {
    const seen: ModelRequest[] = [];
    const model: PipelineModel = {
      name: "rec",
      async complete(req) {
        seen.push(req);
        const text =
          req.label === "extractor:score"
            ? wire()
            : req.label === "extractor:admin"
              ? JSON.stringify({ action: "other", toMatchTime: true })
              : JSON.stringify({ claims: [], affirmation: "none", sideRequests: [] });
        return { text, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 };
      },
    };
    return { model, seen };
  }
  const game = ["THE GAME (the club's latest game, the one a result is about): Mon 20:15, finished. MatchTime is waiting for its score.", '  red: MatchTime calls it "Red"; players Ava Stone'];
  const msg = { id: "m1", body: "@Match Time bibs 9, no bibs 4", authorName: "Ava Stone", tagged: true, history: [], lastBotPost: null, game, now: new Date("2026-11-16T22:14:00Z") };

  it("score: the block is above THE MESSAGE", async () => {
    const { model, seen } = recording();
    await extractForRoute(model, "score", msg);
    const user = seen[0].user;
    expect(user).toContain(game[0]);
    expect(user.indexOf(game[0])).toBeLessThan(user.indexOf("THE MESSAGE"));
  });

  it("admin: no block", async () => {
    const { model, seen } = recording();
    await extractForRoute(model, "admin_ops", msg);
    expect(seen[0].user).not.toContain("THE GAME");
  });
});
