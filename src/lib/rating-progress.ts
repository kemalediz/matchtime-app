/**
 * Rating-progress Q&A (2026-06-06).
 *
 * Lets an admin ask, in the group or by DM, "how many have rated so far?
 * who's left? who hasn't picked a MoM?" and get a REAL, grounded answer
 * — nothing else in the system holds rating-submission data, so without
 * this the model would either deflect or guess.
 *
 * Authorisation (org admin) is the CALLER's responsibility.
 *
 * ── THE PURE HALF MOVED (2026-09-11) ─────────────────────────────────
 * `RatingProgress` and `formatRatingProgressReply` now live in
 * `rating-progress-answer.ts`, alongside the policy constants, and are
 * re-exported here so every existing caller is unchanged. They moved
 * because the COMPOSER has to render this answer now, and nothing the
 * pipeline imports may reach Prisma — see that file's header for what
 * happens when it does.
 */
import { db } from "./db";
import { formatLondon } from "./london-time";
import type { RatingProgress } from "./rating-progress-answer";

export {
  RATING_PROGRESS_IS_ADMIN_ONLY,
  RATING_PROGRESS_TAG_MUST_BE_EXPLICIT,
  formatRatingProgressReply,
  type RatingProgress,
} from "./rating-progress-answer";

/* ────────────────────────────────────────────────────────────────────
 * ⚰️ DELETED 2026-09-11: `looksLikeRatingProgressRequest`
 *
 * It was two keyword tests ANDed over the whole body — a rating word
 * AND a progress word, anywhere — and it had two callers:
 *
 *   analyze/route.ts   a CLAUSE-PEELED group fast path, which its own
 *                      comment called "the WIDEST trigger of the six
 *                      peels": "I haven't rated yet and I'm out
 *                      Thursday" satisfies both halves and addresses
 *                      nobody. Peeled whole, answered with silence
 *                      (the sender is not an admin), and the OUT went
 *                      with it.
 *   dm-reply/route.ts  the 1:1 DM surface.
 *
 * THE FIX IS A DELETION, for the fourth time in this codebase:
 * 2026-04-21 `handlers.ts:7-10` (at Kemal's explicit request),
 * 2026-09-01 `looksLikeRecruitRequest` (a pattern matched half a
 * sentence and MatchTime told the owner his squad was full),
 * 2026-09-10 the stats blast's three ANDed keyword tests (69 mass DMs
 * off an owner's reminder to his players), and now the last two.
 *
 * WHAT REPLACED IT, on each surface:
 *
 *   GROUP  `QuestionFacts.topic = "rating_progress"` on the `question`
 *          route — measured 60/60 `question` on the live router, which
 *          is why it is NOT an `admin_ops` action the way the stats
 *          blast is. `rating-progress-answer.ts` carries the argument.
 *   DM     one model call on the whole DM (`lib/dm-intent.ts`), asked
 *          once instead of testing two regexes, and only after the
 *          deterministic admin lookup has already said the sender could
 *          act on the answer.
 *
 * WHAT WENT WITH IT, stated rather than discovered: the CLAUSE PEEL.
 * `question` is a whole-message route, so a compound "@Match Time who
 * hasn't rated yet? Also I'm out" now loses its attendance half — the
 * same price the stats blast and the recruit blast already pay on
 * `admin_ops`. A peel needs a deterministic predicate over language, and
 * a deterministic predicate over language is the thing that caused both
 * incidents.
 *
 * DO NOT ADD IT BACK.
 * ──────────────────────────────────────────────────────────────────── */

/** Compute rating + MoM completion for the org's most recent completed
 *  match (the one currently in its rating window). */
export async function loadRatingProgress(orgId: string): Promise<RatingProgress> {
  const match = await db.match.findFirst({
    where: { activity: { orgId }, isHistorical: false, status: "COMPLETED" },
    orderBy: { date: "desc" },
    select: {
      id: true,
      date: true,
      activity: { select: { name: true } },
      attendances: {
        where: { status: "CONFIRMED" },
        select: { userId: true, user: { select: { name: true } } },
      },
    },
  });
  if (!match) return { ok: false, reason: "There's no recent completed match to check yet." };

  const conf = match.attendances;
  const ratingVoters = new Set(
    (await db.rating.findMany({ where: { matchId: match.id }, select: { raterId: true }, distinct: ["raterId"] })).map((r) => r.raterId),
  );
  const momVoters = new Set(
    (await db.moMVote.findMany({ where: { matchId: match.id }, select: { voterId: true } })).map((v) => v.voterId),
  );
  const engaged = new Set<string>([...ratingVoters, ...momVoters]);

  return {
    ok: true,
    matchName: match.activity.name,
    matchWhen: formatLondon(match.date, "EEE d MMM"),
    confirmed: conf.length,
    ratedCount: conf.filter((a) => ratingVoters.has(a.userId)).length,
    momCount: conf.filter((a) => momVoters.has(a.userId)).length,
    notRated: conf.filter((a) => !engaged.has(a.userId)).map((a) => a.user.name ?? "Player"),
    ratedNoMom: conf.filter((a) => ratingVoters.has(a.userId) && !momVoters.has(a.userId)).map((a) => a.user.name ?? "Player"),
  };
}
