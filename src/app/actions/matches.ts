"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { matchScoreSchema } from "@/lib/validations";
import { requireOrgAdmin } from "@/lib/org";
import { recordAttendanceEvent } from "@/lib/attendance-events";
import { revalidatePath } from "next/cache";
import { sendRatingEmails } from "@/lib/email";
import { formatLondon } from "@/lib/london-time";
import { buildFormatSwitchAnnouncement } from "@/lib/group-copy";
import { normaliseLang } from "@/lib/i18n/lang";
import { t } from "@/lib/i18n/t";
import { reconcileMatchElo, setMatchScore } from "@/lib/match-elo";
import { canEnterScore } from "@/lib/score-entry";
import {
  planFormatSwitchSchedule,
  renderKickoffMoveLine,
} from "@/lib/format-switch-time";
import { findCarryOverSource, seedRollingSquad } from "@/lib/rolling-squad";
import { organisersAnnounce } from "@/lib/list-announcer";
import { buildOrganiserRelay } from "@/lib/organisers-list-copy";
import { sendAdminNotice } from "@/lib/admin-channel";

/**
 * Switch a match's format by swapping its `activityId` to another activity
 * in the same org with the same sport *family* (football ↔ football) but
 * a different playersPerTeam. Typical use: Tuesday 7-a-side → Tuesday
 * 5-a-side when numbers are short.
 *
 * Attendance is re-evaluated: the first `newMaxPlayers` confirmed stay
 * CONFIRMED, anything beyond moves to BENCH. DROPPED stays DROPPED.
 *
 * The KICKOFF moves too. Each format is its own Activity with its own
 * London wall-clock `time` (Sutton prod: 7-a-side 21:30, 5-a-side 21:15),
 * and until 2026-09-08 this action left `Match.date` on the old format's
 * time — so every downstream post stated the wrong kickoff until an admin
 * noticed. `planFormatSwitchSchedule` owns that arithmetic, including
 * when NOT to move (same-time formats, and a kickoff an admin set
 * deliberately). See src/lib/format-switch-time.ts.
 */
