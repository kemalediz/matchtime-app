/**
 * ORGANISERS ASKING THE MATCHTIME PLAYER POOL IN THEIR OWN WORDS (local
 * player pool L10, 2026-10-24), the pool's twin of `partner-ask-words.ts`.
 * Thin I/O; the rules are the pool's own.
 *
 * (Also the admin group's YES to L8's "wants to join" notice, at the end.)
 *
 * Three ways an organiser asks the pool from a group, all through L5a's
 * `requestPoolAsk` (`pool/round.ts`), the match page tick's own function,
 * so every rule of a tap holds (the switch and the club's flag, an
 * organiser, the match gate, the cut-off, places open, one open ask, 3 a
 * week, somebody near) and everything after it is that path's (partners
 * first, the waves, each person's caps, quiet hours):
 *
 *   in words       "ask the pool", "find someone nearby", "get a player from
 *                  the app" (EN/TR, any wording): the shared admin extractor
 *                  reads `recruit` from the pool (`AdminFacts.pool`), then
 *                  `admin-group-understand.ts` calls `askPoolFromWords` with
 *                  `via: "words"` for the club's next match
 *   in the players' group   an organiser's tagged ask (the engine's admin
 *                  and tag gates, `pool_ask` write), performed by the
 *                  analyze route's batch-final pass, `via: "words"`, for
 *                  the state's match (clubs with no HQ ask here)
 *   a YES          to the short-squad notice's pool line, posted in HQ and
 *                  logged as MatchTime's question (`pool-ask:<matchId>`,
 *                  `poolNoticesAwaiting`), decided by the safe-YES rule,
 *                  then `askPoolFromWords` with `via: "notice"` for that match
 *
 * The organisers' request IS the approval the pool needs (an organiser
 * asked; `requestPoolAsk` re-checks the role). Like the automatic ask it
 * asks for every open place, or joins a partner round still open on the
 * match for its number (`poolAutoRound`), so partner clubs keep their hour.
 *
 * Outside `src/lib/pool/` on purpose: the HQ reader calls the model, and
 * no model-facing file may import a pool module (`pool/__tests__/
 * source-guard.test.ts`). Nothing here reaches a model: the router is
 * shown only the day (`admin-group-context.ts`). Logs carry ids only.
 */
import { db } from "./db";
import { hqQuestionsSince } from "./admin-group-log";
import { JOIN_REQUEST_PREFIX, POOL_ASK_PREFIX, joinRequestRef, latestPoolNoticeAsks, parseJoinRequestRef, poolAskRef } from "./admin-group-pool-refs";
import { answerAsClub, invitationsAwaitingClub } from "./pool/club-invitation";
import { INVITE_LINK_SETTINGS_PATH } from "./pool/invite-link";
import { inviteCopy } from "./i18n/pool-invite";
import { appUrl } from "./app-url";
import type { PendingWithLabel } from "./admin-group-context";
import { dayCommaTimeLabel } from "./i18n/dates";
import { t } from "./i18n/t";
import { loadSquadState } from "./pipeline/load-state";
import { openPartnerRoundOf } from "./pool/auto-ask";
import { poolAutoRound } from "./pool/auto-ask-rules";
import { poolHqAskReply, type PoolRefusalContext } from "./pool/offer-copy";
import { isPoolOffersEnabled } from "./pool/flags";
import { settingsAnchorPath } from "./help-links";
import { PARTNER_ASK_CUTOFF_DEFAULT_HOURS, parseCutoffHours } from "./club-partnership-rules";
import { poolNoticeBand } from "./pool/panel";
import { placesOpenOf, requestPoolAsk } from "./pool/round";

type Env = Record<string, string | undefined>;
const DAY_MS = 24 * 3600_000;

export type PoolHqOutcome = "hq-pool-asked" | "hq-pool-not-asked" | "hq-pool-no-match";

