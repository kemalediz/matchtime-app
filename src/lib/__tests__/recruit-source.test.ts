/**
 * BEFORE A RECRUIT BLAST FROM THE ATTENDANCE PATH, WHERE ARE THE PLAYERS
 * TO COME FROM? (local player pool L10, manager review of #410). In the
 * players' group the router sends "@Match Time ask the pool for a player"
 * to `offer` (measured on the dev key), whose extractor returns a bare
 * "recruit" side request: today a DM blast to the club's past players. The
 * shared admin extractor reads the same words for the source. Stubbed model.
 */
import { describe, expect, it } from "vitest";
import type { ModelRequest, PipelineModel } from "../pipeline/llm";
import { recruitWantsPool } from "../recruit-source";

const NOW = new Date("2026-10-27T12:00:00Z");
const seen: ModelRequest[] = [];
const extractor = (answer: Record<string, unknown> | Error): PipelineModel => ({
  name: "stub",
  async complete(req) {
    seen.push(req);
    if (answer instanceof Error) throw answer;
    return {
      text: JSON.stringify({ action: "other", payerRef: "", count: 0, coveredRefs: [], undo: false, matchDay: "", phrase: "", note: "", lookbackMatches: 0, playersFrom: "", clubRef: "", toMatchTime: true, ...answer }),
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      ms: 0,
    };
  },
});
const ask = (model: PipelineModel) => recruitWantsPool({ id: "wa-1", body: "@Match Time ask the pool for a player", authorName: "Oscar", now: NOW, model });

describe("recruitWantsPool", () => {
  it("the admin extractor reads recruit from the pool: true, through the admin extractor, told it was tagged", async () => {
    expect(await ask(extractor({ action: "recruit", playersFrom: "pool" }))).toBe(true);
    expect(seen.at(-1)?.label).toBe("extractor:admin");
  });

  it("the club's own players, a partner club, or anything else: false (the blast as today)", async () => {
    expect(await ask(extractor({ action: "recruit", playersFrom: "club" }))).toBe(false);
    expect(await ask(extractor({ action: "recruit", playersFrom: "partners", clubRef: "Sutton" }))).toBe(false);
    expect(await ask(extractor({ action: "other" }))).toBe(false);
  });

  it("a failed call: false, never throws (today's behaviour stands)", async () => {
    expect(await ask(extractor(new Error("529")))).toBe(false);
  });
});
