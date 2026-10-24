/**
 * A PARTNER CLUB'S PLAYER VOLUNTEERS FOR ITS ASK (cross-club ask, slice
 * S3, 2026-10-16). Plan: MDs/cross-club-player-ask-plan-2026-10-16.md,
 * sections 3.6 and 3.7.
 *
 * THE ONLY PLACE A PERSON IS WRITTEN ONTO ANOTHER CLUB'S MATCH (a guard
 * test keeps it so). The engine said which ask a reply is about, by the
 * post it quotes (`partner_volunteer`); this reads the facts on the
 * database and decides with `decideVolunteer`:
 *
 *   register   a guest membership in the asking club (or an ordinary IN
 *              for someone already its member), `registerAttendance` on
 *              the ASKING club's match with cause "partner-ask", the
 *              volunteer recorded on the ask, the asking club's
 *              organisers told, and a DM to him;
 *   withdraw   his row on the asking club's match dropped, same cause;
 *   refuse     one plain reply (closed, unknown, an overlapping game of
 *              his own, not on the list) and nothing written.
 *
 * Whether he plays is the asking club's own rule: an organiser-pick club
 * puts every IN on the bench for its organisers to pick, a first-come
 * club confirms while there is room (`registerAttendance` decides, as for
 * any player) AND while the ask's round is below the number its organiser
 * chose (partner discovery P4, 2026-10-22: checked and written under one
 * lock per match). Replies are in HIS club's language (D9); the notice to the
 * asking club in its own. Logs carry ids only.
 *
 * EVERY ANSWER TO HIM IS A DM (Kemal, 2026-10-21): volunteering adds no
 * noise to the partner club's group, whichever way he volunteered (the
 * post's tap-to-DM link, or a swipe-reply in the group). The DM goes out
 * as a reply-priority BotJob of HIS club, to the number he messaged from
 * or the one on file. With no number at all nothing is sent anywhere and
 * the caller is told (`dmQueued: false`).
 *
 * THE POOL (local player pool L5a, 2026-10-24): the same writer gains a
 * pool entry point, `placePoolGuest` (and `withdrawPoolGuest`), so a pool
 * player who taps yes is written exactly as a partner volunteer is: a
 * guest membership in the club (`guestVia = 'pool'`, no home club), a
 * `registerAttendance` on the match with cause "pool-ask", the club's own
 * rule deciding (first-come confirms while the ROUND is below its number,
 * under the SAME per-match lock, `underRoundLock`; organiser-pick benches),
 * plus his `GuestPlace` row. What he and the organisers are told is the
 * pool's (`pool/accept.ts`).
 */
import { db } from "./db";
import { REPLY_PRIORITY } from "./dm-reply-priority";
import { registerAttendance, cancelAttendance } from "./attendance";
import { sendAdminNotice } from "./admin-channel";
import { dayCommaTimeLabel, timeLabel } from "./i18n/dates";
import { t } from "./i18n/t";
import { gamesOverlap } from "./partner-ask-rules";
import { decideVolunteer, isPastGuestDue } from "./partner-volunteer-rules";
import { loadRoundFill, type RoundFill } from "./partner-ask-round";
import { GUEST_MEMBER_WHERE, isGuestMembership } from "./guest-membership";
import { normaliseBenchPickMode } from "./squad-capacity";
import { loadGuestStandings } from "./partner-guest-standing";
import { standingPhrase } from "./partner-guest-standing-rules";

const LIVE = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] as const;

export interface VolunteerWrite {
  askId: string;
  userId: string | null;
  name: string;
  polarity: "in" | "out";
  sourceMessageId: string;
  /** The number he messaged MatchTime from, without "+", when he came by
   *  DM. Otherwise the number on file is used. */
  replyPhone?: string | null;
  /** His own club's match an IN of his was just defaulted to (D5b, revised
   *  2026-10-22): it is being swapped for this game, so it never counts as
   *  an overlap. The caller undoes it once he is registered here. */
  exceptOwnMatchId?: string;
}

export interface VolunteerResult {
  ok: boolean;
  /** What happened, for the message's log line. */
  outcome: "registered-bench" | "registered-in" | "withdrawn" | "closed" | "unknown-sender" | "overlap" | "not-on-list" | "game-over" | "failed";
  /** What he was told by DM (in his club's language), or null. */
  dmText: string | null;
  /** The DM was queued. False when there was nothing to say or no number. */
  dmQueued: boolean;
}

/** The answer to a volunteer, by DM only (2026-10-21). Never throws. */
async function dmVolunteer(args: { partnerOrgId: string; userId: string | null; replyPhone?: string | null; text: string | null }): Promise<boolean> {
  if (!args.text) return false;
  try {
    const phone =
      args.replyPhone ??
      (args.userId ? (await db.user.findUnique({ where: { id: args.userId }, select: { phoneNumber: true } }))?.phoneNumber?.replace(/^\+/, "") : null) ??
      null;
    if (!phone) {
      console.log(`[partner-guest] ${args.userId ?? "unknown sender"}: no number to answer by DM`);
      return false;
    }
    await db.botJob.create({ data: { orgId: args.partnerOrgId, kind: "dm", phone, text: args.text, ...REPLY_PRIORITY } });
    return true;
  } catch (err) {
    console.error(`[partner-guest] ${args.userId ?? "unknown sender"}: the DM was not queued:`, err instanceof Error ? err.message : "failed");
    return false;
  }
}

