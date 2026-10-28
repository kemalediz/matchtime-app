/**
 * BEFORE A RECRUIT BLAST FROM THE ATTENDANCE PATH, WHERE ARE THE PLAYERS
 * TO COME FROM? (local player pool L10, manager review of #410; several
 * places and none, 2026-10-28). In the players' group the router sends
 * "@Match Time ask the pool for a player" to `offer` (measured on the dev
 * key), whose extractor returns a bare "recruit" side request: a DM blast
 * to the club's past players. The shared admin extractor reads the same
 * words for the places. Stubbed model.
 */
import { describe, expect, it } from "vitest";
import type { ModelRequest, PipelineModel } from "../pipeline/llm";
import { recruitPlacesFromWords } from "../recruit-source";

const NOW = new Date("2026-10-27T12:00:00Z");
const seen: ModelRequest[] = [];
const extractor = (answer: Record<string, unknown> | Error): PipelineModel => ({
  name: "stub",
  async complete(req) {
    seen.push(req);
    if (answer instanceof Error) throw answer;
    return {
      text: JSON.stringify({ action: "other", payerRef: "", count: 0, coveredRefs: [], undo: false, matchDay: "", pastGame: false, phrase: "", note: "", lookbackMatches: 0, playersFrom: [], clubRef: "", toMatchTime: true, ...answer }),
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      ms: 0,
    };
  },
});
const ask = (model: PipelineModel) => recruitPlacesFromWords({ id: "wa-1", body: "@Match Time ask the pool for a player", authorName: "Oscar", now: NOW, model });

describe("recruitPlacesFromWords", () => {
  it("the pool: through the admin extractor, told it was tagged", async () => {
    expect(await ask(extractor({ action: "recruit", playersFrom: ["pool"] }))).toEqual({ sources: ["pool"], clubRef: null });
    expect(seen.at(-1)?.label).toBe("extractor:admin");
  });

  it("several places, in order, the partners before the pool", async () => {
    expect(await ask(extractor({ action: "recruit", playersFrom: ["pool", "partners"] }))).toEqual({ sources: ["partners", "pool"], clubRef: null });
    expect(await ask(extractor({ action: "recruit", playersFrom: ["partners", "pool"], clubRef: "Sutton" }))).toEqual({ sources: ["partners", "pool"], clubRef: "Sutton" });
  });

  it("the club's own players, and a partner club alone", async () => {
    expect(await ask(extractor({ action: "recruit", playersFrom: ["club"] }))).toEqual({ sources: ["club"], clubRef: null });
    expect(await ask(extractor({ action: "recruit", playersFrom: ["partners"], clubRef: "Sutton" }))).toEqual({ sources: ["partners"], clubRef: "Sutton" });
  });

  it("nowhere said: sources null (the organiser is asked when the club has more)", async () => {
    expect(await ask(extractor({ action: "recruit", playersFrom: [] }))).toEqual({ sources: null, clubRef: null });
  });

  it("not a recruit, or a failed call: null, never throws (the blast as today)", async () => {
    expect(await ask(extractor({ action: "other" }))).toBeNull();
    expect(await ask(extractor(new Error("529")))).toBeNull();
  });
});
