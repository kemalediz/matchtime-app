/**
 * "4 only" (2026-10-29): where each regular who committed to fewer games
 * stands on each match of the month. Read only, light imports: the weekly
 * flow (`monthly-week.ts`) and the called-off week (`month-close.ts`) both
 * read it. The writer of the count is `month-member-games.ts`.
 */
import type { db } from "./db";
import { commitmentForMatch } from "./monthly-week-rules";
import { londonDateTimeToUtc } from "./london-time";
import { nextMonthStart } from "./month-signup-rules";
import { isSameRecurringFixture, type RecurringFixtureKey } from "./match-slot";

// ── Where each "4 only" regular stands, match by match ─────────────────

export interface CommitmentMonth {
  orgId: string;
  fixture: RecurringFixtureKey;
  /** "2026-11-01". */
  monthStart: string;
  /** Nothing before this is the month's (a month started part-way). */
  startsAt: Date;
  gamesPlayedBeforeStart: number;
  members: Array<{ userId: string; gamesCovered: number; gamesCommitted: number | null; joinedAt: Date; source: string }>;
}

export type CommitmentStates = Map<string, Map<string, { extra: boolean; freeMiss: boolean }>>;

/**
 * For every regular of the month who committed to fewer games, where they
 * stand on each of the month's matches (`commitmentForMatch`), from who
 * played the earlier games. One read of the month's matches. Empty, and no
 * read at all, when nobody committed to fewer games.
 */
export async function loadCommitmentStates(
  client: Pick<typeof db, "match">,
  month: CommitmentMonth,
  now: Date = new Date(),
): Promise<CommitmentStates> {
  const out: CommitmentStates = new Map();
  const committed = month.members.filter((m) => m.gamesCommitted != null);
  if (committed.length === 0) return out;
  const rows = await client.match.findMany({
    where: {
      activity: { orgId: month.orgId },
      isHistorical: false,
      date: { gte: londonDateTimeToUtc(month.monthStart, "00:00"), lt: londonDateTimeToUtc(nextMonthStart(month.monthStart), "00:00") },
    },
    select: {
      id: true,
      date: true,
      status: true,
      activity: { select: { orgId: true, venue: true, dayOfWeek: true } },
      attendances: { where: { userId: { in: committed.map((m) => m.userId) } }, select: { userId: true, status: true } },
    },
    orderBy: { date: "asc" },
  });
  const matches = rows.filter((m) => isSameRecurringFixture(m.activity, month.fixture) && m.date.getTime() >= month.startsAt.getTime());
  for (const m of committed) {
    const states = new Map<string, { extra: boolean; freeMiss: boolean }>();
    const earlier: boolean[] = [];
    const playedBefore = m.source.startsWith("seed") ? month.gamesPlayedBeforeStart : 0;
    for (const match of matches) {
      states.set(match.id, commitmentForMatch({ gamesCovered: m.gamesCovered, gamesCommitted: m.gamesCommitted, playedBefore, earlier }));
      // A game before they joined is not one of theirs; a game still to
      // come is neither played nor missed yet (PR #464 review: a week
      // called off in advance must not be judged against unplayed weeks).
      if (match.date.getTime() < m.joinedAt.getTime() || match.date.getTime() > now.getTime()) continue;
      const row = match.attendances.find((a) => a.userId === m.userId);
      earlier.push(match.status !== "CANCELLED" && row?.status === "CONFIRMED");
    }
    out.set(m.userId, states);
  }
  return out;
}
