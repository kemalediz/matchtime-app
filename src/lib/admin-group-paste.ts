/**
 * A SQUAD LIST PASTED IN A CLUB'S ADMIN GROUP (2026-10-14).
 *
 * An admin pastes the whole squad (numbered, bulleted, or one name per
 * line). MatchTime does NOT apply it at once. It replies in the admin
 * group with the exact changes it would make against the squad of the
 * club's next match ("Adding: Bilal. Removing: Shehryar, Clarence. Unknown
 * names: Naim (...). Reply YES to apply.") and stores the list as an
 * `AdminSquadProposal`. Any owner or admin's YES within 30 minutes applies
 * it, and so does the YES of the member who pasted it (any member of the
 * club may paste one since 2026-10-20, and confirms their own); after that, YES gets "That list is more than 30
 * minutes old". A list identical to the squad gets "That matches the
 * squad, nothing to change." and nothing is stored.
 *
 * At the YES the changes are worked out AGAIN against the squad as it
 * stands then, so a change somebody made in the meantime is not made
 * twice. They are applied with the same writers every other admin action
 * uses (`cancelAttendance`, `registerAttendance` with the admin's
 * authority) and new names with the same resolver as the players' group
 * (`resolveOrProvisionByName`): outs first, so the places are free, then
 * the waiting list, then ins.
 *
 * Deterministic. No model, ever. Logs carry ids and counts only.
 */
import { db } from "./db";
import { cancelAttendance, registerAttendance } from "./attendance";
import type { AttendanceEventContext } from "./attendance-events";
import { selectRegistrationMatch } from "./registration-match-select";
import { resolveOrProvisionByName } from "./resolve-or-provision-name";
import { isDeliberateNameProvisionable } from "./resolve-sender";
import { adminGroupSourceRef } from "./admin-added";
import { formatLondon } from "./london-time";
import { nextNightlyFixtureRun } from "./nightly-fixture-run";
import { loadSquadCount } from "./squad-count";
import {
  PASTE_PROPOSAL_TTL_MS,
  buildPasteExpiredReply,
  buildPasteNoMatchReply,
  buildPasteProposalReply,
  buildSquadChangeReply,
  diffPastedSquad,
  matchPastedName,
  readSquadPaste,
  type PasteMember,
  type SquadChangeKind,
  type SquadRef,
  type SquadStatus,
} from "./admin-group-squad-rules";

export interface PasteReply {
  outcome: "paste-proposed" | "paste-same" | "paste-applied" | "paste-expired" | "paste-no-match";
  replyText: string;
}

/** How long after it expires an unanswered list still earns the "too
 *  late" line rather than silence. */
const EXPIRED_ANSWER_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The club's next match, picked against the caller's `now` (the same
 *  instant the rest of the paste uses), never the wall clock. */
async function registrationMatch(orgId: string, now: Date) {
  const candidates = await db.match.findMany({
    where: { activity: { orgId }, status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] } },
    orderBy: { date: "asc" },
  });
  return selectRegistrationMatch(candidates, now) ?? null;
}

async function currentSquad(matchId: string): Promise<Array<{ userId: string; status: SquadStatus }>> {
  return (
    await db.attendance.findMany({ where: { matchId }, select: { userId: true, status: true } })
  ).map((r) => ({ userId: r.userId, status: r.status as SquadStatus }));
}

async function namesOf(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const users = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name ?? "?"]));
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/**
 * A squad list pasted when the club has no game to put it on (2026-10-15).
 * Club FNF's organiser pasted the squad a minute after going live, before
 * the nightly cron had made the game, and heard nothing. Now a message
 * that reads as the squad (the same `readSquadPaste`, against the places
 * of the club's weekly game) gets one line saying there is no game yet
 * and when the next one is made; anything else is still null, so chatter
 * goes on exactly as before. Nothing is stored. Once per message: the
 * caller has already claimed `admin-group-msg:<messageId>`.
 */
async function answerPasteWithoutMatch(args: {
  orgId: string;
  lang: string | null | undefined;
  messageId: string;
  text: string;
  now: Date;
}): Promise<PasteReply | null> {
  const games = await db.activity.findMany({
    where: { orgId: args.orgId, isActive: true },
    select: { sport: { select: { playersPerTeam: true } } },
  });
  // The places the cron's game would have (2 x per side), the smallest
  // when the club has more than one weekly game. With none, the floor of
  // four names `readSquadPaste` always asks for.
  const places = games.length > 0 ? Math.min(...games.map((g) => g.sport.playersPerTeam * 2)) : 0;
  if (!readSquadPaste(args.text, places)) return null;
  const nextRunTime = games.length > 0 ? formatLondon(nextNightlyFixtureRun(args.now), "HH:mm") : null;
  console.log(`[admin-group] ${args.messageId}: pasted list with no game to put it on (${games.length} weekly game(s))`);
  return { outcome: "paste-no-match", replyText: buildPasteNoMatchReply({ lang: args.lang, nextRunTime }) };
}