/** The guest marks every reader of a membership row needs. */
const GUEST_MARKS = { guestFromOrgId: true, guestMatchId: true, guestVia: true } as const;

/**
 * THE ROUND'S NUMBER, UNDER ONE LOCK PER MATCH (partner discovery P4,
 * 2026-10-22; shared with the pool, L5a). For a first-come club: the fill
 * check and the place are written under ONE advisory lock per match, so
 * two people at once (two partner volunteers, two pool players, or one of
 * each) can never both take the last wanted place. `registerAttendance`
 * commits its own write before the lock is let go, so the next check sees
 * it. Null: the round already has its number (or is gone), nothing written.
 */
async function underRoundLock<R extends { status: string }>(
  matchId: string,
  fill: () => Promise<RoundFill | null>,
  write: () => Promise<R>,
): Promise<{ r: R; full: boolean } | null> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`xask-fill:${matchId}`}))`;
      const f = await fill();
      if (!f || f.placed >= f.wanted) return null;
      const r = await write();
      return { r, full: r.status === "CONFIRMED" && f.placed + 1 >= f.wanted };
    },
    { maxWait: 20_000, timeout: 30_000 },
  );
}

export async function handlePartnerVolunteer(w: VolunteerWrite, now: Date = new Date()): Promise<VolunteerResult> {
  const r = await decideAndWriteVolunteer(w, now);
  const dmQueued = r.partnerOrgId ? await dmVolunteer({ partnerOrgId: r.partnerOrgId, userId: w.userId, replyPhone: w.replyPhone, text: r.dmText }) : false;
  return { ok: r.ok, outcome: r.outcome, dmText: r.dmText, dmQueued };
}

/** His own club's live game overlapping the asking club's, with him in it. */
async function inOverlappingOwnGame(
  userId: string,
  partnerOrgId: string,
  kickoff: Date,
  durationMins: number,
  exceptMatchId?: string,
): Promise<{ yes: boolean; time: string | null }> {
  const rows = await db.attendance.findMany({
    where: {
      userId,
      ...(exceptMatchId ? { matchId: { not: exceptMatchId } } : {}),
      status: { in: ["CONFIRMED", "BENCH"] },
      match: {
        activity: { orgId: partnerOrgId },
        status: { in: [...LIVE] },
        isHistorical: false,
        date: { gte: new Date(kickoff.getTime() - 24 * 3600_000), lte: new Date(kickoff.getTime() + 24 * 3600_000) },
      },
    },
    select: { match: { select: { date: true, activity: { select: { matchDurationMins: true } } } } },
  });
  for (const r of rows) {
    if (gamesOverlap({ kickoff, durationMins }, { kickoff: r.match.date, durationMins: r.match.activity.matchDurationMins })) {
      return { yes: true, time: timeLabel(r.match.date) };
    }
  }
  return { yes: false, time: null };
}

type Decided = { ok: boolean; outcome: VolunteerResult["outcome"]; dmText: string | null; partnerOrgId: string | null };

async function decideAndWriteVolunteer(w: VolunteerWrite, now: Date): Promise<Decided> {
  const ask = await db.partnerAsk.findUnique({
    where: { id: w.askId },
    select: {
      id: true,
      status: true,
      closesAt: true,
      askerOrgId: true,
      partnerOrgId: true,
      matchId: true,
      roundId: true,
      places: true,
      volunteerUserIds: true,
      pickedUserIds: true,
      match: { select: { date: true, status: true, activity: { select: { matchDurationMins: true } } } },
    },
  });
  if (!ask) return { ok: false, outcome: "failed", dmText: null, partnerOrgId: null };
  const [asker, partner] = await Promise.all([
    db.organisation.findUnique({ where: { id: ask.askerOrgId }, select: { id: true, name: true, language: true, benchPickMode: true } }),
    db.organisation.findUnique({ where: { id: ask.partnerOrgId }, select: { id: true, name: true, language: true } }),
  ]);
  if (!asker || !partner) return { ok: false, outcome: "failed", dmText: null, partnerOrgId: null };
  const ps = t(partner.language);
  const name = w.name.trim().split(/\s+/)[0] || w.name;

  const [partnerMember, askerMember, row] = w.userId
    ? await Promise.all([
        db.membership.findUnique({ where: { userId_orgId: { userId: w.userId, orgId: partner.id } }, select: { leftAt: true, ...GUEST_MARKS } }),
        db.membership.findUnique({ where: { userId_orgId: { userId: w.userId, orgId: asker.id } }, select: { id: true, leftAt: true, ...GUEST_MARKS } }),
        db.attendance.findUnique({ where: { matchId_userId: { matchId: ask.matchId, userId: w.userId } }, select: { status: true } }),
      ])
    : [null, null, null];
  const overlap = w.userId
    ? await inOverlappingOwnGame(w.userId, partner.id, ask.match.date, ask.match.activity.matchDurationMins, w.exceptOwnMatchId)
    : { yes: false, time: null };

  const decision = decideVolunteer({
    polarity: w.polarity,
    askOpen: ask.status === "posted" && now.getTime() < ask.closesAt.getTime(),
    // A partner member who is himself a guest there is not that club's.
    senderIsPartnerMember: !!partnerMember && !partnerMember.leftAt && !isGuestMembership(partnerMember),
    inOverlappingOwnGame: overlap.yes,
    ordinaryAskerMember: !!askerMember && !askerMember.leftAt && !isGuestMembership(askerMember),
    onAskerMatch: !!row && (row.status === "CONFIRMED" || row.status === "BENCH"),
    // Review H2: an OUT never touches a game that is over or played, nor a
    // past guest's row.
    askerMatchLive: LIVE.includes(ask.match.status as (typeof LIVE)[number]),
    pastGuest: isGuestMembership(askerMember) && !!askerMember?.leftAt,
  });

  if (decision.kind === "refuse") {
    const replyText =
      decision.why === "closed"
        ? ps.xask_vol_closed({ asker: asker.name })
        : decision.why === "unknown-sender"
          ? ps.xask_vol_unknown({ club: partner.name })
          : decision.why === "overlap"
            ? ps.xask_vol_overlap({ club: partner.name, time: overlap.time ?? "", asker: asker.name })
            : decision.why === "game-over"
              ? ps.xask_vol_game_over({ asker: asker.name })
              : ps.xask_vol_not_on({ asker: asker.name });
    console.log(`[partner-guest] ask ${ask.id}: ${w.userId ?? "unknown sender"} refused (${decision.why})`);
    return { ok: true, outcome: decision.why, dmText: replyText, partnerOrgId: partner.id };
  }

  const userId = w.userId!;
  const event = {
    cause: "partner-ask" as const,
    actorKind: "player" as const,
    actorUserId: userId,
    sourceRef: `xask:${ask.id}`,
    note: `${partner.name} player replied to ${asker.name}'s ask`,
  };
  const askerLang = asker.language;
  const day = dayCommaTimeLabel(askerLang, ask.match.date);
  /** The asking club hears once per reply (review M7): keyed on the ask,
   *  the person, the direction and the message. */
  const tellAskerOnce = async (dir: "in" | "out", text: string) => {
    try {
      await db.sentNotification.create({ data: { key: `xask:${ask.id}:vol:${userId}:${dir}:${w.sourceMessageId}`, kind: "xask-volunteer" } });
    } catch {
      return; // told already
    }
    await sendAdminNotice({ orgId: asker.id, now, holdOvernight: false, text });
  };

  try {
    if (decision.kind === "withdraw") {
      await cancelAttendance(userId, ask.matchId, event);
      // Review M7: removed in SQL, never rewritten from a stale read.
      await db.$executeRaw`UPDATE "PartnerAsk" SET "volunteerUserIds" = array_remove("volunteerUserIds", ${userId}) WHERE id = ${ask.id}`;
      await tellAskerOnce("out", t(askerLang).xask_vol_out_notice_asker({ name: w.name, partner: partner.name, day }));
      console.log(`[partner-guest] ask ${ask.id}: ${userId} withdrew`);
      return { ok: true, outcome: "withdrawn", dmText: ps.xask_vol_out({ asker: asker.name }), partnerOrgId: partner.id };
    }

    // Review M7: claim the volunteer on the ask FIRST, and only while it is
    // open (a compare-and-set). Lost: the ask closed, or he is on it already.
    const claimed = await db.partnerAsk.updateMany({
      where: { id: ask.id, status: "posted", closesAt: { gt: now }, NOT: { volunteerUserIds: { has: userId } } },
      data: { volunteerUserIds: { push: userId } },
    });
    if (claimed.count === 0) {
      const again = await db.partnerAsk.findUnique({ where: { id: ask.id }, select: { status: true, volunteerUserIds: true } });
      if (!again || again.status !== "posted" || !again.volunteerUserIds.includes(userId)) {
        return { ok: true, outcome: "closed", dmText: ps.xask_vol_closed({ asker: asker.name }), partnerOrgId: partner.id };
      }
    }

    const writePlace = async () => {
      if (decision.asGuest) {
        // A guest for this one match (plan 3.7). One membership per club and
        // person: a past guest of this club plays for it again on the same
        // row, so his rating here carries on.
        await db.membership.upsert({
          where: { userId_orgId: { userId, orgId: asker.id } },
          create: { userId, orgId: asker.id, role: "PLAYER", guestVia: "partner", guestFromOrgId: partner.id, guestMatchId: ask.matchId },
          // Review L4: a live guest mark for this match (from another partner
          // club's ask, or the pool) is kept, never overwritten.
          update:
            askerMember && !askerMember.leftAt && isGuestMembership(askerMember) && askerMember.guestMatchId === ask.matchId
              ? {}
              : { leftAt: null, guestVia: "partner", guestFromOrgId: partner.id, guestMatchId: ask.matchId },
        });
      }
      return registerAttendance(userId, ask.matchId, { event, actorIsAdmin: false });
    };

    // THE ROUND'S NUMBER (partner discovery P4, 2026-10-22). Only the
    // ASKING club's mode counts (plan 4). An organiser-pick club puts every
    // volunteer on its bench, unchanged. A first-come club gives a place
    // only while the round is below the number the organiser chose: the
    // fill check and the place are written under ONE lock per match, so
    // two volunteers at once can never both take the last wanted place.
    // The lock is held by this transaction while the place is written;
    // `registerAttendance` commits its own write before the lock is let go,
    // so the next volunteer's check sees it.
    let result: Awaited<ReturnType<typeof registerAttendance>>;
    let roundNowFull = false;
    if (normaliseBenchPickMode(asker.benchPickMode) === "organiser") {
      result = await writePlace();
    } else {
      const locked = await underRoundLock(
        ask.matchId,
        async () => {
          const fresh = await db.partnerAsk.findUnique({
            where: { id: ask.id },
            select: { id: true, roundId: true, matchId: true, places: true, volunteerUserIds: true, pickedUserIds: true },
          });
          return fresh ? loadRoundFill(fresh) : null;
        },
        writePlace,
      );
      if (!locked) {
        // The round has its number: he is taken off the ask again, nothing
        // else was written for him, and he hears the place has gone.
        await db.$executeRaw`UPDATE "PartnerAsk" SET "volunteerUserIds" = array_remove("volunteerUserIds", ${userId}) WHERE id = ${ask.id}`;
        console.log(`[partner-guest] ask ${ask.id}: ${userId} too late, the round has its number`);
        return { ok: true, outcome: "closed", dmText: ps.xask_vol_closed({ asker: asker.name }), partnerOrgId: partner.id };
      }
      result = locked.r;
      roundNowFull = locked.full;
    }
    // Review M7: the ask may have closed (and stood its volunteers down)
    // while he was written. Re-checked after the write: a bench row it no
    // longer covers is undone, and he is told the place has gone.
    const after = await db.partnerAsk.findUnique({ where: { id: ask.id }, select: { status: true } });
    if (after?.status !== "posted" && result.status !== "CONFIRMED") {
      await cancelAttendance(userId, ask.matchId, { ...event, actorKind: "system", note: "the ask closed while he was written" });
      return { ok: true, outcome: "closed", dmText: ps.xask_vol_closed({ asker: asker.name }), partnerOrgId: partner.id };
    }
    const bench = result.status === "BENCH";
    // His standing at HIS club (2026-10-22, option C): his band there, and
    // his number there only when his club shares it. Unreadable: his
    // club's name alone, as before.
    const standing = (await loadGuestStandings([{ userId, homeOrgId: partner.id }])).get(userId);
    const from = standing ? standingPhrase(askerLang, standing) : partner.name;
    await tellAskerOnce("in", t(askerLang).xask_vol_notice_asker({ name: w.name, from, day, bench }));
    // His place filled the round: every ask in it closes now, each partner
    // group hears its one "filled" line (the sweep would, at its next poll).
    if (roundNowFull) {
      const { closeRoundIfDue } = await import("./partner-ask");
      await closeRoundIfDue(ask.id, now);
    }
    console.log(`[partner-guest] ask ${ask.id}: ${userId} on match ${ask.matchId} as ${result.status}${decision.asGuest ? " (guest)" : ""}`);
    return {
      ok: true,
      outcome: bench ? "registered-bench" : "registered-in",
      dmText: bench
        ? ps.xask_vol_bench({ name, asker: asker.name })
        : ps.xask_vol_in({ name, asker: asker.name, day: dayCommaTimeLabel(partner.language, ask.match.date) }),
      partnerOrgId: partner.id,
    };
  } catch (err) {
    console.error(`[partner-guest] ask ${ask.id}: ${userId} not written:`, err instanceof Error ? err.message : "failed");
    return { ok: false, outcome: "failed", dmText: ps.xask_vol_failed, partnerOrgId: partner.id };
  }
}

