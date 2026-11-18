/**
 * ONE RULE FOR WHEN A MAN OF THE MATCH VOTE IS OPEN (review of #608, round
 * 3): kickoff plus the activity's `ratingWindowHours`, inclusive. Read by
 * the web vote (`actions/ratings.ts`), the WhatsApp poll vote
 * (`api/whatsapp/poll-vote`) and the answer's loader (`mom-records.ts`), so
 * "final once the window is over" holds on every path.
 */
import { describe, expect, it } from "vitest";
import { momVoteClosesAt, momVoteOpen } from "../mom-vote-window";

const KICKOFF = new Date("2026-11-03T20:00:00Z");
const H = 60 * 60 * 1000;

describe("the Man of the Match vote window", () => {
  it("closes ratingWindowHours after kickoff", () => {
    expect(momVoteClosesAt(KICKOFF, 120).toISOString()).toBe("2026-11-08T20:00:00.000Z");
  });

  it("is open up to and including the closing instant, and shut after it", () => {
    expect(momVoteOpen(KICKOFF, 72, new Date(KICKOFF.getTime() + 72 * H))).toBe(true);
    expect(momVoteOpen(KICKOFF, 72, new Date(KICKOFF.getTime() + 72 * H + 1))).toBe(false);
    expect(momVoteOpen(KICKOFF, 168, new Date(KICKOFF.getTime() + 100 * H))).toBe(true);
  });
});