/**
 * The paste, proposed. Null when the text is not a squad list or this
 * message was already proposed (a Pi retry). With no match to put it on,
 * a list gets the "no game yet" line (`answerPasteWithoutMatch`).
 */
export async function proposeSquadPaste(args: {
  orgId: string;
  lang: string | null | undefined;
  messageId: string;
  text: string;
  senderUserId: string;
  now: Date;
}): Promise<PasteReply | null> {
  const { orgId, now } = args;
  if (!args.text.includes("\n")) return null;
  const match = await registrationMatch(orgId, now);
  if (!match) return answerPasteWithoutMatch(args);
  const paste = readSquadPaste(args.text, match.maxPlayers);
  if (!paste) return null;

  const [memberships, aliases, current] = await Promise.all([
    db.membership.findMany({ where: { orgId, leftAt: null }, select: { user: { select: { id: true, name: true } } } }),
    db.userAlias.findMany({ where: { orgId }, select: { userId: true, alias: true } }),
    currentSquad(match.id),
  ]);
  const members: PasteMember[] = memberships.map((m) => ({
    userId: m.user.id,
    name: m.user.name,
    aliases: aliases.filter((a) => a.userId === m.user.id).map((a) => a.alias),
  }));
  const onMatch = new Set(current.filter((c) => c.status !== "DROPPED").map((c) => c.userId));

  const unclear: string[] = [];
  // Nobody in the club, and not a name a player can have ("WhatsApp", a
  // phone number): said in the preview and left out, never promised and
  // then refused at the YES. The YES provisions with the same rule.
  const cannotAdd: string[] = [];
  const place = (names: string[]): SquadRef[] => {
    const out: SquadRef[] = [];
    for (const name of names) {
      const m = matchPastedName(name, members, onMatch);
      if (m.kind === "member") out.push({ userId: m.userId });
      else if (m.kind === "new" && isDeliberateNameProvisionable(name)) out.push({ newName: name });
      else if (m.kind === "new") {
        if (!cannotAdd.includes(name)) cannotAdd.push(name);
      } else if (!unclear.includes(name)) unclear.push(name);
    }
    return out;
  };
  const playing = place(paste.playing);
  const reserves = place(paste.reserves);
  const diff = diffPastedSquad({ playing, reserves, current });

  const nameOf = await namesOf([
    ...diff.add.flatMap((r) => ("userId" in r ? [r.userId] : [])),
    ...diff.toBench.flatMap((r) => ("userId" in r ? [r.userId] : [])),
    ...diff.remove.map((r) => r.userId),
  ]);
  const label = (r: SquadRef) => ("userId" in r ? (nameOf.get(r.userId) ?? "?") : r.newName);
  const newNames = [...diff.add, ...diff.toBench].flatMap((r) => ("newName" in r ? [r.newName] : []));
  const replyText = buildPasteProposalReply({
    lang: args.lang,
    add: diff.add.filter((r) => "userId" in r).map(label),
    remove: diff.remove.map(label),
    toBench: diff.toBench.map(label),
    newNames,
    unclear,
    cannotAdd,
    listed: playing.length,
    maxPlayers: match.maxPlayers,
  });

  if (diff.same) {
    console.log(`[admin-group] ${args.messageId}: pasted list matches the squad on match ${match.id}`);
    return { outcome: "paste-same", replyText };
  }

  try {
    await db.adminSquadProposal.updateMany({
      where: { orgId, resolvedAt: null },
      data: { resolvedAt: now, outcome: "superseded" },
    });
    await db.adminSquadProposal.create({
      data: {
        orgId,
        matchId: match.id,
        waMessageId: args.messageId,
        proposedByUserId: args.senderUserId,
        playingUserIds: playing.flatMap((r) => ("userId" in r ? [r.userId] : [])),
        playingNewNames: playing.flatMap((r) => ("newName" in r ? [r.newName] : [])),
        reserveUserIds: reserves.flatMap((r) => ("userId" in r ? [r.userId] : [])),
        reserveNewNames: reserves.flatMap((r) => ("newName" in r ? [r.newName] : [])),
        expiresAt: new Date(now.getTime() + PASTE_PROPOSAL_TTL_MS),
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
  console.log(
    `[admin-group] ${args.messageId}: pasted list proposed on match ${match.id}: ` +
      `${diff.add.length} in, ${diff.remove.length} out, ${diff.toBench.length} to the waiting list, ${unclear.length} unclear, ${cannotAdd.length} cannot be added`,
  );
  return { outcome: "paste-proposed", replyText };
}

/**
 * A YES to the list. Null when there is no list waiting for one (the caller
 * then stays silent), or another YES got there first. `proposedBy`: only a
 * list that member pasted (a member who is not an organiser confirms their
 * own list only, 2026-10-20).
 */
export async function answerSquadPasteYes(args: {
  orgId: string;
  lang: string | null | undefined;
  messageId: string;
  senderUserId: string;
  now: Date;
  proposedBy?: string;
}): Promise<PasteReply | null> {
  const { orgId, now } = args;
  const proposal = await db.adminSquadProposal.findFirst({
    where: {
      orgId,
      resolvedAt: null,
      expiresAt: { gte: new Date(now.getTime() - EXPIRED_ANSWER_WINDOW_MS) },
      ...(args.proposedBy ? { proposedByUserId: args.proposedBy } : {}),
    },
    orderBy: { createdAt: "desc" },
  });
  if (!proposal) return null;
  if (proposal.expiresAt.getTime() < now.getTime()) {
    console.log(`[admin-group] ${args.messageId}: YES to expired list ${proposal.id}`);
    return { outcome: "paste-expired", replyText: buildPasteExpiredReply(args.lang) };
  }
  // Claim it once, before any write: two admins' YES apply it once.
  const claimed = await db.adminSquadProposal.updateMany({
    where: { id: proposal.id, resolvedAt: null },
    data: { resolvedAt: now, outcome: "applied", resolvedByUserId: args.senderUserId },
  });
  if (claimed.count === 0) return null;

  const matchId = proposal.matchId;
  const diff = diffPastedSquad({
    playing: [
      ...proposal.playingUserIds.map((userId) => ({ userId })),
      ...proposal.playingNewNames.map((newName) => ({ newName })),
    ],
    reserves: [
      ...proposal.reserveUserIds.map((userId) => ({ userId })),
      ...proposal.reserveNewNames.map((newName) => ({ newName })),
    ],
    current: await currentSquad(matchId),
  });

  const event: AttendanceEventContext = {
    cause: "admin-message",
    actorKind: "admin",
    actorUserId: args.senderUserId,
    // The admin group's mark: the rolling squad carries a phoneless player
    // added here (admin-added.ts).
    sourceRef: adminGroupSourceRef(proposal.waMessageId),
  };
  const changes: Array<{ kind: SquadChangeKind; userId: string | null; name: string | null }> = [];
  const failed: Array<{ userId: string | null; name: string | null }> = [];

  const resolve = async (r: SquadRef): Promise<{ userId: string; name: string | null } | null> => {
    if ("userId" in r) return { userId: r.userId, name: null };
    const res = await resolveOrProvisionByName(orgId, r.newName, { adminConfirmed: true });
    return res ? { userId: res.userId, name: res.name ?? r.newName } : null;
  };

  for (const r of diff.remove) {
    try {
      await cancelAttendance(r.userId, matchId, event);
      changes.push({ kind: "out", userId: r.userId, name: null });
    } catch {
      failed.push({ userId: r.userId, name: null });
    }
  }
  for (const [refs, bench] of [
    [diff.toBench, true],
    [diff.add, false],
  ] as const) {
    for (const r of refs) {
      const who = await resolve(r).catch(() => null);
      if (!who) {
        failed.push({ userId: null, name: "newName" in r ? r.newName : null });
        continue;
      }
      try {
        const res = await registerAttendance(who.userId, matchId, {
          ...(bench ? { benchIntent: "explicit" as const } : { promoteFromBench: true }),
          event,
          actorIsAdmin: true,
        });
        changes.push({ kind: res.status === "BENCH" ? "bench" : "in", userId: who.userId, name: who.name });
      } catch {
        failed.push({ userId: who.userId, name: who.name });
      }
    }
  }

  const nameOf = await namesOf(
    [...changes, ...failed].flatMap((c) => (c.userId && !c.name ? [c.userId] : [])),
  );
  const display = (c: { userId: string | null; name: string | null }) =>
    c.name ?? (c.userId ? nameOf.get(c.userId) : null) ?? "?";
  const squad = await loadSquadCount(matchId);
  const confirmed = squad.confirmed;
  console.log(
    `[admin-group] ${args.messageId}: list ${proposal.id} applied on match ${matchId}: ` +
      `${changes.length} change(s), ${failed.length} failure(s), ${confirmed} confirmed`,
  );
  return {
    outcome: "paste-applied",
    replyText: buildSquadChangeReply({
      lang: args.lang,
      changes: changes.map((c) => ({ kind: c.kind, name: display(c) })),
      failed: failed.map(display),
      confirmed,
      maxPlayers: squad.maxPlayers ?? confirmed,
      bench: squad.bench,
      benchPickMode: squad.benchPickMode,
    }),
  };
}
