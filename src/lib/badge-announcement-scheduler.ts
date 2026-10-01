/**
 * The scheduler half of BADGE ANNOUNCEMENTS: loads a club's history and
 * ledger, and emits the `<matchId>:badges` group post when one is due.
 * The rules, and why, are in `badge-announcements.ts` (pure).
 *
 * Called from `computeDuePosts` only when the club has the feature on.
 * READ-ONLY: it writes nothing. The ledger rows ride on the instruction
 * (`badgeLedger`) and are written by /api/whatsapp/due-posts in the SAME
 * transaction that claims the post (`claimBadgePost` below), so a preview
 * poll, a lost claim race or a failed claim records nothing, and a
 * claimed post always records its badges.
 *
 * COST: nothing at all outside a due window (18:00 to 20:59 London on the
 * evenings `badgesPostDue` allows) for a match whose post has not gone
 * out. Inside one, four reads per poll: the club's completed matches
 * with their ratings, votes, team sheets and confirmed players; its
 * members; its ledger; its lifecycle.
 */
import { db } from "./db";
import { isClubOperational } from "./club-approval-state";
import type { Lang } from "./i18n/lang";
import {
  announcedKey,
  badgeMatchFinalised,
  badgesPostDue,
  badgesPostKey,
  buildBadgeAnnouncementPost,
  entriesFor,
  pickBadgeAwards,
  replayBadges,
  toReplayMatches,
  type BadgeAward,
  type RawBadgeMatch,
} from "./badge-announcements";

export interface BadgePostInstruction {
  kind: "group-message";
  key: string;
  matchId: string;
  text: string;
  /** Ledger rows to write when (and only when) this post is claimed. */
  badgeLedger: BadgeAward[];
}

/** The scheduler's view of a match: what deciding "due" needs. */
export interface SchedulerMatchLike {
  id: string;
  date: Date;
  status: string;
  postMatchEndFlow: boolean | null;
}

/** Load a club's completed matches in the shape the replay reads. */
export async function loadRawBadgeMatches(orgId: string): Promise<(RawBadgeMatch & { date: Date })[]> {
  const rows = await db.match.findMany({
    where: { activity: { orgId }, status: "COMPLETED", isHistorical: false },
    orderBy: { date: "asc" },
    select: {
      id: true,
      date: true,
      ratings: { select: { playerId: true, score: true } },
      momVotes: { select: { playerId: true } },
      teamAssignments: { select: { userId: true } },
      attendances: { where: { status: "CONFIRMED" }, select: { userId: true } },
    },
  });
  return rows.map((m) => ({
    id: m.id,
    date: m.date,
    confirmed: m.attendances.map((a) => a.userId),
    teamUserIds: m.teamAssignments.map((t) => t.userId),
    ratings: m.ratings,
    momVotes: m.momVotes,
  }));
}

export async function computeBadgeAnnouncements(args: {
  orgId: string;
  lang: Lang;
  matches: SchedulerMatchLike[];
  sentKeys: ReadonlySet<string>;
  now: Date;
}): Promise<BadgePostInstruction[]> {
  const { orgId, lang, sentKeys, now } = args;

  const due = args.matches
    .filter(
      (m) =>
        m.status === "COMPLETED" &&
        m.postMatchEndFlow !== false &&
        !sentKeys.has(badgesPostKey(m.id)) &&
        badgesPostDue(now, m.date),
    )
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  if (due.length === 0) return [];

  // A dormant (or unapproved) club hears nothing on MatchTime's own
  // initiative, even with the bot switched on.
  const org = await db.organisation.findUnique({
    where: { id: orgId },
    select: { approvalStatus: true, dormantAt: true },
  });
  if (!org || !isClubOperational(org)) return [];

  const [raw, members, ledger] = await Promise.all([
    loadRawBadgeMatches(orgId),
    db.membership.findMany({
      where: { orgId, leftAt: null },
      select: { user: { select: { id: true, name: true } } },
    }),
    db.badgeAnnouncement.findMany({ where: { orgId }, select: { userId: true, badgeKey: true } }),
  ]);

  const nameById = new Map<string, string>();
  for (const m of members) {
    const name = m.user.name?.trim();
    if (name) nameById.set(m.user.id, name);
  }
  const eligible = new Set(nameById.keys());
  const announced = new Set(ledger.map((r) => announcedKey(r.userId, r.badgeKey)));
  const isFinal = (m: { id: string; date: Date }) => badgeMatchFinalised(m, sentKeys, now);

  const out: BadgePostInstruction[] = [];
  for (const m of due) {
    const upTo = raw.findIndex((r) => r.id === m.id);
    if (upTo < 0) continue;
    const replay = replayBadges(toReplayMatches(raw.slice(0, upTo + 1), isFinal));
    const { awards, baseline } = pickBadgeAwards({
      replay,
      matchId: m.id,
      announced,
      // No ledger rows at all, and nothing recorded earlier in this poll.
      bootstrap: announced.size === 0,
      eligibleUserIds: eligible,
    });
    const text = buildBadgeAnnouncementPost(entriesFor(awards, nameById), lang);
    if (!text) continue;
    const badgeLedger = [...awards, ...baseline];
    // A second match due in the same poll must not repeat these.
    for (const r of badgeLedger) announced.add(announcedKey(r.userId, r.badgeKey));
    out.push({ kind: "group-message", key: badgesPostKey(m.id), matchId: m.id, text, badgeLedger });
  }
  return out;
}

/** The ledger rows an instruction carries, if it is a badges post. */
export function badgeLedgerOf(instr: unknown): BadgeAward[] | null {
  const rows = (instr as { badgeLedger?: unknown }).badgeLedger;
  return Array.isArray(rows) && rows.length > 0 ? (rows as BadgeAward[]) : null;
}

/**
 * Claim a badges post: the SentNotification row and the ledger rows in
 * one transaction. A lost race (P2002 on the notification key) rolls the
 * ledger back with it, so only the winner records anything.
 */
export async function claimBadgePost(
  orgId: string,
  instr: { key: string; kind: string; matchId?: string },
  rows: BadgeAward[],
): Promise<void> {
  await db.$transaction([
    db.sentNotification.create({
      data: { key: instr.key, kind: instr.kind, matchId: instr.matchId },
    }),
    db.badgeAnnouncement.createMany({
      data: rows.map((r) => ({ orgId, userId: r.userId, badgeKey: r.badgeKey, matchId: r.matchId })),
      skipDuplicates: true,
    }),
  ]);
}
