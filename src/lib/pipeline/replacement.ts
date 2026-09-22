/**
 * "X IS REPLACING Y": ONE PERSON ARRIVES, ONE LEAVES, AND THE SLOT
 * FOLLOWS THE BODY.
 *
 * Pure. No Prisma, no clock, no model. It reads the claims an extractor
 * already produced for ONE message and answers a single question: does
 * this message STATE a replacement, and if so, in which direction?
 *
 * ── THE INCIDENT (2026-09-22 20:32, Sutton FC, 28 minutes to kickoff) ─
 *
 * A player posted, untagged:
 *
 *   "Hi guys, Mojib is replacing Najib on the list. We can change"
 *
 * MatchTime routed it `none` and did nothing at all. Mojib played, Najib
 * did not. The team sheet named Najib, the rating DMs would have gone to
 * Najib, and the match fee was about to be charged to Najib. Kemal
 * corrected the rows by hand that night: Mojib took position 5 and the
 * Yellow slot, Najib went to DROPPED.
 *
 * Three layers each lost part of it and all three are fixed together:
 * the ROUTER did not read a chatty sentence as attendance, the EXTRACTOR
 * was never told that a replacement is TWO claims with a direction, and
 * the CONTRACT would have refused the OUT half for want of a tag. This
 * file is the third piece: the deterministic pairing that the tag
 * waiver, the position inheritance and the team-slot move all hang off.
 *
 * ── WHY THE PAIRING IS CODE AND NOT A PROMPT ─────────────────────────
 *
 * The same argument `lib/team-slot-swap.ts` makes above `isSwapParty`.
 * A sentence of prose asking a model to be sure who is arriving is a
 * probability, and what it guards is the one error this product cannot
 * afford: a false positive DROPS A REAL PLAYER FROM A REAL SQUAD. So the
 * model reports two FACTS about the text (an `in` claim, an `out`
 * claim, and `replaces` naming who the arriving player takes over from)
 * and every decision built on them is taken here, against the roster.
 *
 * ── WHAT IT REFUSES, AND WHY EACH IS A REFUSAL AND NOT A GUESS ───────
 *
 *   no direction     The message names two people and says nothing about
 *                    which way they are moving. "Ali is coming, Mehmet
 *                    can't make it" is two ordinary claims and stays
 *                    two ordinary claims. `replaces` is the only signal;
 *                    it is never inferred from one in beside one out.
 *   unknown name     EITHER side failing to resolve to a current member
 *                    refuses the whole pairing. Capitalisation is NOT
 *                    consulted: PR #99 rejected that approach when
 *                    "swap david and zork" showed that this group types
 *                    in lower case.
 *   two at once      Two arrivals both claiming a replacement. Which
 *                    slot each inherits is a guess; refuse.
 *   same person      Both halves resolve to one member.
 *   below the floor  The confidence floor applies to BOTH claims, with
 *                    no exemption. `SELF_IN_FROM_A_MEMBER_IS_NEVER_
 *                    DROPPED_BY_THE_FLOOR` covers a member's own IN, and
 *                    a third party moving two OTHER people is precisely
 *                    the shape the floor was kept for.
 *   held claims      Contingent, past, hypothetical, or an availability
 *                    statement rather than a decision. The engine
 *                    declines each of those on its own; a pairing built
 *                    from one would grant a tag waiver to a claim that
 *                    is never going to be written.
 *
 * A refusal is not a silence: nothing is consumed. Both claims carry on
 * through the ordinary pipeline under the rules they had before, which
 * for an untagged third-party OUT means the tag gate refuses it exactly
 * as it does today.
 *
 * ── THE ONE ASYMMETRY: WHO MAY BE ARRIVING ───────────────────────────
 *
 * The LEAVING side may be the sender. "I'm out, Mojib is replacing me"
 * is a player reporting their own departure, which the contract has
 * always allowed without a tag, and the pairing adds nothing to it but
 * the slot.
 *
 * The ARRIVING side may NOT be the sender, and that is deliberate. "I'll
 * take Najib's place" is said by somebody with an interest in the slot,
 * about a man who has not spoken, and honouring it untagged would let
 * anyone in the group take a place off anyone else by asking for it.
 * A third party stating a replacement is reporting; a claimant stating
 * one is bidding. Those claims still travel the ordinary path, where a
 * third-party OUT needs a tag, so the sender can still do it: with the
 * tag on, as the contract has always required.
 */