// ── After the ask, and after the match (slice S4) ─────────────────────────

/**
 * When an ask closes (filled, kickoff, cancelled, paused), its volunteers
 * who did NOT get a place are thanked and stood down (plan 3.10): their
 * bench row on the asking club's match is dropped (cause "partner-ask"),
 * they become past guests (the membership is kept, closed with `leftAt`),
 * and they get one DM in their own club's language. A volunteer who got a
 * place keeps it and is recorded as picked; if the game itself is off he
 * is told so. Called by `sweepPartnerAsks` once per close (its
 * compare-and-set). Never throws.
 */
export async function standDownVolunteers(askId: string, reason: string, now: Date = new Date()): Promise<{ thanked: number; picked: number }> {
  let thanked = 0;
  let picked = 0;
  try {
    const ask = await db.partnerAsk.findUnique({
      where: { id: askId },
      select: { id: true, matchId: true, askerOrgId: true, partnerOrgId: true, volunteerUserIds: true, match: { select: { date: true } } },
    });
    if (!ask || ask.volunteerUserIds.length === 0) return { thanked, picked };
    const [asker, partner, rows, users] = await Promise.all([
      db.organisation.findUnique({ where: { id: ask.askerOrgId }, select: { name: true } }),
      db.organisation.findUnique({ where: { id: ask.partnerOrgId }, select: { id: true, language: true } }),
      db.attendance.findMany({ where: { matchId: ask.matchId, userId: { in: ask.volunteerUserIds } }, select: { userId: true, status: true } }),
      db.user.findMany({ where: { id: { in: ask.volunteerUserIds } }, select: { id: true, phoneNumber: true } }),
    ]);
    if (!asker || !partner) return { thanked, picked };
    const ps = t(partner.language);
    const statusOf = new Map(rows.map((r) => [r.userId, r.status]));
    const phoneOf = new Map(users.map((u) => [u.id, u.phoneNumber]));
    const gameOff = reason === "match-cancelled";
    // Review M5: only the guests THIS ask registered are stood down: a
    // guest from this ask's club for this match, still live. An ordinary
    // member who volunteered keeps whatever row he has.
    const mems = await db.membership.findMany({
      where: { orgId: ask.askerOrgId, userId: { in: ask.volunteerUserIds } },
      select: { userId: true, guestFromOrgId: true, guestMatchId: true, leftAt: true },
    });
    const ownGuest = new Set(
      mems.filter((m) => m.guestFromOrgId === ask.partnerOrgId && m.guestMatchId === ask.matchId && !m.leftAt).map((m) => m.userId),
    );
    const pickedIds: string[] = [];
    for (const userId of ask.volunteerUserIds) {
      const status = statusOf.get(userId);
      const phone = phoneOf.get(userId);
      if (status === "CONFIRMED" && !gameOff) {
        pickedIds.push(userId);
        picked++;
        continue;
      }
      if (!ownGuest.has(userId)) continue;
      // Review L4: still a volunteer on another open ask for this match
      // (another partner club): that ask stands him down, not this one.
      const elsewhere = await db.partnerAsk.count({
        where: { matchId: ask.matchId, id: { not: ask.id }, status: { in: ["awaiting-approval", "posted"] }, volunteerUserIds: { has: userId } },
      });
      if (elsewhere > 0) continue;
      if (status === "BENCH") {
        await cancelAttendance(userId, ask.matchId, {
          cause: "partner-ask",
          actorKind: "system",
          sourceRef: `xask:${ask.id}`,
          note: `ask closed (${reason}): stood down`,
        });
      }
      // He becomes a past guest of the asking club (D10): kept, closed.
      await db.membership.updateMany({
        where: { userId, orgId: ask.askerOrgId, guestMatchId: ask.matchId, leftAt: null },
        data: { leftAt: now },
      });
      if (phone) {
        await db.botJob.create({
          data: {
            orgId: partner.id,
            kind: "dm",
            phone: phone.replace(/^\+/, ""),
            text: gameOff
              ? ps.xask_game_off_dm({ asker: asker.name, day: dayCommaTimeLabel(partner.language, ask.match.date) })
              : reason === "organiser-cancelled"
                ? ps.xask_not_needed_dm({ asker: asker.name })
                : ps.xask_thanks_dm({ asker: asker.name }),
          },
        });
      }
      thanked++;
    }
    if (pickedIds.length > 0) {
      await db.partnerAsk.updateMany({ where: { id: ask.id }, data: { pickedUserIds: pickedIds } });
    }
    console.log(`[partner-guest] ask ${ask.id} closed (${reason}): ${picked} kept a place, ${thanked} stood down`);
  } catch (err) {
    console.error(`[partner-guest] ask ${askId}: standing down failed:`, err instanceof Error ? err.message : "failed");
  }
  return { thanked, picked };
}

