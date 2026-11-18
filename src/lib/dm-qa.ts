/**
 * Scoped, no-leak DM Q&A (2026-06-01; the unified answer since 2026-11-18).
 *
 * Lets a player ask MatchTime questions by DMing it 1:1 and get a private
 * answer, STRICTLY limited to the player's own club. Since 2026-11-18 the
 * answer is THE UNIFIED ANSWER (`pipeline/unified-answer.ts`), the same one
 * step the groups use, over the same context with the DM's audience
 * (`unified-dm.ts`): the players' facts, plus the asker's OWN stats and OWN
 * payments; never another player's money, a phone number, or another club.
 * The DM's own prompt and context (`DM_QA_SYSTEM_PROMPT`,
 * `formatScopedContext`), which ran only with UNIFIED_ANSWERS off, were
 * deleted with that flag.
 *
 * THE CORE GUARDRAIL is unchanged: scope by CONTEXT, not just instructions.
 * What the model is not told it cannot leak.
 */

import { db } from "./db";
import { ORDINARY_MEMBER_WHERE } from "@/lib/guest-membership";
import { IN_LIVE_STAGE_CLUB_WHERE } from "./club-setup-rules";
import { buildDmQaApology } from "./dm-copy";
import { normaliseLang, type Lang } from "./i18n/lang";
import { applyHouseStyle } from "./house-style";
import { anthropicModel } from "@/lib/pipeline/llm";
import { isAiBudgetExceeded, withOrgAiBudget } from "@/lib/ai-budget";
import { loadDmReplyContext, quoteForClubs, type QuotedBotMessage } from "./reply-context";

/** Pick the most relevant org for a multi-org player: the one with the
 *  most recent match (any status) they're a member of. */
export async function pickRelevantOrgForUser(
  userId: string,
  opts: {
    /** The MatchTime message the question swipe-replies to (quoted-reply
     *  context S3): its club is the one asked about, when it is one of his. */
    quoted?: QuotedBotMessage | null;
  } = {},
): Promise<string | null> {
  return (await pickQaOrgAndQuote(userId, opts.quoted ?? null)).orgId;
}

/**
 * The club a question is about, and the quote it may be read against
 * (`quoteForClubs`): a swipe-reply naming a match of one of his clubs picks
 * that club; a quote naming another club's match is dropped, and the club
 * is picked as before (the one with the most recent match).
 */
export async function pickQaOrgAndQuote(
  userId: string,
  quoted: QuotedBotMessage | null,
): Promise<{ orgId: string | null; quoted: QuotedBotMessage | null }> {
  // Never a club that is still setting up (club-setup.ts): it may spend
  // nothing, so a question routed to it would get no answer at all.
  const memberships = await db.membership.findMany({
    // Not a club he is only a guest of (cross-club ask, review M6).
    where: { userId, leftAt: null, ...ORDINARY_MEMBER_WHERE, ...IN_LIVE_STAGE_CLUB_WHERE },
    select: { orgId: true },
  });
  let orgIds = memberships.map((m) => m.orgId);
  // A GUEST WITH NO CLUB OF HIS OWN (2026-11-17): he is not in the club's
  // group, so he asks here, and the club he is booked with for a game still
  // to come is the one he asks about (`guest-card/guest-dm.ts`). A partner
  // guest, who has a club, keeps asking about his own club, as before.
  if (orgIds.length === 0) {
    const { liveGuestGames } = await import("./guest-card/guest-dm");
    orgIds = [...new Set((await liveGuestGames(userId, new Date())).map((g) => g.orgId))];
  }
  const quotedOrgId = quoted?.matchId
    ? ((await db.match.findUnique({ where: { id: quoted.matchId }, select: { activity: { select: { orgId: true } } } }))
        ?.activity.orgId ?? null)
    : null;
  const steer = quoteForClubs(quoted, quotedOrgId, orgIds);
  return { orgId: steer.orgId ?? (await mostRecentOrg(orgIds)), quoted: steer.quoted };
}

async function mostRecentOrg(orgIds: string[]): Promise<string | null> {
  if (orgIds.length === 0) return null;
  if (orgIds.length === 1) return orgIds[0];
  const recent = await db.match.findFirst({
    where: { activity: { orgId: { in: orgIds } } },
    orderBy: { date: "desc" },
    select: { activity: { select: { orgId: true } } },
  });
  return recent?.activity.orgId ?? orgIds[0];
}

/** The asker's own season numbers, as `loadPlayerSeasonStats` reads them. */
export interface OwnStats {
  gamesPlayed: number;
  totalOrgMatches: number;
  attendanceRate: number;
  avgRating: number | null;
  fieldAvgSeason: number | null;
  momCount: number;
  record: { w: number; d: number; l: number };
  form: { last5Avg: number | null; trend: string };
  bestPartner: string | null;
  nemesis: string | null;
}

/** PURE. The asker's own stats block, as the DM has always shown it; the
 *  unified answer's DM context shows the same lines (2026-11-10). */
