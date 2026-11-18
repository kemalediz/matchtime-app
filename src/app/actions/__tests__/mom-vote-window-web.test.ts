/**
 * THE WEB MAN OF THE MATCH VOTE OBEYS THE WINDOW (review of #608, round 4).
 * `submitMoMVote` refuses a vote once kickoff plus the activity's
 * `ratingWindowHours` has passed (`mom-vote-window.ts`, the rule the poll
 * vote and the answer share), so a result is final once the window is over.
 * Removing the check fails this test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.fn();
let kickoff = new Date();

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "u-voter" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    match: {
      findUnique: async () => ({
        id: "m-1",
        date: kickoff,
        status: "COMPLETED",
        activity: { ratingWindowHours: 72, org: { momChosenBy: "players" } },
      }),
    },
    attendance: {
      findUnique: async () => ({ status: "CONFIRMED" }),
      findMany: async () => [],
    },
    moMVote: { upsert: (...a: unknown[]) => upsert(...a) },
  },
}));

import { submitMoMVote } from "../ratings";

const H = 60 * 60 * 1000;

beforeEach(() => {
  upsert.mockReset();
  upsert.mockResolvedValue({});
});

describe("submitMoMVote and the vote window", () => {
  it("inside the window the vote is written", async () => {
    kickoff = new Date(Date.now() - 10 * H);
    await expect(submitMoMVote("m-1", { playerId: "u-player" })).resolves.toEqual({ saved: true });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("after the window it is refused and nothing is written", async () => {
    kickoff = new Date(Date.now() - 73 * H);
    await expect(submitMoMVote("m-1", { playerId: "u-player" })).rejects.toThrow("Rating window has closed");
    expect(upsert).not.toHaveBeenCalled();
  });
});
