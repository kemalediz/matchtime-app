/**
 * SWITCHING THE OPEN SQUAD ON OR OFF (2026-11-17). The ONE core the
 * settings page (`setOpenSquadSetting`, app/actions/org.ts) and the
 * WhatsApp tag (the admin extractor's `open_squad` action, in the players'
 * group and the organisers' group) both call, so the two cannot differ.
 * Rules: open-squad.ts.
 *
 *   on   `Organisation.openSquad` is set. No format is asked for: the
 *        places are simply not read as a cap from now on. A player still
 *        waiting on the bench of a game to come is brought in (there is no
 *        bench any more) through the one attendance writer, so the log
 *        says why, and the reply names them. Nobody is DMed.
 *   off  the flag is cleared. The places fall back to the game's own
 *        format (`Match.maxPlayers`, never touched by this setting), and
 *        every player already in STAYS in: nothing here, and nothing after
 *        it, bumps a confirmed player to make the squad fit. New INs past
 *        the places go on the bench, as before the setting existed.
 *
 * Callers check the organiser (an OWNER or ADMIN) first.
 */
import { db } from "./db";
import { t } from "./i18n/t";
import { joinList } from "./i18n/text";
import { openSquadMinimum } from "./open-squad";
import { matchFormatTitle } from "./match-format-title";
import { recordAttendanceEvent } from "./attendance-events";

const LIVE = ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] as const;

export interface OpenSquadReply {
  outcome: "open-squad-on" | "open-squad-off" | "open-squad-unchanged";
  replyText: string;
  /** Players brought in from the bench by switching it on. */
  movedUp: number;
}

/** The club's game, for the reply: its name, minimum and places. */
async function gameFacts(orgId: string, now: Date): Promise<{ name: string; min: number; places: number }> {
  const a = await db.activity.findFirst({
    where: { orgId, isActive: true },
    orderBy: { createdAt: "asc" },
    select: {
      name: true,
      minPlayers: true,
      sport: { select: { playersPerTeam: true } },
      matches: { where: { date: { gt: now }, status: { in: [...LIVE] } }, orderBy: { date: "asc" }, take: 1, select: { maxPlayers: true } },
    },
  });
  const perTeam = a?.sport?.playersPerTeam ?? 7;
  return {
    name: a?.name ?? "",
    min: openSquadMinimum({ minPlayers: a?.minPlayers ?? null, playersPerTeam: perTeam }),
    places: a?.matches?.[0]?.maxPlayers ?? perTeam * 2,
  };
}

/**
 * THE MINIMUM OF AN OPEN SQUAD'S GAME, by WhatsApp ("@Match Time we can
 * play with 12") or the activities page: any whole number from 2, with no
 * format to check it against; null is back to two full sides of the sport.
 * A most is refused: there is none while the squad has no limit.
 */
export async function saveOpenSquadMinimum(p: {
  activityId: string;
  /** The minimum said; null: back to two full sides. */
  min: number | null;
  /** A most was said too (refused when no minimum is). */
  maxAsked?: boolean;
  lang: string | null;
}): Promise<{ outcome: "player-range-set" | "player-range-cleared" | "player-range-unchanged" | "player-range-refused"; replyText: string }> {
  const s = t(p.lang);
  if (p.min === null && p.maxAsked) return { outcome: "player-range-refused", replyText: s.os_no_max };
  if (p.min !== null && !(Number.isInteger(p.min) && p.min >= 2 && p.min <= 99)) return { outcome: "player-range-refused", replyText: s.os_min_refused };
  const a = await db.activity.findUnique({
    where: { id: p.activityId },
    select: { name: true, minPlayers: true, maxPlayers: true, sport: { select: { playersPerTeam: true } } },
  });
  if (!a) return { outcome: "player-range-refused", replyText: s.os_min_refused };
  const activityName = matchFormatTitle(a.name, null, { openSquad: true });
  const after = openSquadMinimum({ minPlayers: p.min, playersPerTeam: a.sport.playersPerTeam });
  if ((a.minPlayers ?? null) === p.min) return { outcome: "player-range-unchanged", replyText: s.os_min_unchanged({ activityName, min: after }) };
  await db.activity.update({ where: { id: p.activityId }, data: { minPlayers: p.min } });
  console.log(`[open-squad] activity=${p.activityId} minimum ${p.min ?? "two full sides"}`);
  return { outcome: p.min === null ? "player-range-cleared" : "player-range-set", replyText: s.os_min_set({ activityName, min: after }) };
}

/** The slice of a Prisma client (or transaction) the promotion uses. */
type PromoteClient = Pick<typeof db, "attendance" | "attendanceEvent">;

/**
 * NO BENCH, MADE TRUE (review of #623). Every BENCH row on a game of this
 * club still to be played goes straight to CONFIRMED, keeping its place in
 * the list, each with its event. Directly, not through
 * `registerAttendance`: that writer has guards for a single IN (a previous
 * match still in flight, the squad lock's count) that must never leave a
 * player on a bench that no longer exists. A row moved by someone else in
 * between is left alone (`updateMany` on BENCH). Returns who moved.
 */