export function formatOwnStatsLines(s: OwnStats): string[] {
  const lines = ["YOUR STATS:"];
  lines.push(`- Games played: ${s.gamesPlayed}/${s.totalOrgMatches} (${s.attendanceRate}% attendance)`);
  lines.push(`- Average rating: ${s.avgRating?.toFixed(1) ?? "—"} (squad avg ${s.fieldAvgSeason?.toFixed(1) ?? "—"})`);
  lines.push(`- Man of the Match: ${s.momCount}`);
  lines.push(`- Record: ${s.record.w}W ${s.record.d}D ${s.record.l}L`);
  lines.push(`- Form (last 5): ${s.form.last5Avg?.toFixed(1) ?? "—"} (${s.form.trend})`);
  if (s.bestPartner) lines.push(`- Best partnership: ${s.bestPartner}`);
  if (s.nemesis) lines.push(`- Nemesis: ${s.nemesis}`);
  return lines;
}

export interface ScopedAnswer {
  answer: string;
  orgId: string;
  orgName: string;
}

export async function answerScopedQuestion(args: {
  userId: string;
  orgId: string;
  question: string;
  askerName?: string | null;
  /** Set true ONLY when the asker is an OWNER/ADMIN/superadmin of the
   *  resolved org (the route computes this). An admin's context also says
   *  who in the squad has no number on record; nobody else's does. */
  includePhoneFlags?: boolean;
  /** The MatchTime message the question swipe-replies to, already checked
   *  to be about this club (`pickQaOrgAndQuote`), or null. */
  quoted?: QuotedBotMessage | null;
  /** Where DMs to this player are queued (digits, no "+"), for the chat
   *  context's recent messages. */
  phone?: string | null;
  /** The player pool switch as the request resolved it, for the answer's
   *  pool facts (`pool/switch-env.ts`). Absent: closed. */
  poolEnv?: () => Promise<Record<string, string | undefined>>;
}): Promise<ScopedAnswer | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  // TEST-ONLY seam: the e2e suite runs with no Anthropic key. Instead of
  // calling the model we return the context itself as the "answer", so
  // specs can assert the no-leak guarantee STRUCTURALLY. Inert in prod
  // (the env var is never set there).
  const stubMode = !!process.env.MT_TEST_DM_QA_STUB;
  if (!apiKey && !stubMode) return null;

  const org = await db.organisation.findUnique({
    where: { id: args.orgId },
    // `language`: the org the question is about decides the answer's language.
    select: { name: true, language: true },
  });
  if (!org) return null;
  const lang = normaliseLang(org.language);
  return answerScopedQuestionUnified({ ...args, orgName: org.name, lang, apiKey: apiKey ?? null, stubMode });
}

/**
 * A DM question: the unified answer with the DM's audience. The stub seam
 * returns the context. A call that fails or a reply the grounding check
 * refuses gets the DM's apology; the daily cap means no answer at all.
 * A GUEST of this club (2026-11-17, review of #621) is shown only his own
 * game (`guest-card/context.ts` `guestView`, in `loadUnifiedDmInput`).
 */
async function answerScopedQuestionUnified(args: {
  userId: string;
  orgId: string;
  question: string;
  askerName?: string | null;
  includePhoneFlags?: boolean;
  quoted?: QuotedBotMessage | null;
  phone?: string | null;
  orgName: string;
  lang: Lang;
  apiKey: string | null;
  stubMode: boolean;
  poolEnv?: () => Promise<Record<string, string | undefined>>;
}): Promise<ScopedAnswer | null> {
  const replyContext = await loadDmReplyContext(db, {
    userId: args.userId,
    phone: args.phone ?? null,
    quoted: args.quoted ?? null,
    orgIds: [args.orgId],
  });
  const { loadUnifiedDmInput } = await import("./unified-dm");
  const { answerUnified, buildUnifiedContext } = await import("./pipeline/unified-answer");
  const input = await loadUnifiedDmInput({
    orgId: args.orgId,
    userId: args.userId,
    askerName: args.askerName ?? null,
    askerIsAdmin: args.includePhoneFlags ?? false,
    question: args.question,
    lang: args.lang,
    replyContext,
    now: new Date(),
    ...(args.poolEnv ? { poolEnv: args.poolEnv } : {}),
  });
  if (args.stubMode) {
    return { answer: `[unified-dm-stub]\n${buildUnifiedContext(input).text}`, orgId: args.orgId, orgName: args.orgName };
  }
  const model = anthropicModel({ apiKey: args.apiKey ?? undefined });
  try {
    const g = await withOrgAiBudget(args.orgId, () => answerUnified({ ...input, model }));
    // The daily cap: no answer and nothing sent. `answerUnified` never
    // throws, so the cap comes back as `capped` (review of #595: it came
    // back as a plain rejection and the apology went out).
    if (g.capped) {
      console.log(`[dm-qa] org=${args.orgId} is at its daily AI cap; no answer composed`);
      return null;
    }
    if ("rejected" in g.result) {
      console.error(`[dm-qa] org=${args.orgId}: unified answer not used (${g.result.rejected}); the apology instead`);
      return { answer: buildDmQaApology(args.lang), orgId: args.orgId, orgName: args.orgName };
    }
    return { answer: applyHouseStyle(g.result.text, args.lang), orgId: args.orgId, orgName: args.orgName };
  } catch (err) {
    if (isAiBudgetExceeded(err)) {
      console.log(`[dm-qa] org=${args.orgId} is at its daily AI cap; no answer composed`);
      return null;
    }
    throw err;
  }
}