export async function switchMatchFormat(matchId: string, newActivityId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { activity: { include: { sport: true, org: { select: { language: true, listAnnouncer: true } } } } },
  });
  if (!match) throw new Error("Match not found");

  await requireOrgAdmin(session.user.id, match.activity.orgId);
  // Optional chaining: the unit test mocks the match without its org.
  const lang = normaliseLang(match.activity.org?.language);

  const newActivity = await db.activity.findFirst({
    where: { id: newActivityId, orgId: match.activity.orgId },
    include: { sport: true },
  });
  if (!newActivity) throw new Error("Target activity not found or not in your org");

  // Same-sport check — we don't let admin turn a football match into a
  // basketball one by accident.
  if (newActivity.sport.name.split(" ")[0] !== match.activity.sport.name.split(" ")[0]) {
    throw new Error(
      `Can't switch from ${match.activity.sport.name} to ${newActivity.sport.name}: they are different sports`,
    );
  }

  const newMaxPlayers = newActivity.sport.playersPerTeam * 2;

  // Kickoff + deadline. When the plan says "don't move", the update must
  // carry NEITHER key — a no-op has to be a no-op, not a rewrite with
  // identical values.
  const schedule = planFormatSwitchSchedule({
    currentKickoff: match.date,
    currentActivityTime: match.activity.time,
    newActivityTime: newActivity.time,
    newDeadlineHours: newActivity.deadlineHours,
  });

  await db.match.update({
    where: { id: matchId },
    data: {
      activityId: newActivity.id,
      maxPlayers: newMaxPlayers,
      ...(schedule.move
        ? {
            date: schedule.kickoff,
            attendanceDeadline: schedule.attendanceDeadline,
          }
        : {}),
    },
  });

  // Recompute attendance statuses. Confirmed + bench players are sorted by
  // their original position (earliest IN first), the first newMaxPlayers
  // stay/become CONFIRMED, the rest become BENCH. DROPPED is untouched.
  const attendances = await db.attendance.findMany({
    where: { matchId, status: { in: ["CONFIRMED", "BENCH"] } },
    orderBy: { position: "asc" },
  });
  // ONE transaction for the whole recut, so the log carries a single
  // `txId` for it. A format switch is one decision that moves several
  // players at once, and reading it back as N unrelated moves would
  // misrepresent exactly the incident (2026-08-30, "Najib + Mojib +
  // Mustafa go on the bench") this history is being kept for.
  await db.$transaction(async (tx) => {
    for (let i = 0; i < attendances.length; i++) {
      const shouldBe = i < newMaxPlayers ? "CONFIRMED" : "BENCH";
      if (attendances[i].status !== shouldBe) {
        await tx.attendance.update({
          where: { id: attendances[i].id },
          data: { status: shouldBe as "CONFIRMED" | "BENCH" },
        });
        await recordAttendanceEvent(
          tx,
          {
            matchId,
            userId: attendances[i].userId,
            orgId: match.activity.orgId,
            fromStatus: attendances[i].status,
            toStatus: shouldBe,
            fromPosition: attendances[i].position,
            toPosition: attendances[i].position,
          },
          {
            cause: "format-switch",
            actorKind: "admin",
            actorUserId: session.user!.id,
            sourceRef: `admin:switchMatchActivity:${newActivity.id}`,
            note: `squad recut to ${newMaxPlayers} places; ranked ${i + 1} by original position`,
          },
        );
      }
    }
  });

  // Queue a group announcement so the bot posts the new lineup. Server
  // creates a BotJob (text built with the updated roster); scheduler picks
  // it up on next tick.
  const fresh = await db.attendance.findMany({
    where: { matchId, status: "CONFIRMED" },
    include: { user: { select: { name: true } } },
    orderBy: { position: "asc" },
  });
  const benchList = await db.attendance.findMany({
    where: { matchId, status: "BENCH" },
    include: { user: { select: { name: true } } },
    orderBy: { position: "asc" },
  });

  // The incident was the group being told the wrong kickoff, so when the
  // switch moves it, say so in the same message. Empty when it didn't.
  const kickoffLine = renderKickoffMoveLine(schedule, lang);

  // The words live in `group-copy.ts` (pure, golden-pinned).
  const announcement = buildFormatSwitchAnnouncement({
    sportName: newActivity.sport.name,
    maxPlayers: newMaxPlayers,
    kickoffLine,
    playing: fresh.map((a) => a.user.name),
    bench: benchList.map((a) => a.user.name),
    lang,
  });
  // The club's organisers announce the list (2026-10-14, list-announcer.ts):
  // the post lists who is playing, so it goes to them, and they tell the
  // players. Same words, with a lead saying it was not posted in the group.
  if (organisersAnnounce(match.activity.org)) {
    await sendAdminNotice({ orgId: match.activity.orgId, text: buildOrganiserRelay(announcement, lang) });
  } else {
    await db.botJob.create({
      data: {
        orgId: match.activity.orgId,
        kind: "group",
        text: announcement,
      },
    });
  }

  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/admin/matches/${matchId}/teams`);
}

/**
 * Cancel a match entirely. Sets status=CANCELLED; scheduler gates every
 * subsequent trigger on that, so no more reminders/polls fire. Queues a
 * group-message announcing the cancellation.
 *
 * A match that has KICKED OFF (2026-10-28, "This game didn't happen" on the
 * match page): inside the 7-day window and with no score, the same core
 * marks it as not played (no announcement, nothing after the game) and the
 * returned `message` is the organiser's reply, shown on the page.
 */
export async function cancelMatch(matchId: string): Promise<{ message: string | null }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const match = await db.match.findUnique({
    where: { id: matchId },
    select: { status: true, activity: { select: { orgId: true, org: { select: { language: true } } } } },
  });
  if (!match) throw new Error("Match not found");
  if (match.status === "CANCELLED") return { message: null }; // idempotent

  await requireOrgAdmin(session.user.id, match.activity.orgId);

  // The status, a monthly club's credits and the players' group
  // announcement: the ONE path HQ's cancel uses too (lib/match-cancel.ts).
  const { cancelMatchById, notPlayedGameLabel, notPlayedReply } = await import("@/lib/match-cancel");
  const { PAST_CANCEL_WINDOW_DAYS } = await import("@/lib/match-cancel-rules");
  const lang = normaliseLang(match.activity.org?.language);
  const s = t(lang);
  const r = await cancelMatchById(matchId);
  if (r.kind === "completed") throw new Error("Match is already completed");
  if (r.kind === "too-old") throw new Error(s.not_played_too_old({ days: PAST_CANCEL_WINDOW_DAYS }));
  if (r.kind === "scored") throw new Error(s.not_played_scored({ game: notPlayedGameLabel(lang, r.activityName, r.date) }));
  let message: string | null = null;
  if (r.kind === "not-played") {
    const { buildCancelCreditLine } = await import("@/lib/month-close-copy");
    message = notPlayedReply(lang, r, r.creditedGames > 0 ? buildCancelCreditLine({ count: 1, lang }) : null);
  }

  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/admin/matches/${matchId}/teams`);
  revalidatePath("/matches");
  return { message };
}

/**
 * "It did happen" on the match page (2026-10-28): a game marked as not
 * played, inside the 7-day window, back on the record as played. The core
 * HQ uses (`restoreMatchById`): COMPLETED, nothing posted.
 */
