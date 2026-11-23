/**
 * A MONTHLY CLUB'S ORGANISER DMs TWO THINGS, ONE OF THEM A SEASON BREAK
 * (review of #629, item 1). The break is found wherever it sits among the
 * actions and set, and the one reply names what a DM cannot do here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  membership: { findMany: vi.fn() },
  botJob: { create: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("../db", () => ({ db: dbMock }));
const words = vi.hoisted(() => ({ applySeasonBreakWords: vi.fn() }));
vi.mock("../season-break-words", () => words);
vi.mock("../ai-budget", () => ({ withOrgAiBudget: async (_o: string, f: () => unknown) => f() }));

import { handleSeasonBreakDm } from "../season-break-dm";
import type { PipelineModel } from "../pipeline/llm";

const NOW = new Date("2026-11-23T14:44:00Z");
const model = (body: unknown): PipelineModel => ({
  name: "stub",
  async complete() {
    return { text: JSON.stringify(body), stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 };
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.membership.findMany.mockResolvedValue([{ org: { id: "vets", squadMode: "monthly", language: "en" } }]);
  words.applySeasonBreakWords.mockResolvedValue({ outcome: "season-break-set", replyText: "✅ No football in December." });
});

describe("handleSeasonBreakDm, several actions", () => {
  it("the break second: set, and the other action named in the same DM", async () => {
    const r = await handleSeasonBreakDm({
      userId: "u-davide",
      text: "turn off quiet hours and no football in December",
      authorName: "Davide",
      replyPhone: "447700900123",
      now: NOW,
      deps: {
        model: model({
          toMatchTime: true,
          actions: [
            { action: "quiet_hours", quietOff: true, words: "turn off quiet hours" },
            { action: "season_break", breakMonths: ["2026-12"], words: "no football in December" },
          ],
        }),
      },
    });
    expect(r).toEqual({ handled: "season-break-set" });
    expect(words.applySeasonBreakWords).toHaveBeenCalledWith(expect.objectContaining({ breakMonths: ["2026-12"] }));
    const text = dbMock.botJob.create.mock.calls[0][0].data.text as string;
    expect(text).toBe('✅ No football in December.\n\nI couldn\'t do this part of your message: "turn off quiet hours". Please ask me for it on its own.');
  });
});
