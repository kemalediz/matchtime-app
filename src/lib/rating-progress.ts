/**
 * Rating-progress Q&A (2026-06-06).
 *
 * Lets an admin ask, in the group or by DM, "how many have rated so far?
 * who's left? who hasn't picked a MoM?" and get a REAL, grounded answer
 * — the analyzer's normal context has no rating-submission data, so
 * without this the LLM would either deflect or hallucinate.
 *
 * Two distinct actions are tracked separately because they're separate:
 *   - "rated"      = submitted at least one teammate rating (Rating.raterId)
 *   - "picked MoM" = cast a Man-of-the-Match vote (MoMVote.voterId)
 * A player can rate without picking a MoM (e.g. Omar Yusuf, 4 Jun).
 *
 * Authorisation (org admin) is the CALLER's responsibility.
 */
import { db } from "./db";
import { formatLondon } from "./london-time";

export interface RatingProgress {
  ok: boolean;
  reason?: string;
  matchName?: string;
  matchWhen?: string;
  confirmed?: number;
  ratedCount?: number; // confirmed players who submitted ratings
  momCount?: number; // confirmed players who picked a MoM
  notRated?: string[]; // confirmed players who did neither
  ratedNoMom?: string[]; // rated teammates but skipped the MoM pick
}

/** Does this read like "how many have rated / who's left / who hasn't
 *  picked MoM?" — needs a rating/MoM word AND a completion/who word, so it
 *  won't hijack historical stats questions like "how many MoM has X won". */
export function looksLikeRatingProgressRequest(text: string): boolean {
  const hasTopic = /\b(rate|rated|rating|ratings|mom|moms|motm|man of the match|voted|vote)\b/i.test(text);
  const hasProgress =
    /\b(so far|remaining|left|pending|outstanding|yet|still to|who'?s? (left|remaining|yet|still)|hasn'?t|haven'?t|not (yet|rated|voted|picked|selected|done|in))\b/i.test(text);
  return hasTopic && hasProgress;
}

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

/** Render a progress result into a WhatsApp-friendly reply. */
export function formatRatingProgressReply(p: RatingProgress): string {
  if (!p.ok) return p.reason ?? "Couldn't check that right now.";
  const lines = [`📋 *${p.matchName}* (${p.matchWhen}) — rating progress:`];
  lines.push(`• Rated: ${p.ratedCount}/${p.confirmed}`);
  lines.push(`• Picked MoM: ${p.momCount}/${p.confirmed}`);
  lines.push(
    (p.notRated && p.notRated.length > 0)
      ? `• Still to rate (${p.notRated.length}): ${p.notRated.join(", ")}`
      : `• Everyone's rated ✅`,
  );
  if (p.ratedNoMom && p.ratedNoMom.length > 0) {
    lines.push(`• Rated but no MoM pick (${p.ratedNoMom.length}): ${p.ratedNoMom.join(", ")}`);
  }
  return lines.join("\n");
}
