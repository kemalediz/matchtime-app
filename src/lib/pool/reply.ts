/**
 * A REPLY IN WORDS TO A POOL OFFER (slice L5a's one line, slice L6's reader,
 * 2026-10-24). Thin I/O around `reply-rules.ts` (which offers, what to do)
 * and `reply-reader.ts` (what the words mean). Plan 5.3.
 *
 *   1. His offers that REACHED him (`sentAt`, the Pi's "sent", review of
 *      #400 M3) in the last day, plus any place he took and still holds,
 *      each only if it went to the number his profile is on. None: null,
 *      no model, the route carries on exactly as before.
 *   2. `replyScope`: a quote of an offer is about it; otherwise the state
 *      prior (one live offer, several, or the newest ended one; a club
 *      member only with one live offer and no club DM since). None: null.
 *   3. The reader, once, against those offers' own words (Haiku 5.5, the
 *      offer's club's daily AI budget).
 *   4. `replyAction`, then the SAME writers as the tap link's page
 *      (`accept.ts`: accept, decline with its 14-day cooldown, give back;
 *      `manage.ts`: stop), so every L5a check holds (the switch and the
 *      club's flag, the cut-off, kickoff, a live game, his profile active,
 *      the per-match lock, one guest place per club).
 *
 * PROOF: the DM itself, from the number the offer was sent to, is his
 * (`proved`). A sender known only by display name, or a LID without his
 * number, changes nothing: he gets the tap link, whose page proves him.
 *
 * Every line is in his pool language, ends with his manage link (but the
 * stop and switched-off lines, which ARE about it), and is rate-limited by
 * a `SentNotification` key: today's line and the re-ask once per offer,
 * the facts at most `POOL_REPLY_FACTS_PER_OFFER` times, "which" once per
 * set. A repeat past the limit returns null (the route carries on; for
 * someone in no club that is silence).
 */
import { db } from "../db";
import { withOrgAiBudget } from "../ai-budget";
import { appUrl } from "../app-url";
import { ORDINARY_MEMBER_WHERE } from "../guest-membership";
import { normaliseLang, type Lang } from "../i18n/lang";
import { normalisePhone } from "../phone";
import { queuePlatformDm } from "../platform-jobs";
import { sameWhatsAppMessage } from "../quoted-message";
import { acceptOffer, declineOffer, pullOutOfOffer } from "./accept";
import { buildPoolManageLink } from "./links";
import { applyManageAction } from "./manage";
import { OPEN_MATCH_STATUSES } from "./matching-rules";
import { loadMatchOfferFacts } from "./offer-facts";
import {
  poolReplyFactsText,
  poolReplyGoneText,
  poolReplyProfileOffText,
  poolReplyReaskText,
  poolReplyStateText,
  poolReplyStoppedText,
  poolReplyTapText,
  poolReplyWhichText,
} from "./offer-copy";
import { poolOfferPath } from "./offer-token";
import { readPoolReply, type PoolReplyReading } from "./reply-reader";
import {
  offerReplyState,
  POOL_REPLY_FACTS_PER_OFFER,
  POOL_REPLY_WINDOW_MS,
  replyAction,
  replyScope,
  type OfferReplyState,
  type ReplyAction,
  type ReplyOffer,
} from "./reply-rules";

type Env = Record<string, string | undefined>;

export type PoolReplyAnswer =
  | "pool-offer-tap-link"
  | "pool-offer-gone"
  | "pool-reply-accept"
  | "pool-reply-decline"
  | "pool-reply-pull-out"
  | "pool-reply-stop"
  | "pool-reply-facts"
  | "pool-reply-reask"
  | "pool-reply-which"
  | "pool-reply-profile-off"
  | null;

export interface PoolReplyInput {
  userId: string;
  /** His words. Empty: read as "neither" with no model. */
  text?: string | null;
  quotedId?: string | null;
  /** The envelope's phone and alternate phone (the proof it is his number). */
  phone?: string | null;
  senderAltPhone?: string | null;
  waMessageId?: string | null;
  now?: Date;
  /** The pool switch for this request (`poolEnvForApiRequest`). */
  env?: Env;
}

interface LoadedReplyOffer extends ReplyOffer {
  orgId: string;
  matchId: string;
  club: string;
  kickoff: Date;
  text: string;
}

const digitsOf = (p: string | null | undefined) => (p ? (normalisePhone(p) ?? "").replace(/^\+/, "") : "");
const LIVE_STATUSES = OPEN_MATCH_STATUSES as readonly string[];

