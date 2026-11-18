/**
 * A STORED MAN OF THE MATCH RESULT ACROSS A PLAYER MERGE (review of #608,
 * round 3).
 *
 * "MoMAnnouncement".result names its winner(s) by user id, and those ids
 * decide who the win is credited to (`decideMom`). So when a duplicate
 * player is merged into the kept one, the ids move with it, on BOTH merge
 * paths: the admin, phone-collision, cross-club and placeholder merges
 * (`merge-players-core.ts`) and the user merge (`user-merge-plan.ts`). Both
 * read `mergeMomResultIds`, so they cannot disagree.
 *
 * Both players in ONE stored result (the same person voted for under two
 * records) become one tally entry for the kept player, their votes summed
 * (a count of one person), under the kept player's name as shown. The
 * WINNERS are only mapped, never recomputed from the merged tally (round 4
 * of the review: "Alex 3, Pete 2, Pete S 2" is still Alex's win), and the
 * result is marked `merged`, because its counts no longer match the post.
 *
 * Imports nothing that loads `lib/db.ts`: `merge-players-core.ts` runs from
 * scripts with their own Prisma client.
 */
import { readMomAnnouncedResult, type MomAnnouncedResult, type MomAnnouncedVote } from "./mom-announce-rules";
import { matchMomPostToRoster, parseMomAnnouncementText } from "./mom-announcement-parse";
import { NOT_CANCELLED } from "./played-match";

const byVotes = (a: MomAnnouncedVote, b: MomAnnouncedVote) => b.votes - a.votes || a.name.localeCompare(b.name);

/** PURE. The result with `from` merged into `to`; the same object when it
 *  names neither. */
export function mergeMomResultIds(r: MomAnnouncedResult, from: string, to: string): MomAnnouncedResult {
  if (r.kind === "pick") {
    return r.winner.userId === from ? { v: 1, kind: "pick", winner: { ...r.winner, userId: to } } : r;
  }
  const dropped = r.tally.find((t) => t.userId === from);
  if (!dropped) return r;
  const kept = r.tally.find((t) => t.userId === to);
  const rest = r.tally.filter((t) => t.userId !== from && t.userId !== to);
  const entry: MomAnnouncedVote = kept
    ? { userId: to, name: kept.name, votes: kept.votes + dropped.votes }
    : { userId: to, name: dropped.name, votes: dropped.votes };
  const winners = [...new Set(r.winners.map((id) => (id === from ? to : id)))];
  // Counts change only when BOTH were in it; a winner's own count only when
  // one of the two was a winner.
  const summed = kept !== undefined;
  const merged = summed || r.merged === true;
  const winnerMerged = (summed && (r.winners.includes(from) || r.winners.includes(to))) || r.winnerMerged === true;
  return {
    v: 1,
    kind: "vote",
    tally: [...rest, entry].sort(byVotes),
    winners,
    ...(merged ? { merged: true as const } : {}),
    ...(winnerMerged ? { winnerMerged: true as const } : {}),
  };
}

/** PURE. The stored JSON with `from` merged into `to`, or null when it does
 *  not read as a stored result (left as it is). */