/**
 * The morning after his match a guest becomes a PAST guest (Kemal,
 * 2026-10-16): the membership is kept, with its guest marks, and closed
 * with `leftAt`, so every roster reader of the asking club skips him and
 * his profile still shows that club's row with his rating there
 * (the profile's all-clubs card). From the morning after kickoff, or at
 * once for a cancelled match. Every due-posts poll of the asking club; one
 * indexed query when there are none. Never throws.
 */
export async function retirePastGuests(orgId: string, now: Date = new Date()): Promise<number> {
  try {
    const guests = await db.membership.findMany({
      where: { orgId, leftAt: null, guestMatchId: { not: null } },
      select: { id: true, guestMatchId: true },
    });
    if (guests.length === 0) return 0;
    const matches = await db.match.findMany({
      where: { id: { in: guests.map((g) => g.guestMatchId!) } },
      select: { id: true, date: true, status: true },
    });
    const byId = new Map(matches.map((m) => [m.id, m]));
    const due = guests.filter((g) => {
      const m = byId.get(g.guestMatchId!);
      return !m || isPastGuestDue({ kickoff: m.date, status: m.status, now });
    });
    if (due.length === 0) return 0;
    const done = await db.membership.updateMany({ where: { id: { in: due.map((g) => g.id) }, leftAt: null }, data: { leftAt: now } });
    console.log(`[partner-guest] org ${orgId}: ${done.count} guest(s) now past guests`);
    return done.count;
  } catch (err) {
    console.error(`[partner-guest] org ${orgId}: retiring guests failed:`, err instanceof Error ? err.message : "failed");
    return 0;
  }
}