export async function answerPoolOfferReply(args: PoolReplyInput): Promise<PoolReplyAnswer> {
  const now = args.now ?? new Date();
  try {
    const profile = await db.poolProfile.findUnique({
      where: { userId: args.userId },
      select: { status: true, language: true, user: { select: { phoneNumber: true } } },
    });
    const his = digitsOf(profile?.user?.phoneNumber);
    if (!profile || !his) return null;

    const offers = await loadReplyOffers(args.userId, his, args.quotedId ?? null, now);
    if (offers.length === 0) return null;

    const own = await db.membership.findFirst({
      where: { userId: args.userId, leftAt: null, ...ORDINARY_MEMBER_WHERE },
      select: { org: { select: { name: true } } },
    });
    const inAClub = !!own;
    const newestLive = offers.find((o) => o.state !== "ended");
    const clubDmSinceOffer =
      inAClub && !!newestLive && (await db.botJob.count({ where: { kind: "dm", phone: his, sentAt: { gt: newestLive.sentAt } } })) > 0;

    const scope = replyScope({ offers, inAClub, clubDmSinceOffer });
    if (scope.kind === "none") return null;
    const inScope = scope.kind === "one" ? [scope.offer as LoadedReplyOffer] : (scope.offers as LoadedReplyOffer[]);

    const reading = await readReply(args.text ?? "", inScope, own?.org.name ?? null, now);
    const proved = [args.phone, args.senderAltPhone].some((p) => digitsOf(p) === his);
    const action = replyAction({ scope, reading, inAClub, proved, profileActive: profile.status === "active" });
    console.log(
      `[pool] ${args.userId}: reply read ${reading.intent} (${reading.confidence.toFixed(2)}) over ${inScope.length} offer(s): ${action.kind}${proved ? "" : " (not proved)"}`,
    );
    const lang = normaliseLang(profile.language);
    const answer = await act(action, { userId: args.userId, phone: his, lang, offers, now, env: args.env, waMessageId: args.waMessageId ?? null });
    if (answer) await db.poolProfile.updateMany({ where: { userId: args.userId }, data: { lastActiveAt: now } });
    return answer;
  } catch (err) {
    console.error(`[pool] ${args.userId}: reply to an offer not answered:`, err instanceof Error ? err.message : "failed");
    return null;
  }
}

/** His delivered offers in the window and the places he holds, newest
 *  first, each only if it went to his number. */
async function loadReplyOffers(userId: string, his: string, quotedId: string | null, now: Date): Promise<LoadedReplyOffer[]> {
  const rows = await db.poolOffer.findMany({
    where: {
      userId,
      sentAt: { not: null, lte: now },
      OR: [{ sentAt: { gte: new Date(now.getTime() - POOL_REPLY_WINDOW_MS) } }, { outcome: "accepted", ask: { match: { date: { gt: now } } } }],
    },
    orderBy: { sentAt: "desc" },
    select: {
      id: true,
      orgId: true,
      matchId: true,
      outcome: true,
      sentAt: true,
      expiresAt: true,
      platformJobId: true,
      ask: { select: { status: true, org: { select: { name: true } }, match: { select: { date: true, status: true, isHistorical: true } } } },
    },
  });
  if (rows.length === 0) return [];
  const jobIds = rows.map((r) => r.platformJobId).filter((x): x is string => !!x);
  const accepted = rows.filter((r) => r.outcome === "accepted").map((r) => r.matchId);
  const [jobs, holds] = await Promise.all([
    db.platformJob.findMany({ where: { id: { in: jobIds } }, select: { id: true, waMessageId: true, text: true, phone: true } }),
    accepted.length
      ? db.attendance.findMany({ where: { userId, matchId: { in: accepted }, status: { in: ["CONFIRMED", "BENCH"] } }, select: { matchId: true } })
      : Promise.resolve([] as Array<{ matchId: string }>),
  ]);
  const jobOf = new Map(jobs.map((j) => [j.id, j]));
  const held = new Set(holds.map((h) => h.matchId));
  const out: LoadedReplyOffer[] = [];
  for (const r of rows) {
    const job = r.platformJobId ? jobOf.get(r.platformJobId) : undefined;
    // Only an offer that went to HIS number can be answered from it.
    if (!job || digitsOf(job.phone) !== his || !r.sentAt) continue;
    const m = r.ask.match;
    const state: OfferReplyState = offerReplyState({
      outcome: r.outcome,
      askStatus: r.ask.status,
      sentAt: r.sentAt,
      expiresAt: r.expiresAt,
      matchLive: LIVE_STATUSES.includes(m.status) && !m.isHistorical,
      kickoff: m.date,
      holdsPlace: held.has(r.matchId),
      now,
    });
    out.push({
      id: r.id,
      state,
      sentAt: r.sentAt,
      quoted: !!quotedId && sameWhatsAppMessage(quotedId, job.waMessageId),
      orgId: r.orgId,
      matchId: r.matchId,
      club: r.ask.org.name,
      kickoff: m.date,
      text: job.text ?? "",
    });
  }
  return out;
}

async function readReply(text: string, offers: LoadedReplyOffer[], ownClub: string | null, now: Date): Promise<PoolReplyReading> {
  const quotedIndex = offers.findIndex((o) => o.quoted);
  const ctx = { now, ownClub, quotedIndex: quotedIndex >= 0 ? quotedIndex : null, offers: offers.map((o) => ({ state: o.state, sentAt: o.sentAt, text: o.text })) };
  return withOrgAiBudget(offers[0].orgId, () => readPoolReply(text, ctx)).catch(() => ({ intent: "neither" as const, confidence: 0, reasoning: "budget" }));
}

