/**
 * The open-question context, on the measurement side.
 *
 * The two real cases, replayed through the harness's own reconstruction
 * rather than through hand-written windows: if `awaitingQuestionsFrom`
 * and `openQuestionForBatch` do not find them, the sweep cannot report
 * the thing the gate is blocked on.
 */
import { describe, it, expect } from "vitest";
import {
  awaitingQuestionsFrom,
  openQuestionForBatch,
  summariseAwaiting,
  PI_FLUSH_MS,
} from "./router-recall-awaiting";
import { summariseRecall, type RoutedRow } from "./router-recall";
import type { ReplaySource } from "./types";

const ORG = "cmnnwhdx30000zfr85q18lyy9";
const OTHER_ORG = "cmplc3znw0000719kj8f1gkon";

/** The two matches the two cases happened on, and the 2026-06-18 one
 *  that is the negative. Everything else in `ReplaySource` is unused by
 *  this module, so it is empty rather than invented. */
const SOURCE = {
  messages: [],
  matches: [
    { id: "may5", orgId: ORG, date: "2026-05-05T19:30:00.000Z" },
    { id: "jun16", orgId: ORG, date: "2026-06-16T19:30:00.000Z" },
    { id: "jun18", orgId: OTHER_ORG, date: "2026-06-18T19:00:00.000Z" },
  ],
  attendance: [],
  memberships: [],
  users: [],
  orgs: [],
  teamAssignments: [],
  benchOffers: [
    // Case 2: Ehtisham dropped, Aydın claimed it with a `👍`.
    { matchId: "jun16", replacingUserId: null, createdAt: "2026-06-15T20:40:10.493Z", resolvedAt: "2026-06-15T20:50:08.637Z" },
    // The negative: closed at 08:10:10, and Nabeel's `👍👍` was 14:50.
    { matchId: "jun18", replacingUserId: null, createdAt: "2026-06-18T08:10:07.769Z", resolvedAt: "2026-06-18T08:10:10.955Z" },
    // A match that is not in the extract at all — dropped, not guessed.
    { matchId: "gone", replacingUserId: null, createdAt: "2026-06-15T20:40:10.493Z", resolvedAt: null },
  ],
  pendingBenchConfirmations: [
    // Case 1.
    {
      matchId: "may5",
      userId: "cmo606q0100000gr8usbnhkdl",
      createdAt: "2026-05-05T07:12:35.350Z",
      resolvedAt: "2026-05-05T07:42:36.785Z",
      expiresAt: "2026-05-05T19:30:00.000Z",
    },
  ],
  tentativeAvailabilities: [
    // `notifiedAt` null: the follow-up DM never went out, so MatchTime
    // never asked and there is nothing to wait for.
    { matchId: "jun16", userId: "u", notifiedAt: null, resolvedAt: null },
  ],
} as unknown as ReplaySource;

describe("awaitingQuestionsFrom", () => {
  const qs = awaitingQuestionsFrom(SOURCE);

  it("reads all three tables and drops a question whose match is gone", () => {
    expect(qs.map((q) => q.kind).sort()).toEqual(["bench-confirmation", "bench-slot-offer", "bench-slot-offer"]);
  });

  it("never invents a question out of a follow-up DM that was never sent", () => {
    expect(qs.some((q) => q.kind === "tentative-followup")).toBe(false);
  });

  it("closes a question at whichever came first, the answer or kickoff", () => {
    const case1 = qs.find((q) => q.kind === "bench-confirmation")!;
    // resolved 07:42:36, expires 19:30 — the answer came first.
    expect(case1.closesAt?.toISOString()).toBe("2026-05-05T07:42:36.785Z");
  });

  it("carries the org through from the match, so one club cannot see another's", () => {
    expect(qs.filter((q) => q.orgId === OTHER_ORG)).toHaveLength(1);
  });
});

