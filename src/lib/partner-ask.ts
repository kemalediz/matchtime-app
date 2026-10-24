/**
 * ASKING A PARTNER CLUB FOR A PLAYER (slice S2, 2026-10-16).
 * Plan: MDs/cross-club-player-ask-plan-2026-10-16.md, sections 3.3 to 3.5.
 *
 *   requestPartnerAsk   an organiser (the match page button, later HQ or
 *                       DM) or the automatic timer asks; the rules in
 *                       `partner-ask-rules.ts` decide; the partner's
 *                       organisers are asked to approve (D3, through
 *                       `sendAdminNotice`), or, with standing permission,
 *                       the ask is posted at once and they are told.
 *   approvePartnerAsk   a partner organiser's YES (HQ, the safe-YES rule)
 *   declinePartnerAsk   or the approve page's buttons.
 *   sweepPartnerAsks    every due-posts poll: close what should close
 *                       (filled, kickoff, the cut-off for an approval
 *                       still waiting, a cancelled or moved game, a paused
 *                       pairing) with the one line each side should hear,
 *                       and report a post whose WhatsApp id never came back.
 *
 * THE POST is a `group` BotJob of the PARTNER club, so the partner's own
 * mute switch and gates hold it like every other post; its WhatsApp id,
 * stamped on the ask when the Pi acknowledges it (`stampPartnerAskPost`,
 * called from /api/whatsapp/ack), is how a quoted reply finds the ask
 * (slice S3).
 *
 * The only writer of `PartnerAsk` besides `partner-guest.ts` (its
 * volunteers, slice S3). Every status change is a compare-and-set on the
 * status read, and the partial unique index allows one open ask per match
 * and partner, so a second poll, a second press or a second organiser can
 * never act twice. Logs carry ids only.
 */
import { randomUUID } from "node:crypto";
import { db } from "./db";
import { sendAdminNotice } from "./admin-channel";
import { recordMatchTimeQuestion } from "./admin-group-log";
import { isBillingPaused } from "./club-billing-rules";
import { isClubApproved } from "./club-approval-state";
import { isClubSettingUp, SETUP_STAGE_SELECT } from "./club-setup-rules";
import { isGroupPostable } from "./group-postability-store";
import { londonMidnight } from "./club-connect-rules";
import { isNextUpcomingForPosting } from "./next-upcoming-match";
import { loadPartnerAskSettings } from "./club-partnership";
import { retirePastGuests, standDownVolunteers, tellGuestsMoved } from "./partner-guest";
import { matchtimeWaNumber } from "./club-connect";
import { askDmLink, askDmPrefill, askRefCode } from "./partner-ask-ref";
import { loadRoundFill, type RoundFill } from "./partner-ask-round";
import { dayCommaTimeLabel } from "./i18n/dates";
import { t } from "./i18n/t";
import {
  MISSING_POST_ID_AFTER_MS,
  OPEN_ASK_STATUSES,
  PARTNER_ASKS_PER_DAY,
  askWindows,
  autoAskAt,
  autoAskDue,
  canAsk,
  closeReason,
  closeTells,
  closedStatus,
  gamesOverlap,
  isPartnerPaused,
  movedWindows,
  partnerReachable,
  roundKey,
  roundPartners,
  type AskRefusal,
  type CloseReason,
  type PartnerAskVia,
} from "./partner-ask-rules";
import type { PartnerAskOutcome } from "./partner-ask-words-rules";
import { effectiveAskTime, type ClubRole } from "./club-partnership-rules";
import { loadPoolPanel, type PoolPanelData } from "./pool/panel";
import { cancelPoolAsk } from "./pool/round";
import { autoAskPool, poolAutoAskClub } from "./pool/auto-ask";
import { poolAutoAskApplies } from "./pool/auto-ask-rules";

/** The ask ref of the approval question in the partner's admin group. */
export const partnerAskRef = (askId: string): string => `xask:${askId}`;
export const parsePartnerAskRef = (ref: string): string | null => (ref.startsWith("xask:") ? ref.slice(5) : null);

/** The approve page a partner organiser's link opens. */
export const partnerAskPath = (askId: string): string => `/partner-asks/${askId}`;

const LIVE_MATCH: Array<"UPCOMING" | "TEAMS_GENERATED" | "TEAMS_PUBLISHED"> = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"];

/** £8, £7.50: a fee in pounds, for the ask and the approval notice. */
export function feeLabel(pounds: number | null | undefined): string | null {
  if (pounds == null || !Number.isFinite(pounds) || pounds <= 0) return null;
  return Number.isInteger(pounds) ? `£${pounds}` : `£${pounds.toFixed(2)}`;
}

const MATCH_SELECT = {
  id: true,
  date: true,
  status: true,
  isHistorical: true,
  maxPlayers: true,
  activityId: true,
  feePerPlayer: true,
  activity: {
    select: {
      orgId: true,
      venue: true,
      dayOfWeek: true,
      feePerPlayer: true,
      feeSplitTotal: true,
      sport: { select: { playersPerTeam: true } },
    },
  },
} as const;

type AskMatch = {
  id: string;
  date: Date;
  status: string;
  isHistorical: boolean;
  maxPlayers: number;
  activityId: string;
  feePerPlayer: number | null;
  activity: {
    orgId: string;
    venue: string;
    dayOfWeek: number;
    feePerPlayer: number | null;
    feeSplitTotal: boolean;
    sport: { playersPerTeam: number } | null;
  };
};

/** The match facts the ask and its notices state (plan 3.5). No names. */
export interface AskFacts {
  asker: string;
  places: number;
  day: string;
  venue: string;
  format: string | null;
  fee: string | null;
}

function factsFor(match: AskMatch, askerName: string, places: number, lang: string | null): AskFacts {
  const perSide = match.activity.sport?.playersPerTeam;
  const fee = match.feePerPlayer ?? (match.activity.feeSplitTotal ? null : match.activity.feePerPlayer);
  return {
    asker: askerName,
    places,
    day: dayCommaTimeLabel(lang, match.date),
    venue: match.activity.venue,
    format: perSide ? t(lang).sj_per_side_option({ perSide }) : null,
    fee: feeLabel(fee),
  };
}

export async function placesOpen(matchId: string, maxPlayers: number): Promise<number> {
  const confirmed = await db.attendance.count({ where: { matchId, status: "CONFIRMED" } });
  return Math.max(0, maxPlayers - confirmed);
}