/**
 * "Add to <club>" (plan 3.10): the asking club keeps a guest as an
 * ordinary member. Both guest marks and `leftAt` cleared. The caller has
 * proven the actor is an owner or admin of `orgId`.
 */
export async function keepGuestAsMember(orgId: string, userId: string): Promise<boolean> {
  // A partner or a pool guest (L5a): every guest mark cleared, `guestVia`
  // too, so the guest CHECK holds.
  const done = await db.membership.updateMany({
    where: { orgId, userId, ...GUEST_MEMBER_WHERE },
    data: { guestVia: null, guestFromOrgId: null, guestMatchId: null, leftAt: null },
  });
  if (done.count > 0) console.log(`[partner-guest] org ${orgId}: guest ${userId} kept as a member`);
  return done.count > 0;
}

/** Is this person a guest in this club, and from which club (for the
 *  language of his DMs and the label)? Null for an ordinary member. */
export async function guestOf(userId: string, orgId: string): Promise<{ fromOrgId: string; fromName: string; language: string } | null> {
  const m = await db.membership.findUnique({ where: { userId_orgId: { userId, orgId } }, select: { guestFromOrgId: true } });
  if (!m?.guestFromOrgId) return null;
  const from = await db.organisation.findUnique({ where: { id: m.guestFromOrgId }, select: { name: true, language: true } });
  return from ? { fromOrgId: m.guestFromOrgId, fromName: from.name, language: from.language } : null;
}

