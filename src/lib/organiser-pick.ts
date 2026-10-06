/**
 * ORGANISER PICK, THE DATABASE HALF (slice 2b, 2026-10-01).
 * Plan: MDs/friday-group-features-plan-2026-09-30.md, sections 2.7 to 2.13.
 *
 * A club with `benchPickMode = "organiser"`: MatchTime never fills an open
 * place by itself. This module
 *
 *   sweepOrganiserPicks   (every due-posts poll, before the posts are
 *                         computed) opens a pick round when a place is free
 *                         and somebody is waiting, supersedes a stale one,
 *                         closes rounds that are filled or past kickoff,
 *                         and runs the fallback (D5) when nobody picked;
 *   handlePickReply       reads an admin's reply (the admin group or a DM)
 *                         and acts on it: first valid reply wins;
 *   applyOrganiserPick    the ONE writer for a pick, from the admin group,
 *                         a DM or the match page: under the per-match slot
 *                         lock, BENCH to CONFIRMED, the audit event, the
 *                         vacated team slot, the round;
 *   announcePick          who is told what (A1 to A3), after the commit.
 *
 * NO MODEL, EVER. Every word is composed by code from database facts, and
 * the admin-group route that reaches this module is pinned model-free by
 * `admin-group-no-model.source.test.ts`, which follows every import. That
 * is why nothing here imports `attendance.ts` or `bot-scheduler.ts`.
 *
 * Messages to the admin channel go through `sendAdminNotice` (the one door,
 * slice 2a); posts to the community group and DMs to a player are BotJobs,
 * so a muted club sends nothing until unmuted, like every other post.
 */
import { db } from "./db";
import { recordAttendanceEvent } from "./attendance-events";
import { fillVacatedSlots, lockTeamSlots } from "./team-slot-fill";
import { resolveTeamLabels } from "./team-labels";
import { announceSquadFullIfJustFilled } from "./squad-announce";
import { loadAdminChannel, sendAdminNotice } from "./admin-channel";
import { resolveAdminNoticeTargets } from "./admin-channel-rules";
import { resolveSenderUserIds } from "./admin-group-link";
import { isClubOperational } from "./club-approval-state";
import { billingQuietWhere, isBillingPaused } from "./club-billing-rules";
import { getOrgFeatures } from "./org-features";
import { isNextUpcomingForPosting } from "./next-upcoming-match";
import { weeklyDeadlinesFor } from "./weekly-deadlines";
import { summariseClubDisplayRatings } from "./player-rating";
import { normaliseBenchPickFallback } from "./squad-capacity";
import { dayTimeLabel, weekdayTimeLabel } from "./i18n/dates";
import { t } from "./i18n/t";
import { normalisePhone } from "./phone";
import {
  PICK_CONFIRM_TTL_MS,
  PICK_LATE_REPLY_MS,
  PICK_RACE_WINDOW_MS,
  buildPickListChanged,
  buildPickMessage,
  decidePickRound,
  foldPickText,
  parsePickReply,
  pickFallbackAt,
  positionLabel,
  type PickCandidate,
  type PickListRow,
  type PickReason,
  fallbackOfferCount,
} from "./organiser-pick-rules";

const LIVE = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] as const;
const CLUB_RATING_WINDOW = 60;
const bare = (phone: string) => phone.replace(/^\+/, "");

/** The idempotency key that stops two polls opening the same round twice. */
export function pickOpenClaimKey(matchId: string, previousRoundId: string | null): string {
  return `pick-open:${matchId}:${previousRoundId ?? "first"}`;
}

/** The slice 3 summary's key; the first round after the deadline claims it. */
const deadlineSummaryKey = (matchId: string) => `${matchId}:deadline-summary`;

// ── Loading ──────────────────────────────────────────────────────────────

interface PickOrg {
  id: string;
  name: string;
  language: string;
  benchPickMode: string;
  benchPickFallback: string;
  approvalStatus: string | null;
  dormantAt: Date | null;
  billingStatus: string;
  dropOutDeadlineDay: number | null;
  dropOutDeadlineTime: string | null;
}

async function loadPickOrg(orgId: string): Promise<PickOrg | null> {
  return db.organisation.findUnique({
    where: { id: orgId },
    select: {
      id: true,
      name: true,
      language: true,
      benchPickMode: true,
      benchPickFallback: true,
      approvalStatus: true,
      dormantAt: true,
      billingStatus: true,
      dropOutDeadlineDay: true,
      dropOutDeadlineTime: true,
    },
  });
}

/** Rows for the numbered list: position for the match's activity, and the
 *  club rating players see (never the seed), in one read each. */
export async function loadPickListRows(
  orgId: string,
  activityId: string,
  users: PickCandidate[],
): Promise<PickListRow[]> {
  if (users.length === 0) return [];
  const ids = users.map((u) => u.userId);
  const [positions, ratings] = await Promise.all([
    db.playerActivityPosition.findMany({
      where: { activityId, userId: { in: ids } },
      select: { userId: true, positions: true },
    }),
    db.rating.findMany({
      where: { playerId: { in: ids }, match: { activity: { orgId } } },
      orderBy: { createdAt: "desc" },
      select: { playerId: true, matchId: true, score: true },
    }),
  ]);
  const posOf = new Map(positions.map((p) => [p.userId, positionLabel(p.positions)]));
  const summary = summariseClubDisplayRatings(ids, ratings, CLUB_RATING_WINDOW);
  return users.map((u) => ({ name: u.name, position: posOf.get(u.userId) ?? null, rating: summary[u.userId]?.rating ?? null }));
}

interface MatchWorld {
  id: string;
  date: Date;
  maxPlayers: number;
  activityId: string;
  activityName: string;
  venue: string;
  confirmed: PickCandidate[];
  waiting: PickCandidate[];
  dropped: string[];
}

