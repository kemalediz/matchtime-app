/**
 * ── WHEN A PLACE OPENS, THE BENCH FILLS IT (2026-11-17) ───────────────
 *
 * The rule and the incident behind it are in `bench-fill-rules.ts`. This
 * module applies the rule to the database and tells the people involved.
 *
 * ONE WRITER FOR "WHO PLAYS" AFTER A PLACE OPENS. Every path that opens a
 * place in a first-come club ends here:
 *   • a CONFIRMED player drops, by any route (`cancelAttendance` →
 *     `requestBenchConfirmationOnDrop`);
 *   • a CONFIRMED player is moved to the bench on purpose
 *     (`registerAttendance`'s explicit bench);
 *   • an admin deletes a CONFIRMED row on the match page
 *     (`removePlayerFromMatch`);
 *   • and, as the safety net for anything else (two requests racing, a
 *     path not listed here), every scheduler poll (`sweepBenchFill`).
 * So no list MatchTime posts, all of which are read from the database,
 * can say "need 1 more" while somebody on the bench could take the place.
 *
 * WHAT IT DOES, under the per-match team-slot lock, in ONE transaction:
 * re-reads the squad, moves the first players on the bench into the open
 * places (bench order, skipping anyone who chose the bench while he could
 * have played), writes each move to the attendance log, seats each of them
 * in a vacated team slot when a team sheet exists (`team-slot-fill.ts`),
 * and closes any bench offer that no longer has a place behind it. Then,
 * outside it: the monthly bookkeeping, ONE group line naming who moved up
 * (on the squad-complete post when the move completed the squad, so the
 * group gets one message, not two), and a DM to each of them saying they
 * are in and that OUT passes the place on. Both wait for the club's quiet
 * hours to end. Nobody is ever dropped for not answering.
 *
 * NOT FOR: an organiser-pick club (the organisers choose), a club with the
 * bench switched off (the old behaviour stands: nobody is messaged), a
 * match that is over, cancelled or kicked off.
 */
import { db } from "./db";
import { recordAttendanceEvent, type AttendanceActorKind } from "./attendance-events";
import { pickBenchMovers, type BenchFillRow } from "./bench-fill-rules";
import { fillVacatedSlots, lockTeamSlots, type AppliedSlotMove } from "./team-slot-fill";
import { buildBenchMovedUpDm, buildBenchMovedUpLine } from "./bench-offer-copy";
import { buildBenchOfferContext } from "./scheduler-copy";
import { resolveTeamLabels } from "./team-labels";
import { announceSquadFullIfJustFilled } from "./squad-announce";
import { organisersAnnounce } from "./list-announcer";
import { buildOrganiserRelay } from "./organisers-list-copy";
import { sendAdminNotice } from "./admin-channel";
import { loadClubQuietHours } from "./club-quiet-hours";
import { adminNoticeSendAfter } from "./rolling-squad-rules";
import { normaliseBenchPickMode } from "./squad-capacity";
import { t } from "./i18n/t";

const LIVE = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] as const;

export interface BenchFillTrigger {
  /** "system" when a change in the app opened the place, "scheduler" for
   *  the poll's safety net. */
  actorKind: Extract<AttendanceActorKind, "system" | "scheduler">;
  /** What opened the place, for the log ("drop:<userId>", …). */
  sourceRef: string;
  /** The CONFIRMED player whose leaving opened it, when one did: the group
   *  line names him ("replacing David") when there is no team sheet. */
  vacatedByUserId?: string | null;
  now?: Date;
}

export interface BenchFillResult {
  /** Who moved up, first in bench order first. */
  moved: string[];
}

const NOTHING: BenchFillResult = { moved: [] };

/** Can this club's bench fill a place by itself? */
function fillsByItself(org: { benchPickMode: string | null; featureBench: boolean } | null | undefined): boolean {
  return !!org && org.featureBench && normaliseBenchPickMode(org.benchPickMode) === "first-come";
}

