/**
 * EVERY MATCH'S MAN OF THE MATCH, AS THE RULES DECIDE IT (review of #608,
 * 2026-11-16). READ-ONLY: every statement is a find.
 *
 * One loader for the "last Man of the Match" answer (`pipeline/load-stats.ts`)
 * and for every Man of the Match WINS count and label: the group's tables and
 * the per-match labels (`match-history.ts`), a player's count and badges
 * (`player-stats.ts`), the badge announcements (`badge-announcement-scheduler.ts`)
 * and the web pages (`mom-web.ts`). Each match goes through the one decision
 * (`decideMom` in `pipeline/last-mom.ts`), so nothing can credit an open
 * vote's leader, nor credit someone other than the winner the group was shown.
 *
 * Read per match: the votes per player voted FOR (who voted is never
 * selected), whether its result was posted and when, what that post said
 * (the stored "MoMAnnouncement", read best effort; with no stored record, the
 * post's own words, `SentNotification.text`, read back by our template with
 * an exact re-render, so a failed record write recovers by itself and older
 * posts that kept their text need no backfill), when its vote closes, its
 * next fixture by the scheduler's own rule (`nextFixtureKickoff`), whether it
 * is a historical (back-filled) anchor, and whether the scheduler can post
 * its result at all (not cancelled, `postMatchEndFlow`, the club's
 * `momVoting`, and the club's posts not suppressed: `clubPostsWhere`, the
 * due-posts gate). A post is "posted" only when its claim row carries the
 * sent message's id (`waMessageId`, stamped by the Pi's ack).
 *
 * The matches: the club's, not cancelled, with MoMVote rows OR a stored
 * result (a posted result stays selectable after its vote rows are gone).
 * Historical anchors included.
 *
 * ONCE PER REQUEST. A group stats answer used to read this about three times
 * and a DM about six. Inside `withMomRecordsScope` (opened by the inbound
 * WhatsApp routes) the club's records are read once and shared; outside one,
 * every call reads afresh, so nothing is ever served stale across requests.
 */
import { db } from "./db";
import { momRecordsMemo } from "./mom-records-scope";
import { getOrgFeatures } from "./org-features";
import { organisersPickMom } from "./mom-chooser";
import { resolveTeamLabels } from "./team-labels";
import { NOT_CANCELLED } from "./played-match";
import { clubPostsWhere } from "./club-posting";
import { momVoteClosesAt } from "./mom-vote-window";
import { nextFixtureKickoff, readMomAnnouncedResult, type MomAnnouncedResult } from "./mom-announce-rules";
import { decideMom, type MomDecision, type MomMatchRecord, type MomWinner } from "./pipeline/last-mom";
import { matchMomPostToRoster, parseMomAnnouncementText } from "./mom-announcement-parse";

export interface LoadedMomRecord extends MomMatchRecord {
  matchId: string;
  /** `Match.status`: the player's stats count COMPLETED matches only. */
  status: string;
}

export interface MomRecords {
  records: LoadedMomRecord[];
  /** The club's organisers pick Man of the Match (`mom-chooser.ts`). */
  organisersPick: boolean;
  /** Every user named by the records, by their CURRENT name. */
  nameOf: ReadonlyMap<string, string>;
}

// ── Once per request (`mom-records-scope.ts`) ───────────────────────

export { withMomRecordsScope } from "./mom-records-scope";

// ── The missing table, before the migration is applied ─────────────

let missingTableNoted = false;

/** Tests only: forget the "table missing" note (unless kept). */
export function clearMomRecordsForTests(opts: { keepWarned?: boolean } = {}): void {
  if (!opts.keepWarned) missingTableNoted = false;
}

function isMissingTable(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (e?.code === "P2021" || e?.code === "42P01") return true;
  return typeof e?.message === "string" && /MoMAnnouncement/.test(e.message) && /does not exist/.test(e.message);
}

/** The stored announcement results for the club. BEST EFFORT: the table not
 *  migrated yet is a quiet fallback (one info line per process); any other
 *  failure is logged as an error. Either way it reads as no records. */
async function loadStoredResults(orgId: string): Promise<Map<string, MomAnnouncedResult>> {
  try {
    const rows = await db.moMAnnouncement.findMany({ where: { match: { activity: { orgId } } }, select: { matchId: true, result: true } });
    const out = new Map<string, MomAnnouncedResult>();
    for (const r of rows) {
      const result = readMomAnnouncedResult(r.result);
      if (result) out.set(r.matchId, result);
    }
    return out;
  } catch (err) {
    if (isMissingTable(err)) {
      if (!missingTableNoted) {
        missingTableNoted = true;
        console.info('[mom-records] "MoMAnnouncement" is not migrated yet (20261116120000_mom_announcement); posted results read with no stored record');
      }
    } else {
      console.error("[mom-records] stored MoM results could not be read; posted results read with no stored record:", err);
    }
    return new Map();
  }
}