/**
 * A guest takes himself out of the asking club's match by DM (review H4,
 * after he answered "which game?"). Only while the match is still to play
 * and he is a current guest there. His row is dropped (cause partner-ask),
 * he is taken off every ask of that match, the asking club is told once,
 * and he is told, in his club's language. False when there was nothing to
 * do.
 */
export async function withdrawGuest(args: { userId: string; matchId: string; now?: Date }): Promise<boolean> {
  const now = args.now ?? new Date();
  const match = await db.match.findUnique({
    where: { id: args.matchId },
    select: { id: true, date: true, status: true, activity: { select: { orgId: true } } },
  });
  if (!match || !LIVE.includes(match.status as (typeof LIVE)[number])) return false;
  const orgId = match.activity.orgId;
  const mem = await db.membership.findUnique({
    where: { userId_orgId: { userId: args.userId, orgId } },
    select: { leftAt: true, guestFromOrgId: true, guestMatchId: true },
  });
  if (!mem?.guestFromOrgId || mem.leftAt || mem.guestMatchId !== args.matchId) return false;
  const row = await db.attendance.findUnique({ where: { matchId_userId: { matchId: args.matchId, userId: args.userId } }, select: { status: true } });
  if (!row || (row.status !== "CONFIRMED" && row.status !== "BENCH")) return false;
  await cancelAttendance(args.userId, args.matchId, {
    cause: "partner-ask",
    actorKind: "player",
    actorUserId: args.userId,
    sourceRef: `xask-dm:${args.matchId}`,
    note: "the guest said OUT by DM",
  });
  await db.$executeRaw`UPDATE "PartnerAsk" SET "volunteerUserIds" = array_remove("volunteerUserIds", ${args.userId}) WHERE "matchId" = ${args.matchId}`;
  const [asker, from, user] = await Promise.all([
    db.organisation.findUnique({ where: { id: orgId }, select: { name: true, language: true } }),
    db.organisation.findUnique({ where: { id: mem.guestFromOrgId }, select: { id: true, name: true, language: true } }),
    db.user.findUnique({ where: { id: args.userId }, select: { name: true, phoneNumber: true } }),
  ]);
  if (asker && from) {
    try {
      await db.sentNotification.create({ data: { key: `xask-dm:${args.matchId}:out:${args.userId}`, kind: "xask-volunteer" } });
      await sendAdminNotice({
        orgId,
        now,
        holdOvernight: false,
        text: t(asker.language).xask_vol_out_notice_asker({ name: user?.name ?? "", partner: from.name, day: dayCommaTimeLabel(asker.language, match.date) }),
      });
    } catch {
      // told already
    }
    if (user?.phoneNumber) {
      await db.botJob.create({
        data: { orgId: from.id, kind: "dm", phone: user.phoneNumber.replace(/^\+/, ""), text: t(from.language).xask_vol_out({ asker: asker.name }), ...REPLY_PRIORITY },
      });
    }
  }
  console.log(`[partner-guest] ${args.userId}: out of match ${args.matchId} by DM`);
  return true;
}