export function mergeStoredMomResult(json: unknown, from: string, to: string): MomAnnouncedResult | null {
  const r = readMomAnnouncedResult(json);
  return r ? mergeMomResultIds(r, from, to) : null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Does "MoMAnnouncement" exist yet? Before the migration it does not, and a
 * statement on it inside a merge's transaction would abort the whole merge.
 * Read by both merge paths before they touch the table.
 */
export async function momAnnouncementTableExists(tx: any): Promise<boolean> {
  if (typeof tx?.$queryRawUnsafe !== "function") return false;
  const [probe] = await tx.$queryRawUnsafe(`SELECT to_regclass('"MoMAnnouncement"')::text AS t`);
  return !!probe?.t;
}

/**
 * The merge step on a transaction (`merge-players-core.ts`): every stored
 * result naming `from` is rewritten. Before the migration the table does not
 * exist, and a failed statement would abort the whole merge's transaction,
 * so the table is looked up first and nothing else runs without it.
 * Returns how many results it rewrote.
 */
export async function rekeyStoredMomResults(tx: any, from: string, to: string): Promise<number> {
  if (!(await momAnnouncementTableExists(tx))) return 0;
  const rows: Array<{ matchId: string; result: unknown }> = await tx.$queryRawUnsafe(
    `SELECT "matchId", result FROM "MoMAnnouncement" WHERE result::text LIKE $1`,
    `%${from}%`,
  );
  let n = 0;
  for (const row of rows) {
    const next = mergeStoredMomResult(row.result, from, to);
    if (!next || JSON.stringify(next) === JSON.stringify(readMomAnnouncedResult(row.result))) continue;
    await tx.moMAnnouncement.update({ where: { matchId: row.matchId }, data: { result: next } });
    n++;
  }
  return n;
}

/**
 * BEFORE A MERGE (round 5 of the review): a posted result with no stored
 * record is read back from the post's own words, by NAME (`mom-records.ts`).
 * A merge removes the dropped player's name from the match, so after it the
 * read-back would fail and the winner would be re-counted from merged votes.
 * So every posted match `userId` is part of (CONFIRMED, on the team sheet, or
 * voted for), with no record and a stored post text, gets its record now,
 * by the same exact re-render rule and the names as they still are, dated
 * by its post. The merge then remaps it like any other stored result.
 * Returns how many records it stored. Nothing without the table.
 */
export async function storeMomRecordsFromPostText(tx: any, userId: string): Promise<number> {
  if (!(await momAnnouncementTableExists(tx))) return 0;
  const [att, teams, votes] = await Promise.all([
    tx.attendance.findMany({ where: { userId, status: "CONFIRMED" }, select: { matchId: true } }),
    tx.teamAssignment.findMany({ where: { userId }, select: { matchId: true } }),
    // A cancelled match is never posted.
    tx.moMVote.findMany({ where: { playerId: userId, match: NOT_CANCELLED }, select: { matchId: true } }),
  ]);
  const ids = [...new Set([...att, ...teams, ...votes].map((r: { matchId: string }) => r.matchId))];
  if (ids.length === 0) return 0;
  const [posts, existing] = await Promise.all([
    tx.sentNotification.findMany({
      where: { key: { in: ids.map((id) => `${id}:mom-announcement`) }, text: { not: null } },
      select: { key: true, text: true, createdAt: true },
    }),
    tx.moMAnnouncement.findMany({ where: { matchId: { in: ids } }, select: { matchId: true } }),
  ]);
  const has = new Set(existing.map((r: { matchId: string }) => r.matchId));
  let n = 0;
  for (const p of posts as Array<{ key: string; text: string; createdAt: Date }>) {
    const matchId = p.key.slice(0, -":mom-announcement".length);
    if (has.has(matchId)) continue;
    const post = parseMomAnnouncementText(p.text);
    if (!post) continue;
    const [people, sheet, voted] = await Promise.all([
      tx.attendance.findMany({ where: { matchId, status: "CONFIRMED" }, select: { matchId: true, user: { select: { id: true, name: true } } } }),
      tx.teamAssignment.findMany({ where: { matchId }, select: { matchId: true, user: { select: { id: true, name: true } } } }),
      tx.moMVote.findMany({ where: { matchId }, select: { matchId: true, player: { select: { id: true, name: true } } } }),
    ]);
    const byId = new Map<string, string>();
    for (const r of [...people.map((x: any) => x.user), ...sheet.map((x: any) => x.user), ...voted.map((x: any) => x.player)]) {
      if (r?.name) byId.set(r.id, r.name);
    }
    const matched = matchMomPostToRoster(post, [...byId].map(([id, name]) => ({ userId: id, name })));
    if (!matched.ok) continue;
    await tx.moMAnnouncement.create({ data: { matchId, result: matched.result, announcedAt: p.createdAt } });
    n++;
  }
  return n;
}