export async function askPoolFromWords(args: {
  orgId: string;
  /** The notice's match; absent: the club's next match (asked in words). */
  matchId?: string | null;
  userId: string;
  via: "words" | "notice";
  /** Where it was said: "hq" (default) or the players' "group". */
  where?: "hq" | "group";
  lang: string | null;
  now: Date;
  env?: Env;
  /** An organiser's ask in words: a refusal the club can fix (no venue
   *  yet) is remembered and asked again once it is fixed
   *  (`pool-ask-retry.ts`). Absent (the retry itself, a notice): never. */
  remember?: { askMessageId: string | null };
}): Promise<{ outcome: PoolHqOutcome; replyText: string }> {
  const { orgId, lang, now } = args;
  const matchId = args.matchId ?? (await loadSquadState(orgId, now)).matchId;
  const match = matchId
    ? await db.match.findUnique({ where: { id: matchId }, select: { id: true, date: true, activity: { select: { venueRef: { select: { name: true } } } } } })
    : null;
  if (!match) return { outcome: "hq-pool-no-match", replyText: t(lang).recruit_no_match };
  const placesOpen = await placesOpenOf(match.id);
  const round = poolAutoRound({ askedNowRoundId: null, openRound: await openPartnerRoundOf(orgId, match.id), placesOpen });
  const r = await requestPoolAsk({
    orgId,
    matchId: match.id,
    places: round.places,
    roundId: round.roundId,
    approvedByUserId: args.userId,
    via: args.via,
    now,
    env: args.env,
  });
  console.log(`[pool-ask-words] ${orgId}: ${args.where ?? "hq"} ${args.via} ask for match ${match.id}: ${r.ok ? `asked ${r.askId}` : r.refusal}`);
  if (!r.ok) {
    if (args.remember) {
      const { rememberRefusedPoolAsk } = await import("./pool-ask-retry");
      await rememberRefusedPoolAsk({
        orgId,
        matchId: match.id,
        askedByUserId: args.userId,
        askedIn: args.where ?? "hq",
        askMessageId: args.remember.askMessageId,
        places: round.places,
        refusal: r.refusal,
        now,
      });
    }
    const ctx = { ...(await refusalContext(orgId, lang, match.date, args.env)), venue: match.activity?.venueRef?.name ?? null, excluded: r.excluded, willRetry: !!args.remember };
    return { outcome: "hq-pool-not-asked", replyText: poolHqAskReply(lang, { ok: false, refusal: r.refusal, placesOpen, ctx }) };
  }
  return {
    outcome: "hq-pool-asked",
    replyText: poolHqAskReply(lang, {
      ok: true,
      places: round.places,
      day: dayCommaTimeLabel(lang, match.date),
      partnersFirst: round.roundId !== null && !r.waveSent,
      inHq: args.where !== "group",
    }),
  };
}

/** What a refusal needs to say what to do next: the club's name, the
 *  cut-off, whether only the club's own switch is off, and the links. */
async function refusalContext(orgId: string, lang: string | null, kickoff: Date, env?: Env): Promise<PoolRefusalContext> {
  const org = await db.organisation
    .findUnique({ where: { id: orgId }, select: { name: true, featurePlayerPool: true, partnerAskCutoffHours: true } })
    .catch(() => null);
  return {
    club: org?.name ?? "",
    day: dayCommaTimeLabel(lang, kickoff),
    cutoffHours: parseCutoffHours(org?.partnerAskCutoffHours) ?? PARTNER_ASK_CUTOFF_DEFAULT_HOURS,
    clubSwitchOff: !!org && org.featurePlayerPool !== true && isPoolOffersEnabled(env ?? process.env),
    links: {
      // The weekly game's venue is the one the pool measures from
      // (`activity.venueRef`), set and confirmed on the weekly games page.
      weeklyGame: appUrl("/admin/activities"),
      poolSwitch: appUrl(settingsAnchorPath("player-pool")),
      partnerSettings: appUrl(settingsAnchorPath("partner-clubs")),
    },
  };
}

