/**
 * RECRUIT REQUESTS — the pure pieces of the verdict-driven recruit path.
 *
 * ── The incident (2026-09-01, Sutton FC, in front of the club) ────────
 *
 * The owner posted:
 *
 *   "Najib is out. We need one more player.
 *
 *    Can someone pls come forward"
 *
 * MatchTime recorded `intent=recruit_recent action=recruit:0
 * handledBy=fast-path conf=1` and replied:
 *
 *   "The squad for *Tuesday 5-a-side* is already full — no open spots to
 *    recruit for."
 *
 * Najib was never dropped. `looksLikeRecruitRequest` matched the SECOND
 * sentence and the fast path removed the message from the LLM batch
 * unconditionally, so the third-party OUT was never analysed by anything.
 * The squad stayed 10/10, the recruit action correctly found zero open
 * spots, and MatchTime told the owner his squad was full moments after he
 * told it a player was out.
 *
 * ── Why the fix is a deletion ─────────────────────────────────────────
 *
 * The fast path was built for a real reason: on 2026-06-05 the LLM was
 * *claiming* "I'll DM the recent players" with no action behind it, so a
 * guaranteed action had to live in code. But it kept the wrong half. It
 * made a REGEX do the classification and code do the action, when this
 * codebase's stated split is the opposite: the model extracts, code
 * decides and acts.
 *
 * `looksLikeRecruitRequest` was the proof. It carried "hard exclusions"
 * trying to separate "list the players" from "get more players" with a
 * pattern — language understanding, done in regex, inside a system
 * already paying a language model to do exactly that. And it is how the
 * incident happened: the pattern matched half a sentence and discarded
 * the rest.
 *
 * So recruit is now an extracted verdict FACT (`AnalysisVerdict.
 * recruitRequest`), deliberately a FLAG rather than an intent, because
 * `intent` is single-valued and this message carries two facts. The
 * server still performs the blast deterministically and still writes the
 * sentence describing it, so the 2026-06-05 guarantee is untouched: the
 * model never acts and never promises, it only reports the ask.
 *
 * These regex fast paths were deleted once before, on 2026-04-21
 * (`handlers.ts:7-10`), when the LLM took every message. They crept back
 * one incident at a time. This is a return to a decision already made.
 */
import { mergeOneReply } from "./pipeline/clause-peel";

/**
 * Merge the LLM's reply and the server's recruit line into EXACTLY ONE
 * outbound message.
 *
 * MatchTime must never reply twice to one message — the nagging the whole
 * interaction contract exists to prevent. A message that carries both a
 * drop and a recruit ask produces two candidate sentences and must still
 * produce one send.
 *
 * Whitespace-only counts as silence; two identical lines collapse rather
 * than being said twice.
 *
 * THE RULE MOVED, THE NAME STAYED (2026-09-09). Clause peeling
 * (`pipeline/clause-peel.ts`) produces exactly this shape for every fast
 * path that takes half a message, not just for the recruit blast, so the
 * implementation lives there as `mergeOneReply` and this delegates to it.
 * Two copies of "MatchTime replies once" is one copy too many: the
 * invariant must not be able to hold in one caller and drift in another.
 */
export function mergeRecruitReply(
  llmReply: string | null | undefined,
  recruitReply: string | null | undefined,
): string | null {
  return mergeOneReply(llmReply, recruitReply);
}

// RETIRED 2026-11-02: `RECRUIT_COMMAND_IMPLIES_ADDRESSED`. It let the
// attendance half of an admin's untagged recruit command through the tag
// gate ("Najib is out. We need one more player.", 2026-09-01). Attendance
// needs no tag at all now (`interaction-contract.ts`), so it had nothing
// left to waive.

