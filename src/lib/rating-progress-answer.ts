/**
 * RATING PROGRESS — the pure half, and the policy behind it.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS AT ALL
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Two reasons, and they are the same two that split `recruit.ts` from
 * `recruit-request.ts` and `stats-blast.ts` from the route:
 *
 *   1. `rating-progress.ts` imports Prisma, and NOTHING the pipeline
 *      imports may reach Prisma. `compose.ts`'s header records what
 *      happens when it does: the Playwright worker never loads Prisma
 *      and a static import kills the whole corpus spec at load, with an
 *      error nobody can read. The composer has to render this answer, so
 *      the renderer lives here, on its own, with no imports.
 *   2. The DECISION — who may ask, and what counts as asking — is policy
 *      and belongs next to the argument for it, not buried in a branch.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT THIS REPLACED: `looksLikeRatingProgressRequest` (deleted 2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * It was two keyword tests ANDed over the whole body:
 *
 *     /\b(rate|rated|rating|ratings|mom|moms|motm|…|voted|vote)\b/
 *     AND
 *     /\b(so far|remaining|left|pending|outstanding|yet|still to|
 *         who'?s? (left|remaining|yet|still)|hasn'?t|haven'?t|
 *         not (yet|rated|voted|picked|selected|done|in))\b/
 *
 * `analyze/route.ts` called it, in its own words, "the WIDEST trigger of
 * the six peels": "I haven't rated yet and I'm out Thursday" satisfies
 * both halves and addresses nobody. That is the conjunction shape that
 * has now caused two production incidents in eleven days —
 * `looksLikeRecruitRequest` matching half a sentence on 2026-09-01, and
 * three ANDed keyword tests queueing 69 mass DMs on 2026-09-10 — and the
 * argument against a third pattern is `stats-blast.ts`'s, verbatim.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT REPLACED IT, AND WHY IT IS NOT THE STATS BLAST'S SHAPE
 * ═══════════════════════════════════════════════════════════════════════
 *
 * The stats blast became `AdminFacts.action = "stats_blast"` on the
 * `admin_ops` route. Rating progress does NOT, and the reason is a
 * measurement rather than a preference.
 *
 * Four phrasings, 15 live router calls each, 2026-09-11:
 *
 *   "@Match Time who hasn't rated yet?"            question 15/15
 *   "@Match Time how many have rated so far?"      question 15/15
 *   "@Match Time who hasn't picked a MoM yet?"     question 15/15
 *   "@Match Time who is still to rate from tuesday" question 15/15
 *
 * Sixty of sixty. The router's own rule 8 says why: "ASKING is question;
 * INSTRUCTING is admin_ops." A rating-progress ask ASKS. Putting the
 * fact on `admin_ops` would have shipped a feature the router never
 * routes to — a deletion dressed as a conversion.
 *
 * So it is a `question` TOPIC, and it follows `payments` exactly, which
 * is the one topic already in the product that reads something
 * `loadSquadState` does not load:
 *
 *   the extractor  reports the ask as a typed topic
 *                  (`QuestionFacts.topic = "rating_progress"`)
 *   answer-batch   does ONE targeted load, after extraction, only when
 *                  such a topic survived ownership, and hands it down as
 *                  data (`SquadState.ratingProgress`)
 *   the engine     GATES it — the question route's tag, plus admin — and
 *                  emits `answer_rating_progress`, which carries no
 *                  counts and no names
 *   the composer   renders `state.ratingProgress` through the function
 *                  below
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY LOST, SAID OUT LOUD
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   THE CLAUSE PEEL. The deleted fast path was one of six clause-peeled
 *   paths, so "@Match Time who hasn't rated yet? Also I'm out" answered
 *   AND dropped the sender. It cannot any more: `question` is a
 *   whole-message route. A peel needs a deterministic predicate over
 *   language, and a deterministic predicate over language is the thing
 *   that caused both incidents. This is the same price the stats blast
 *   paid on 2026-09-10 and the recruit blast on 2026-09-01, and it is
 *   recorded rather than discovered later. The fix, if it is worth one,
 *   is a `sideRequests` entry on the ATTENDANCE extractor — which is how
 *   a recruit ask already survives beside a drop.
 *
 *   THE UNTAGGED ANSWER. The fast path was not tag-gated at all (its own
 *   comment flagged that as a wart). "who hasn't rated yet?" with no tag
 *   is now silence. That is the ordinary bar every other answer has had
 *   since 2026-09-08, and see `RATING_PROGRESS_TAG_MUST_BE_EXPLICIT` for
 *   why it is not raised any higher than that.
 *
 *   THE 📋 REACT. The fast path reacted 📋 alongside its reply. Answers
 *   on the `question` route carry no react, and this one now behaves
 *   like the rest of them. The reply is the acknowledgement.
 */