/** Claim a rate-limit key; false when it was claimed already. */
async function once(key: string): Promise<boolean> {
  try {
    await db.sentNotification.create({ data: { key, kind: "pool-reply" } });
    return true;
  } catch {
    return false;
  }
}

interface ActCtx {
  userId: string;
  phone: string;
  lang: Lang;
  offers: LoadedReplyOffer[];
  now: Date;
  env?: Env;
  waMessageId: string | null;
}

async function act(action: ReplyAction, c: ActCtx): Promise<PoolReplyAnswer> {
  if (action.kind === "carry-on") return null;
  const offerOf = (id: string) => c.offers.find((o) => o.id === id)!;
  const tapLink = (id: string) => appUrl(poolOfferPath(id));
  const send = async (text: string, refId: string | null) => {
    await queuePlatformDm({ phone: c.phone, text, purpose: "pool-reply", refId });
  };
  const manage = () => buildPoolManageLink(c.userId);

  switch (action.kind) {
    case "fallback": {
      // Today's (L5a) line: "tap the link" while live, "gone" once ended.
      const o = offerOf(action.offerId);
      const kind = o.state === "ended" ? "pool-offer-gone" : "pool-offer-tap-link";
      if (!(await once(`pool-reply:${o.id}:${kind}`))) return null;
      await send(kind === "pool-offer-gone" ? poolReplyGoneText(c.lang, { club: o.club, manageLink: await manage() }) : poolReplyTapText(c.lang, { tapLink: tapLink(o.id), manageLink: await manage() }), o.id);
      return kind;
    }
    case "accept": {
      const state = await acceptOffer(action.offerId, c.now, c.env, "words");
      // In or on the bench: the match details DM (queued by acceptOffer) says it.
      if (state !== "in" && state !== "bench") await send(poolReplyStateText(c.lang, state, await manage()), action.offerId);
      return "pool-reply-accept";
    }
    case "decline": {
      const state = await declineOffer(action.offerId, c.now, "words");
      if (state !== "in" && state !== "bench") await send(poolReplyStateText(c.lang, state, await manage()), action.offerId);
      return "pool-reply-decline";
    }
    case "pull-out": {
      const state = await pullOutOfOffer(action.offerId, c.now);
      if (state !== "in" && state !== "bench") await send(poolReplyStateText(c.lang, state, await manage()), action.offerId);
      return "pool-reply-pull-out";
    }
    case "stop": {
      const r = await applyManageAction(c.userId, "stop", { now: c.now, via: { channel: "whatsapp", waMessageId: c.waMessageId ?? `dm:${c.now.getTime()}` } });
      // Already stopped: nothing more to say.
      if (r.ok) await send(poolReplyStoppedText(c.lang, await manage()), null);
      console.log(`[pool] ${c.userId}: stop by words: ${r.ok ? "stopped" : r.reason}`);
      return "pool-reply-stop";
    }
    case "facts": {
      const o = offerOf(action.offerId);
      if (o.state === "ended") return null;
      let slot = 0;
      for (let i = 1; i <= POOL_REPLY_FACTS_PER_OFFER && !slot; i++) if (await once(`pool-reply:${o.id}:facts:${i}`)) slot = i;
      if (!slot) return null;
      const [facts, row] = await Promise.all([
        loadMatchOfferFacts(o.matchId, c.now),
        db.poolOffer.findUnique({ where: { id: o.id }, select: { distanceMiles: true, ask: { select: { places: true } } } }),
      ]);
      if (!facts || !row) return null;
      await send(
        poolReplyFactsText(c.lang, { ...facts, places: row.ask.places, distanceMiles: row.distanceMiles }, { state: o.state, tapLink: tapLink(o.id), manageLink: await manage() }),
        o.id,
      );
      return "pool-reply-facts";
    }
    case "reask": {
      const o = offerOf(action.offerId);
      // Asked once already: today's one line, then nothing.
      if (!(await once(`pool-reply:${o.id}:reask`))) return act({ kind: "fallback", offerId: o.id }, c);
      await send(poolReplyReaskText(c.lang, { tapLink: tapLink(o.id), manageLink: await manage() }), o.id);
      return "pool-reply-reask";
    }
    case "which": {
      const ids = [...action.offerIds].sort();
      if (!(await once(`pool-reply:which:${ids.join(",")}`))) return null;
      const list = action.offerIds.map((id) => offerOf(id)).map((o) => ({ club: o.club, kickoff: o.kickoff, tapLink: tapLink(o.id) }));
      await send(poolReplyWhichText(c.lang, { offers: list, manageLink: await manage() }), null);
      return "pool-reply-which";
    }
    case "profile-off": {
      if (!(await once(`pool-reply:${action.offerId}:profile-off`))) return null;
      await send(poolReplyProfileOffText(c.lang, await manage()), action.offerId);
      return "pool-reply-profile-off";
    }
  }
}
