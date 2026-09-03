/**
 * THE LAST GAP IN FRONT OF `ROUTER_GATE_ENABLED`.
 *
 * PR #42 routed all 1,695 production messages that have a body through
 * the real router and found exactly TWO that are an attendance write the
 * gate would have lost. Both are the same thing: **a bare `👍`**.
 *
 *   1. 2026-05-05T07:45:08.806Z — Aydın Kocahal, `👍`.
 *      Production: `intent=in`, `action=IN`.
 *      What it answered: a `PendingBenchConfirmation` MatchTime had
 *      opened for him at 07:12:35 (`cmoscovpy0000dnr8xwa5homh`,
 *      `replacingUserId` = ba, `expiresAt` 19:30). The `👍` resolved it
 *      `confirmed` at 07:42:36 and moved his Attendance row.
 *
 *   2. 2026-06-15T20:50:09.796Z — Aydın Kocahal again, `👍`.
 *      Production: `intent=in`, `action=IN`.
 *      What it answered: a `BenchSlotOffer` opened at 20:40:10
 *      (`cmqfqlda5000004jpzqopngpk`, `replacingUserId` = Ehtisham Ul
 *      Haq). The `👍` claimed it at 20:50:08.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT A `👍` PATTERN IN THE FLOOR
 * ─────────────────────────────────────────────────────────────────────
 *
 * A bare `👍` means NOTHING on its own. In the same 1,695 messages it is
 * banter far more often than it is a registration — Nabeel's `👍👍` on
 * 2026-06-18, his `🙏🙏🙏👍`, David's `👍` on 2026-07-14, all `noise`. A
 * floor entry matching `👍` would route every one of them to the
 * analyzer whatever it was answering, which is the floor becoming a
 * classifier again — the thing PR #33 deleted and PR #42 measured as a
 * complete no-op (183 claims, zero rescues).
 *
 * So the information is not in the token. It is in the DATABASE: does
 * MatchTime have an open, unanswered question on the board right now?
 * That is a row, not a regex — a `BenchSlotOffer` with `resolvedAt IS
 * NULL`, a `PendingBenchConfirmation` still inside its expiry, a
 * `TentativeAvailability` whose follow-up DM went out and came back with
 * nothing. While one of those is open the router's `none` is not
 * trusted, and when none is open nothing changes at all.
 *
 * The negative direction is the larger population by far and is tested
 * explicitly below.
 */
import { describe, it, expect } from "vitest";
import {
  GROUP_QUESTION_TTL_MS,
  isAnswerWindowOpen,
  openQuestionAt,
  type AwaitingQuestion,
} from "../awaiting-answer";

const T = (s: string) => new Date(s);

/** Case 1, exactly as production recorded it. */
const BENCH_CONFIRMATION: AwaitingQuestion = {
  id: "cmoscovpy0000dnr8xwa5homh",
  orgId: "cmnnwhdx30000zfr85q18lyy9",
  kind: "bench-confirmation",
  askedAt: T("2026-05-05T07:12:35.350Z"),
  closesAt: T("2026-05-05T19:30:00.000Z"),
};

/** Case 2, exactly as production recorded it. */
const BENCH_SLOT_OFFER: AwaitingQuestion = {
  id: "cmqfqlda5000004jpzqopngpk",
  orgId: "cmnnwhdx30000zfr85q18lyy9",
  kind: "bench-slot-offer",
  askedAt: T("2026-06-15T20:40:10.493Z"),
  closesAt: T("2026-06-16T19:30:00.000Z"),
};

describe("the two real production `👍`s — the release condition for the gate", () => {
  it("case 1: MatchTime was still waiting on Aydın when the 👍 arrived (2026-05-05)", () => {
    // The batch that carried the `👍` was analysed at 07:45:08.806.
    expect(
      openQuestionAt([BENCH_CONFIRMATION], "cmnnwhdx30000zfr85q18lyy9", T("2026-05-05T07:45:08.806Z")),
    ).toEqual(BENCH_CONFIRMATION);
  });

  it("case 2: the bench slot was still open when the 👍 arrived (2026-06-15)", () => {
    expect(
      openQuestionAt([BENCH_SLOT_OFFER], "cmnnwhdx30000zfr85q18lyy9", T("2026-06-15T20:50:09.796Z")),
    ).toEqual(BENCH_SLOT_OFFER);
  });
});

