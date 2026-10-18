/**
 * THE SQUAD COUNT AS IT STANDS, for a count line (FNF HQ, 2026-10-18).
 * The words are `squad-count-line.ts`; this reads the facts they need:
 * how many are confirmed, the places, who is on the bench (in bench
 * order, leaving out anyone who has left the club, as the organisers'
 * pick list does) and the club's bench pick mode. No model.
 */
import { db } from "./db";

export interface SquadCount {
  confirmed: number;
  maxPlayers: number | null;
  bench: string[];
  benchPickMode: string | null;
}

export async function loadSquadCount(matchId: string): Promise<SquadCount> {
  const m = await db.match.findUnique({
    where: { id: matchId },
    select: {
      maxPlayers: true,
      activity: { select: { orgId: true, org: { select: { benchPickMode: true } } } },
      attendances: {
        where: { status: { in: ["CONFIRMED", "BENCH"] } },
        orderBy: { position: "asc" },
        select: { userId: true, status: true, user: { select: { name: true } } },
      },
    },
  });
  if (!m) return { confirmed: 0, maxPlayers: null, bench: [], benchPickMode: null };
  const benchRows = m.attendances.filter((a) => a.status === "BENCH");
  const left = benchRows.length
    ? new Set(
        (
          await db.membership.findMany({
            where: { orgId: m.activity.orgId, userId: { in: benchRows.map((a) => a.userId) }, leftAt: { not: null } },
            select: { userId: true },
          })
        ).map((x) => x.userId),
      )
    : new Set<string>();
  return {
    confirmed: m.attendances.filter((a) => a.status === "CONFIRMED").length,
    maxPlayers: m.maxPlayers,
    bench: benchRows.filter((a) => !left.has(a.userId)).map((a) => a.user.name ?? "?"),
    benchPickMode: m.activity.org?.benchPickMode ?? null,
  };
}