async function promoteBenchRows(
  client: PromoteClient,
  orgId: string,
  now: Date,
  actor: { kind: "admin" | "scheduler"; userId: string | null; sourceRef: string },
): Promise<Array<{ matchId: string; userId: string; name: string | null }>> {
  const waiting = await client.attendance.findMany({
    where: { status: "BENCH", match: { activity: { orgId }, status: { in: [...LIVE] }, date: { gt: now } } },
    orderBy: [{ matchId: "asc" }, { position: "asc" }],
    select: { id: true, matchId: true, userId: true, position: true, user: { select: { name: true } } },
  });
  const moved: Array<{ matchId: string; userId: string; name: string | null }> = [];
  for (const w of waiting) {
    const { count } = await client.attendance.updateMany({
      where: { id: w.id, status: "BENCH" },
      data: { status: "CONFIRMED", benchByChoice: false, respondedAt: now },
    });
    if (count === 0) continue;
    await recordAttendanceEvent(
      client,
      { matchId: w.matchId, userId: w.userId, orgId, fromStatus: "BENCH", toStatus: "CONFIRMED", fromPosition: w.position, toPosition: w.position },
      { cause: "bench-moved-up", actorKind: actor.kind, actorUserId: actor.userId, sourceRef: actor.sourceRef, note: "no squad limit: there is no bench" },
    );
    moved.push({ matchId: w.matchId, userId: w.userId, name: w.user?.name ?? null });
  }
  return moved;
}

/** What follows a promotion, outside its transaction: the month's slot
 *  numbers and credits, and a seat on teams already made. Never throws. */
async function afterPromotion(moved: Array<{ matchId: string; userId: string }>): Promise<void> {
  const byMatch = new Map<string, string[]>();
  for (const m of moved) byMatch.set(m.matchId, [...(byMatch.get(m.matchId) ?? []), m.userId]);
  for (const [matchId, users] of byMatch) {
    try {
      const { afterMonthlyAttendanceChange } = await import("./monthly-week");
      for (const u of users) await afterMonthlyAttendanceChange(matchId, u, true);
      const { seatOpenSquadLateIns } = await import("./open-squad-seat");
      await seatOpenSquadLateIns(matchId);
    } catch (err) {
      console.error(`[open-squad] after promoting on ${matchId}:`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * THE SAFETY NET (review of #623): while the setting is on, any BENCH row
 * on an upcoming game is promoted. Run from the scheduler's existing bench
 * sweep (`sweepBenchFill`, every due-posts poll). One read for a club
 * with the setting off; never throws.
 */
export async function promoteOpenSquadBench(orgId: string, now: Date = new Date()): Promise<number> {
  try {
    const org = await db.organisation.findUnique({ where: { id: orgId }, select: { openSquad: true } });
    if (org?.openSquad !== true) return 0;
    const moved = await db.$transaction((tx) => promoteBenchRows(tx, orgId, now, { kind: "scheduler", userId: null, sourceRef: "scheduler:open-squad" }));
    if (moved.length > 0) {
      console.log(`[open-squad] org=${orgId} safety net promoted ${moved.map((m) => m.userId).join(",")}`);
      await afterPromotion(moved);
    }
    return moved.length;
  } catch (err) {
    console.error(`[open-squad] safety net for ${orgId} failed:`, err);
    return 0;
  }
}

export async function setOpenSquad(p: { orgId: string; on: boolean; actorUserId: string | null; now: Date }): Promise<OpenSquadReply> {
  const game = await gameFacts(p.orgId, p.now);
  // THE FLAG AND THE BENCH, ONE TRANSACTION (review of #623). Switching it
  // on, or asking for it when it is already on, empties any bench left on
  // a game to come: idempotent, so a bench the first switch missed is
  // still emptied by the second.
  const done = await db.$transaction(async (tx) => {
    const org = await tx.organisation.findUnique({ where: { id: p.orgId }, select: { openSquad: true, language: true } });
    const changed = (org?.openSquad === true) !== p.on;
    // F3: the organiser's own choice; the learned setup never overrides it.
    if (changed) await tx.organisation.update({ where: { id: p.orgId }, data: { openSquad: p.on, settingsSetByOrganiser: { push: ["openSquad"] } } });
    const moved = p.on
      ? await promoteBenchRows(tx, p.orgId, p.now, { kind: "admin", userId: p.actorUserId, sourceRef: "open-squad:on" })
      : [];
    return { changed, moved, lang: org?.language ?? null };
  });
  const s = t(done.lang);
  if (done.changed) console.log(`[open-squad] org=${p.orgId} switched ${p.on ? "on" : "off"} by ${p.actorUserId ?? "unknown"}`);

  // OFF BUMPS NOBODY, monthly clubs included: the running month keeps room
  // for every regular already signed until it ends (`squad-month.ts`).
  if (done.changed && !p.on) {
    try {
      const { liftMonthCapForOpenSquadOff } = await import("./squad-month");
      await liftMonthCapForOpenSquadOff(p.orgId, p.now);
    } catch (err) {
      console.error(`[open-squad] keeping the month's regulars for ${p.orgId} failed:`, err instanceof Error ? err.message : err);
    }
  }
  if (done.moved.length > 0) await afterPromotion(done.moved);

  const names = [...new Set(done.moved.map((m) => m.name ?? s.unnamed))];
  const movedLine = names.length > 0 ? ` ${s.os_moved_up({ names: joinList(done.lang, names), many: names.length > 1 })}` : "";
  if (!done.changed) {
    return {
      outcome: "open-squad-unchanged",
      replyText: (p.on ? s.os_already_on({ min: game.min }) : s.os_already_off({ places: game.places })) + movedLine,
      movedUp: done.moved.length,
    };
  }
  if (!p.on) return { outcome: "open-squad-off", replyText: s.os_off({ activityName: game.name, places: game.places }), movedUp: 0 };
  return { outcome: "open-squad-on", replyText: s.os_on({ min: game.min }) + movedLine, movedUp: done.moved.length };
}