/** The squad as it stands: confirmed and the waiting list (BENCH rows of
 *  members who have not left), both in position order. */
async function loadMatchWorld(matchId: string): Promise<MatchWorld | null> {
  const m = await db.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      date: true,
      maxPlayers: true,
      activityId: true,
      activity: { select: { name: true, venue: true, orgId: true } },
      attendances: {
        orderBy: { position: "asc" },
        select: { userId: true, status: true, user: { select: { name: true } } },
      },
    },
  });
  if (!m) return null;
  const left = new Set(
    (
      await db.membership.findMany({
        where: { orgId: m.activity.orgId, userId: { in: m.attendances.map((a) => a.userId) }, leftAt: { not: null } },
        select: { userId: true },
      })
    ).map((x) => x.userId),
  );
  const named = (a: (typeof m.attendances)[number]): PickCandidate => ({ userId: a.userId, name: a.user.name ?? "?" });
  return {
    id: m.id,
    date: m.date,
    maxPlayers: m.maxPlayers,
    activityId: m.activityId,
    activityName: m.activity.name,
    venue: m.activity.venue,
    confirmed: m.attendances.filter((a) => a.status === "CONFIRMED").map(named),
    waiting: m.attendances.filter((a) => a.status === "BENCH" && !left.has(a.userId)).map(named),
    dropped: m.attendances.filter((a) => a.status === "DROPPED").map((a) => a.userId),
  };
}

/** CONFIRMED to DROPPED moves on the match since `since`, oldest first,
 *  with whether each was after the drop-out deadline. */
async function dropsSince(matchId: string, since: Date): Promise<Array<{ userId: string; late: boolean }>> {
  const events = await db.attendanceEvent.findMany({
    where: { matchId, fromStatus: "CONFIRMED", toStatus: "DROPPED", at: { gt: since } },
    orderBy: { at: "asc" },
    select: { userId: true, note: true },
  });
  return events.map((e) => ({ userId: e.userId, late: /after the drop-out deadline/.test(e.note ?? "") }));
}

// ── The sweep ────────────────────────────────────────────────────────────

export interface SweepResult {
  opened: number;
  superseded: number;
  closed: number;
  fallbacks: number;
}

/**
 * Run on each due-posts poll of an organiser-pick club, before the posts
 * are computed. A side effect, so the route never calls it in preview mode.
 * A first-come club (Sutton FC) returns at once.
 */
export async function sweepOrganiserPicks(orgId: string, now: Date = new Date()): Promise<SweepResult> {
  const out: SweepResult = { opened: 0, superseded: 0, closed: 0, fallbacks: 0 };
  const org = await loadPickOrg(orgId);
  if (!org || org.benchPickMode !== "organiser") return out;
  if (!isClubOperational(org)) return out;
  if (!(await getOrgFeatures(orgId)).attendance) return out;

  const matches = await db.match.findMany({
    where: { activity: { orgId }, isHistorical: false, status: { in: [...LIVE] } },
    select: { id: true, date: true, status: true, activityId: true, isHistorical: true, activity: { select: { orgId: true, venue: true, dayOfWeek: true } } },
    orderBy: { date: "asc" },
  });

  for (const m of matches) {
    try {
      await sweepOneMatch(org, m, matches, now, out);
    } catch (err) {
      console.error(`[organiser-pick] org ${orgId} match ${m.id}: sweep failed:`, err);
    }
  }
  return out;
}

type SweepMatch = Parameters<typeof isNextUpcomingForPosting>[1];

