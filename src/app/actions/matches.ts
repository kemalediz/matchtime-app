"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { matchScoreSchema } from "@/lib/validations";
import { requireOrgAdmin } from "@/lib/org";
import { recordAttendanceEvent } from "@/lib/attendance-events";
import { revalidatePath } from "next/cache";
import { sendRatingEmails } from "@/lib/email";
import { formatLondon } from "@/lib/london-time";
import { buildFormatSwitchAnnouncement, buildMatchCancelledAnnouncement } from "@/lib/group-copy";
import { dayTimeLabel } from "@/lib/i18n/dates";
import { normaliseLang } from "@/lib/i18n/lang";
import { computeEloDeltas } from "@/lib/elo";
import { applyMembershipEloDeltas, loadMembershipEloInputs } from "@/lib/membership-elo";
import {
  planFormatSwitchSchedule,
  renderKickoffMoveLine,
} from "@/lib/format-switch-time";

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
    include: { activity: { include: { sport: true, org: { select: { language: true } } } } },
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
      `Can't switch from ${match.activity.sport.name} to ${newActivity.sport.name} — different sports`,
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

  await db.botJob.create({
    data: {
      orgId: match.activity.orgId,
      kind: "group",
      // The words live in `group-copy.ts` (pure, golden-pinned).
      text: buildFormatSwitchAnnouncement({
        sportName: newActivity.sport.name,
        maxPlayers: newMaxPlayers,
        kickoffLine,
        playing: fresh.map((a) => a.user.name),
        bench: benchList.map((a) => a.user.name),
        lang,
      }),
    },
  });

  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/admin/matches/${matchId}/teams`);
}

/**
 * Cancel a match entirely. Sets status=CANCELLED; scheduler gates every
 * subsequent trigger on that, so no more reminders/polls fire. Queues a
 * group-message announcing the cancellation.
 */
export async function cancelMatch(matchId: string) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { activity: { select: { orgId: true, name: true, org: { select: { language: true } } } } },
  });
  if (!match) throw new Error("Match not found");
  if (match.status === "CANCELLED") return; // idempotent
  if (match.status === "COMPLETED") throw new Error("Match is already completed");

  await requireOrgAdmin(session.user.id, match.activity.orgId);

  await db.match.update({
    where: { id: matchId },
    data: { status: "CANCELLED" },
  });

  await db.botJob.create({
    data: {
      orgId: match.activity.orgId,
      kind: "group",
      text: buildMatchCancelledAnnouncement({
        activityName: match.activity.name,
        whenLabel: dayTimeLabel(normaliseLang(match.activity.org?.language), match.date),
        lang: normaliseLang(match.activity.org?.language),
      }),
    },
  });

  revalidatePath(`/matches/${matchId}`);
  revalidatePath(`/admin/matches/${matchId}/teams`);
  revalidatePath("/matches");
}

export async function updateMatchScore(matchId: string, formData: { redScore: number; yellowScore: number }) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not authenticated");

  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { activity: true },
  });
  if (!match) throw new Error("Match not found");

  await requireOrgAdmin(session.user.id, match.activity.orgId);

  const parsed = matchScoreSchema.parse(formData);

  // Pull the team assignments so we can compute Elo deltas alongside
  // the update that persists the score. The ratings themselves come
  // from this club's memberships at apply time, not from the user.
  const before = await db.match.findUnique({
    where: { id: matchId },
    include: {
      teamAssignments: { select: { userId: true, team: true } },
    },
  });

  const updated = await db.match.update({
    where: { id: matchId },
    data: {
      redScore: parsed.redScore,
      yellowScore: parsed.yellowScore,
      status: "COMPLETED",
    },
    include: {
      activity: true,
      attendances: {
        where: { status: "CONFIRMED" },
        include: { user: { select: { email: true, name: true } } },
      },
    },
  });

  // Apply Elo updates — only to players who were in teamAssignments, not
  // generic attendees (in case teams were generated but some players never
  // assigned). Fails open: log and continue if something's off.
  try {
    if (before?.teamAssignments?.length) {
      // The club is the one already authorised against a few lines up,
      // so an admin at one club can never move another club's Elo.
      const orgId = match.activity.orgId;
      const { inputs } = await loadMembershipEloInputs({
        orgId,
        assignments: before.teamAssignments,
      });
      const deltas = computeEloDeltas(inputs, parsed.redScore, parsed.yellowScore);
      await applyMembershipEloDeltas({ orgId, deltas });
    }
  } catch (err) {
    console.error("Elo update failed (match will still be COMPLETED):", err);
  }

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

  revalidatePath(`/matches/${matchId}`);
  revalidatePath("/matches");
}