/**
 * Must the asker be an org ADMIN?
 *
 * YES — unchanged from the fast path, and not re-litigated here. This is
 * a classifier fix.
 *
 * It is also the one place where this answer differs from `payments`,
 * whose module argues at length that it needs NO admin gate: "the 17:00
 * scheduler already posts this exact number to the whole group,
 * unprompted… Naming names — which nothing here can do — would be the
 * part that needed an admin, and a DM to send it in."
 *
 * This answer NAMES NAMES. `formatRatingProgressReply` prints "Still to
 * rate (4): Zair, Wasim, …" straight into the group. That is precisely
 * the case `payment-answer.ts` says would need an admin, so the gate the
 * fast path already had is the right one and it stays.
 */
export const RATING_PROGRESS_IS_ADMIN_ONLY = true;

/**
 * And must the tag be an EXPLICIT @-mention, the way the two bulk-DM
 * doors demand?
 *
 * ⚠️ NO, AND THE DIFFERENCE IS THE WHOLE POINT OF ASKING.
 *
 * `STATS_BLAST_TAG_MUST_BE_EXPLICIT` and `RECRUIT_BLAST_REQUIRES_TAG`
 * are set by an ASYMMETRY: "a blast that does not fire costs Kemal one
 * re-typed message; a blast that fires wrongly costs 69 DMs from an
 * unofficial WhatsApp client and possibly the account." That asymmetry
 * does not exist here. This answer sends NO DM. It posts one grounded
 * sentence in a group MatchTime posts in several times a week, composed
 * from the database, to an admin who tagged it. A wrong one costs one
 * confused reader, and the next message corrects it.
 *
 * The costs therefore point the OTHER way, and `messageTagsBot`'s own
 * looseness is the precedent: it was deliberately hardened loose on
 * 2026-06-29 after the Pi's structured mention signal regressed and a
 * genuine admin command was silently dropped. For an ANSWER, a false
 * negative — silence at somebody who really did ask — is the worse
 * error. That is exactly the trade every other `question` topic makes,
 * and there is no argument for making rating progress the single
 * stricter one.
 *
 * So the gate is the question route's own: `msg.tagged`, which is
 * `messageTagsBot`. Not looser than the other answers, not stricter.
 *
 * ⚠️ AND THE CONSEQUENCE, SPELLED OUT RATHER THAN LEFT TO BE FOUND. The
 * 2026-09-10 incident message ("…the link from Matchtime DM'ed to you…")
 * is `messageTagsBot`-TAGGED, because the bare word appears in it. So if
 * the extractor ever calls that sentence `rating_progress`, MatchTime
 * ANSWERS IT — in the group, naming the players who have not rated. The
 * tag is not a backstop on this path; the MODEL is the whole defence.
 *
 * That is measured rather than assumed (case M3 of
 * `scripts/dryrun-pipeline.ts`, 15 live runs) and pinned, in its true
 * form, by `e2e/sim/rating-progress.spec.ts`'s worst-case test — which
 * asserts that MatchTime answers, because pretending otherwise would be
 * a test that lies about the system.
 *
 * A loose tag is not a gate in front of anything expensive. It is
 * defensible in front of a sentence, and indefensible in front of a DM.
 * SET THIS TO `true` THE MOMENT THIS TOPIC GAINS A SIDE EFFECT.
 */
export const RATING_PROGRESS_TAG_MUST_BE_EXPLICIT = false;

/**
 * Rating + MoM completion for one match. Produced by
 * `loadRatingProgress` (which reads the database) and rendered by
 * `formatRatingProgressReply` (which does not).
 *
 * Two distinct actions, tracked separately because they ARE separate:
 *   - "rated"      = submitted at least one teammate rating (Rating.raterId)
 *   - "picked MoM" = cast a Man-of-the-Match vote (MoMVote.voterId)
 * A player can rate without picking a MoM (e.g. Omar Yusuf, 4 Jun).
 */
export interface RatingProgress {
  ok: boolean;
  reason?: string;
  matchName?: string;
  matchWhen?: string;
  confirmed?: number;
  /** Confirmed players who submitted ratings. */
  ratedCount?: number;
  /** Confirmed players who picked a MoM. */
  momCount?: number;
  /** Confirmed players who did neither. */
  notRated?: string[];
  /** Rated teammates but skipped the MoM pick. */
  ratedNoMom?: string[];
}

/**
 * Render a progress result into a WhatsApp-friendly reply.
 *
 * BYTE-FOR-BYTE what the deleted fast path sent. The copy is not the
 * thing that went wrong, and a rewrite would be an unreviewed change
 * riding along with a fix.
 */
export function formatRatingProgressReply(p: RatingProgress): string {
  if (!p.ok) return p.reason ?? "Couldn't check that right now.";
  const lines = [`📋 *${p.matchName}* (${p.matchWhen}) — rating progress:`];
  lines.push(`• Rated: ${p.ratedCount}/${p.confirmed}`);
  lines.push(`• Picked MoM: ${p.momCount}/${p.confirmed}`);
  lines.push(
    p.notRated && p.notRated.length > 0
      ? `• Still to rate (${p.notRated.length}): ${p.notRated.join(", ")}`
      : `• Everyone's rated ✅`,
  );
  if (p.ratedNoMom && p.ratedNoMom.length > 0) {
    lines.push(`• Rated but no MoM pick (${p.ratedNoMom.length}): ${p.ratedNoMom.join(", ")}`);
  }
  return lines.join("\n");
}