async function sweepOneMatch(
  org: PickOrg,
  m: SweepMatch,
  all: SweepMatch[],
  now: Date,
  out: SweepResult,
): Promise<void> {
  const rounds = await db.organiserPickRound.findMany({ where: { matchId: m.id }, orderBy: { createdAt: "desc" } });
  const open = rounds.find((r) => r.resolvedAt === null) ?? null;
  const lastClosed = rounds.find((r) => r.resolvedAt !== null) ?? null;

  if (now.getTime() >= m.date.getTime()) {
    if (open) {
      await closeRound(open.id, "closed-at-kickoff", now);
      out.closed++;
    }
    return;
  }

  const world = await loadMatchWorld(m.id);
  if (!world) return;
  const openPlaces = Math.max(0, world.maxPlayers - world.confirmed.length);

  if (open && openPlaces === 0) {
    await closeRound(open.id, "filled", now);
    out.closed++;
    return;
  }
  if (open && now.getTime() >= open.fallbackAt.getTime()) {
    await runFallback(org, open, world, openPlaces, now);
    out.fallbacks++;
    return;
  }

  if (!isNextUpcomingForPosting(all, m)) return;

  const reference = open ?? lastClosed;
  const drops = await dropsSince(m.id, reference?.createdAt ?? new Date(0));
  const openOffers = await db.benchSlotOffer.count({ where: { matchId: m.id, resolvedAt: null } });
  const { dropOut } = weeklyDeadlinesFor(m.date, org);
  const decision = decidePickRound({
    now,
    kickoff: m.date,
    openPlaces,
    waitingUserIds: world.waiting.map((w) => w.userId),
    dropOutDeadline: dropOut,
    openOffers,
    openRound: open,
    lastClosedRound: lastClosed,
    dropsSince: drops.length,
  });
  if (decision.action === "wait") return;

  // Claim the opening, so two polls at the same instant open one round.
  const previousId = rounds[0]?.id ?? null;
  try {
    await db.sentNotification.create({ data: { key: pickOpenClaimKey(m.id, previousId), kind: "admin-notice", matchId: m.id } });
  } catch {
    return; // another poll opened it
  }

  // The drops this round is about: the superseded round's, plus any since,
  // still out.
  const stillOut = new Set(world.dropped);
  const vacated = [...new Set([...(open?.vacatedByUserIds ?? []), ...drops.map((d) => d.userId)])].filter((id) => stillOut.has(id));
  const late = new Set([...(open?.lateDropUserIds ?? []), ...drops.filter((d) => d.late).map((d) => d.userId)]);
  const lateIds = vacated.filter((id) => late.has(id));

  // The first round after the club's drop-out deadline IS the deadline
  // summary (slice 3, plan 3.2): it claims the summary's key so D2 does
  // not also go out.
  let reason: PickReason = vacated.length > 0 ? "drop" : "open-place";
  if (dropOut && now.getTime() >= dropOut.getTime()) {
    try {
      await db.sentNotification.create({ data: { key: deadlineSummaryKey(m.id), kind: "admin-notice", matchId: m.id } });
      reason = "deadline-summary";
    } catch {
      /* the summary already went out (or an earlier round claimed it) */
    }
  }

  // Where the message goes, fixed now (plan 2.7): the admin group when the
  // club routes there and has one linked, otherwise DMs. For the group,
  // the one person a notice falls back to by DM (an old Pi) may answer by
  // DM too.
  const channel = await loadAdminChannel(org.id);
  if (!channel) return;
  const isGroup = channel.cfg.mode === "admin-group" && !!channel.cfg.adminGroupId;
  const dmTarget = resolveAdminNoticeTargets(channel.cfg, channel.admins, { adminGroup: false });
  const dmUsers = dmTarget.kind === "dm" ? dmTarget.users : [];
  const recipientUserIds = isGroup
    ? dmUsers.slice(0, 1).map((u) => u.id)
    : dmUsers.map((u) => u.id);
  if (!isGroup && recipientUserIds.length === 0) {
    console.warn(`[organiser-pick] org ${org.id}: no admin to ask; the fallback will run at its time`);
  }

  const fallbackAt = pickFallbackAt(now, m.date, open?.fallbackAt ?? null);
  if (open) {
    await closeRound(open.id, "superseded", now);
    out.superseded++;
  }
  const round = await db.organiserPickRound.create({
    data: {
      matchId: m.id,
      orgId: org.id,
      channel: isGroup ? "admin-group" : "dm",
      recipientUserIds,
      listUserIds: world.waiting.map((w) => w.userId),
      vacatedByUserIds: vacated,
      lateDropUserIds: lateIds,
      openPlaces,
      reason,
      fallbackAt,
    },
  });
  out.opened++;

  const names = await namesOf(vacated);
  const rows = await loadPickListRows(org.id, world.activityId, world.waiting);
  const fallback = normaliseBenchPickFallback(org.benchPickFallback);
  const message = (audience: "dm" | "group") =>
    buildPickMessage({
      lang: org.language,
      reason,
      droppedNames: vacated.map((id) => names.get(id) ?? "?"),
      late: vacated.length > 0 && lateIds.length === vacated.length,
      activityName: world.activityName,
      whenLabel: dayTimeLabel(org.language, m.date),
      open: openPlaces,
      confirmed: world.confirmed.length,
      maxPlayers: world.maxPlayers,
      rows,
      audience,
      fallback,
      fallbackWhen: weekdayTimeLabel(org.language, fallbackAt),
    });
  await sendAdminNotice({ orgId: org.id, now, text: (_link, audience) => message(audience) });
}

async function closeRound(roundId: string, outcome: string, now: Date): Promise<boolean> {
  const res = await db.organiserPickRound.updateMany({
    where: { id: roundId, resolvedAt: null },
    data: { resolvedAt: now, outcome },
  });
  return res.count > 0;
}

async function namesOf(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const users = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name ?? "?"]));
}

/**
 * D5, nobody picked in time. "bench-offer" (the default): one
 * BenchSlotOffer per free place SOMEBODY IS WAITING FOR
 * (`fallbackOfferCount`), and from there the existing first-come
 * machinery runs unchanged (ONE group post tagging the waiting list and
 * ONE DM to each, however many places; first IN wins; `canTakeFreePlace`
 * allows it because an offer is open). "leave-empty", or nobody left on
 * the list: the place stays open.
 */
async function runFallback(
  org: PickOrg,
  round: { id: string; vacatedByUserIds: string[]; pickedUserIds: string[] },
  world: MatchWorld,
  openPlaces: number,
  now: Date,
): Promise<void> {
  const offer = normaliseBenchPickFallback(org.benchPickFallback) === "bench-offer" && world.waiting.length > 0 && openPlaces > 0;
  const outcome = offer ? "fallback-bench-offer" : "fallback-left-open";
  if (!(await closeRound(round.id, outcome, now))) return;
  const s = t(org.language);
  if (offer) {
    const stillOut = new Set(world.dropped);
    const vacated = round.vacatedByUserIds.filter((id) => stillOut.has(id)).slice(round.pickedUserIds.length);
    const offers = fallbackOfferCount(openPlaces, world.waiting.length);
    for (let i = 0; i < offers; i++) {
      await db.benchSlotOffer.create({ data: { matchId: world.id, replacingUserId: vacated[i] ?? null } });
    }
    const said = offers > 1 ? s.pick_fallback_offered_many : s.pick_fallback_offered;
    await sendAdminNotice({ orgId: org.id, now, text: said({ activityName: world.activityName }) });
  } else {
    await sendAdminNotice({
      orgId: org.id,
      now,
      text: s.pick_fallback_left({ activityName: world.activityName, confirmed: world.confirmed.length, maxPlayers: world.maxPlayers }),
    });
  }
}

// ── Applying a pick ──────────────────────────────────────────────────────