/**
 * THE ASKING CLUB'S ORGANISERS TOOK A GUEST OFF THEIR GAME (Kemal,
 * 2026-10-22). Called by `cancelAttendance` for every drop an ADMIN made
 * (a group message such as "C1 OUT", the admin group, HQ, a pasted list),
 * and by the match page's "Remove" (`removePlayerFromMatch`, the one admin
 * removal that deletes the row instead), always AFTER the write and only
 * when the row was live (CONFIRMED or BENCH), so a replay never DMs twice.
 *
 * Only a CURRENT guest of that club for that match counts: an ordinary
 * member gets nothing, as ever. He is taken off every ask of the match
 * (so he is not picked again; in SQL, never a stale rewrite) and gets one
 * DM from his own club, in its language. His place is freed as any place
 * is (`cancelAttendance` already did that: the bench offer, the round's
 * count). His own OUT never comes here (actor "player"), so he keeps the
 * one reply he gets today. Never throws.
 */
export async function tellGuestTakenOffByAdmin(args: { userId: string; matchId: string }): Promise<boolean> {
  try {
    const match = await db.match.findUnique({
      where: { id: args.matchId },
      select: { id: true, date: true, status: true, activity: { select: { orgId: true } } },
    });
    if (!match || !LIVE.includes(match.status as (typeof LIVE)[number])) return false;
    const orgId = match.activity.orgId;
    const mem = await db.membership.findUnique({
      where: { userId_orgId: { userId: args.userId, orgId } },
      select: { guestFromOrgId: true, guestMatchId: true, leftAt: true },
    });
    if (!mem?.guestFromOrgId || mem.leftAt || mem.guestMatchId !== args.matchId) return false;
    await db.$executeRaw`UPDATE "PartnerAsk" SET "volunteerUserIds" = array_remove("volunteerUserIds", ${args.userId}) WHERE "matchId" = ${args.matchId}`;
    const [asker, from, user] = await Promise.all([
      db.organisation.findUnique({ where: { id: orgId }, select: { id: true, name: true, language: true } }),
      db.organisation.findUnique({ where: { id: mem.guestFromOrgId }, select: { id: true, name: true, language: true } }),
      db.user.findUnique({ where: { id: args.userId }, select: { phoneNumber: true } }),
    ]);
    if (asker && from && user?.phoneNumber) {
      await db.botJob.create({
        data: {
          orgId: from.id,
          kind: "dm",
          phone: user.phoneNumber.replace(/^\+/, ""),
          text: t(from.language).xask_taken_off_dm({ asker: asker.name, day: dayCommaTimeLabel(from.language, match.date) }),
        },
      });
    } else {
      console.log(`[partner-guest] ${args.userId}: taken off match ${args.matchId}, no number to tell`);
    }
    console.log(`[partner-guest] ${args.userId}: taken off match ${args.matchId} by its organisers`);
    return true;
  } catch (err) {
    console.error(`[partner-guest] ${args.userId}: taken off match ${args.matchId}, not told:`, err instanceof Error ? err.message : "failed");
    return false;
  }
}

/**
 * A MOVED game (review H3): the ask follows the new kickoff (S2), and its
 * volunteers who have a place (CONFIRMED or on the bench) keep it and are
 * told the new time, once, in their own club's language. Nothing is
 * dropped and nobody becomes a past guest. Never throws.
 */
export async function tellGuestsMoved(askId: string, now: Date = new Date()): Promise<number> {
  void now;
  try {
    const ask = await db.partnerAsk.findUnique({
      where: { id: askId },
      select: { id: true, matchId: true, askerOrgId: true, partnerOrgId: true, volunteerUserIds: true, match: { select: { date: true } } },
    });
    if (!ask || ask.volunteerUserIds.length === 0) return 0;
    const [asker, partner, rows, users] = await Promise.all([
      db.organisation.findUnique({ where: { id: ask.askerOrgId }, select: { name: true } }),
      db.organisation.findUnique({ where: { id: ask.partnerOrgId }, select: { id: true, language: true } }),
      db.attendance.findMany({ where: { matchId: ask.matchId, userId: { in: ask.volunteerUserIds } }, select: { userId: true, status: true } }),
      db.user.findMany({ where: { id: { in: ask.volunteerUserIds } }, select: { id: true, phoneNumber: true } }),
    ]);
    if (!asker || !partner) return 0;
    const phoneOf = new Map(users.map((u) => [u.id, u.phoneNumber]));
    const text = t(partner.language).xask_moved_dm({ asker: asker.name, day: dayCommaTimeLabel(partner.language, ask.match.date) });
    let told = 0;
    for (const r of rows) {
      if (r.status !== "CONFIRMED" && r.status !== "BENCH") continue;
      const phone = phoneOf.get(r.userId);
      if (!phone) continue;
      await db.botJob.create({ data: { orgId: partner.id, kind: "dm", phone: phone.replace(/^\+/, ""), text } });
      told++;
    }
    return told;
  } catch (err) {
    console.error(`[partner-guest] ask ${askId}: telling guests of the move failed:`, err instanceof Error ? err.message : "failed");
    return 0;
  }
}

// ── The pool's entry points (local player pool L5a, 2026-10-24) ─────────

export interface PoolGuestWrite {
  offerId: string;
  userId: string;
  orgId: string;
  matchId: string;
  benchPickMode: string | null;
  /** The round's fill (`pool/round.ts` `poolAskFill`), read under the lock. */
  fill: () => Promise<RoundFill | null>;
  now: Date;
}

export type PoolGuestPlaced =
  | { kind: "in" | "bench"; roundNowFull: boolean }
  | { kind: "gone" }
  | { kind: "failed" };