async function isNextMatch(orgId: string, match: AskMatch, now: Date): Promise<boolean> {
  const candidates = await db.match.findMany({
    where: { activity: { orgId }, isHistorical: false, date: { gte: new Date(now.getTime() - 2 * 24 * 3600_000) } },
    select: { id: true, date: true, status: true, activityId: true, isHistorical: true, activity: { select: { orgId: true, venue: true, dayOfWeek: true } } },
  });
  return isNextUpcomingForPosting(candidates, match, now);
}

const PARTNER_GATE_SELECT = {
  id: true,
  name: true,
  language: true,
  whatsappGroupId: true,
  whatsappBotEnabled: true,
  dormantAt: true,
  billingStatus: true,
  ...SETUP_STAGE_SELECT,
} as const;

async function partnerGate(partnerOrgId: string) {
  const org = await db.organisation.findUnique({ where: { id: partnerOrgId }, select: PARTNER_GATE_SELECT });
  if (!org) return { org: null, refusal: "partner-not-approved" as const };
  const refusal = partnerReachable({
    whatsappGroupId: org.whatsappGroupId,
    whatsappBotEnabled: org.whatsappBotEnabled,
    dormantAt: org.dormantAt,
    approved: isClubApproved(org),
    billingPaused: isBillingPaused(org),
    settingUp: isClubSettingUp(org),
    groupPostable: await isGroupPostable(org.whatsappGroupId),
  });
  return { org, refusal };
}

/** How many asks today already count against the partner group (D12):
 *  those posted today, and those still waiting that may post. */
async function partnerAsksToday(partnerOrgId: string, now: Date): Promise<number> {
  const since = londonMidnight(now);
  return db.partnerAsk.count({
    where: {
      partnerOrgId,
      OR: [{ postedAt: { gte: since } }, { status: "awaiting-approval", createdAt: { gte: since } }],
    },
  });
}

async function roleIn(userId: string | null, orgId: string): Promise<ClubRole | null> {
  if (!userId) return null;
  const m = await db.membership.findUnique({ where: { userId_orgId: { userId, orgId } }, select: { role: true, leftAt: true } });
  if (!m || m.leftAt) return null;
  return m.role as ClubRole;
}

export type RequestResult =
  | { ok: true; askId: string; status: "awaiting-approval" | "posted"; partnerName: string; places: number }
  | { ok: false; refusal: AskRefusal | "not-found"; partnerName: string | null };

/**
 * Ask one partner club for this match. Every check is the pure `canAsk`
 * and `partnerReachable`; a refusal writes nothing and is returned for the
 * caller to say in plain words (`askRefusalText`).
 *
 * `places` (P4, D-5): the number the organiser chose, 1 up to the open
 * places, for the whole round `roundId` (asks sent together). Absent: the
 * automatic ask and asking in words, which ask for every open place.
 */