import type { Claim } from "./types";

/** A person the pairing has resolved, as the roster has them. */
export interface ReplacementSide {
  userId: string;
  name: string;
}

/** A replacement the message STATES, with both ends resolved. */
export interface StatedReplacement {
  /** The claim that brings the arriving player in. */
  inClaim: Claim;
  /** The claim that takes the leaving player out. */
  outClaim: Claim;
  incoming: ReplacementSide;
  outgoing: ReplacementSide;
}

export interface FindStatedReplacementArgs {
  /** The message's claims, after the per-person collapse. */
  claims: readonly Claim[];
  /**
   * Who a CLAIM is about: the sender for a self claim, a resolved
   * roster member for a third party, null for anything that resolves to
   * nobody. Supplied by the caller because only the caller has the
   * roster and the sender.
   */
  targetOf: (claim: Claim) => ReplacementSide | null;
  /**
   * Who a bare REFERENCE names. Asked of the `replaces` words, which can
   * be "me" as easily as a name.
   */
  refersTo: (ref: string) => ReplacementSide | null;
  /** `CONFIDENCE_FLOOR`, passed in so this module holds no policy. */
  confidenceFloor: number;
}

/** Every veto the engine would apply to this claim anyway, asked up
 *  front so a pairing is never built on a claim that will be held. */
function isActionable(c: Claim, floor: number): boolean {
  if (c.confidence < floor) return false;
  if (c.tense === "past" || c.tense === "hypothetical") return false;
  if (c.basis !== "decision") return false;
  if (c.contingent) return false;
  return true;
}

export function findStatedReplacement(
  args: FindStatedReplacementArgs,
): StatedReplacement | null {
  const { claims, targetOf, refersTo, confidenceFloor } = args;

  // 1. THE ARRIVAL. A third party, joining, who the message says is
  //    taking somebody's place. `replaces` is the whole signal and it is
  //    never inferred.
  const arrivals = claims.filter(
    (c) =>
      c.subject === "other" &&
      c.polarity === "in" &&
      c.personNamed &&
      (c.replaces ?? "").trim().length > 0,
  );
  // Nothing stated, or two stated at once and no way to tell which slot
  // goes where.
  if (arrivals.length !== 1) return null;
  const inClaim = arrivals[0];
  if (!isActionable(inClaim, confidenceFloor)) return null;

  const incoming = targetOf(inClaim);
  if (!incoming) return null;

  // 2. WHO IS BEING REPLACED, resolved through the roster rather than
  //    matched as a string. The extractor copies the words the message
  //    used ("Najib", "@Najib", "Najib Ahmadi", "me"); the roster is the
  //    only thing that knows they are one person.
  const replacedRef = (inClaim.replaces ?? "").trim();
  const outgoing = refersTo(replacedRef);
  if (!outgoing) return null;
  if (outgoing.userId === incoming.userId) return null;

  // 3. THE DEPARTURE, as its own claim. The pairing NEVER drops anybody
  //    on the strength of `replaces` alone: there has to be an `out`
  //    claim about that same person, and it has to be one the engine
  //    would have acted on. Without this the new field would be a second
  //    way to remove a player, which is the failure it exists to prevent.
  const departures = claims.filter(
    (c) => c !== inClaim && c.polarity === "out" && targetOf(c)?.userId === outgoing.userId,
  );
  if (departures.length !== 1) return null;
  const outClaim = departures[0];
  if (!isActionable(outClaim, confidenceFloor)) return null;

  return { inClaim, outClaim, incoming, outgoing };
}