export async function restorePlayedMatch(matchId: string): Promise<{ message: string }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const match = await db.match.findUnique({
    where: { id: matchId },
    select: { date: true, activity: { select: { orgId: true, org: { select: { language: true } } } } },
  });
  if (!match) throw new Error("Match not found");
  await requireOrgAdmin(session.user.id, match.activity.orgId);
  const { restoreMatchById, notPlayedGameLabel } = await import("@/lib/match-cancel");
  const { PAST_CANCEL_WINDOW_DAYS, isPastGame } = await import("@/lib/match-cancel-rules");
  const lang = normaliseLang(match.activity.org?.language);
  const s = t(lang);
  const now = new Date();
  // This button is for a game that kicked off; one still to come is put
  // back on from the matches list, which tells the players' group.
  if (!isPastGame(match.date, now)) throw new Error(s.not_played_restore_none({ days: PAST_CANCEL_WINDOW_DAYS }));
  const r = await restoreMatchById(matchId, now);
  if (r.kind !== "restored") {
    throw new Error(r.kind === "past" ? s.not_played_too_old({ days: PAST_CANCEL_WINDOW_DAYS }) : s.not_played_restore_none({ days: PAST_CANCEL_WINDOW_DAYS }));
  }
  revalidatePath(`/matches/${matchId}`);
  revalidatePath("/matches");
  return { message: s.not_played_restored({ game: notPlayedGameLabel(lang, r.activityName, r.date) }) };
}

export async function updateMatchScore(matchId: string, formData: { redScore: number; yellowScore: number }) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { activity: { include: { org: { select: { language: true } } } } },
  });
  if (!match) throw new Error("Match not found");

  await requireOrgAdmin(session.user.id, match.activity.orgId);

  // Only a PLAYED match takes a score (src/lib/score-entry.ts): the page
  // offers the box on the same rule, and a score marks the match
  // COMPLETED, which a cancelled match or one still to come must not be.
  if (!canEnterScore(match)) {
    throw new Error(t(normaliseLang(match.activity.org?.language)).score_entry_err_not_played);
  }

  const parsed = matchScoreSchema.parse(formData);
  /** Set when the score was saved and the Elo could NOT be recalculated
   *  (`match-elo.ts`, `legacy_left`). Returned so the page can show it:
   *  a console line is not something an admin ever reads. */
  let eloNote: string | null = null;

  // THE SCORE, THEN THE ELO IT IMPLIES (2026-10-07). Two steps on
  // purpose, both in `lib/match-elo.ts`: the score is the fact and must
  // land even if the Elo pass fails. `reconcileMatchElo` takes back the
  // points the previous result added before adding this one's, and does
  // nothing when the score has not changed. Until today this action
  // added the entered result's points on every save: a corrected score
  // left the ratings carrying both results, and saving twice added the
  // same result twice (`__tests__/update-match-score-elo.test.ts`).
  const { previous } = await setMatchScore({
    matchId,
    red: parsed.redScore,
    yellow: parsed.yellowScore,
  });

  try {
    const elo = await reconcileMatchElo({ matchId });
    if (elo.status === "legacy_left") {
      console.warn(`[updateMatchScore] match ${matchId}: Elo not recalculated. ${elo.detail}`);
      eloNote = t(normaliseLang(match.activity.org?.language)).score_elo_left_note;
    } else if (elo.status === "no_teams") {
      eloNote = t(normaliseLang(match.activity.org?.language)).score_elo_no_teams_note;
    }
  } catch (err) {
    console.error("Elo update failed (match will still be COMPLETED):", err);
  }

  // The "rate the match" email goes out when the match first gets a
  // result. A correction is not a new match to rate.
  if (!previous) {
    const updated = await db.match.findUnique({
      where: { id: matchId },
      include: {
        activity: true,
        attendances: {
          where: { status: "CONFIRMED" },
          include: { user: { select: { email: true, name: true } } },
        },
      },
    });
    if (updated) {
      const players = updated.attendances.map((a) => ({
        email: a.user.email,
        name: a.user.name,
      }));
      sendRatingEmails(
        matchId,
        updated.activity.name,
        formatLondon(updated.date, "EEEE, d MMMM yyyy"),
        players
      ).catch((err) => console.error("Failed to send rating emails:", err));
    }
  }

  revalidatePath(`/matches/${matchId}`);
  revalidatePath("/matches");
  return { eloNote };
}

/**
 * "Carry over last squad" on the match page (2026-09-30, plan 1.9).
 *
 * For a rolling-squad club whose match has no rows yet: copies the last
 * PLAYED match of the fixture onto it, with no lookback limit (a club
 * back from a summer break). Same writer as the 08:00 cron
 * (`seedRollingSquad`), recorded as the admin, and it claims the same
 * `rollingSeededAt`, so the cron never seeds it again and the rolling
 * announcement follows next morning.
 */
export async function carryOverLastSquad(matchId: string): Promise<{ carried: number }> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");
  const match = await db.match.findUnique({
    where: { id: matchId },
    select: { id: true, activity: { select: { orgId: true, org: { select: { rollingSquadEnabled: true } } } } },
  });
  if (!match) throw new Error("Match not found");
  await requireOrgAdmin(session.user.id, match.activity.orgId);
  if (!match.activity.org.rollingSquadEnabled) {
    throw new Error("Turn on the rolling squad in Settings first");
  }

  const source = await findCarryOverSource(matchId);
  if (!source) return { carried: 0 };
  const res = await seedRollingSquad({
    targetId: matchId,
    sourceId: source.id,
    actor: { kind: "admin", userId: session.user.id },
  });
  revalidatePath(`/matches/${matchId}`);
  return { carried: res.carried };
}