/**
 * Must an EXPLICIT BULK-DM COMMAND carry an @Match Time tag?
 *
 * The untagged attendance path (a drop with a recruit side request) is
 * a different thing and needs no tag; see the note above.
 *
 * ── WHAT WAS MEASURED (2026-09-06, live router, 20 runs a phrasing) ──
 *
 *   "message everyone from the last 50 games"          UNTAGGED
 *        admin_ops 13/20 · question 4/20 · none 3/20
 *   "message everyone from the last 50 games and invite them"
 *        admin_ops 20/20
 *   "DM everyone who played in the last 5 matches and invite them"
 *        admin_ops 20/20
 *   "@Match Time DM everyone who played in the last 50 games …"
 *        admin_ops 20/20
 *   "come on lads we need more players"                none 20/20
 *   "Najib is out. We need one more player. …"         other_att 20/20
 *
 * So the router is not generally unstable — every neighbouring wording
 * is unanimous. That ONE sentence is genuinely ambiguous to it, because
 * it names no purpose for the messaging: it can be read as an
 * instruction, as a question about who those people are, or as chat.
 * The router runs at the SDK's default temperature of 1 (`llm.ts` sets
 * none), so an input the model is 65% sure about comes back as 13/20.
 *
 * ── WHY THAT IS UNACCEPTABLE RATHER THAN UNTIDY ──────────────────────
 *
 * Until this constant, the route was the ONLY gate on the action. So
 * the same message, in the same state, proposed a mass DM on 13 runs in
 * 20 and nothing at all on the other 7. Measured against the live Sutton
 * FC data the same day, that blast DMs 27 people at the clamped lookback
 * of 12 that "the last 50 games" resolves to, and 13 at the default of 5
 * — before the per-category DM opt-out filter, which only shrinks it.
 * `recruit-lookback.ts` spells out the stake: "the bot runs on an
 * UNOFFICIAL WhatsApp client; a mass DM risks the account being banned,
 * which takes the whole product down."
 *
 * The costs are not symmetric, and that decides it. A blast that does
 * not fire costs the owner one re-typed message with a tag on it. A
 * blast that fires when it should not costs the WhatsApp account.
 *
 * ── WHY A TAG, AND NOT A CLEVERER TEST ───────────────────────────────
 *
 * The obvious alternative is "fire untagged when the imperative is
 * unambiguous". Both ways of building that were rejected:
 *
 *   In CODE it is a regex classifier. This codebase has deleted one
 *   twice — 2026-04-21 (`handlers.ts:7-10`, at Kemal's explicit
 *   request) and 2026-09-01 (`looksLikeRecruitRequest`, above) — and
 *   the second deletion happened BECAUSE a pattern classified half a
 *   sentence and caused the incident. In front of the single most
 *   dangerous action in the product is the worst place to put one back.
 *
 *   In the MODEL it is another sample at temperature 1: the same coin
 *   flip, one layer down, and dressed up as a safeguard. Note that two
 *   models already have to agree for a blast to fire today — the router
 *   must say `admin_ops` AND the extractor must say `action: recruit` —
 *   and that pair is exactly what produced 13/20. Adding a third
 *   opinion buys precision, never a guarantee.
 *
 * A tag is neither. It is a fact about the bytes the owner sent.
 *
 * ── WHAT THIS BUYS: A DETERMINISTIC DECISION, NOT A STABLE ROUTE ─────
 *
 * An LLM router cannot be made deterministic, and pretending otherwise
 * is how this got shipped. What CAN be made deterministic is the
 * DECISION. `question` and `none` already refused an untagged blast;
 * `admin_ops` now does too, so all three sampled routes converge and
 * the blast is invariant under the coin flip. The route still wobbles;
 * nothing that matters does.
 *
 * ── WHAT IT DOES NOT TOUCH ───────────────────────────────────────────
 *
 * The 2026-09-01 incident, on the ATTENDANCE path
 * (`engine.ts:handleAttendance`, via `facts.sideRequests`): "Najib is
 * out. We need one more player."
 * still drops Najib untagged and still carries its recruit side
 * request, which `attendance-engine-batch.ts` still reports and
 * `route.ts` still fires — at `inviteRecentPlayers`' bounded default of
 * 5, with no model-read number anywhere in it. That is the real line
 * between the two: the untagged path can never WIDEN a blast; only a
 * tagged one can.
 *
 * Set to `false` and the `admin_ops` branch behaves exactly as it did
 * between §10 step 7 part 2 and 2026-09-06.
 */
export const RECRUIT_BLAST_REQUIRES_TAG = true;
