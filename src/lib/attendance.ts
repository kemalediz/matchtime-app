import { db } from "./db";
import { requestBenchConfirmationOnDrop, queueSlotEmojiRefresh } from "./bot-scheduler";

export async function registerAttendance(
  userId: string,
  matchId: string,
  options: {
    /** When true, force BENCH regardless of squad capacity. Used when a
     *  player explicitly self-declares "for bench" / "I'll bench" — we
     *  respect their stated intent rather than letting capacity logic
     *  promote them to a confirmed slot they didn't ask for. */
    forceBench?: boolean;
  } = {},
) {
  const match = await db.match.findUnique({
    where: { id: matchId },
    include: { activity: { select: { orgId: true } } },
  });
  if (!match) throw new Error("Match not found");

  // Deadline check removed 2026-05-06 (Kemal's call): players can
  // register all the way up to match completion. Late INs on a full
  // squad just go to the bench — the squad-capacity logic below
  // handles that. Once the match is COMPLETED or CANCELLED the
  // analyze route's findRegistrationMatch returns null so we never
  // get here in the first place.
  //
  // BUT: block registrations for a FUTURE match while a previous
  // scheduled match in the same org is still in flight (UPCOMING/
  // TEAMS_GENERATED/TEAMS_PUBLISHED with date < today). This stops
  // the dashboard's "I'm in" button on next week's match from
  // working before this week's match has been completed by the
  // cron. Without this guard, the same race that bit the WhatsApp
  // analyzer (Kemal/Izzet/Baki silently registered for the May 12
  // match minutes after the May 5 match-day deadline) would happen
  // again via the UI. Mirrors the rule in
  // analyze/route.ts:findRegistrationMatch.
  {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    if (match.date >= todayStart) {
      const inFlight = await db.match.findFirst({
        where: {
          activity: { orgId: match.activity.orgId },
          status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] },
          date: { lt: todayStart },
          id: { not: matchId },
        },
        select: { id: true, date: true },
      });
      if (inFlight) {
        throw new Error(
          `Previous match (${inFlight.date.toISOString().slice(0, 10)}) hasn't been completed yet — can't register for the next one yet.`,
        );
      }
    }
  }

  // Idempotency: if the user is already CONFIRMED or BENCH for this
  // match, don't touch position/status — UNLESS the new request is an
  // explicit forceBench AND they're currently CONFIRMED. That means
  // they retroactively want bench (e.g. "actually put me on bench").
  const existing = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId } },
  });
  if (existing && (existing.status === "CONFIRMED" || existing.status === "BENCH")) {
    const wantsBenchDowngrade =
      options.forceBench === true && existing.status === "CONFIRMED";
    if (!wantsBenchDowngrade) {
      const all = await db.attendance.findMany({
        where: { matchId, status: { in: ["CONFIRMED", "BENCH"] } },
        orderBy: { position: "asc" },
      });
      const confirmed = all.filter((a) => a.status === "CONFIRMED");
      const bench = all.filter((a) => a.status === "BENCH");
      const slot =
        existing.status === "CONFIRMED"
          ? confirmed.findIndex((a) => a.userId === userId) + 1
          : bench.findIndex((a) => a.userId === userId) + 1;
      return {
        status: existing.status,
        position: existing.position,
        slot,
        confirmedCount: confirmed.length,
        maxPlayers: match.maxPlayers,
      };
    }
  }

  const maxPos = await db.attendance.aggregate({
    where: { matchId },
    _max: { position: true },
  });
  const nextPosition = (maxPos._max.position ?? 0) + 1;

  const confirmedCount = await db.attendance.count({
    where: { matchId, status: "CONFIRMED" },
  });
  const benchCount = await db.attendance.count({
    where: { matchId, status: "BENCH" },
  });

  const status = options.forceBench
    ? "BENCH"
    : confirmedCount < match.maxPlayers
      ? "CONFIRMED"
      : "BENCH";

  // For an existing CONFIRMED row downgrading to BENCH, keep their
  // existing position so we don't shuffle the slot list.
  const positionToWrite =
    existing && options.forceBench && existing.status === "CONFIRMED"
      ? existing.position
      : nextPosition;

  const attendance = await db.attendance.upsert({
    where: { matchId_userId: { matchId, userId } },
    create: { matchId, userId, status, position: positionToWrite },
    update: { status, position: positionToWrite, respondedAt: new Date() },
  });

  // Friendly "slot" the bot uses for its reaction emoji. If the player
  // made the squad, their slot is their 1-indexed place in the squad
  // (equals the new confirmed count). If they landed on the bench, it's
  // their 1-indexed bench slot.
  const slot =
    status === "CONFIRMED" ? confirmedCount + 1 : benchCount + 1;

  // If we forced BENCH on a previously-confirmed user, slots may have
  // shifted up for others — refresh emojis like cancelAttendance does.
  if (existing?.status === "CONFIRMED" && status === "BENCH") {
    await queueSlotEmojiRefresh(matchId);
  }

  return {
    status: attendance.status,
    position: attendance.position,
    slot,
    confirmedCount:
      confirmedCount + (status === "CONFIRMED" && existing?.status !== "CONFIRMED" ? 1 : 0) -
      (existing?.status === "CONFIRMED" && status === "BENCH" ? 1 : 0),
    maxPlayers: match.maxPlayers,
  };
}

export async function cancelAttendance(userId: string, matchId: string) {
  const match = await db.match.findUnique({ where: { id: matchId } });
  if (!match) throw new Error("Match not found");

  // Deadline check removed 2026-05-06 — symmetric with
  // registerAttendance. Players can drop all the way to kickoff;
  // late OUTs trigger the bench-promote chain regardless of how
  // close to kickoff the drop happens.

  const attendance = await db.attendance.findUnique({
    where: { matchId_userId: { matchId, userId } },
  });

  if (!attendance) throw new Error("Not attending this match");

  const wasConfirmed = attendance.status === "CONFIRMED";

  await db.attendance.update({
    where: { id: attendance.id },
    data: { status: "DROPPED" },
  });

  // If someone in the confirmed 14 dropped, we DON'T auto-promote any more.
  // Instead we ask the first bench player via WhatsApp 👍/👎 first (they
  // may have mentally checked out). The bot-scheduler creates a
  // PendingBenchConfirmation; subsequent /due-posts cycles post the prompt
  // and handle confirmation/timeout.
  if (wasConfirmed) {
    // Pass the dropped user's id so the bench-prompt knows which team
    // slot is being filled. On 👍 the reaction handler will transfer
    // this user's TeamAssignment to the bench player and announce the
    // swap to the group.
    await requestBenchConfirmationOnDrop(matchId, userId);
    // Slots have shifted up — queue retroactive react updates so
    // every confirmed player's IN message shows their NEW slot emoji.
    // Idempotent and bounded; bot picks them up on its next 5-min tick.
    await queueSlotEmojiRefresh(matchId);
  }

  return { status: "DROPPED" as const };
}
