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
 */
export function mergeRecruitReply(
  llmReply: string | null | undefined,
  recruitReply: string | null | undefined,
): string | null {
  const a = (llmReply ?? "").trim();
  const b = (recruitReply ?? "").trim();
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  if (a === b) return a;
  return `${a}\n\n${b}`;
}

/**
 * Does an ADMIN's recruit command count as ADDRESSING MatchTime, for the
 * purposes of the @Match Time interaction-contract tag gate?
 *
 * ⚠️ THIS IS A DELIBERATE, ARGUED WIDENING OF THE CONTRACT, kept as one
 * named constant so it can be reverted on its own line without disturbing
 * the ordering fix it travels with. Set it to `false` and the gate
 * behaves exactly as it did before 2026-09-01.
 *
 * THE ARGUMENT. The contract's real question is "is this message
 * addressed to MatchTime?" The @Match Time tag is a PROXY for that, not
 * the thing itself. A recruit request is a direct operational command to
 * MatchTime — "we need one more player, can someone come forward" asks
 * MatchTime to go and find one — and MatchTime has always acted on it
 * untagged, gated on the sender being an admin rather than on a tag. On
 * 2026-09-01 it acted AND replied in the group, from an untagged message.
 * That half of the contract was already bypassed, by design, since
 * 2026-06-05.
 *
 * Having decided a message IS addressed to it, MatchTime cannot coherently
 * treat the REST of that same message as overheard banter. That is exactly
 * what produced the incident: an answer that contradicted the sentence
 * immediately before it.
 *
 * THE SCOPE, and it is narrow:
 *   - one message: the one whose verdict carries `recruitRequest`;
 *   - only when the sender is an OWNER or ADMIN, the same gate the
 *     recruit action itself has always had;
 *   - `actionRequiresTag` is NOT modified, so every other untagged
 *     third-party OUT in the group stays suppressed exactly as today.
 *
 * WHAT IT DOES NOT DO. It does not make untagged third-party OUTs
 * tag-free in general. Wasim's 10:09 message on the same day — "Najib has
 * hurt his foot unfortunately @Amir can you step in for tonight?" —
 * carries no command to MatchTime, so it stays suppressed. Whether THAT
 * should change is a separate decision and is not taken here.
 */
export const RECRUIT_COMMAND_IMPLIES_ADDRESSED = true;