export interface AppliedPick {
  userId: string;
  name: string;
  /** Whose place they took: the holder of the team slot actually inherited
   *  when teams exist, else the round's next unfilled drop, else null. */
  replacedName: string | null;
  team: "RED" | "YELLOW" | null;
}

export interface ApplyPickResult {
  applied: AppliedPick[];
  alreadyIn: string[];
  notOnWaitingList: string[];
  noPlaceFor: string[];
  confirmedAfter: number;
  maxPlayers: number;
  /** The round is now filled and closed. */
  filled: boolean;
}

/**
 * THE ONE WRITER FOR A PICK (plan 2.9): the admin group, a DM and the
 * match page all come here. One transaction under the per-match slot
 * lock: re-read the squad, and for each picked player in reply order,
 * who must still be on the waiting list (or be brought in after YES),
 * while a place is free: BENCH to CONFIRMED with its audit event (cause
 * `organiser-pick`); then seat them in the team slot actually vacant
 * (`fillVacatedSlots`, the 29 September rule); then the round.
 *
 * Two admins racing for one place: the lock serialises them, and the
 * second finds no place (`noPlaceFor`).
 */
export async function applyOrganiserPick(args: {
  matchId: string;
  userIds: string[];
  pickerUserId: string;
  roundId: string | null;
  /** E1 answered YES: this player may come in without being on the list. */
  allowNotOnList?: boolean;
  now?: Date;
}): Promise<ApplyPickResult> {
  const now = args.now ?? new Date();
  const match = await db.match.findUnique({
    where: { id: args.matchId },
    select: { id: true, maxPlayers: true, activity: { select: { orgId: true } } },
  });
  if (!match) throw new Error("Match not found");
  const orgId = match.activity.orgId;
  const sourceRef = args.roundId ?? "admin:web";

  const res = await db.$transaction(async (tx) => {
    await lockTeamSlots(tx, args.matchId);
    const rows = await tx.attendance.findMany({
      where: { matchId: args.matchId },
      select: { userId: true, status: true, position: true },
    });
    const byUser = new Map(rows.map((r) => [r.userId, r]));
    let confirmed = rows.filter((r) => r.status === "CONFIRMED").length;
    let nextPosition = rows.reduce((mx, r) => Math.max(mx, r.position), 0) + 1;
    const applied: string[] = [];
    const alreadyIn: string[] = [];
    const notOnWaitingList: string[] = [];
    const noPlaceFor: string[] = [];
    for (const userId of [...new Set(args.userIds)]) {
      const row = byUser.get(userId);
      if (row?.status === "CONFIRMED") {
        alreadyIn.push(userId);
        continue;
      }
      if (row?.status !== "BENCH" && !args.allowNotOnList) {
        notOnWaitingList.push(userId);
        continue;
      }
      if (confirmed >= match.maxPlayers) {
        noPlaceFor.push(userId);
        continue;
      }
      const position = row && row.status === "BENCH" ? row.position : nextPosition++;
      await tx.attendance.upsert({
        where: { matchId_userId: { matchId: args.matchId, userId } },
        create: { matchId: args.matchId, userId, status: "CONFIRMED", position },
        update: { status: "CONFIRMED", position, respondedAt: now },
      });
      await recordAttendanceEvent(
        tx,
        {
          matchId: args.matchId,
          userId,
          orgId,
          fromStatus: row?.status ?? null,
          toStatus: "CONFIRMED",
          fromPosition: row?.position ?? null,
          toPosition: position,
        },
        {
          cause: "organiser-pick",
          actorKind: "admin",
          actorUserId: args.pickerUserId,
          sourceRef,
          note: row?.status === "BENCH" ? "picked from the waiting list" : "brought in by an admin (not on the waiting list)",
        },
      );
      confirmed++;
      applied.push(userId);
    }
    const moves = applied.length > 0 ? await fillVacatedSlots(tx, args.matchId) : [];

    // A full squad closes any fallback offer still open: there is no place
    // left to claim.
    if (applied.length > 0 && confirmed >= match.maxPlayers) {
      await tx.benchSlotOffer.updateMany({
        where: { matchId: args.matchId, resolvedAt: null },
        data: { resolvedAt: now, outcome: "claimed" },
      });
    }

    let round: { vacatedByUserIds: string[]; pickedUserIds: string[] } | null = null;
    if (args.roundId) {
      const r = await tx.organiserPickRound.findUnique({
        where: { id: args.roundId },
        select: { vacatedByUserIds: true, pickedUserIds: true },
      });
      round = r;
      if (r && applied.length > 0) {
        await tx.organiserPickRound.update({
          where: { id: args.roundId },
          data: {
            pickedUserIds: [...r.pickedUserIds, ...applied],
            lastPickedByUserId: args.pickerUserId,
            pendingConfirmUserId: null,
            pendingConfirmAskedByUserId: null,
            pendingConfirmAskedAt: null,
            ...(confirmed >= match.maxPlayers ? { resolvedAt: now, outcome: "filled" } : {}),
          },
        });
      }
    } else if (applied.length > 0 && confirmed >= match.maxPlayers) {
      // A pick from the match page fills the squad: the open round is done.
      await tx.organiserPickRound.updateMany({
        where: { matchId: args.matchId, resolvedAt: null },
        data: { resolvedAt: now, outcome: "filled", lastPickedByUserId: args.pickerUserId },
      });
    }
    return { applied, alreadyIn, notOnWaitingList, noPlaceFor, moves, confirmed, round, rows };
  });

  // WHOSE PLACE. With a sheet, only the slot actually inherited (never the
  // round's drop list: that is the 29 September lie). Without one, the
  // round's drops in order, skipping those already replaced.
  const sheetExists = (await db.teamAssignment.count({ where: { matchId: args.matchId } })) > 0;
  const stillOut = new Set(res.rows.filter((r) => r.status === "DROPPED").map((r) => r.userId));
  const openDrops = (res.round?.vacatedByUserIds ?? []).filter((id) => stillOut.has(id)).slice(res.round?.pickedUserIds.length ?? 0);
  const names = await namesOf([...res.applied, ...res.moves.map((mv) => mv.fromUserId), ...openDrops]);
  const applied: AppliedPick[] = res.applied.map((userId, i) => {
    const move = res.moves.find((mv) => mv.toUserId === userId) ?? null;
    const replacedId = move ? move.fromUserId : sheetExists ? null : (openDrops[i] ?? null);
    return {
      userId,
      name: names.get(userId) ?? "?",
      replacedName: replacedId ? (names.get(replacedId) ?? null) : null,
      team: move ? (move.team as "RED" | "YELLOW") : null,
    };
  });

  if (res.applied.length > 0) {
    await announceSquadFullIfJustFilled(args.matchId).catch((err) =>
      console.error("[organiser-pick] squad-full announce failed:", err),
    );
  }
  return {
    applied,
    alreadyIn: res.alreadyIn,
    notOnWaitingList: res.notOnWaitingList,
    noPlaceFor: res.noPlaceFor,
    confirmedAfter: res.confirmed,
    maxPlayers: match.maxPlayers,
    filled: res.confirmed >= match.maxPlayers,
  };
}