export async function requestPartnerAsk(args: {
  askerOrgId: string;
  matchId: string;
  partnershipId: string;
  requestedByUserId: string | null;
  via: PartnerAskVia;
  places?: number;
  roundId?: string | null;
  now?: Date;
}): Promise<RequestResult> {
  const now = args.now ?? new Date();
  const [partnership, asker, settings, match] = await Promise.all([
    db.clubPartnership.findUnique({ where: { id: args.partnershipId } }),
    db.organisation.findUnique({ where: { id: args.askerOrgId }, select: { id: true, name: true, language: true } }),
    loadPartnerAskSettings(args.askerOrgId),
    db.match.findUnique({ where: { id: args.matchId }, select: MATCH_SELECT }) as Promise<AskMatch | null>,
  ]);
  if (!partnership || partnership.askerOrgId !== args.askerOrgId || !asker || !settings || !match || match.activity.orgId !== args.askerOrgId) {
    return { ok: false, refusal: "not-found", partnerName: null };
  }
  const gate = await partnerGate(partnership.partnerOrgId);
  const partnerName = gate.org?.name ?? null;
  const { postBy, closesAt } = askWindows(match.date, settings.cutoffHours);
  const [places, next, open, today, role] = await Promise.all([
    placesOpen(match.id, match.maxPlayers),
    isNextMatch(args.askerOrgId, match, now),
    db.partnerAsk.count({ where: { matchId: match.id, partnerOrgId: partnership.partnerOrgId, status: { in: [...OPEN_ASK_STATUSES] } } }),
    partnerAsksToday(partnership.partnerOrgId, now),
    roleIn(args.requestedByUserId, args.askerOrgId),
  ]);
  const wanted = args.places ?? places;
  const verdict0 = canAsk({
    partnershipStatus: partnership.status,
    askWhen: settings.when,
    via: args.via,
    requesterRole: role,
    isNextMatch: next,
    matchStatus: match.status,
    matchHistorical: match.isHistorical,
    placesOpen: places,
    places: wanted,
    now,
    postBy,
    openAskForPair: open > 0,
    partnerAsksToday: today,
  });
  if (!verdict0.ok) return { ok: false, refusal: verdict0.refusal, partnerName };
  if (gate.refusal || !gate.org) return { ok: false, refusal: gate.refusal ?? "partner-not-approved", partnerName };
  const partner = gate.org;

  // THE DAILY CAP, ATOMICALLY (review L2): two requests for one partner
  // club at once must not both pass a count of 1. One transaction-scoped
  // advisory lock per partner club, then the count again, then the row.
  let askId: string;
  try {
    const created = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`xask-cap:${partner.id}`}))`;
      const since = londonMidnight(now);
      const todayNow = await tx.partnerAsk.count({
        where: { partnerOrgId: partner.id, OR: [{ postedAt: { gte: since } }, { status: "awaiting-approval", createdAt: { gte: since } }] },
      });
      if (todayNow >= PARTNER_ASKS_PER_DAY) return null;
      return tx.partnerAsk.create({
        data: {
          partnershipId: partnership.id,
          askerOrgId: asker.id,
          partnerOrgId: partner.id,
          matchId: match.id,
          places: wanted,
          roundId: args.roundId ?? null,
          requestedByUserId: args.requestedByUserId,
          requestedVia: args.via,
          postBy,
          closesAt,
        },
        select: { id: true },
      });
    });
    if (!created) return { ok: false, refusal: "daily-cap", partnerName };
    askId = created.id;
  } catch (err) {
    // The partial unique index: another press or poll opened it first.
    if ((err as { code?: string })?.code === "P2002") return { ok: false, refusal: "already-open", partnerName };
    throw err;
  }
  console.log(
    `[partner-ask] ${askId}: ${asker.id} asks ${partner.id} for match ${match.id} (${args.via}, ${wanted} of ${places} open place(s)${args.roundId ? `, round ${args.roundId}` : ""})`,
  );

  if (partnership.partnerApproval === "standing") {
    const posted = await postAsk(askId, null, now);
    if (posted) {
      await sendAdminNotice({
        orgId: partner.id,
        now,
        text: t(partner.language).xask_posted_notice_partner(factsFor(match, asker.name, wanted, partner.language)),
      });
      await tellAskerApproved(askId, now);
    }
    return { ok: true, askId, status: "posted", partnerName: partner.name, places: wanted };
  }

  await askPartnerToApprove(askId, match, asker.name, wanted, partner, now);
  return { ok: true, askId, status: "awaiting-approval", partnerName: partner.name, places: wanted };
}

export interface RoundResult {
  roundId: string;
  /** What `requestPartnerAsk` said for each partner asked. */
  results: Array<{ partnershipId: string; partnerName: string; result: PartnerAskOutcome }>;
  /** Paused partners (dormant or billing-paused), not asked (plan 2.1). */
  skippedPaused: string[];
  /** How many were asked (posted, or waiting for their organisers). */
  asked: number;
  /** The match's open places now, for a refusal of the number. */
  placesOpen: number;
}

/**
 * Ask several partners at once (P4): one ROUND, one number for all of
 * them (D-5), each ask through `requestPartnerAsk`, so every rule of a
 * single ask holds. `partnershipIds` is the ticked partners, or "all"
 * (every active partner). A paused partner is never asked: no row, no
 * notice, no post; it is named in `skippedPaused`.
 */
export async function requestPartnerRound(args: {
  askerOrgId: string;
  matchId: string;
  partnershipIds: string[] | "all";
  places: number;
  requestedByUserId: string | null;
  via: PartnerAskVia;
  now?: Date;
}): Promise<RoundResult> {
  const now = args.now ?? new Date();
  const [partnerships, match] = await Promise.all([
    db.clubPartnership.findMany({
      where: { askerOrgId: args.askerOrgId, status: "active" },
      orderBy: { createdAt: "asc" },
      select: { id: true, partnerOrgId: true, partnerOrg: { select: { name: true, dormantAt: true, billingStatus: true } } },
    }),
    db.match.findUnique({ where: { id: args.matchId }, select: { id: true, maxPlayers: true } }),
  ]);
  const choices = partnerships.map((p) => ({
    partnershipId: p.id,
    name: p.partnerOrg.name,
    paused: isPartnerPaused({ dormantAt: p.partnerOrg.dormantAt, billingPaused: isBillingPaused(p.partnerOrg) }),
  }));
  const { ask, skippedPaused } = roundPartners(choices, args.partnershipIds);
  const roundId = randomUUID();
  const results: RoundResult["results"] = [];
  for (const p of ask) {
    let result: PartnerAskOutcome;
    try {
      const r = await requestPartnerAsk({
        askerOrgId: args.askerOrgId,
        matchId: args.matchId,
        partnershipId: p.partnershipId,
        requestedByUserId: args.requestedByUserId,
        via: args.via,
        places: args.places,
        roundId,
        now,
      });
      result = r.ok ? (r.status === "posted" ? "posted" : "awaiting") : r.refusal;
    } catch (err) {
      // One partner failing never loses what the others said.
      console.error(`[partner-ask] round ${roundId}: asking ${p.partnershipId} failed:`, err instanceof Error ? err.message : "failed");
      result = "not-found";
    }
    results.push({ partnershipId: p.partnershipId, partnerName: p.name, result });
  }
  const asked = results.filter((r) => r.result === "posted" || r.result === "awaiting").length;
  if (skippedPaused.length > 0) console.log(`[partner-ask] round ${roundId}: ${skippedPaused.length} paused partner(s) not asked`);
  return {
    roundId,
    results,
    skippedPaused: skippedPaused.map((p) => p.name),
    asked,
    placesOpen: match ? await placesOpen(match.id, match.maxPlayers) : 0,
  };
}

/** The approval notice to the partner's organisers (plan 3.3 step 4),
 *  with how their own squad stands on the same day. */
async function askPartnerToApprove(
  askId: string,
  match: AskMatch,
  askerName: string,
  places: number,
  partner: { id: string; language: string },
  now: Date,
): Promise<void> {
  const own = await partnerOwnGameThatDay(partner.id, match.date);
  const facts = factsFor(match, askerName, places, partner.language);
  const s = t(partner.language);
  const sent = await sendAdminNotice({
    orgId: partner.id,
    now,
    holdOvernight: false,
    nextPath: partnerAskPath(askId),
    text: (link, audience) => s.xask_approval_notice({ ...facts, own, link, inGroup: audience === "group" }),
  });
  // In an admin group the notice is a question the safe-YES rule answers:
  // logged with its ask ref, so a YES that quotes it, or comes next, is
  // about this ask and nothing else.
  if (sent.channel === "admin-group") {
    await recordMatchTimeQuestion({
      orgId: partner.id,
      askRef: partnerAskRef(askId),
      text: s.xask_approval_notice({ ...facts, own, link: "", inGroup: true }),
      now,
    });
  }
}

/** The partner club's own game on the same London day, as "12 of 14", or null. */
async function partnerOwnGameThatDay(partnerOrgId: string, kickoff: Date): Promise<{ confirmed: number; max: number } | null> {
  const dayStart = londonMidnight(kickoff);
  const dayEnd = new Date(dayStart.getTime() + 30 * 3600_000);
  const own = await db.match.findFirst({
    where: { activity: { orgId: partnerOrgId }, status: { in: LIVE_MATCH }, isHistorical: false, date: { gte: dayStart, lt: dayEnd } },
    orderBy: { date: "asc" },
    select: { id: true, maxPlayers: true },
  });
  if (!own) return null;
  const confirmed = await db.attendance.count({ where: { matchId: own.id, status: "CONFIRMED" } });
  return { confirmed, max: own.maxPlayers };
}

/** Post an ask that is still waiting, or one with standing permission.
 *  A compare-and-set on the status, in one transaction with its BotJob,
 *  so it can never post twice. Returns false when it was not posted. */
async function postAsk(askId: string, approverUserId: string | null, now: Date): Promise<boolean> {
  const ask = await db.partnerAsk.findUnique({ where: { id: askId } });
  if (!ask || ask.status !== "awaiting-approval") return false;
  const [asker, partner, match] = await Promise.all([
    db.organisation.findUnique({ where: { id: ask.askerOrgId }, select: { name: true } }),
    db.organisation.findUnique({ where: { id: ask.partnerOrgId }, select: { id: true, language: true } }),
    db.match.findUnique({ where: { id: ask.matchId }, select: MATCH_SELECT }) as Promise<AskMatch | null>,
  ]);
  if (!asker || !partner || !match) return false;
  const open = await placesOpen(match.id, match.maxPlayers);
  // P4: the post asks for the organiser's number (the round's), never more
  // than the places still open. The ask's own `places` is never rewritten.
  const places = Math.max(1, Math.min(ask.places, open));
  // Volunteers answer MatchTime by DM (2026-10-21): the post carries the
  // tap-to-DM link with this ask's code, and nothing else reaches the group.
  const text = t(partner.language).xask_post({
    ...factsFor(match, asker.name, places, partner.language),
    link: askDmLink({ number: matchtimeWaNumber(), lang: partner.language, askId }),
    prefill: askDmPrefill(partner.language, askRefCode(askId)),
  });
  return db.$transaction(async (tx) => {
    const job = await tx.botJob.create({ data: { orgId: partner.id, kind: "group", text }, select: { id: true } });
    const done = await tx.partnerAsk.updateMany({
      where: { id: askId, status: "awaiting-approval" },
      data: {
        status: "posted",
        postedAt: now,
        postJobId: job.id,
        ...(approverUserId ? { approvedByUserId: approverUserId, approvedAt: now } : {}),
      },
    });
    if (done.count === 0) {
      await tx.botJob.delete({ where: { id: job.id } });
      return false;
    }
    console.log(`[partner-ask] ${askId}: posted to ${partner.id} as job ${job.id}`);
    return true;
  });
}

async function askAndMatch(askId: string) {
  const ask = await db.partnerAsk.findUnique({ where: { id: askId } });
  if (!ask) return null;
  const [asker, partner, match] = await Promise.all([
    db.organisation.findUnique({ where: { id: ask.askerOrgId }, select: { id: true, name: true, language: true } }),
    db.organisation.findUnique({
      where: { id: ask.partnerOrgId },
      select: { id: true, name: true, language: true, dormantAt: true, billingStatus: true },
    }),
    db.match.findUnique({ where: { id: ask.matchId }, select: MATCH_SELECT }) as Promise<AskMatch | null>,
  ]);
  if (!asker || !partner || !match) return null;
  return { ask, asker, partner, match };
}

async function tellAskerApproved(askId: string, now: Date): Promise<void> {
  const a = await askAndMatch(askId);
  if (!a) return;
  await sendAdminNotice({
    orgId: a.asker.id,
    now,
    holdOvernight: false,
    text: t(a.asker.language).xask_approved_notice_asker({ partner: a.partner.name, day: dayCommaTimeLabel(a.asker.language, a.match.date) }),
  });
}

export type ApproveResult =
  | { ok: true; outcome: "posted" }
  | { ok: false; outcome: "not-found" | "not-admin" | "closed" | "too-late" | "no-places" | "unreachable" };

/**
 * A partner organiser's YES. The ask must still be waiting, before its
 * cut-off, with a place open, the pairing active and the partner group
 * reachable: an approval never posts an ask the rules would now refuse.
 */
export async function approvePartnerAsk(args: { askId: string; userId: string; now?: Date }): Promise<ApproveResult> {
  const now = args.now ?? new Date();
  const a = await askAndMatch(args.askId);
  if (!a) return { ok: false, outcome: "not-found" };
  const role = await roleIn(args.userId, a.ask.partnerOrgId);
  if (role !== "OWNER" && role !== "ADMIN") return { ok: false, outcome: "not-admin" };
  if (a.ask.status !== "awaiting-approval") return { ok: false, outcome: "closed" };
  if (now.getTime() >= a.ask.postBy.getTime()) return { ok: false, outcome: "too-late" };
  const partnership = await db.clubPartnership.findUnique({ where: { id: a.ask.partnershipId }, select: { status: true } });
  if (partnership?.status !== "active") return { ok: false, outcome: "closed" };
  if ((await placesOpen(a.match.id, a.match.maxPlayers)) <= 0) return { ok: false, outcome: "no-places" };
  // P4: the round already has its number (from another of its asks).
  const fill = await loadRoundFill(a.ask);
  if (fill.placed >= fill.wanted) return { ok: false, outcome: "no-places" };
  if ((await partnerGate(a.ask.partnerOrgId)).refusal) return { ok: false, outcome: "unreachable" };
  const posted = await postAsk(a.ask.id, args.userId, now);
  if (!posted) return { ok: false, outcome: "closed" };
  await tellAskerApproved(a.ask.id, now);
  return { ok: true, outcome: "posted" };
}

/** A partner organiser's "no thanks" on the approve page. */
export async function declinePartnerAsk(args: { askId: string; userId: string; now?: Date }): Promise<{ ok: boolean; outcome: string }> {
  const now = args.now ?? new Date();
  const a = await askAndMatch(args.askId);
  if (!a) return { ok: false, outcome: "not-found" };
  const role = await roleIn(args.userId, a.ask.partnerOrgId);
  if (role !== "OWNER" && role !== "ADMIN") return { ok: false, outcome: "not-admin" };
  const done = await db.partnerAsk.updateMany({
    where: { id: a.ask.id, status: "awaiting-approval" },
    data: { status: "declined", reason: "declined", closedAt: now },
  });
  if (done.count === 0) return { ok: false, outcome: "closed" };
  await sendAdminNotice({
    orgId: a.asker.id,
    now,
    holdOvernight: false,
    text: t(a.asker.language).xask_declined_notice_asker({ partner: a.partner.name, day: dayCommaTimeLabel(a.asker.language, a.match.date) }),
  });
  return { ok: true, outcome: "declined" };
}

/** Stamp the post's WhatsApp id when the Pi acknowledges its BotJob. */
export async function stampPartnerAskPost(botJobId: string, waMessageId: string | null | undefined): Promise<void> {
  if (!waMessageId) return;
  await db.partnerAsk.updateMany({ where: { postJobId: botJobId, postWaMessageId: null }, data: { postWaMessageId: waMessageId } });
}

/** What the approve page shows: the ask, if the viewer may act on it. */
export async function loadPartnerAskForApprover(askId: string, userId: string) {
  const a = await askAndMatch(askId);
  if (!a) return null;
  const role = await roleIn(userId, a.ask.partnerOrgId);
  if (role !== "OWNER" && role !== "ADMIN") return null;
  return {
    status: a.ask.status,
    language: a.partner.language,
    partnerName: a.partner.name,
    facts: factsFor(a.match, a.asker.name, a.ask.places, a.partner.language),
    own: await partnerOwnGameThatDay(a.partner.id, a.match.date),
  };
}

export interface PartnerAskPanelData {
  /** The match's open places now: the picker offers 1 up to this. */
  placesOpen: number;
  /** One line per active partner. */
  rows: Array<{
    partnershipId: string;
    partnerName: string;
    /** Its latest ask's status for this match, or null. */
    status: string | null;
    volunteers: number;
    /** Dormant or billing-paused (plan 2.1): shown, never offered. */
    paused: boolean;
    /** The round of its OPEN ask, or null. */
    roundKey: string | null;
  }>;
  /** Each round still open: its number, how many have a place, who.
   *  `pool`: the MatchTime player pool is asked in it too (L5a). */
  rounds: Array<{ roundKey: string; wanted: number; placed: number; partners: string[]; pool: boolean }>;
  /** The MatchTime player pool (L5a): null unless the pool is open for
   *  this club (the switch and its flag), so the panel is unchanged for
   *  every club today. */
  pool: PoolPanelData | null;
}

/** The asks of this club's next match, for the match page (P4): the open
 *  places, a line per partner (what an organiser can tick, a paused one,
 *  or what is already open), and each open round with its number. */
export async function loadPartnerAskPanel(
  matchId: string,
  askerOrgId: string,
  opts: { poolEnv?: Record<string, string | undefined>; now?: Date } = {},
): Promise<PartnerAskPanelData | null> {
  const pool = await loadPoolPanel(matchId, askerOrgId, { env: opts.poolEnv, now: opts.now }).catch((err: unknown) => {
    console.error(`[partner-ask] match ${matchId}: the pool panel was not read:`, err instanceof Error ? err.message : "failed");
    return null;
  });
  const [settings, partnerships, asks, match] = await Promise.all([
    loadPartnerAskSettings(askerOrgId),
    db.clubPartnership.findMany({
      where: { askerOrgId, status: "active" },
      orderBy: { createdAt: "asc" },
      select: { id: true, partnerOrgId: true, partnerOrg: { select: { name: true, dormantAt: true, billingStatus: true } } },
    }),
    db.partnerAsk.findMany({
      where: { matchId, askerOrgId },
      orderBy: { createdAt: "desc" },
      select: { id: true, roundId: true, places: true, partnerOrgId: true, status: true, volunteerUserIds: true, pickedUserIds: true },
    }),
    db.match.findUnique({ where: { id: matchId }, select: { maxPlayers: true } }),
  ]);
  if (!match) return null;
  const partnersOn = !!settings && settings.when !== "off" && partnerships.length > 0;
  if (!partnersOn && !pool) return null;
  const nameOf = new Map(partnerships.map((p) => [p.partnerOrgId, p.partnerOrg.name]));
  const rows = (partnersOn ? partnerships : []).map((p) => {
    const latest = asks.find((a) => a.partnerOrgId === p.partnerOrgId) ?? null;
    const open = latest && isOpenAsk(latest.status);
    return {
      partnershipId: p.id,
      partnerName: p.partnerOrg.name,
      status: latest?.status ?? null,
      volunteers: latest?.volunteerUserIds.length ?? 0,
      paused: isPartnerPaused({ dormantAt: p.partnerOrg.dormantAt, billingPaused: isBillingPaused(p.partnerOrg) }),
      roundKey: open ? roundKey(latest) : null,
    };
  });
  const openAsks = asks.filter((a) => isOpenAsk(a.status));
  const rounds: PartnerAskPanelData["rounds"] = [];
  for (const key of [...new Set(openAsks.map((a) => roundKey(a)))]) {
    const inRound = openAsks.filter((a) => roundKey(a) === key);
    const fill = await loadRoundFill({ ...inRound[0], matchId });
    rounds.push({
      roundKey: key,
      wanted: fill.wanted,
      placed: fill.placed,
      partners: inRound.map((a) => nameOf.get(a.partnerOrgId) ?? ""),
      pool: pool?.ask?.status === "open" && pool.ask.roundKey === key,
    });
  }
  // A round that asks only the pool (L5a): its own line.
  if (pool?.ask?.status === "open" && !rounds.some((r) => r.roundKey === pool.ask!.roundKey)) {
    rounds.push({ roundKey: pool.ask.roundKey, wanted: pool.ask.wanted, placed: pool.ask.placed, partners: [], pool: true });
  }
  return { placesOpen: await placesOpen(matchId, match.maxPlayers), rows, rounds, pool };
}

const isOpenAsk = (status: string): boolean => (OPEN_ASK_STATUSES as readonly string[]).includes(status);

/**
 * Every due-posts poll, for asks this club made OR received: close the ones
 * that should close, tell each side what it should hear (D8), and report a
 * post whose WhatsApp id never came back (plan 3.13). Never throws.
 */
export async function sweepPartnerAsks(orgId: string, now: Date = new Date()): Promise<{ closed: number }> {
  let closed = 0;
  // Guests whose match is over become past guests (S4). Never throws.
  await retirePastGuests(orgId, now);
  // P4: one read of each round's fill per sweep.
  const fills = new Map<string, RoundFill>();
  try {
    const asks = await db.partnerAsk.findMany({
      where: { OR: [{ askerOrgId: orgId }, { partnerOrgId: orgId }], status: { in: [...OPEN_ASK_STATUSES] } },
      include: { partnership: { select: { status: true } }, match: { select: MATCH_SELECT } },
    });
    for (const ask of asks) {
      const match = ask.match as unknown as AskMatch;
      // A MOVED game (review H3): the ask follows the new kickoff and stays
      // open; nobody is told it is off. A compare-and-set on the old close.
      if (match.status !== "CANCELLED") {
        const cutoff = (await loadPartnerAskSettings(ask.askerOrgId))?.cutoffHours ?? 4;
        const moved = movedWindows({ closesAt: ask.closesAt, matchDate: match.date, cutoffHours: cutoff });
        if (moved) {
          const done = await db.partnerAsk.updateMany({
            where: { id: ask.id, status: ask.status, closesAt: ask.closesAt },
            data: { closesAt: moved.closesAt, postBy: moved.postBy },
          });
          if (done.count > 0) {
            console.log(`[partner-ask] ${ask.id}: the game moved; the ask follows it`);
            await afterMove(ask.id, now);
          }
          continue;
        }
      }
      if (await closeIfDue(ask, match, ask.partnership.status, fills, now)) closed++;
    }
  } catch (err) {
    console.error(`[partner-ask] org ${orgId}: sweep failed:`, err instanceof Error ? err.message : "failed");
  }
  return { closed };
}

type OpenAskRow = {
  id: string;
  roundId: string | null;
  matchId: string;
  places: number;
  status: string;
  postBy: Date;
  closesAt: Date;
  postedAt: Date | null;
  postWaMessageId: string | null;
  postJobId: string | null;
  askerOrgId: string;
  volunteerUserIds: string[];
  pickedUserIds: string[];
};

/**
 * One open ask, the sweep's rule (`closeReason`): close it if it should,
 * with the one line each side should hear. Filled is the ROUND's number
 * reached (P4, counted across its asks; `fills` caches one read per round
 * per sweep) or no open place left. Otherwise a post whose WhatsApp id
 * never came back is reported. True when it closed.
 */
async function closeIfDue(ask: OpenAskRow, match: AskMatch, partnershipStatus: string, fills: Map<string, RoundFill>, now: Date): Promise<boolean> {
  const places = await placesOpen(match.id, match.maxPlayers);
  const key = roundKey(ask);
  let fill = fills.get(key);
  if (!fill) {
    fill = await loadRoundFill(ask);
    fills.set(key, fill);
  }
  const reason = closeReason({
    status: ask.status,
    now,
    postBy: ask.postBy,
    closesAt: ask.closesAt,
    matchDate: match.date,
    matchStatus: match.status,
    partnershipStatus,
    placesOpen: places,
    roundPlaced: fill.placed,
    roundWanted: fill.wanted,
  });
  if (!reason) {
    await reportMissingPostId(ask, now);
    return false;
  }
  return closeAsk(ask, reason, now);
}

/** Close one open ask for `reason`: a compare-and-set on the status read,
 *  then the one line each side should hear (D8), then its volunteers
 *  without a place are thanked and stood down (S4). True when it closed. */
async function closeAsk(ask: { id: string; status: string; volunteerUserIds: string[] }, reason: CloseReason, now: Date): Promise<boolean> {
  const status = closedStatus(reason, ask.status);
  const done = await db.partnerAsk.updateMany({
    where: { id: ask.id, status: ask.status },
    data: { status, reason, closedAt: now },
  });
  if (done.count === 0) return false;
  console.log(`[partner-ask] ${ask.id}: closed ${status} (${reason})`);
  await tellClose(ask.id, reason, ask.status, ask.volunteerUserIds.length, now);
  await standDownVolunteers(ask.id, reason, now);
  return true;
}

/** The open asks of one round (P4): the asks sharing `roundId`, or the
 *  one ask that is a round of its own. */
function openRoundWhere(args: { matchId: string; key: string; askerOrgId?: string }) {
  return {
    matchId: args.matchId,
    ...(args.askerOrgId ? { askerOrgId: args.askerOrgId } : {}),
    status: { in: [...OPEN_ASK_STATUSES] },
    OR: [{ roundId: args.key }, { id: args.key }],
  };
}

/**
 * Close this ask's round NOW if it should close (P4): called when a
 * first-come volunteer took the round's last wanted place, so every
 * partner group hears "filled" at once rather than at the next poll. The
 * same rule as the sweep (`closeIfDue`). Never throws.
 */
export async function closeRoundIfDue(askId: string, now: Date = new Date()): Promise<number> {
  let closed = 0;
  try {
    const one = await db.partnerAsk.findUnique({ where: { id: askId }, select: { id: true, roundId: true, matchId: true } });
    if (!one) return 0;
    const asks = await db.partnerAsk.findMany({
      where: openRoundWhere({ matchId: one.matchId, key: roundKey(one) }),
      include: { partnership: { select: { status: true } }, match: { select: MATCH_SELECT } },
    });
    const fills = new Map<string, RoundFill>();
    for (const ask of asks) {
      if (await closeIfDue(ask, ask.match as unknown as AskMatch, ask.partnership.status, fills, now)) closed++;
    }
  } catch (err) {
    console.error(`[partner-ask] ${askId}: closing the round failed:`, err instanceof Error ? err.message : "failed");
  }
  return closed;
}

/**
 * An organiser CANCELS an open round by hand (Kemal, 2026-10-22): every
 * open ask in the round closes as cancelled. Each partner group that saw
 * the ask hears one "no longer needed" line, an ask still waiting for the
 * partner's approval simply closes, and the volunteers without a place are
 * thanked and stood down. Owners and admins of the asking club only.
 */
export async function cancelPartnerRound(args: {
  askerOrgId: string;
  matchId: string;
  roundKey: string;
  userId: string;
  now?: Date;
}): Promise<{ ok: boolean; cancelled: number }> {
  const now = args.now ?? new Date();
  const role = await roleIn(args.userId, args.askerOrgId);
  if (role !== "OWNER" && role !== "ADMIN") return { ok: false, cancelled: 0 };
  const asks = await db.partnerAsk.findMany({
    where: openRoundWhere({ matchId: args.matchId, key: args.roundKey, askerOrgId: args.askerOrgId }),
    select: { id: true, status: true, volunteerUserIds: true },
  });
  let cancelled = 0;
  for (const ask of asks) {
    if (await closeAsk(ask, "organiser-cancelled", now)) cancelled++;
  }
  // The round's pool ask, if it has one (L5a): its unsent offers are
  // cancelled and nobody else is offered the place.
  cancelled += await cancelPoolAsk({ orgId: args.askerOrgId, matchId: args.matchId, roundKey: args.roundKey, now }).catch((err: unknown) => {
    console.error(`[partner-ask] round ${args.roundKey}: the pool ask was not cancelled:`, err instanceof Error ? err.message : "failed");
    return 0;
  });
  console.log(`[partner-ask] round ${args.roundKey} of match ${args.matchId}: ${cancelled} ask(s) cancelled by ${args.userId}`);
  return { ok: cancelled > 0, cancelled };
}

/** After a moved game: the hook S4 fills in (guests told the new time). */
async function afterMove(askId: string, now: Date): Promise<void> {
  // Its guests keep their place and are told the new time (S4).
  await tellGuestsMoved(askId, now);
}

async function tellClose(askId: string, reason: Parameters<typeof closeTells>[0], wasStatus: string, volunteers: number, now: Date): Promise<void> {
  const a = await askAndMatch(askId);
  if (!a) return;
  const tells = closeTells(reason, wasStatus, volunteers);
  const ps = t(a.partner.language);
  // A partner that is paused now (dormant or billing-paused, plan 2.1):
  // MatchTime is off in its groups, so nothing is queued there, not even
  // the closing line (it would go out late, whenever the club is back).
  const partnerPaused = isPartnerPaused({ dormantAt: a.partner.dormantAt, billingPaused: isBillingPaused(a.partner) });
  if (tells.partnerGroup && !partnerPaused) {
    const text =
      tells.partnerGroup === "filled"
        ? ps.xask_filled_line({ asker: a.asker.name })
        : tells.partnerGroup === "not-needed"
          ? ps.xask_not_needed_line({ asker: a.asker.name })
          : ps.xask_off_line({ asker: a.asker.name, day: dayCommaTimeLabel(a.partner.language, a.match.date) });
    await db.botJob.create({ data: { orgId: a.partner.id, kind: "group", text } });
  }
  const as = t(a.asker.language);
  const day = dayCommaTimeLabel(a.asker.language, a.match.date);
  if (tells.asker === "expired-approval") {
    await sendAdminNotice({ orgId: a.asker.id, now, holdOvernight: false, text: as.xask_expired_notice_asker({ partner: a.partner.name, day }) });
  } else if (tells.asker === "nobody") {
    await sendAdminNotice({ orgId: a.asker.id, now, holdOvernight: false, text: as.xask_nobody_notice_asker({ partner: a.partner.name, day }) });
  }
}

/** Plan 3.13: the post's id never came back from the Pi. The asking club's
 *  organisers are told once (a claim key), never left wondering. */
async function reportMissingPostId(
  ask: { id: string; status: string; postedAt: Date | null; postWaMessageId: string | null; postJobId: string | null; askerOrgId: string; matchId: string },
  now: Date,
): Promise<void> {
  if (ask.status !== "posted" || ask.postWaMessageId || !ask.postedAt) return;
  if (now.getTime() - ask.postedAt.getTime() < MISSING_POST_ID_AFTER_MS) return;
  try {
    await db.sentNotification.create({ data: { key: `xask:${ask.id}:no-post-id`, kind: "xask-no-post-id", matchId: ask.matchId } });
  } catch {
    return; // claimed already: told once
  }
  const a = await askAndMatch(ask.id);
  if (!a) return;
  console.warn(`[partner-ask] ${ask.id}: no WhatsApp id for the post after ${MISSING_POST_ID_AFTER_MS / 60000} minutes`);
  await sendAdminNotice({ orgId: a.asker.id, now, holdOvernight: false, text: t(a.asker.language).xask_no_post_id_notice_asker({ partner: a.partner.name }) });
}

/** The asks a club's organisers are waiting to approve, for the HQ
 *  safe-YES rule (`admin-group-understand.ts`). */
export async function partnerAsksAwaitingApproval(partnerOrgId: string, now: Date) {
  const rows = await db.partnerAsk.findMany({
    where: { partnerOrgId, status: "awaiting-approval", postBy: { gt: now } },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true, askerOrgId: true, match: { select: { date: true } } },
  });
  if (rows.length === 0) return [];
  const askers = await db.organisation.findMany({ where: { id: { in: rows.map((r) => r.askerOrgId) } }, select: { id: true, name: true } });
  const nameOf = new Map(askers.map((o) => [o.id, o.name]));
  return rows.map((r) => ({ askId: r.id, askedAt: r.createdAt, askerName: nameOf.get(r.askerOrgId) ?? "", matchDate: r.match.date }));
}

/** An HQ YES the safe-YES rule decided is about this ask. */
export async function answerPartnerAskYes(args: { orgId: string; askId: string; userId: string; lang: string | null; now: Date }): Promise<{ outcome: string; replyText: string }> {
  const s = t(args.lang);
  const a = await askAndMatch(args.askId);
  if (!a || a.ask.partnerOrgId !== args.orgId) return { outcome: "hq-nothing-waiting", replyText: s.hq_nothing_waiting };
  const r = await approvePartnerAsk({ askId: args.askId, userId: args.userId, now: args.now });
  if (r.ok) return { outcome: "xask-approved", replyText: s.xask_hq_approved({ asker: a.asker.name }) };
  return { outcome: `xask-${r.outcome}`, replyText: s.xask_hq_not_posted({ asker: a.asker.name }) };
}

/** A refusal, in the asking club's words, for the button and the notices. */
export function askRefusalText(
  lang: string | null,
  refusal: AskRefusal | "not-found",
  partnerName: string | null,
  cutoffHours: number,
  placesOpenNow = 1,
): string {
  const s = t(lang);
  const partner = partnerName ?? "";
  switch (refusal) {
    case "bad-number":
      return placesOpenNow > 0 ? s.xask_refused_bad_number({ max: placesOpenNow }) : s.xask_refused_no_places;
    case "partner-dormant":
    case "partner-paused":
      return s.xask_refused_paused({ partner });
    case "too-late":
      return s.xask_refused_too_late({ hours: cutoffHours });
    case "daily-cap":
      return s.xask_refused_daily_cap({ partner });
    case "already-open":
      return s.xask_refused_already_open({ partner });
    case "no-places":
      return s.xask_refused_no_places;
    case "asking-off":
      return s.xask_refused_off;
    case "partner-muted":
    case "partner-not-approved":
    case "partner-setting-up":
    case "partner-no-group":
    case "partner-not-postable":
      return s.xask_refused_unreachable({ partner });
    default:
      return s.xask_refused_generic;
  }
}

// ── The automatic ask (slice S5) ────────────────────────────────────────

/**
 * The automatic ask (D4), every due-posts poll of a club on "Automatically
 * at a time": from the club's time on match day until the cut-off, when a
 * place is open and its own waiting list is empty, ask each active partner
 * once for the match (`autoAskDue`), unless that partner's own game at an
 * overlapping time is short itself (plan 3.13). Through `requestPartnerAsk`,
 * so every rule and gate of a button press applies; the asking club's
 * organisers are told what was asked. The partners asked in one pass share
 * a round (`roundId`), as the ones an organiser ticks together do.
 *
 * THE POOL (local player pool L9, 2026-10-24): a club that switched on the
 * automatic pool ask (`poolAutoAsk`, with the pool open for it) has the
 * pool join the same round right after, through the organiser tap's own
 * function (`pool/auto-ask.ts`), so its first offers go an hour after the
 * partners, or at once when none was asked. A club with no partner club
 * gets that too. Every other club makes two reads. Never throws.
 */
export async function sweepAutoPartnerAsks(
  orgId: string,
  now: Date = new Date(),
  opts: { poolEnv?: Record<string, string | undefined> } = {},
): Promise<{ asked: number }> {
  let asked = 0;
  try {
    const settings = await loadPartnerAskSettings(orgId);
    if (!settings) return { asked };
    const pool = await poolAutoAskClub(orgId, opts.poolEnv);
    const poolRule = { poolOpen: pool.poolOpen, poolAutoAsk: pool.poolAutoAsk, partnersWhen: settings.when };
    // Before reading the partners: could the pool join at all (it can with none)?
    if (settings.when !== "auto" && !poolAutoAskApplies({ ...poolRule, hasPartners: false })) return { asked };
    const partnerships = await db.clubPartnership.findMany({
      where: { askerOrgId: orgId, status: "active" },
      orderBy: { createdAt: "asc" },
      select: { id: true, partnerOrgId: true },
    });
    const askPartners = settings.when === "auto" ? partnerships : [];
    const poolJoins = poolAutoAskApplies({ ...poolRule, hasPartners: partnerships.length > 0 });
    if (askPartners.length === 0 && !poolJoins) return { asked };
    const dayStart = londonMidnight(now);
    const matches = (await db.match.findMany({
      where: { activity: { orgId }, isHistorical: false, status: { in: LIVE_MATCH }, date: { gte: now, lt: new Date(dayStart.getTime() + 30 * 3600_000) } },
      orderBy: { date: "asc" },
      select: { ...MATCH_SELECT, activity: { select: { ...MATCH_SELECT.activity.select, matchDurationMins: true } } },
    })) as Array<AskMatch & { activity: { matchDurationMins: number } }>;
    for (const match of matches) {
      // Match day only: the club's time is a time ON the day of the game.
      if (londonMidnight(match.date).getTime() !== dayStart.getTime()) continue;
      if (!(await isNextMatch(orgId, match, now))) continue;
      const { postBy } = askWindows(match.date, settings.cutoffHours);
      const askAt = autoAskAt(match.date, effectiveAskTime(settings.time));
      const [places, waiting] = await Promise.all([
        placesOpen(match.id, match.maxPlayers),
        db.attendance.count({ where: { matchId: match.id, status: "BENCH" } }),
      ]);
      const roundId = randomUUID();
      let askedHere = 0;
      for (const p of askPartners) {
        const askedBefore = (await db.partnerAsk.count({ where: { matchId: match.id, partnerOrgId: p.partnerOrgId } })) > 0;
        const due = autoAskDue({
          now,
          askAt,
          postBy,
          placesOpen: places,
          waitingCount: waiting,
          askedBefore,
          partnerOwnGameShort: await partnerOwnOverlappingGameShort(p.partnerOrgId, match.date, match.activity.matchDurationMins),
        });
        if (!due) continue;
        const r = await requestPartnerAsk({ askerOrgId: orgId, matchId: match.id, partnershipId: p.id, requestedByUserId: null, via: "auto", roundId, now });
        if (!r.ok) {
          console.log(`[partner-ask] auto ask for match ${match.id} to ${p.partnerOrgId} not made: ${r.refusal}`);
          continue;
        }
        asked++;
        askedHere++;
        const asker = await db.organisation.findUnique({ where: { id: orgId }, select: { language: true } });
        const lang = asker?.language ?? null;
        await sendAdminNotice({
          orgId,
          now,
          holdOvernight: false,
          text: t(lang).xask_auto_notice_asker({ partner: r.partnerName, day: dayCommaTimeLabel(lang, match.date), posted: r.status === "posted" }),
        });
      }
      if (poolJoins) {
        await autoAskPool({
          orgId,
          match: { id: match.id, date: match.date },
          now,
          askAt,
          postBy,
          placesOpen: places,
          waitingCount: waiting,
          hasPartners: partnerships.length > 0,
          partnersWhen: settings.when,
          askedNowRoundId: askedHere > 0 ? roundId : null,
          club: pool,
          env: opts.poolEnv,
        });
      }
    }
  } catch (err) {
    console.error(`[partner-ask] org ${orgId}: auto sweep failed:`, err instanceof Error ? err.message : "failed");
  }
  return { asked };
}

/** The partner's own live game overlapping this one, when it is short. */
async function partnerOwnOverlappingGameShort(partnerOrgId: string, kickoff: Date, durationMins: number): Promise<boolean> {
  const dayStart = londonMidnight(kickoff);
  const own = await db.match.findMany({
    where: { activity: { orgId: partnerOrgId }, status: { in: LIVE_MATCH }, isHistorical: false, date: { gte: dayStart, lt: new Date(dayStart.getTime() + 30 * 3600_000) } },
    select: { id: true, date: true, maxPlayers: true, activity: { select: { matchDurationMins: true } } },
  });
  for (const g of own) {
    if (!gamesOverlap({ kickoff, durationMins }, { kickoff: g.date, durationMins: g.activity.matchDurationMins })) continue;
    const confirmed = await db.attendance.count({ where: { matchId: g.id, status: "CONFIRMED" } });
    if (confirmed < g.maxPlayers) return true;
  }
  return false;
}

/**
 * The line the organisers' short-squad notice ends with (slice S5): the
 * partner clubs they could ask now, or null (no partner, asking Off, past
 * the cut-off, or an ask already open to each). Null leaves the notice
 * exactly as it was.
 */
export async function partnerOfferFor(orgId: string, match: { id: string; date: Date }, now: Date): Promise<string[] | null> {
  const settings = await loadPartnerAskSettings(orgId);
  if (!settings || settings.when === "off") return null;
  if (now.getTime() >= askWindows(match.date, settings.cutoffHours).postBy.getTime()) return null;
  const partnerships = await db.clubPartnership.findMany({
    where: { askerOrgId: orgId, status: "active" },
    orderBy: { createdAt: "asc" },
    select: { partnerOrgId: true, partnerOrg: { select: { name: true } } },
  });
  if (partnerships.length === 0) return null;
  const open = await db.partnerAsk.findMany({ where: { matchId: match.id, status: { in: [...OPEN_ASK_STATUSES] } }, select: { partnerOrgId: true } });
  const busy = new Set(open.map((a) => a.partnerOrgId));
  const names = partnerships.filter((p) => !busy.has(p.partnerOrgId)).map((p) => p.partnerOrg.name);
  return names.length > 0 ? names : null;
}
