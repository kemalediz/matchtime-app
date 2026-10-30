/**
 * What a roster-SHAPED message may say to the attendance engine: only its
 * sender's own drop (`clampPastedRosterFacts`, below).
 *
 * KEPT ONLY FOR `attendance-engine-batch.ts` and `pipeline/run.ts` (another
 * package of the 2026-10-30 "no string parsing" sweep owns them and is
 * replacing this shape test with a fact). The registration half that lived
 * here (`decidePastedRosterRegistration`, the numbered-list arithmetic) is
 * deleted: the analyze route reads a pasted list with the squad reader
 * (`hq-squad-reader.ts`, `place: "players"`). Delete this file with its
 * last caller.
 */
import type { Facts } from "./pipeline/types";
import { parsePastedRoster } from "./pasted-roster";

// ══════════════════════════════════════════════════════════════════════
// THE ONE THING A ROSTER-SHAPED MESSAGE MAY ALSO SAY: THE SENDER IS OUT
// ══════════════════════════════════════════════════════════════════════
//
// ── The defect this exists for (2026-09-07, PR #55's `test.fail()`) ───
// The route's paste branch used to be TERMINAL: any message
// `parsePastedRoster` recognised was peeled out of the batch before the
// router ran, and `attendance-engine-batch.ts` refused the same shape
// independently. So a message that was BOTH a list and its sender's own
// drop lost the drop entirely. Pat posts "can't make it lads, someone
// take my spot" above the list and stays CONFIRMED: the squad reads
// full, the vacated slot is never offered to the bench, and the club is
// a player short on the night.
//
// That is the fourth instance of one bug class in this repo — a terminal
// branch that silently deletes every guard below it (MEMORY.md,
// "terminal short-circuits skip every guard below"). The fix follows
// that note's own instruction: do not reimplement drop handling inside
// the paste branch, leave the message to the owner that already has the
// rules. This function is what makes leaving it there safe.
//
// ── Why the sender's OUT, and ONLY the sender's OUT ───────────────────
//
//   • A THIRD-PARTY claim off a roster message is the exact write PR #39
//     exists to stop. PR #35 measured the same paste against the same
//     world twice and got `Nabeel` one run and `Adam, Amir, Ehtisham,
//     Martin` the next. Who a list registers is arithmetic
//     (`reconcilePastedRoster`), never a reading.
//   • The SENDER'S OWN IN is the same hazard wearing a friendlier face.
//     A sender whose name is a slot ("4. Adam", sent by Adam) is read as
//     a self IN on one run and not on the next, which would put back the
//     non-determinism on the not-of-record branch whose whole rule is
//     "registers NOBODY". The of-record branch already registers an
//     appended sender ARITHMETICALLY (`senderAddition`), so there is
//     nothing here for a model to add that is not either redundant or
//     wrong.
//   • The SENDER'S OWN OUT has no other owner and cannot be produced by
//     arithmetic at all: a paste can only ever ADD lines, so nothing in
//     `reconcilePastedRoster` can drop anybody. It is self-attendance —
//     the tag-free, no-provisioning, no-ghost-member class — and §13's
//     asymmetry ("a missed add is recoverable in one message; a wrong
//     registration on a paid match is not") is an argument FOR keeping
//     it, not against: a missed drop is neither of those two, it is the
//     club turning up short.
//
// SHAPE, NEVER CONTENT. The test is `parsePastedRoster` on the envelope
// and `subject`/`polarity` on the claim, so nothing about who is named
// can steer it.
//
// WHAT IS STILL LOST, deliberately and unchanged: the `offList` residue,
// "here's the list, also adding Kieran". That is the §13-accepted missed
// ADD this module's header already names, it is asserted as a passing
// test in `e2e/api/pasted-roster.spec.ts`, and this change does not
// touch it.

export interface RosterFactsClamp {
  /** The facts the owner may act on. `{kind:"none"}` when the message
   *  said nothing a roster-shaped message is allowed to say. */
  facts: Facts;
  /** How many claims were removed, for the log line. */
  dropped: number;
}

/**
 * Clamp what may be read out of a message that IS a pasted roster.
 *
 * Pure. Not a roster → the facts pass through untouched and this
 * function has no opinion at all.
 */
export function clampPastedRosterFacts(
  body: string | null | undefined,
  facts: Facts,
): RosterFactsClamp {
  if (!parsePastedRoster(body)) return { facts, dropped: 0 };
  // Only the attendance extractor can produce a claim, and the four
  // routes the attendance engine owns are the only ones that reach this.
  // Any other shape carries nothing this clamp is about, and a roster is
  // not a question or a score either, so it becomes nothing.
  if (facts.kind !== "attendance") {
    return { facts: facts.kind === "none" ? facts : { kind: "none" }, dropped: 0 };
  }
  const kept = facts.claims.filter((c) => c.subject === "sender" && c.polarity === "out");
  const dropped = facts.claims.length - kept.length;
  if (kept.length === 0) return { facts: { kind: "none" }, dropped };
  return {
    facts: {
      kind: "attendance",
      claims: kept,
      // A bare "yes"/"no" answering MatchTime's last post, and a
      // "recruit"/"teams" side request, are both things the paste branch
      // has never owned. Widening them is not this fix's business and
      // the direction of the loss is the safe one: MatchTime does less.
      affirmation: null,
      sideRequests: [],
    },
    dropped,
  };
}
