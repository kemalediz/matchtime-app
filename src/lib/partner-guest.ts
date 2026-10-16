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
 *              organisers told, and a reply to him in his own group;
 *   withdraw   his row on the asking club's match dropped, same cause;
 *   refuse     one plain reply (closed, unknown, an overlapping game of
 *              his own, not on the list) and nothing written.
 *
 * Whether he plays is the asking club's own rule: an organiser-pick club
 * puts every IN on the bench for its organisers to pick, a first-come
 * club confirms while there is room (`registerAttendance` decides, as for
 * any player). Replies are in HIS club's language (D9); the notice to the
 * asking club in its own. Logs carry ids only.
 */
import { db } from "./db";
import { registerAttendance, cancelAttendance } from "./attendance";
import { sendAdminNotice } from "./admin-channel";
import { dayCommaTimeLabel, timeLabel } from "./i18n/dates";
import { t } from "./i18n/t";
import { gamesOverlap } from "./partner-ask-rules";
import { decideVolunteer } from "./partner-volunteer-rules";

const LIVE = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] as const;

export interface VolunteerWrite {
  askId: string;
  userId: string | null;
  name: string;
  polarity: "in" | "out";
  sourceMessageId: string;
}

export interface VolunteerResult {
  ok: boolean;
  /** What happened, for the message's log line. */
  outcome: "registered-bench" | "registered-in" | "withdrawn" | "closed" | "unknown-sender" | "overlap" | "not-on-list" | "failed";
  /** The reply to the volunteer, in his own group. */
  replyText: string | null;
}

/** His own club's live game overlapping the asking club's, with him in it. */
async function inOverlappingOwnGame(userId: string, partnerOrgId: string, kickoff: Date, durationMins: number): Promise<{ yes: boolean; time: string | null }> {
  const rows = await db.attendance.findMany({
    where: {
      userId,
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

export async function handlePartnerVolunteer(w: VolunteerWrite, now: Date = new Date()): Promise<VolunteerResult> {
  const ask = await db.partnerAsk.findUnique({
    where: { id: w.askId },
    select: {
      id: true,
      status: true,
      closesAt: true,
      askerOrgId: true,
      partnerOrgId: true,
      matchId: true,
      volunteerUserIds: true,
      match: { select: { date: true, activity: { select: { matchDurationMins: true } } } },
    },
  });
  if (!ask) return { ok: false, outcome: "failed", replyText: null };
  const [asker, partner] = await Promise.all([
    db.organisation.findUnique({ where: { id: ask.askerOrgId }, select: { id: true, name: true, language: true } }),
    db.organisation.findUnique({ where: { id: ask.partnerOrgId }, select: { id: true, name: true, language: true } }),
  ]);
  if (!asker || !partner) return { ok: false, outcome: "failed", replyText: null };
  const ps = t(partner.language);
  const name = w.name.trim().split(/\s+/)[0] || w.name;

  const [partnerMember, askerMember, row] = w.userId
    ? await Promise.all([
        db.membership.findUnique({ where: { userId_orgId: { userId: w.userId, orgId: partner.id } }, select: { leftAt: true, guestFromOrgId: true } }),
        db.membership.findUnique({ where: { userId_orgId: { userId: w.userId, orgId: asker.id } }, select: { id: true, leftAt: true, guestFromOrgId: true } }),
        db.attendance.findUnique({ where: { matchId_userId: { matchId: ask.matchId, userId: w.userId } }, select: { status: true } }),
      ])
    : [null, null, null];
  const overlap = w.userId
    ? await inOverlappingOwnGame(w.userId, partner.id, ask.match.date, ask.match.activity.matchDurationMins)
    : { yes: false, time: null };

  const decision = decideVolunteer({
    polarity: w.polarity,
    askOpen: ask.status === "posted" && now.getTime() < ask.closesAt.getTime(),
    // A partner member who is himself a guest there is not that club's.
    senderIsPartnerMember: !!partnerMember && !partnerMember.leftAt && !partnerMember.guestFromOrgId,
    inOverlappingOwnGame: overlap.yes,
    ordinaryAskerMember: !!askerMember && !askerMember.leftAt && !askerMember.guestFromOrgId,
    onAskerMatch: !!row && (row.status === "CONFIRMED" || row.status === "BENCH"),
  });

  if (decision.kind === "refuse") {
    const replyText =
      decision.why === "closed"
        ? ps.xask_vol_closed({ asker: asker.name })
        : decision.why === "unknown-sender"
          ? ps.xask_vol_unknown({ club: partner.name })
          : decision.why === "overlap"
            ? ps.xask_vol_overlap({ club: partner.name, time: overlap.time ?? "", asker: asker.name })
            : ps.xask_vol_not_on({ asker: asker.name });
    console.log(`[partner-guest] ask ${ask.id}: ${w.userId ?? "unknown sender"} refused (${decision.why})`);
    return { ok: true, outcome: decision.why, replyText };
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

  try {
    if (decision.kind === "withdraw") {
      await cancelAttendance(userId, ask.matchId, event);
      await db.partnerAsk.updateMany({
        where: { id: ask.id },
        data: { volunteerUserIds: ask.volunteerUserIds.filter((id) => id !== userId) },
      });
      await sendAdminNotice({
        orgId: asker.id,
        now,
        holdOvernight: false,
        text: t(askerLang).xask_vol_out_notice_asker({ name: w.name, partner: partner.name, day }),
      });
      console.log(`[partner-guest] ask ${ask.id}: ${userId} withdrew`);
      return { ok: true, outcome: "withdrawn", replyText: ps.xask_vol_out({ asker: asker.name }) };
    }

    if (decision.asGuest) {
      // A guest for this one match (plan 3.7). One membership per club and
      // person: a past guest of this club plays for it again on the same
      // row, so his rating here carries on.
      await db.membership.upsert({
        where: { userId_orgId: { userId, orgId: asker.id } },
        create: { userId, orgId: asker.id, role: "PLAYER", guestFromOrgId: partner.id, guestMatchId: ask.matchId },
        update: { leftAt: null, guestFromOrgId: partner.id, guestMatchId: ask.matchId },
      });
    }
    const result = await registerAttendance(userId, ask.matchId, { event, actorIsAdmin: false });
    if (!ask.volunteerUserIds.includes(userId)) {
      await db.partnerAsk.updateMany({ where: { id: ask.id }, data: { volunteerUserIds: { push: userId } } });
    }
    const bench = result.status === "BENCH";
    await sendAdminNotice({
      orgId: asker.id,
      now,
      holdOvernight: false,
      text: t(askerLang).xask_vol_notice_asker({ name: w.name, partner: partner.name, day, bench }),
    });
    console.log(`[partner-guest] ask ${ask.id}: ${userId} on match ${ask.matchId} as ${result.status}${decision.asGuest ? " (guest)" : ""}`);
    return {
      ok: true,
      outcome: bench ? "registered-bench" : "registered-in",
      replyText: bench
        ? ps.xask_vol_bench({ name, asker: asker.name })
        : ps.xask_vol_in({ name, asker: asker.name, day: dayCommaTimeLabel(partner.language, ask.match.date) }),
    };
  } catch (err) {
    console.error(`[partner-guest] ask ${ask.id}: ${userId} not written:`, err instanceof Error ? err.message : "failed");
    return { ok: false, outcome: "failed", replyText: ps.xask_vol_failed };
  }
}