/**
 * After a pick: A2 in the community group (one post per player) and A3 to
 * each picked player by DM (a match-invite DM, so it honours
 * `subMatchInviteDm`; an unsubscribed player has A2 as their notice). The
 * rest of the waiting list is told nothing and keeps its order.
 */
export async function announcePickToGroupAndPlayers(matchId: string, result: ApplyPickResult): Promise<void> {
  if (result.applied.length === 0) return;
  const m = await db.match.findUnique({
    where: { id: matchId },
    include: { activity: { include: { sport: true, org: { select: { id: true, teamLabels: true, language: true } } } } },
  });
  if (!m) return;
  const org = m.activity.org;
  const s = t(org.language);
  const labels = resolveTeamLabels(m, org, m.activity.sport, org.language);
  const confirmedNow = await db.attendance.count({ where: { matchId, status: "CONFIRMED" } });
  const users = await db.user.findMany({
    where: { id: { in: result.applied.map((a) => a.userId) } },
    select: { id: true, phoneNumber: true, memberships: { where: { orgId: org.id }, select: { subMatchInviteDm: true } } },
  });
  for (const a of result.applied) {
    await db.botJob.create({
      data: {
        orgId: org.id,
        kind: "group",
        text: s.pick_group_post({
          name: a.name,
          replacedName: a.replacedName,
          team: a.team ? (a.team === "RED" ? labels[0] : labels[1]) : null,
          confirmed: confirmedNow,
          maxPlayers: m.maxPlayers,
        }),
      },
    });
    const u = users.find((x) => x.id === a.userId);
    const subscribed = u?.memberships[0]?.subMatchInviteDm !== false;
    if (u?.phoneNumber && subscribed) {
      await db.botJob.create({
        data: {
          orgId: org.id,
          kind: "dm",
          phone: bare(u.phoneNumber),
          text: s.pick_player_dm({ dayTime: weekdayTimeLabel(org.language, m.date), venue: m.activity.venue }),
        },
      });
    }
  }
}

// ── Reading a reply ──────────────────────────────────────────────────────

export interface PickReplyInput {
  orgId: string;
  door: "dm" | "admin-group";
  senderUserId: string;
  text: string;
  /** The real @tags in the text, as the Pi forwarded them. */
  mentionNames?: Array<{ jid: string; name?: string; phone?: string }>;
  /** When the admin sent it (WhatsApp time). Absent: now. */
  sentAt?: Date | null;
  now?: Date;
}

export interface PickReplyOutcome {
  /** Did this reply belong to a pick at all? False: not ours, fall through. */
  handled: boolean;
  /** The answer to the sender, in the same place. */
  replyText: string | null;
  /** DM rounds only: A1 to the round's other recipients. */
  alsoTell?: Array<{ userId: string; text: string }>;
  outcome?: string;
}

const NOT_OURS: PickReplyOutcome = { handled: false, replyText: null };

/** The club members a name or a tag can mean, active only. */
async function loadClubMembers(orgId: string): Promise<Array<PickCandidate & { phone: string | null }>> {
  const rows = await db.membership.findMany({
    where: { orgId, leftAt: null },
    select: { user: { select: { id: true, name: true, phoneNumber: true } } },
  });
  return rows.filter((r) => !!r.user.name).map((r) => ({ userId: r.user.id, name: r.user.name as string, phone: r.user.phoneNumber }));
}

/**
 * The real @tags in an admin's reply, resolved against the CLUB's roster
 * (not the admin group's members): the phone behind the mention (a phone
 * JID, or the phone the Pi was told for a LID), then a LID the server
 * stored itself, then the display name as a lookup key against the club
 * (never as text). The same order of trust as `pipeline/mention-names.ts`,
 * which this path may not import (it has no model, and pins that).
 */