/**
 * A pool player said yes by the tap link. The CALLER (`pool/accept.ts`)
 * has already claimed the offer (a compare-and-set on its outcome, so a
 * double tap writes once) and gives it back if this says "gone" or
 * "failed". Here he is placed under the club's rule and his `GuestPlace`
 * row written. Lost the race (the round has its number): nothing written.
 * Never throws.
 */
export async function placePoolGuest(w: PoolGuestWrite): Promise<PoolGuestPlaced> {
  try {
    const mem = await db.membership.findUnique({ where: { userId_orgId: { userId: w.userId, orgId: w.orgId } }, select: { leftAt: true, ...GUEST_MARKS } });
    const ordinary = !!mem && !mem.leftAt && !isGuestMembership(mem);
    const event = {
      cause: "pool-ask" as const,
      actorKind: "player" as const,
      actorUserId: w.userId,
      sourceRef: `pool-offer:${w.offerId}`,
      note: "MatchTime player pool: said yes by the offer link",
    };
    const writePlace = async () => {
      if (!ordinary) {
        const liveHere = !!mem && !mem.leftAt && mem.guestMatchId === w.matchId;
        await db.membership.upsert({
          where: { userId_orgId: { userId: w.userId, orgId: w.orgId } },
          create: { userId: w.userId, orgId: w.orgId, role: "PLAYER", guestVia: "pool", guestMatchId: w.matchId },
          update: liveHere ? {} : { leftAt: null, guestVia: "pool", guestFromOrgId: null, guestMatchId: w.matchId },
        });
      }
      return registerAttendance(w.userId, w.matchId, { event, actorIsAdmin: false });
    };
    let result: Awaited<ReturnType<typeof registerAttendance>>;
    let roundNowFull = false;
    if (normaliseBenchPickMode(w.benchPickMode) === "organiser") {
      result = await writePlace();
    } else {
      const locked = await underRoundLock(w.matchId, w.fill, writePlace);
      if (!locked) {
        console.log(`[partner-guest] pool offer ${w.offerId}: ${w.userId} too late, the round has its number`);
        return { kind: "gone" };
      }
      result = locked.r;
      roundNowFull = locked.full;
    }
    if (result.status !== "CONFIRMED" && result.status !== "BENCH") return { kind: "failed" };
    if (!ordinary) {
      await db.guestPlace.upsert({
        where: { matchId_userId: { matchId: w.matchId, userId: w.userId } },
        create: { orgId: w.orgId, matchId: w.matchId, userId: w.userId, source: "pool", poolOfferId: w.offerId },
        update: { source: "pool", fromOrgId: null, partnerAskId: null, poolOfferId: w.offerId, result: "booked", resultAt: null, resultById: null },
      });
    }
    console.log(`[partner-guest] pool offer ${w.offerId}: ${w.userId} on match ${w.matchId} as ${result.status}${ordinary ? " (member)" : " (pool guest)"}`);
    return { kind: result.status === "CONFIRMED" ? "in" : "bench", roundNowFull };
  } catch (err) {
    console.error(`[partner-guest] pool offer ${w.offerId}: ${w.userId} not written:`, err instanceof Error ? err.message : "failed");
    return { kind: "failed" };
  }
}

/**
 * A pool guest gives his place back (the offer page's "I can't make it"):
 * his row dropped (cause "pool-ask"; the normal drop flow and the bench
 * offer follow, as for any OUT), his `GuestPlace` marked `result` (in time
 * or late, `pool/round-rules.ts` `pullOutResult`), and he becomes a past
 * guest. True when there was a place to give back.
 */
export async function withdrawPoolGuest(args: { userId: string; matchId: string; orgId: string; offerId: string; result: "withdrawn" | "late-cancel"; now: Date }): Promise<boolean> {
  const mem = await db.membership.findUnique({ where: { userId_orgId: { userId: args.userId, orgId: args.orgId } }, select: { leftAt: true, ...GUEST_MARKS } });
  if (!mem || mem.leftAt || mem.guestVia !== "pool" || mem.guestMatchId !== args.matchId) return false;
  const row = await db.attendance.findUnique({ where: { matchId_userId: { matchId: args.matchId, userId: args.userId } }, select: { status: true } });
  if (!row || (row.status !== "CONFIRMED" && row.status !== "BENCH")) return false;
  await cancelAttendance(args.userId, args.matchId, {
    cause: "pool-ask",
    actorKind: "player",
    actorUserId: args.userId,
    sourceRef: `pool-offer:${args.offerId}`,
    note: "MatchTime player pool: gave the place back by the offer link",
  });
  await db.guestPlace.updateMany({ where: { matchId: args.matchId, userId: args.userId, result: "booked" }, data: { result: args.result, resultAt: args.now } });
  await db.membership.updateMany({ where: { userId: args.userId, orgId: args.orgId, guestMatchId: args.matchId, leftAt: null }, data: { leftAt: args.now } });
  console.log(`[partner-guest] pool offer ${args.offerId}: ${args.userId} gave the place back (${args.result})`);
  return true;
}
