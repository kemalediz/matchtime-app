/**
 * SWITCH A MATCH TO ANOTHER OF THE CLUB'S FORMATS (another Activity, with its
 * own players a side and kickoff): Sutton's Tuesday 7-a-side to 5-a-side.
 * Moved here from `app/actions/matches.ts` (2026-11-03, review of #517) so
 * an organiser can ask for it by tagging MatchTime too ("@Match Time switch
 * to 5 a side", `format-switch-words.ts`); the switch page's server action
 * calls it after its own admin check. The behaviour is the action's, byte
 * for byte.
 *
 * NO AUTHORISATION LIVES HERE: every caller checks the organiser first.
 *
 * Re-points `activityId`, re-cuts the squad (the first `newMaxPlayers`
 * confirmed stay, the rest go to the bench; DROPPED untouched), moves the
 * kickoff to the new Activity's time unless it was set by hand
 * (`format-switch-time.ts`), and posts the new lineup.
 */
import { db } from "./db";
import { recordAttendanceEvent } from "./attendance-events";
import { buildFormatSwitchAnnouncement } from "./group-copy";
import { normaliseLang } from "./i18n/lang";
import { planFormatSwitchSchedule, renderKickoffMoveLine } from "./format-switch-time";
import { organisersAnnounce } from "./list-announcer";
import { buildOrganiserRelay } from "./organisers-list-copy";
import { sendAdminNotice } from "./admin-channel";
import { flexFormatCopy } from "./i18n/flex-format";
import { normaliseSquadMode } from "./squad-month-rules";

/**
 * A MONTHLY CLUB'S GAME STAYS ON ITS GAME (club summary B2, K8 a). A game is
 * matched to its month by its Activity (`monthPhaseFor`), so re-pointing a
 * month's game to another Activity would take it out of its month. Refused
 * for every match of a monthly club; its message is the organiser's reply,
 * on the web (the switch page shows it) and in WhatsApp. The size switch
 * inside the game (`format-resize.ts`) keeps the Activity and is the way a
 * monthly club plays another size.
 */
export class MonthlyGameStaysError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonthlyGameStaysError";
  }
}

export async function switchMatchToActivity(p: { matchId: string; newActivityId: string; actorUserId: string }): Promise<{ maxPlayers: number; kickoff: Date }> {
  const { matchId, newActivityId } = p;

  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { activity: { include: { sport: true, org: { select: { language: true, listAnnouncer: true, squadMode: true } } } } },
  });
  if (!match) throw new Error("Match not found");

  // Optional chaining: the unit test mocks the match without its org.
  const lang = normaliseLang(match.activity.org?.language);
  if (normaliseSquadMode(match.activity.org?.squadMode) === "monthly") {
    throw new MonthlyGameStaysError(flexFormatCopy(lang).monthlyKeepsGame({ activityName: match.activity.name }));
  }

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
            actorUserId: p.actorUserId,
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

  return { maxPlayers: newMaxPlayers, kickoff: schedule.move ? schedule.kickoff : match.date };
}
