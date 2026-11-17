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

export async function setOpenSquad(p: { orgId: string; on: boolean; actorUserId: string | null; now: Date }): Promise<OpenSquadReply> {
  const org = await db.organisation.findUnique({ where: { id: p.orgId }, select: { openSquad: true, language: true } });
  const lang = org?.language ?? null;
  const s = t(lang);
  const game = await gameFacts(p.orgId, p.now);
  if ((org?.openSquad === true) === p.on) {
    return {
      outcome: "open-squad-unchanged",
      replyText: p.on ? s.os_already_on({ min: game.min }) : s.os_already_off({ places: game.places }),
      movedUp: 0,
    };
  }

  // F3: the organiser's own choice; the learned setup never overrides it.
  await db.organisation.update({ where: { id: p.orgId }, data: { openSquad: p.on, settingsSetByOrganiser: { push: ["openSquad"] } } });
  console.log(`[open-squad] org=${p.orgId} switched ${p.on ? "on" : "off"} by ${p.actorUserId ?? "unknown"}`);

  if (!p.on) {
    return { outcome: "open-squad-off", replyText: s.os_off({ activityName: game.name, places: game.places }), movedUp: 0 };
  }

  // No bench any more: whoever is waiting on a game still to be played is
  // in. Written AFTER the flag, so the writer's own rule takes them.
  const waiting = await db.attendance.findMany({
    where: { status: "BENCH", match: { activity: { orgId: p.orgId }, status: { in: [...LIVE] }, date: { gt: p.now } } },
    orderBy: [{ matchId: "asc" }, { position: "asc" }],
    select: { matchId: true, userId: true, user: { select: { name: true } } },
  });
  const { registerAttendance } = await import("./attendance");
  const moved: string[] = [];
  for (const w of waiting) {
    try {
      const r = await registerAttendance(w.userId, w.matchId, {
        promoteFromBench: true,
        event: { cause: "bench-moved-up", actorKind: "admin", actorUserId: p.actorUserId, sourceRef: "open-squad:on", note: "open squad switched on: no bench" },
      });
      if (r.status === "CONFIRMED") moved.push(w.user?.name ?? s.unnamed);
    } catch (err) {
      console.error(`[open-squad] ${w.userId} on ${w.matchId} could not be brought in:`, err instanceof Error ? err.message : err);
    }
  }
  const names = [...new Set(moved)];
  return {
    outcome: "open-squad-on",
    replyText: s.os_on({ min: game.min, movedUp: names.length > 0 ? joinList(lang, names) : null, movedCount: names.length }),
    movedUp: moved.length,
  };
}