describe("the negative direction — the population that is 500x larger", () => {
  it("MatchTime has asked nothing: no window, whatever the message says", () => {
    expect(openQuestionAt([], "cmnnwhdx30000zfr85q18lyy9", T("2026-07-14T18:55:50.130Z"))).toBeNull();
  });

  it("Nabeel's `👍👍` on 2026-06-18 — the day's offers closed at 08:10, he posted at 14:50", () => {
    const closed: AwaitingQuestion = {
      id: "cmqja4cyh000004juesd179vh",
      orgId: "cmplc3znw0000719kj8f1gkon",
      kind: "bench-slot-offer",
      askedAt: T("2026-06-18T08:10:07.769Z"),
      closesAt: T("2026-06-18T08:10:10.955Z"),
    };
    expect(openQuestionAt([closed], "cmplc3znw0000719kj8f1gkon", T("2026-06-18T14:50:09.208Z"))).toBeNull();
  });

  it("a question open in ANOTHER org never reaches this group", () => {
    expect(openQuestionAt([BENCH_SLOT_OFFER], "some-other-org", T("2026-06-15T20:50:09.796Z"))).toBeNull();
  });

  it("a question asked AFTER the batch cannot be what the batch answered", () => {
    expect(
      openQuestionAt([BENCH_SLOT_OFFER], BENCH_SLOT_OFFER.orgId, T("2026-06-15T20:00:00.000Z")),
    ).toBeNull();
  });
});

describe("the window closes, and says when", () => {
  it("closes at `closesAt`, EARLIER than the TTL, when the row says so", () => {
    // The 2026-06-18 offer that Nabeel claimed: opened 08:10:07,
    // resolved 08:10:10. Three seconds, not an hour.
    const shortLived: AwaitingQuestion = {
      id: "cmqja4cyh000004juesd179vh",
      orgId: "cmplc3znw0000719kj8f1gkon",
      kind: "bench-slot-offer",
      askedAt: T("2026-06-18T08:10:07.769Z"),
      closesAt: T("2026-06-18T08:10:10.955Z"),
    };
    expect(isAnswerWindowOpen(shortLived, T("2026-06-18T08:10:10.954Z"))).toBe(true);
    expect(isAnswerWindowOpen(shortLived, T("2026-06-18T08:10:10.955Z"))).toBe(false);
    // …and the TTL alone would still have said "open" at that instant.
    expect(shortLived.closesAt!.getTime() - shortLived.askedAt.getTime()).toBeLessThan(
      GROUP_QUESTION_TTL_MS,
    );
  });

  it("closes after the TTL even when the row is still open", () => {
    // A bench slot offer lives until kickoff — one observed offer stayed
    // open for 22 hours. Nobody is answering a question 22 hours later,
    // and treating the whole of it as "MatchTime is waiting" would drag
    // a day of banter into the analyzer. Measured over the same 1,723
    // messages: no TTL costs 119 forced analyses, one hour costs 69, ten
    // minutes costs 59. An hour is the knee, and it is comfortably clear
    // of both real cases (10.0 min and 32.6 min).
    const justInside = new Date(BENCH_SLOT_OFFER.askedAt.getTime() + GROUP_QUESTION_TTL_MS - 1);
    const justOutside = new Date(BENCH_SLOT_OFFER.askedAt.getTime() + GROUP_QUESTION_TTL_MS + 1);
    expect(isAnswerWindowOpen(BENCH_SLOT_OFFER, justInside)).toBe(true);
    expect(isAnswerWindowOpen(BENCH_SLOT_OFFER, justOutside)).toBe(false);
  });

  it("the TTL is longer than the gap in BOTH real cases", () => {
    const gap1 = T("2026-05-05T07:45:08.806Z").getTime() - BENCH_CONFIRMATION.askedAt.getTime();
    const gap2 = T("2026-06-15T20:50:09.796Z").getTime() - BENCH_SLOT_OFFER.askedAt.getTime();
    expect(gap1).toBeLessThan(GROUP_QUESTION_TTL_MS);
    expect(gap2).toBeLessThan(GROUP_QUESTION_TTL_MS);
    // …and the shorter one is only just over the Pi's ten-minute flush
    // window, which is why a ten-minute TTL is not safe here.
    expect(gap2).toBeGreaterThan(9 * 60 * 1000);
  });

  it("picks the EARLIEST open question when several are on the board", () => {
    const later: AwaitingQuestion = { ...BENCH_SLOT_OFFER, id: "later", askedAt: T("2026-06-15T20:45:00.000Z") };
    expect(
      openQuestionAt([later, BENCH_SLOT_OFFER], BENCH_SLOT_OFFER.orgId, T("2026-06-15T20:50:09.796Z"))?.id,
    ).toBe(BENCH_SLOT_OFFER.id);
  });
});
