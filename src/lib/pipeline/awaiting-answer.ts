/**
 * "IS MATCHTIME STILL WAITING FOR AN ANSWER?" — THE ONE FACT THE ROUTER
 * WAS MISSING.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE GAP THIS CLOSES
 * ─────────────────────────────────────────────────────────────────────
 *
 * PR #42 put the router in front of the analyzer, default off, and
 * measured it over all 1,695 production messages that have a body. It
 * routes 80.8% of benign traffic to `none` and would skip the analyzer
 * on 44% of batches. Exactly **two messages of 1,695 (0.12%)** are an
 * attendance write the gate would have lost, and both are the same
 * thing: **a bare `👍`**.
 *
 *   1. 2026-05-05T07:45:08.806Z, Aydın Kocahal, `👍` → production wrote
 *      `IN`. It answered the `PendingBenchConfirmation` MatchTime had
 *      opened for him 32 minutes earlier.
 *   2. 2026-06-15T20:50:09.796Z, Aydın Kocahal, `👍` → production wrote
 *      `IN`. It claimed the `BenchSlotOffer` opened 10 minutes earlier
 *      when Ehtisham Ul Haq dropped.
 *
 * PR #42's own conclusion: *"the floor cannot cover it without becoming
 * a classifier again."* That is right, and it is why there is no `👍`
 * pattern anywhere in this file.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY A ROW AND NOT A REGEX
 * ─────────────────────────────────────────────────────────────────────
 *
 * A bare `👍` means NOTHING on its own. Over the same history it is
 * banter far more often than it is a registration — `👍👍` and
 * `🙏🙏🙏👍` from Nabeel on 2026-06-18, `👍` from David on 2026-07-14,
 * every one of them `noise`. A floor entry matching `👍` would force all
 * of them to the analyzer regardless of what they answered, which is the
 * floor doing CLASSIFICATION: exactly what PR #33 deleted, and what
 * PR #42 measured as a complete no-op (183 floor claims, **zero**
 * rescues).
 *
 * The information is not in the token. It is in the conversation, and
 * the part of the conversation that MatchTime writes down is its own
 * open questions:
 *
 *   `BenchSlotOffer`            a slot opened and nobody has claimed it
 *   `PendingBenchConfirmation`  a named bench player was asked to confirm
 *   `TentativeAvailability`     the follow-up DM went out and came back
 *                               with nothing
 *
 * While one of those is open, MatchTime is waiting for an answer, and a
 * `none` route is not trusted. When none is open — which is 99% of the
 * history — nothing here changes anything at all.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE AUDIENCE IS THE GROUP, AND THAT IS FORCED, NOT CHOSEN
 * ─────────────────────────────────────────────────────────────────────
 *
 * A `PendingBenchConfirmation` names one player, so "waiting for an
 * answer from THIS person" would be tighter. The gate cannot use it:
 * it runs before sender resolution, so at route time a message has an
 * author NAME and no user id. Widening to the group is therefore the
 * only shape available, and it is the safe direction — it can only add
 * analyzer calls, never remove one. Measured cost below.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THERE IS A TTL
 * ─────────────────────────────────────────────────────────────────────
 *
 * A `BenchSlotOffer` lives until kickoff. One real offer
 * (`cmpleeq960000wm9kov23qexz`) stayed open for **22 hours**. Nobody is
 * answering a question 22 hours later, and treating all of it as "still
 * waiting" would drag a day of banter into the analyzer for nothing.
 *
 * Measured over the same 1,723 messages, messages inside an open window:
 *
 *   no TTL   119        ← a day of banter, twice
 *   60 min    69        ← the knee
 *   30 min    66
 *   20 min    65
 *   10 min    59        ← and it MISSES case 1 (32.6 min)
 *
 * An hour is the knee and it clears both real cases (10.0 min and
 * 32.6 min) comfortably. It is also six Pi flush windows, so an answer
 * that took two or three flushes to reach the analyzer is still inside
 * it.
 *
 * PURE. Not one import, no clock of its own, no database. The rows come
 * from `load-awaiting-answer.ts`, which is the only thing here that
 * touches Prisma — `router.ts` and `gate.ts` both have to stay loadable
 * in the Playwright worker the recall harness runs in, and a runtime
 * Prisma import anywhere in their graph breaks that.
 */
export type AwaitingKind = "bench-slot-offer" | "bench-confirmation" | "tentative-followup";

/** One question MatchTime asked and has not had an answer to. */
export interface AwaitingQuestion {
  /** The row's id, so a route can be traced back to what opened it. */
  id: string;
  orgId: string;
  kind: AwaitingKind;
  /** When MatchTime asked. */
  askedAt: Date;
  /** When the row stops being open on its own terms — resolved,
   *  expired, or kickoff. `null` when nothing bounds it. */
  closesAt: Date | null;
}

/**
 * How long after asking MatchTime is still treated as waiting.
 *
 * See the essay above for the measurement this number comes from. It is
 * deliberately a constant rather than a flag: a knob here is a knob on
 * how much banter reaches the analyzer, and the honest way to change it
 * is to re-run the recall sweep.
 */
export const GROUP_QUESTION_TTL_MS = 60 * 60 * 1000;

/** PURE. Is `q` still open at `now`? */
export function isAnswerWindowOpen(q: AwaitingQuestion, now: Date): boolean {
  const t = now.getTime();
  const asked = q.askedAt.getTime();
  if (t < asked) return false;
  if (t - asked >= GROUP_QUESTION_TTL_MS) return false;
  if (q.closesAt && t >= q.closesAt.getTime()) return false;
  return true;
}

/**
 * PURE. The open question this batch could be answering, or null.
 *
 * Earliest first, so the answer is stable when two slots opened at once
 * (2026-05-25 and 2026-05-26 both produced offer pairs milliseconds
 * apart) and a report can name one of them rather than "some question".
 */
export function openQuestionAt(
  questions: AwaitingQuestion[],
  orgId: string,
  now: Date,
): AwaitingQuestion | null {
  let best: AwaitingQuestion | null = null;
  for (const q of questions) {
    if (q.orgId !== orgId) continue;
    if (!isAnswerWindowOpen(q, now)) continue;
    if (!best || q.askedAt.getTime() < best.askedAt.getTime()) best = q;
  }
  return best;
}

/** Human wording for a degradation line and for the recall report. */
export function describeQuestion(q: AwaitingQuestion): string {
  return `${q.kind} ${q.id} opened ${q.askedAt.toISOString()}`;
}

