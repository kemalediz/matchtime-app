/**
 * The Man of the Match label on each match in the Recent History block
 * (`momLabelOf`, match-history.ts), from the shared decision (review of
 * #608). An open vote shows no leader and no counts, and a closed vote
 * never claims a post is coming unless one is.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { momLabelOf } from "../match-history";
import type { MomMatchDecision } from "../mom-records";

const at = new Date("2026-11-03T20:00:00Z");
const pending = (state: "voting" | "closed" | "undecided", toBePosted: boolean): MomMatchDecision => ({
  date: at,
  decision: { kind: "pending", state, toBePosted },
  credit: [],
});
const told = (mom: Record<string, unknown>, credit: Array<{ userId: string; name: string }>): MomMatchDecision => ({
  date: at,
  decision: { kind: "told", mom: { tally: [], votes: null, pickedByOrganisers: false, winners: credit, told: "winner-only", ...mom } as never, credit },
  credit,
});

describe("momLabelOf", () => {
  it("an open vote: no leader, no counts", () => {
    expect(momLabelOf(pending("voting", true))).toBe("vote still open");
    expect(momLabelOf(pending("undecided", false))).toBe("vote still open");
  });

  it("closed: 'not posted yet' only when a post is coming; otherwise just closed", () => {
    expect(momLabelOf(pending("closed", true))).toBe("vote closed, result to be posted in the group");
    expect(momLabelOf(pending("closed", false))).toBe("vote closed");
  });

  it("decided: as announced with the votes, the winner only, a pick, shared", () => {
    const pete = [{ userId: "u-p", name: "Pete" }];
    expect(momLabelOf(told({ told: "announced", votes: { top: 3, total: 4 } }, pete))).toBe("Pete (3 of 4 votes)");
    expect(momLabelOf(told({}, pete))).toBe("Pete");
    expect(momLabelOf(told({ pickedByOrganisers: true }, pete))).toBe("Pete (picked by the organisers)");
    expect(momLabelOf(told({}, [...pete, { userId: "u-d", name: "Dan" }]))).toBe("shared between Pete & Dan");
  });

  it("an organisers' pick still to be posted: no name", () => {
    expect(momLabelOf(pending("picked" as never, true))).toBe("picked by the organisers, to be posted in the group");
  });

  it("posted before results were stored, vote still open: no name", () => {
    expect(momLabelOf(told({ told: "posted-unrecorded", winners: [] }, []))).toBe("result posted in the group (no copy held here)");
  });

  it("no votes at all", () => {
    expect(momLabelOf(undefined)).toBe("no votes yet");
  });
});