/**
 * The short-squad notices in HQ whose pool line still waits for a YES:
 * logged in the last day, and the pool can still be asked for that match
 * now (`poolNoticeBand`: open for the club, before the cut-off, nobody
 * asked yet, someone near) with a place still open. Every club with no
 * such notice pays the one indexed query.
 */
export async function poolNoticesAwaiting(orgId: string, now: Date, lang: string | null, env?: Env): Promise<PendingWithLabel[]> {
  const asks = latestPoolNoticeAsks(await hqQuestionsSince(orgId, POOL_ASK_PREFIX, new Date(now.getTime() - DAY_MS)));
  const out: PendingWithLabel[] = [];
  for (const a of asks) {
    const match = await db.match.findUnique({ where: { id: a.matchId }, select: { id: true, date: true } });
    if (!match) continue;
    const [band, placesOpen] = await Promise.all([poolNoticeBand(orgId, { id: match.id, date: match.date }, now, env), placesOpenOf(match.id)]);
    if (!band || placesOpen <= 0) continue;
    // The day and kickoff: two games on one day are told apart.
    out.push({ ref: poolAskRef(match.id), kind: "pool-ask", day: dayCommaTimeLabel(lang, match.date), askedAt: a.askedAt });
  }
  return out;
}

// ── A guest who wants to join (L8's notice, L10) ───────────────────────

/**
 * The guests whose "wants to join" notice was posted in HQ in the last day
 * (logged as MatchTime's question, `join-request:<invitation>`) and who
 * still wait for the club's answer. After a day the card's button stays.
 */
export async function joinRequestsAwaiting(orgId: string, now: Date): Promise<PendingWithLabel[]> {
  const asked = await hqQuestionsSince(orgId, JOIN_REQUEST_PREFIX, new Date(now.getTime() - DAY_MS));
  const latest = new Map<string, Date>();
  for (const q of asked) {
    const id = parseJoinRequestRef(q.askRef);
    if (id) latest.set(id, q.createdAt);
  }
  if (latest.size === 0) return [];
  const waiting = await invitationsAwaitingClub(orgId, [...latest.keys()]);
  return waiting.map((w) => ({ ref: joinRequestRef(w.id), kind: "join-request" as const, day: null, names: w.name, askedAt: latest.get(w.id)! }));
}

export type JoinRequestOutcome = "hq-join-link-sent" | "hq-join-approved" | "hq-join-not-done";

/**
 * An organiser's YES in HQ to a guest who wants to join: the card's own
 * "Send the invite link" (`answerAsClub`, the organiser as the actor), so
 * the link goes only as L8 sends it (to him, once, both yeses stored).
 * Null when he no longer waits for the club (answered on the card).
 */
export async function answerJoinRequestInHq(args: {
  orgId: string;
  invitationId: string;
  actorId: string;
  lang: string | null;
  now: Date;
  env?: Env;
}): Promise<{ outcome: JoinRequestOutcome; replyText: string } | null> {
  const [inv] = await invitationsAwaitingClub(args.orgId, [args.invitationId]);
  if (!inv) return null;
  const c = inviteCopy(args.lang);
  const r = await answerAsClub({ orgId: args.orgId, userId: inv.userId, actorId: args.actorId, answer: "yes", now: args.now, env: args.env ?? {} });
  console.log(`[pool-ask-words] ${args.orgId}: HQ yes to invitation ${inv.id}: ${r.ok ? r.state : r.reason}`);
  if (r.ok) {
    return r.state === "link-sent"
      ? { outcome: "hq-join-link-sent", replyText: c.hq_link_sending({ name: inv.name }) }
      : { outcome: "hq-join-approved", replyText: c.hq_link_waiting({ name: inv.name, link: appUrl(INVITE_LINK_SETTINGS_PATH) }) };
  }
  const replyText =
    r.reason === "no-link"
      ? c.notice_no_link({ link: appUrl(INVITE_LINK_SETTINGS_PATH) })
      : r.reason === "already-invited"
        ? c.hq_join_already({ name: inv.name })
        : c.hq_join_closed({ name: inv.name });
  return { outcome: "hq-join-not-done", replyText };
}