async function resolvePickTags(
  text: string,
  mentionNames: PickReplyInput["mentionNames"],
  members: Array<PickCandidate & { phone: string | null }>,
): Promise<Array<{ digits: string; userId: string | null }>> {
  const tokens = [...new Set([...(text ?? "").matchAll(/@(\d{5,})\b/g)].map((m) => m[1]))];
  const memberIds = new Set(members.map((m) => m.userId));
  const out: Array<{ digits: string; userId: string | null }> = [];
  for (const digits of tokens) {
    const mn = (mentionNames ?? []).find((x) => typeof x?.jid === "string" && x.jid.replace(/@.*$/, "").replace(/\D/g, "") === digits);
    const isPhoneJid = !!mn && /@(c\.us|s\.whatsapp\.net)$/i.test(mn.jid);
    const isLid = !!mn && /@lid$/i.test(mn.jid);
    const phones = [isPhoneJid ? digits : null, mn?.phone ?? null];
    let hits = (await resolveSenderUserIds({ phones, lid: isLid ? digits : null })).filter((id) => memberIds.has(id));
    if (hits.length !== 1 && mn?.name) {
      const key = foldPickText(mn.name);
      const full = members.filter((m) => foldPickText(m.name) === key);
      hits = full.length === 1 ? [full[0].userId] : members.filter((m) => foldPickText(m.name).split(" ")[0] === key).map((m) => m.userId);
    }
    out.push({ digits, userId: hits.length === 1 ? hits[0] : null });
  }
  return out;
}

/** The round a reply answers: the most recent open round of the club (for a
 *  DM, one the sender was asked on), else one just filled (the race). */
async function findReplyRound(orgId: string, door: "dm" | "admin-group", senderUserId: string, now: Date) {
  const channel = door === "admin-group" ? "admin-group" : undefined;
  const mine = (r: { channel: string; recipientUserIds: string[] }) =>
    door === "admin-group" ? r.channel === "admin-group" : r.recipientUserIds.includes(senderUserId);
  const open = (await db.organiserPickRound.findMany({
    where: { orgId, resolvedAt: null, ...(channel ? { channel } : {}) },
    orderBy: { createdAt: "desc" },
  })).filter(mine);
  if (open.length > 0) return { round: open[0], open: true as const };
  const recent = (await db.organiserPickRound.findMany({
    where: {
      orgId,
      outcome: "filled",
      resolvedAt: { gte: new Date(now.getTime() - PICK_RACE_WINDOW_MS) },
      ...(channel ? { channel } : {}),
    },
    orderBy: { resolvedAt: "desc" },
  })).filter(mine);
  return recent.length > 0 ? { round: recent[0], open: false as const } : null;
}

/**
 * An admin's reply to a pick message, from either door. Returns what to
 * say back, in the same place; `handled: false` means "not a pick reply":
 * the admin group then ignores the message and a DM falls through to its
 * other handlers. The first valid reply wins; a race gets E3.
 */
export async function handlePickReply(input: PickReplyInput): Promise<PickReplyOutcome> {
  const now = input.now ?? new Date();
  const org = await loadPickOrg(input.orgId);
  if (!org || org.benchPickMode !== "organiser") return NOT_OURS;
  // Club fee billing (B1): a club paused for the club fee answers no pick
  // reply and applies none. Never while BILLING_ENABLED is off.
  if (isBillingPaused(org)) return NOT_OURS;
  const found = await findReplyRound(org.id, input.door, input.senderUserId, now);
  if (!found) return NOT_OURS;
  const { round } = found;
  const s = t(org.language);
  const audience = input.door === "admin-group" ? "group" : "dm";

  const world = await loadMatchWorld(round.matchId);
  if (!world) return NOT_OURS;
  const members = await loadClubMembers(org.id);
  const listNames = await namesOf(round.listUserIds);
  const list: PickCandidate[] = round.listUserIds.map((id) => ({ userId: id, name: listNames.get(id) ?? "?" }));
  const listed = new Set(round.listUserIds);
  const confirmedIds = new Set(world.confirmed.map((c) => c.userId));
  const pendingFresh =
    !!round.pendingConfirmUserId &&
    !!round.pendingConfirmAskedAt &&
    now.getTime() - round.pendingConfirmAskedAt.getTime() <= PICK_CONFIRM_TTL_MS;
  const tags = await resolvePickTags(input.text, input.mentionNames, members);
  const reply = parsePickReply(
    input.text,
    {
      list,
      confirmed: world.confirmed,
      members: members.filter((mm) => !listed.has(mm.userId) && !confirmedIds.has(mm.userId)),
      pendingConfirm: found.open && pendingFresh,
      tags,
    },
    audience,
  );
  if (reply.kind === "not-a-pick") return NOT_OURS;
  if (reply.kind === "not-understood") {
    // The admin group never gets P6 (the parser says not-a-pick there).
    return { handled: true, replyText: s.pick_not_understood, outcome: "not-understood" };
  }

  const currentRows = () => loadPickListRows(org.id, world.activityId, world.waiting);

  // A race lost: the round was filled a moment ago.
  if (!found.open) {
    return { handled: true, replyText: await alreadyFilledText(org.language, round, world), outcome: "already-filled" };
  }

  // Late: sent more than 30 minutes before it reached us. Nothing applied.
  const sentAt = input.sentAt ?? now;
  if (now.getTime() - sentAt.getTime() > PICK_LATE_REPLY_MS) {
    return { handled: true, replyText: buildPickListChanged({ lang: org.language, rows: await currentRows(), audience }), outcome: "late" };
  }

  if (reply.kind === "unresolved-tag") return { handled: true, replyText: s.pick_unresolved_tag, outcome: "unresolved-tag" };
  if (reply.kind === "ambiguous") {
    return { handled: true, replyText: s.pick_ambiguous({ first: reply.first, names: reply.names }), outcome: "ambiguous" };
  }
  if (reply.kind === "none") {
    await closeRound(round.id, "none-by-admin", now);
    return { handled: true, replyText: s.pick_none_ack, outcome: "none" };
  }

  let userIds: string[];
  let allowNotOnList = false;
  if (reply.kind === "numbers") {
    // Numbers typed before this list went out answer an older list.
    if (sentAt.getTime() < round.createdAt.getTime()) {
      return {
        handled: true,
        replyText: buildPickListChanged({ lang: org.language, rows: await currentRows(), audience }),
        outcome: "stale-numbers",
      };
    }
    userIds = reply.numbers.map((n) => round.listUserIds[n - 1]).filter(Boolean);
  } else if (reply.kind === "all") {
    const waitingNow = new Set(world.waiting.map((w) => w.userId));
    userIds = round.listUserIds.filter((id) => waitingNow.has(id));
  } else if (reply.kind === "yes") {
    userIds = [round.pendingConfirmUserId!];
    allowNotOnList = true;
  } else {
    userIds = reply.userIds;
  }

  const result = await applyOrganiserPick({
    matchId: round.matchId,
    userIds,
    pickerUserId: input.senderUserId,
    roundId: round.id,
    allowNotOnList,
    now,
  });

  const lines: string[] = [];
  const pickerName = members.find((mm) => mm.userId === input.senderUserId)?.name ?? null;
  if (result.applied.length > 0) {
    for (const a of result.applied) {
      lines.push(s.pick_done_admin({ name: a.name, replacedName: a.replacedName, pickerName: audience === "group" ? pickerName : null }));
    }
    if (result.noPlaceFor.length > 0) {
      lines.push(s.pick_only_k({ k: result.applied.length, names: result.applied.map((a) => a.name) }));
    }
  } else if (result.noPlaceFor.length > 0) {
    lines.push(await alreadyFilledText(org.language, await refreshRound(round.id), world));
  }
  const nameOf = (id: string) => members.find((mm) => mm.userId === id)?.name ?? listNames.get(id) ?? "?";
  for (const id of result.alreadyIn) lines.push(s.pick_already_in({ name: nameOf(id) }));
  const notListed = result.notOnWaitingList.filter((id) => members.some((mm) => mm.userId === id));
  if (notListed.length > 0) {
    // E1: one question at a time; a new pick replaces it.
    await db.organiserPickRound.updateMany({
      where: { id: round.id, resolvedAt: null },
      data: { pendingConfirmUserId: notListed[0], pendingConfirmAskedByUserId: input.senderUserId, pendingConfirmAskedAt: now },
    });
    lines.push(s.pick_not_on_list({ name: nameOf(notListed[0]) }));
  }

  let alsoTell: PickReplyOutcome["alsoTell"];
  if (result.applied.length > 0) {
    await announcePickToGroupAndPlayers(round.matchId, result);
    if (input.door === "dm") {
      alsoTell = round.recipientUserIds
        .filter((id) => id !== input.senderUserId)
        .map((userId) => ({
          userId,
          text: result.applied.map((a) => s.pick_done_admin({ name: a.name, replacedName: a.replacedName, pickerName })).join("\n"),
        }));
    }
  }
  return { handled: true, replyText: lines.join("\n") || null, alsoTell, outcome: result.applied.length > 0 ? "picked" : "nothing-applied" };
}