describe("openQuestionForBatch — the two real cases", () => {
  const qs = awaitingQuestionsFrom(SOURCE);

  it("case 1: the 07:45:08 batch overlaps a question that closed at 07:42:36", () => {
    // The question was open when the message ARRIVED; the rows landed
    // later. A point-in-time test at 07:45:08 would miss it, which is
    // exactly why the harness reads the flush window.
    const q = openQuestionForBatch(qs, ORG, new Date("2026-05-05T07:45:08.806Z"));
    expect(q?.kind).toBe("bench-confirmation");
  });

  it("case 2: the 20:50:09 batch overlaps the offer opened at 20:40:10", () => {
    const q = openQuestionForBatch(qs, ORG, new Date("2026-06-15T20:50:09.796Z"));
    expect(q?.kind).toBe("bench-slot-offer");
  });
});

describe("openQuestionForBatch — the negatives", () => {
  const qs = awaitingQuestionsFrom(SOURCE);

  it("Nabeel's `👍👍` at 14:50 — the day's offer closed at 08:10", () => {
    expect(openQuestionForBatch(qs, OTHER_ORG, new Date("2026-06-18T14:50:09.208Z"))).toBeNull();
  });

  it("a batch before MatchTime asked anything", () => {
    expect(openQuestionForBatch(qs, ORG, new Date("2026-06-15T20:00:00.000Z"))).toBeNull();
  });

  it("another club's open question is not this club's", () => {
    expect(openQuestionForBatch(qs, "someone-else", new Date("2026-06-15T20:50:09.796Z"))).toBeNull();
  });

  it("the flush window is what it says it is, and nothing wider", () => {
    const q = awaitingQuestionsFrom(SOURCE).find((x) => x.kind === "bench-confirmation")!;
    const closed = q.closesAt!.getTime();
    expect(openQuestionForBatch(qs, ORG, new Date(closed + PI_FLUSH_MS - 1))).not.toBeNull();
    expect(openQuestionForBatch(qs, ORG, new Date(closed + PI_FLUSH_MS))).toBeNull();
  });
});

describe("summariseAwaiting — before and after, from one sweep", () => {
  const row = (o: Partial<RoutedRow>): RoutedRow => ({
    waMessageId: "x",
    groupRef: "g",
    body: "👍",
    intent: "noise",
    handledBy: "llm",
    createdAt: "2026-06-15T20:50:09.796Z",
    route: "none",
    source: "model",
    ...o,
  });

  const rows: RoutedRow[] = [
    // rescued: production called it `in`, the router called it `none`
    row({ waMessageId: "a", intent: "in", route: "unsure", source: "awaiting", overrodeRoute: "none" }),
    // dragged back: benign, one analyzer call, nothing worse
    row({ waMessageId: "b", intent: "noise", route: "unsure", source: "awaiting", overrodeRoute: "none" }),
    // untouched banter
    row({ waMessageId: "c", intent: "noise", route: "none", source: "model" }),
    // a miss the context did not reach
    row({ waMessageId: "d", intent: "out", route: "none", source: "model" }),
  ];

  const report = summariseRecall(rows);
  const eff = summariseAwaiting(rows, report);

  it("counts the rescue and the drag separately", () => {
    expect(eff.rescuedMisses.map((m) => m.waMessageId)).toEqual(["a"]);
    expect(eff.forcedBenign).toBe(1);
  });

  it("recovers the run WITHOUT the context exactly, with no second sweep", () => {
    // after: only `d` is still a miss. before: `a` and `d`.
    expect(report.misses).toHaveLength(1);
    expect(eff.missesBefore).toBe(2);
    // benign: `b` and `c`. after: only `c` was skipped. before: both.
    expect(report.noneOnBenign).toBe(1);
    expect(eff.noneOnBenignBefore).toBe(2);
    expect(eff.savingRateBefore).toBeGreaterThan(report.savingRate);
  });

  it("reports nothing when the context never fired", () => {
    const quiet = rows.map((r) => ({ ...r, source: "model", overrodeRoute: undefined }));
    const qReport = summariseRecall(quiet);
    const qEff = summariseAwaiting(quiet, qReport);
    expect(qEff.forced).toBe(0);
    expect(qEff.missesBefore).toBe(qReport.misses.length);
    expect(qEff.savingRateBefore).toBe(qReport.savingRate);
  });
});
