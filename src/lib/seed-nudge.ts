/**
 * THE SEED-RATING NUDGE IN THE SCHEDULER (2026-10-15). One hook in
 * `computeDuePosts` (bot-scheduler.ts). When it is due
 * (seed-nudge-rules.ts) the club's admins are told, once, through the
 * admin channel (`adminNoticeInstructions`): the linked admin group with
 * the plain ratings URL, else each recipient by DM with their own
 * signed-in link. The text is seed-nudge-copy.ts. No model.
 *
 * Cheap on every poll: everything decidable from what the scheduler has
 * already loaded is checked first, and a club already nudged, not live,
 * on monthly mode, without team balancing, with teams made, or outside
 * its window makes no query here. Never throws: a failure costs this one
 * notice on this poll, never the poll.
 */
import { db } from "./db";
import { adminNoticeInstructions, type LoadedAdminChannel } from "./admin-channel";
import type { PiCaps } from "./admin-channel-rules";
import type { DueInstruction } from "./bot-scheduler";
import {
  MANUAL_SEED_NUDGE_MARKER,
  decideSeedNudge,
  seedNudgeAlreadySent,
  seedNudgeKey,
  seedNudgePrecheck,
} from "./seed-nudge-rules";
import { buildSeedNudgeNotice } from "./seed-nudge-copy";

/** The page the nudge points at (src/app/admin/players/ratings). */
export const SEED_RATINGS_PATH = "/admin/players/ratings";

interface SchedulerMatch {
  date: Date;
  status: string;
  attendances: ReadonlyArray<{ userId: string; status: string }>;
}

/**
 * What the seed rules read from the database, for one club and the players
 * confirmed for its next match: its peer ratings, how many of those players
 * and of its active members have a seed, and whether the one-off manual
 * nudge (`MANUAL_SEED_NUDGE_MARKER`) was queued. Shared with the
 * first-teams notice (admin-onboarding.ts), so the two read one rule.
 */
export async function loadSeedState(
  orgId: string,
  confirmedUserIds: readonly string[],
): Promise<{
  clubHasPeerRatings: boolean;
  confirmed: { total: number; seeded: number };
  active: { total: number; seeded: number };
  manualNudge: boolean;
}> {
  const peer = await db.rating.findFirst({ where: { match: { activity: { orgId } } }, select: { id: true } });
  const all = await db.membership.findMany({
    where: { orgId },
    select: { userId: true, seedRating: true, leftAt: true, guestFromOrgId: true },
  });
  // A partner club's guest is not this club's player to seed (cross-club
  // ask); with no guest, the counts are exactly what they always were.
  const guestIds = new Set(all.filter((m) => m.guestFromOrgId).map((m) => m.userId));
  const members = all.filter((m) => !m.guestFromOrgId);
  const seedOf = new Map(members.map((m) => [m.userId, m.seedRating]));
  const active = members.filter((m) => m.leftAt == null);
  const manual = await db.botJob.findFirst({
    where: { orgId, text: { contains: MANUAL_SEED_NUDGE_MARKER } },
    select: { id: true },
  });
  return {
    clubHasPeerRatings: !!peer,
    confirmed: (() => {
      const own = confirmedUserIds.filter((u) => !guestIds.has(u));
      return { total: own.length, seeded: own.filter((u) => seedOf.get(u) != null).length };
    })(),
    active: { total: active.length, seeded: active.filter((m) => m.seedRating != null).length },
    manualNudge: !!manual,
  };
}

export async function seedNudgeInstructions(args: {
  /** `live`: not setting up (`isClubSettingUp`, club-setup-rules.ts). */
  org: { id: string; live: boolean; liveAt: Date | null };
  features: { teamBalancing: boolean; squadMode: string; playerRating: boolean; language: string };
  /** The scheduler's loaded matches (date ascending, no cancelled ones). */
  matches: ReadonlyArray<SchedulerMatch>;
  sentKeys: ReadonlySet<string>;
  now: Date;
  piCaps: PiCaps;
  getChannel: () => Promise<LoadedAdminChannel | null>;
}): Promise<DueInstruction[]> {
  const { org, features, now } = args;
  try {
    const next =
      args.matches
        .filter((m) => m.status !== "COMPLETED" && m.status !== "CANCELLED" && m.date.getTime() > now.getTime())
        .sort((a, b) => a.date.getTime() - b.date.getTime())[0] ?? null;
    const base = {
      now,
      live: org.live,
      squadMode: features.squadMode,
      teamBalancing: features.teamBalancing,
      liveAt: org.liveAt,
      alreadyNudged: seedNudgeAlreadySent(org.id, args.sentKeys),
      match: next ? { date: next.date, status: next.status } : null,
    };
    if (seedNudgePrecheck(base) || !next) return [];

    const state = await loadSeedState(
      org.id,
      next.attendances.filter((a) => a.status === "CONFIRMED").map((a) => a.userId),
    );
    const decision = decideSeedNudge({
      ...base,
      alreadyNudged: base.alreadyNudged || state.manualNudge,
      confirmed: state.confirmed,
      active: state.active,
      clubHasPeerRatings: state.clubHasPeerRatings,
    });
    if (!decision.due) return [];

    const channel = await args.getChannel();
    if (!channel) return [];
    const lang = channel.language ?? features.language;
    return await adminNoticeInstructions({
      channel,
      piCaps: args.piCaps,
      sentKeys: args.sentKeys,
      now,
      key: (who) => seedNudgeKey(org.id, who),
      notice: {
        nextPath: SEED_RATINGS_PATH,
        text: (link) =>
          buildSeedNudgeNotice({
            lang,
            matchDate: next.date,
            adminNames: channel.admins.map((a) => a.name),
            pool: decision.pool,
            total: decision.total,
            unseeded: decision.unseeded,
            anySeeded: decision.unseeded < decision.total,
            peerRatingsOn: features.playerRating,
            link,
          }),
      },
    });
  } catch (err) {
    console.error(`[seed-nudge] org ${org.id}: not computed on this poll:`, err instanceof Error ? err.message : err);
    return [];
  }
}