async function refreshRound(roundId: string) {
  return db.organiserPickRound.findUniqueOrThrow({ where: { id: roundId } });
}

/** E3: who got the place and who picked them, or "the squad is full". */
async function alreadyFilledText(
  lang: string,
  round: { pickedUserIds: string[]; lastPickedByUserId: string | null },
  world: MatchWorld,
): Promise<string> {
  const s = t(lang);
  const lastPicked = round.pickedUserIds[round.pickedUserIds.length - 1] ?? null;
  if (lastPicked && round.lastPickedByUserId) {
    const names = await namesOf([lastPicked, round.lastPickedByUserId]);
    return s.pick_already_filled({ name: names.get(lastPicked) ?? "?", pickerName: names.get(round.lastPickedByUserId) ?? "?" });
  }
  const confirmed = await db.attendance.count({ where: { matchId: world.id, status: "CONFIRMED" } });
  return s.pick_already_filled_full({ confirmed, maxPlayers: world.maxPlayers });
}

// ── Door 1: a DM ────────────────────────────────────────────────────────

/**
 * A DM that may answer a pick round (plan 2.8, door 1). Engages only when
 * the sender, resolved BY PHONE ONLY (the envelope's phone and its
 * alternate address; never the pushname, which the sender chooses), was
 * asked on an open round (or one just filled). Returns null to fall
 * through to the DM's other handlers.
 *
 * Idempotent per WhatsApp message id: a Pi retry applies nothing twice.
 */