export async function fillOpenPlacesFromBench(matchId: string, trigger: BenchFillTrigger): Promise<BenchFillResult> {
  const now = trigger.now ?? new Date();
  const match = await db.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      date: true,
      status: true,
      teamLabels: true,
      activity: {
        select: {
          name: true,
          orgId: true,
          sport: { select: { teamLabels: true } },
          org: {
            select: {
              benchPickMode: true,
              featureBench: true,
              language: true,
              squadMode: true,
              listAnnouncer: true,
              teamLabels: true,
            },
          },
        },
      },
    },
  });
  if (!match || !fillsByItself(match.activity.org)) return NOTHING;
  if (!(LIVE as readonly string[]).includes(match.status) || match.date.getTime() <= now.getTime()) return NOTHING;
  const orgId = match.activity.orgId;

  const done = await db.$transaction(async (tx) => {
    await lockTeamSlots(tx, matchId);
    const cur = await tx.match.findUnique({ where: { id: matchId }, select: { maxPlayers: true } });
    if (!cur) return null;
    const rows = await tx.attendance.findMany({
      where: { matchId, status: { in: ["CONFIRMED", "BENCH"] } },
      select: { id: true, userId: true, status: true, position: true, respondedAt: true, benchByChoice: true },
    });
    const confirmedBefore = rows.filter((r) => r.status === "CONFIRMED").length;
    const benchIds = rows.filter((r) => r.status === "BENCH").map((r) => r.userId);
    if (benchIds.length === 0 || confirmedBefore >= cur.maxPlayers) return null;

    const movers = pickBenchMovers({
      maxPlayers: cur.maxPlayers,
      rows: rows.map(
        (r): BenchFillRow => ({
          userId: r.userId,
          status: r.status as BenchFillRow["status"],
          position: r.position,
          joinedAt: r.respondedAt.getTime(),
          // On the bench by choice (`Attendance.benchByChoice`).
          held: r.status === "BENCH" && r.benchByChoice === true,
        }),
      ),
    });
    if (movers.length === 0) return null;

    const moved: string[] = [];
    for (const userId of movers) {
      const row = rows.find((r) => r.userId === userId)!;
      // Conditional on the status it was read with: a row another path
      // has just changed is left as it is.
      const { count } = await tx.attendance.updateMany({
        where: { id: row.id, status: "BENCH" },
        data: { status: "CONFIRMED", benchByChoice: false },
      });
      if (count === 0) continue;
      moved.push(userId);
      await recordAttendanceEvent(
        tx,
        { matchId, userId, orgId, fromStatus: "BENCH", toStatus: "CONFIRMED", fromPosition: row.position, toPosition: row.position },
        {
          cause: "bench-moved-up",
          actorKind: trigger.actorKind,
          actorUserId: null,
          sourceRef: trigger.sourceRef,
          note: trigger.vacatedByUserId
            ? `first on the bench, moved up into the place ${trigger.vacatedByUserId} left`
            : "first on the bench, moved up into an open place",
        },
      );
    }
    if (moved.length === 0) return null;

    // A team sheet: each of them takes a vacated slot on it.
    const seats: AppliedSlotMove[] = await fillVacatedSlots(tx, matchId);
    const sheetExists = seats.length > 0 || (await tx.teamAssignment.count({ where: { matchId } })) > 0;

    // An offer is a promise that a place is free. Keep only as many open
    // as there are places still free, oldest closed first, each closed
    // one put down to whoever moved up.
    const confirmedAfter = confirmedBefore + moved.length;
    const free = Math.max(0, cur.maxPlayers - confirmedAfter);
    const open = await tx.benchSlotOffer.findMany({
      where: { matchId, resolvedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    const surplus = open.slice(0, Math.max(0, open.length - free));
    for (let i = 0; i < surplus.length; i++) {
      await tx.benchSlotOffer.updateMany({
        where: { id: surplus[i].id, resolvedAt: null },
        data: { resolvedAt: now, outcome: "bench-moved-up", claimedByUserId: moved[i] ?? null },
      });
    }
    return { moved, seats, sheetExists, confirmedAfter, maxPlayers: cur.maxPlayers };
  });
  if (!done) return NOTHING;

  console.log(
    `[bench-fill] org=${orgId} match=${matchId} moved up ${done.moved.join(",")} (${trigger.sourceRef}); squad ${done.confirmedAfter}/${done.maxPlayers}`,
  );

  // MONTHLY SQUAD: a player who has just come in takes the slot number a
  // regular vacated, and the month's credits catch up. Never throws.
  if (match.activity.org?.squadMode === "monthly") {
    const { afterMonthlyAttendanceChange } = await import("./monthly-week");
    for (const userId of done.moved) await afterMonthlyAttendanceChange(matchId, userId, true);
  }

  try {
    await tellBenchMovedUp({ matchId, match, orgId, now, trigger, done });
  } catch (err) {
    // The move stands and the lists read it from the database; only the
    // words failed, and they are logged rather than retried twice.
    console.error(`[bench-fill] ${matchId}: telling the group and the players failed:`, err);
  }
  return { moved: done.moved };
}

async function tellBenchMovedUp(p: {
  matchId: string;
  match: {
    date: Date;
    teamLabels: string[];
    activity: {
      name: string;
      sport: { teamLabels: string[] } | null;
      org: { language: string | null; listAnnouncer: string | null; teamLabels: string[] } | null;
    };
  };
  orgId: string;
  now: Date;
  trigger: BenchFillTrigger;
  done: { moved: string[]; seats: AppliedSlotMove[]; sheetExists: boolean; confirmedAfter: number; maxPlayers: number };
}): Promise<void> {
  const { matchId, match, orgId, now, trigger } = p;
  // TOLD ONLY IF STILL IN (2026-11-17, review of #622): a mover whose OUT
  // landed straight after the fill (it waited on the squad lock) is not
  // told he is in.
  const stillIn = new Set(
    (
      await db.attendance.findMany({
        where: { matchId, userId: { in: p.done.moved }, status: "CONFIRMED" },
        select: { userId: true },
      })
    ).map((r) => r.userId),
  );
  const done = { ...p.done, moved: p.done.moved.filter((id) => stillIn.has(id)) };
  if (done.moved.length === 0) return;
  const org = match.activity.org;
  const lang = org?.language ?? null;
  const users = await db.user.findMany({
    where: { id: { in: done.moved } },
    select: { id: true, name: true, phoneNumber: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  const nameOf = (id: string) => byId.get(id)?.name ?? t(lang).unnamed;

  // WHO EACH OF THEM REPLACED. With a sheet, only the holder of the slot
  // he actually inherited (the 29 September rule, `team-slot-fill.ts`);
  // without one, the player whose leaving opened the place, when a single
  // player moved up into it.
  const seatOf = new Map(done.seats.map((s) => [s.toUserId, s]));
  const single = done.moved.length === 1 ? done.moved[0] : null;
  const seat = single ? seatOf.get(single) ?? null : null;
  const replacedId = single ? (seat ? seat.fromUserId : done.sheetExists ? null : trigger.vacatedByUserId ?? null) : null;
  const replaced = replacedId
    ? (await db.user.findUnique({ where: { id: replacedId }, select: { name: true } }))?.name ?? null
    : null;
  const labels = done.seats.length > 0 ? resolveTeamLabels(match, org, match.activity.sport, lang) : null;
  const teamLabelOf = (s: AppliedSlotMove | null | undefined) => (s && labels ? (s.team === "RED" ? labels[0] : labels[1]) : null);

  // WHEN HE HEARS (2026-11-17, review of #622). The DM waits for the club's
  // quiet hours, unless they would hold it past kickoff: then it goes now.
  // A player who will not get a DM in time to act on it (he switched bench
  // messages off, or quiet hours end after kickoff) is @tagged in the group
  // line, which keeps the group's own quiet-hours rule.
  const quiet = await loadClubQuietHours(orgId);
  const sendAfter = adminNoticeSendAfter(now, quiet);
  const quietPastKickoff = !!sendAfter && sendAfter.getTime() >= match.date.getTime();
  const dmSendAfter = quietPastKickoff ? null : sendAfter;
  const optedOut = new Set(
    (
      await db.membership.findMany({
        where: { orgId, userId: { in: done.moved }, subBenchOfferDm: false },
        select: { userId: true },
      })
    ).map((m) => m.userId),
  );
  const phoneOf = (id: string) => byId.get(id)?.phoneNumber?.replace(/^\+/, "") ?? null;
  // Tags only in the players' group: an organisers' message names him.
  const toOrganisers = organisersAnnounce(org);
  const tagged = toOrganisers ? [] : done.moved.filter((id) => !!phoneOf(id) && (optedOut.has(id) || quietPastKickoff));
  const mentions = tagged.map((id) => phoneOf(id)!);
  const line = (squad: { confirmed: number; maxPlayers: number } | null) =>
    buildBenchMovedUpLine({
      names: done.moved.map((id) => (tagged.includes(id) ? { tag: phoneOf(id)! } : nameOf(id))),
      droppedName: replaced,
      teamLabel: teamLabelOf(seat),
      squad,
      lang,
    });

  // ONE MESSAGE PER FILL. When the move completed the squad, the line leads
  // the squad-complete post (which also re-opens the bench for new INs),
  // or the organisers' list update when the organisers announce it;
  // otherwise, or when that post is not the group's to make (a team sheet,
  // a monthly list), the line goes on its own, to whoever announces.
  const announced =
    done.confirmedAfter >= done.maxPlayers
      ? await announceSquadFullIfJustFilled(matchId, { lead: line(null), sendAfter, mentions })
      : null;
  if (announced === null) {
    const text = line({ confirmed: done.confirmedAfter, maxPlayers: done.maxPlayers });
    if (toOrganisers) {
      await sendAdminNotice({ orgId, text: buildOrganiserRelay(text, lang), now });
    } else {
      await db.botJob.create({
        data: {
          orgId,
          kind: "group",
          matchId,
          text,
          ...(mentions.length > 0 ? { mentions } : {}),
          ...(sendAfter ? { sendAfter } : {}),
        },
      });
    }
  }

  // A DM to each of them: he is in, and OUT passes the place on. Not to a
  // player who switched bench messages off (`subBenchOfferDm`; he is
  // tagged in the group instead), nor to one with no number.
  for (const userId of done.moved) {
    const phone = phoneOf(userId);
    if (!phone || optedOut.has(userId)) continue;
    const mySeat = seatOf.get(userId) ?? null;
    const myReplaced = mySeat
      ? (await db.user.findUnique({ where: { id: mySeat.fromUserId }, select: { name: true } }))?.name ?? null
      : null;
    const { plain } = buildBenchOfferContext({
      activityName: match.activity.name,
      team: mySeat ? { teamLabel: teamLabelOf(mySeat)!, replacingName: myReplaced } : null,
      matchDate: match.date,
      now,
      lang,
    });
    const u = byId.get(userId);
    await db.botJob.create({
      data: {
        orgId,
        kind: "dm",
        phone,
        matchId,
        text: buildBenchMovedUpDm({ firstName: u?.name ? u.name.split(" ")[0] : "", context: plain, lang }),
        ...(dmSendAfter ? { sendAfter: dmSendAfter } : {}),
      },
    });
  }
}

/** How long the safety net leaves a match alone after a change to it, so
 *  an organiser's "remove X" on the match page followed by "add Y" gives
 *  the place to Y, not to the first one on the bench (review of #622). */
export const SWEEP_GRACE_MS = 2 * 60 * 1000;

/**
 * THE SAFETY NET, run on every scheduler poll before anything is posted
 * (`/api/whatsapp/due-posts`). Any upcoming match of a first-come club with
 * a place open and somebody on the bench gets the same fill as a drop. One
 * read for a club with nothing to do; never throws.
 */
export async function sweepBenchFill(orgId: string, now: Date = new Date()): Promise<number> {
  try {
    const org = await db.organisation.findUnique({
      where: { id: orgId },
      select: { benchPickMode: true, featureBench: true, openSquad: true },
    });
    // NO SQUAD LIMIT (review of #623): there is no bench, so whoever is
    // still on one (a write that raced the switch) is promoted.
    if (org?.openSquad === true) {
      const { promoteOpenSquadBench } = await import("./open-squad-save");
      return await promoteOpenSquadBench(orgId, now);
    }
    if (!fillsByItself(org)) return 0;
    const matches = await db.match.findMany({
      where: { activity: { orgId }, status: { in: [...LIVE] }, date: { gt: now } },
      select: { id: true, maxPlayers: true, attendances: { where: { status: { in: ["CONFIRMED", "BENCH"] } }, select: { status: true } } },
    });
    let moved = 0;
    for (const m of matches) {
      const confirmed = m.attendances.filter((a) => a.status === "CONFIRMED").length;
      const bench = m.attendances.length - confirmed;
      if (bench === 0 || confirmed >= m.maxPlayers) continue;
      // A change in the last two minutes: an organiser may be mid-way
      // through a remove-then-add on the match page. The next poll fills.
      const recent = await db.attendanceEvent.findFirst({
        where: { matchId: m.id, at: { gt: new Date(now.getTime() - SWEEP_GRACE_MS) } },
        select: { id: true },
      });
      if (recent) continue;
      const res = await fillOpenPlacesFromBench(m.id, { actorKind: "scheduler", sourceRef: "scheduler:bench-fill", now });
      moved += res.moved.length;
    }
    return moved;
  } catch (err) {
    console.error(`[bench-fill] sweep for org ${orgId} failed:`, err);
    return 0;
  }
}