// ── The read ────────────────────────────────────────────────────────

/** Every match of the club with a Man of the Match, newest first, any date. */
async function readClub(orgId: string): Promise<MomRecords> {
  const [org, features, posting, stored] = await Promise.all([
    db.organisation.findUnique({ where: { id: orgId }, select: { teamLabels: true, language: true } }),
    getOrgFeatures(orgId),
    db.organisation.count({ where: { id: orgId, ...clubPostsWhere() } }),
    loadStoredResults(orgId),
  ]);
  const organisersPick = organisersPickMom(features);
  const storedIds = [...stored.keys()];
  const matches = await db.match.findMany({
    where: {
      activity: { orgId },
      ...NOT_CANCELLED,
      OR: [{ momVotes: { some: {} } }, ...(storedIds.length ? [{ id: { in: storedIds } }] : [])],
    },
    orderBy: { date: "desc" },
    select: {
      id: true,
      date: true,
      status: true,
      isHistorical: true,
      postMatchEndFlow: true,
      activityId: true,
      redScore: true,
      yellowScore: true,
      teamLabels: true,
      activity: {
        select: { orgId: true, venue: true, dayOfWeek: true, ratingWindowHours: true, sport: { select: { teamLabels: true } } },
      },
    },
  });
  if (matches.length === 0) return { records: [], organisersPick, nameOf: new Map() };
  const ids = matches.map((m) => m.id);
  const oldest = matches[matches.length - 1].date;
  const [counts, posted, later] = await Promise.all([
    db.moMVote.groupBy({ by: ["matchId", "playerId"], where: { matchId: { in: ids } }, _count: { playerId: true } }),
    db.sentNotification.findMany({ where: { key: { in: ids.map((id) => `${id}:mom-announcement`) } }, select: { key: true, createdAt: true, text: true, waMessageId: true } }),
    // The fixtures after them, played or to come, for the next-fixture rule.
    db.match.findMany({
      where: { activity: { orgId }, isHistorical: false, date: { gt: oldest } },
      select: { id: true, date: true, status: true, activityId: true, activity: { select: { orgId: true, venue: true, dayOfWeek: true } } },
    }),
  ]);
  const recordUserIds = ids.flatMap((id) => {
    const r = stored.get(id);
    return !r ? [] : r.kind === "pick" ? [r.winner.userId] : r.tally.map((t) => t.userId);
  });
  const users = await db.user.findMany({
    where: { id: { in: [...new Set([...counts.map((c) => c.playerId), ...recordUserIds])] } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(users.map((u) => [u.id, u.name ?? "?"]));
  // A claim counts as POSTED only once the Pi stamped the sent message's id
  // on it (`/api/whatsapp/ack`; round 6 of the review). A claim with none
  // was never confirmed sent: not announced, and never claimed again.
  const sent = posted.filter((p) => p.waMessageId);
  const unsent = new Set(posted.filter((p) => !p.waMessageId).map((p) => p.key));
  const postedAt = new Map(sent.map((p) => [p.key, p.createdAt]));
  const fromText = await resultsFromPostText(
    sent.flatMap((p) => {
      const matchId = p.key.slice(0, -":mom-announcement".length);
      return !stored.has(matchId) && p.text ? [{ matchId, text: p.text }] : [];
    }),
    counts.map((c) => ({ matchId: c.matchId, userId: c.playerId, name: nameOf.get(c.playerId) })),
  );
  const canPost = features.momVoting && posting > 0;
  const records: LoadedMomRecord[] = matches.map((m) => {
    const key = `${m.id}:mom-announcement`;
    const at = postedAt.get(key) ?? null;
    const postUnsent = unsent.has(key);
    return {
      matchId: m.id,
      status: m.status,
      date: m.date,
      teamLabels: resolveTeamLabels({ teamLabels: m.teamLabels }, org, m.activity.sport, org?.language),
      redScore: m.redScore,
      yellowScore: m.yellowScore,
      tally: counts
        .filter((c) => c.matchId === m.id)
        .map((c) => ({ userId: c.playerId, name: nameOf.get(c.playerId) ?? "?", votes: c._count.playerId })),
      announced: at !== null,
      postedAt: at,
      announcedResult: at === null ? null : withCurrentNames(stored.get(m.id) ?? fromText.get(m.id) ?? null, nameOf),
      voteClosesAt: momVoteClosesAt(m.date, m.activity.ratingWindowHours),
      nextFixtureAt: nextFixtureKickoff(m, later),
      isHistorical: m.isHistorical,
      // Not cancelled (the query) is enough: a match that has kicked off and
      // is still to be COMPLETED is posted once it completes, so a pick
      // made in that gap waits for its post (round 6 of the review).
      // `loadMomRecords` keeps only matches that have kicked off.
      announceable: canPost && m.postMatchEndFlow !== false && !postUnsent,
      postUnsent,
    };
  });
  return { records, organisersPick, nameOf };
}

/**
 * A posted result with no stored record, read back from the post's own words
 * (`mom-announcement-parse.ts`): accepted only when our builder renders the
 * parsed result back to the exact text and every name is exactly one of the
 * match's people (CONFIRMED attendance, the team sheet, a player with a vote).
 */
async function resultsFromPostText(
  posts: Array<{ matchId: string; text: string }>,
  voted: Array<{ matchId: string; userId: string; name: string | undefined }>,
): Promise<Map<string, MomAnnouncedResult>> {
  const out = new Map<string, MomAnnouncedResult>();
  const parsed = posts.flatMap((p) => {
    const post = parseMomAnnouncementText(p.text);
    return post ? [{ matchId: p.matchId, post }] : [];
  });
  if (parsed.length === 0) return out;
  const ids = parsed.map((p) => p.matchId);
  const [att, teams] = await Promise.all([
    db.attendance.findMany({ where: { matchId: { in: ids }, status: "CONFIRMED" }, select: { matchId: true, user: { select: { id: true, name: true } } } }),
    db.teamAssignment.findMany({ where: { matchId: { in: ids } }, select: { matchId: true, user: { select: { id: true, name: true } } } }),
  ]);
  for (const { matchId, post } of parsed) {
    const byId = new Map<string, string>();
    for (const r of [...att, ...teams]) if (r.matchId === matchId && r.user?.name) byId.set(r.user.id, r.user.name);
    for (const v of voted) if (v.matchId === matchId && v.name) byId.set(v.userId, v.name);
    const matched = matchMomPostToRoster(post, [...byId].map(([userId, name]) => ({ userId, name })));
    if (matched.ok) out.set(matchId, matched.result);
  }
  return out;
}

/** PURE. A stored result under the players' CURRENT names (round 5 of the
 *  review): ids are stored, so the answer, the tables and the web all say
 *  the name the player goes by now, whatever the post once said. */
function withCurrentNames(r: MomAnnouncedResult | null, nameOf: ReadonlyMap<string, string>): MomAnnouncedResult | null {
  if (!r) return null;
  if (r.kind === "pick") return { ...r, winner: { ...r.winner, name: nameOf.get(r.winner.userId) ?? r.winner.name } };
  return { ...r, tally: r.tally.map((t) => ({ ...t, name: nameOf.get(t.userId) ?? t.name })) };
}

/** The club's records, once per request scope (see the header). */
function clubRecords(orgId: string): Promise<MomRecords> {
  const memo = momRecordsMemo() as Map<string, Promise<MomRecords>> | undefined;
  if (!memo) return readClub(orgId);
  let p = memo.get(orgId);
  if (!p) {
    p = readClub(orgId);
    memo.set(orgId, p);
    // A failed read is not kept: the next reader tries again.
    p.catch(() => memo.delete(orgId));
  }
  return p;
}

/** The club's Man of the Match records that have kicked off by `now`,
 *  newest first; `take` keeps the newest. */
export async function loadMomRecords(orgId: string, now: Date, opts: { take?: number } = {}): Promise<MomRecords> {
  const all = await clubRecords(orgId);
  const played = all.records.filter((r) => r.date.getTime() <= now.getTime());
  return { ...all, records: opts.take ? played.slice(0, opts.take) : played };
}

/** One match's decision and who it credits, by the CURRENT names. */
export interface MomMatchDecision {
  date: Date;
  decision: MomDecision;
  credit: MomWinner[];
  /** A synthetic back-filled anchor: in the group's tables, not a player's
   *  own count (the stats page reads real completed matches only). */
  isHistorical?: boolean;
  /** `Match.status` is COMPLETED. */
  completed?: boolean;
}

/** Every Man of the Match decision of the club, by match id. */
export async function loadMomDecisions(orgId: string, now: Date): Promise<Map<string, MomMatchDecision>> {
  const { records, organisersPick, nameOf } = await loadMomRecords(orgId, now);
  const out = new Map<string, MomMatchDecision>();
  for (const r of records) {
    const decision = decideMom(r, now, organisersPick);
    const credit = decision.kind === "told" ? decision.credit.map((w) => ({ userId: w.userId, name: nameOf.get(w.userId) ?? w.name })) : [];
    out.set(r.matchId, { date: r.date, decision, credit, isHistorical: r.isHistorical, completed: r.status === "COMPLETED" });
  }
  return out;
}

/** PURE. Each player's Man of the Match WINS by these decisions, counted as
 *  the player's own stats count them (`player-stats.ts`): real completed
 *  matches only, a match credited to its winner(s), an open vote to nobody.
 *  Read by the dashboard tile and the admin stats. */
export function momWinsByUser(decisions: ReadonlyMap<string, MomMatchDecision>): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of decisions.values()) {
    if (d.isHistorical || d.completed === false) continue;
    for (const w of d.credit) out.set(w.userId, (out.get(w.userId) ?? 0) + 1);
  }
  return out;
}