export async function handleOrganiserPickDm(input: {
  phone?: string | null;
  senderAltPhone?: string | null;
  text: string;
  waMessageId: string;
  timestamp?: string | null;
  now?: Date;
}): Promise<{ handled: string; outcome?: string } | null> {
  const phones = [input.phone, input.senderAltPhone]
    .map((p) => (typeof p === "string" && p.trim() ? normalisePhone(p.trim().startsWith("+") ? p.trim() : `+${p.trim().replace(/\D/g, "")}`) : null))
    .filter((p): p is string => !!p);
  if (phones.length === 0) return null;
  // Cheap gate first: is anyone being asked at all?
  const now = input.now ?? new Date();
  const anyRound = await db.organiserPickRound.findFirst({
    where: {
      OR: [{ resolvedAt: null }, { outcome: "filled", resolvedAt: { gte: new Date(now.getTime() - PICK_RACE_WINDOW_MS) } }],
    },
    select: { id: true },
  });
  if (!anyRound) return null;
  const users = await db.user.findMany({ where: { phoneNumber: { in: phones } }, select: { id: true, phoneNumber: true } });
  if (users.length === 0) return null;

  for (const user of users) {
    const memberships = await db.membership.findMany({
      // Club fee billing (B1): a billing-paused club is left out, so nothing
      // is claimed, applied or answered for it. Empty while the flag is off.
      where: {
        userId: user.id,
        leftAt: null,
        role: { in: ["OWNER", "ADMIN"] },
        org: { benchPickMode: "organiser", ...billingQuietWhere() },
      },
      select: { orgId: true },
    });
    for (const { orgId } of memberships) {
      // Claimed BEFORE anything is applied, so a Pi retry of the same DM
      // applies nothing twice; released again if the DM is not a pick
      // reply, so it falls through as if this handler had never looked.
      const claimKey = `pick-dm-msg:${input.waMessageId}:${orgId}`;
      try {
        await db.sentNotification.create({ data: { key: claimKey, kind: "admin-notice" } });
      } catch {
        return { handled: "organiser-pick-duplicate" };
      }
      const outcome = await handlePickReply({
        orgId,
        door: "dm",
        senderUserId: user.id,
        text: input.text,
        sentAt: parseTimestamp(input.timestamp),
        now,
      }).catch(async (err) => {
        await db.sentNotification.deleteMany({ where: { key: claimKey } }).catch(() => {});
        throw err;
      });
      if (!outcome.handled) {
        await db.sentNotification.deleteMany({ where: { key: claimKey } });
        continue;
      }
      const replyPhone = bare(user.phoneNumber ?? phones[0]);
      if (outcome.replyText) {
        await db.botJob.create({ data: { orgId, kind: "dm", phone: replyPhone, text: outcome.replyText } });
      }
      if (outcome.alsoTell && outcome.alsoTell.length > 0) {
        const others = await db.user.findMany({
          where: { id: { in: outcome.alsoTell.map((a) => a.userId) } },
          select: { id: true, phoneNumber: true },
        });
        for (const a of outcome.alsoTell) {
          const ph = others.find((o) => o.id === a.userId)?.phoneNumber;
          if (ph) await db.botJob.create({ data: { orgId, kind: "dm", phone: bare(ph), text: a.text } });
        }
      }
      return { handled: "organiser-pick", outcome: outcome.outcome };
    }
  }
  return null;
}

function parseTimestamp(ts: unknown): Date | null {
  if (typeof ts === "number" && Number.isFinite(ts)) return new Date(ts < 1e12 ? ts * 1000 : ts);
  if (typeof ts === "string" && ts.trim()) {
    const n = Number(ts);
    if (Number.isFinite(n)) return new Date(n < 1e12 ? n * 1000 : n);
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// ── The match page (plan 2.13) ─────────────────────────────────────────

/**
 * A pick from the match page's "Bring in": the same writer, the same
 * posts. The admin channel gets A1 with the web admin as the picker.
 */
export async function pickFromWaitingListAsAdmin(args: { matchId: string; userId: string; adminUserId: string }): Promise<ApplyPickResult> {
  const open = await db.organiserPickRound.findFirst({
    where: { matchId: args.matchId, resolvedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  const result = await applyOrganiserPick({
    matchId: args.matchId,
    userIds: [args.userId],
    pickerUserId: args.adminUserId,
    roundId: open?.id ?? null,
  });
  if (result.applied.length > 0) {
    const m = await db.match.findUnique({ where: { id: args.matchId }, select: { activity: { select: { orgId: true, org: { select: { language: true } } } } } });
    if (m) {
      const s = t(m.activity.org.language);
      const picker = await db.user.findUnique({ where: { id: args.adminUserId }, select: { name: true } });
      await sendAdminNotice({
        orgId: m.activity.orgId,
        text: result.applied.map((a) => s.pick_done_admin({ name: a.name, replacedName: a.replacedName, pickerName: picker?.name ?? null })).join("\n"),
      });
    }
    await announcePickToGroupAndPlayers(args.matchId, result);
  }
  return result;
}

/**
 * Reorder the waiting list (plan 2.13): rewrites `position` for BENCH rows
 * only, reusing the set of positions they already hold, so confirmed
 * positions never move. One audit event per moved row. The next pick list
 * follows this order.
 */
export async function reorderWaitingListRows(args: { matchId: string; orderedUserIds: string[]; adminUserId: string }): Promise<{ moved: number }> {
  const match = await db.match.findUnique({ where: { id: args.matchId }, select: { activity: { select: { orgId: true } } } });
  if (!match) throw new Error("Match not found");
  return db.$transaction(async (tx) => {
    const bench = await tx.attendance.findMany({
      where: { matchId: args.matchId, status: "BENCH" },
      orderBy: { position: "asc" },
      select: { id: true, userId: true, position: true },
    });
    const ids = bench.map((b) => b.userId);
    const wanted = args.orderedUserIds.filter((id) => ids.includes(id));
    if (wanted.length !== ids.length || new Set(wanted).size !== ids.length) throw new Error("The waiting list has changed; reload the page");
    const slots = bench.map((b) => b.position).sort((a, b) => a - b);
    let moved = 0;
    for (let i = 0; i < wanted.length; i++) {
      const row = bench.find((b) => b.userId === wanted[i])!;
      if (row.position === slots[i]) continue;
      await tx.attendance.update({ where: { id: row.id }, data: { position: slots[i] } });
      await recordAttendanceEvent(
        tx,
        {
          matchId: args.matchId,
          userId: row.userId,
          orgId: match.activity.orgId,
          fromStatus: "BENCH",
          toStatus: "BENCH",
          fromPosition: row.position,
          toPosition: slots[i],
        },
        { cause: "admin-squad-edit", actorKind: "admin", actorUserId: args.adminUserId, sourceRef: "admin:reorderWaitingList", note: "waiting list reordered" },
      );
      moved++;
    }
    return { moved };
  });
}
