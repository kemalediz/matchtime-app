/**
 * THE SQUAD COUNT AS IT STANDS, for a count line (FNF HQ, 2026-10-18).
 * The words are `squad-count-line.ts`; this reads the facts they need:
 * how many are confirmed, the places, who is on the bench (in bench
 * order, leaving out anyone who has left the club, as the organisers'
 * pick list does) and the club's bench pick mode. No model.
 *
 * Every count line is read by the organisers only (the HQ "Done" and
 * pasted-list replies, the late drop-out notice), so a bencher is shown
 * under the organisers' label (`organiser-names.ts`): the best name
 * MatchTime holds, else his phone, else the club's word for "unnamed".
 * Never "?" (sandbox club replay, 2026-11-04: "2 on the bench (? and
 * Bilal) ... (for example ?)").
 */
import { db } from "./db";
import { t } from "./i18n/t";
import { loadOrganiserNames } from "./organiser-names";

export interface SquadCount {
  confirmed: number;
  maxPlayers: number | null;
  bench: string[];
  benchPickMode: string | null;
}

/** `lang`: the language the line is written in; the club's when absent. */
export async function loadSquadCount(matchId: string, lang?: string | null): Promise<SquadCount> {
  const m = await db.match.findUnique({
    where: { id: matchId },
    select: {
      maxPlayers: true,
      activity: { select: { orgId: true, org: { select: { benchPickMode: true, language: true } } } },
      attendances: {
        where: { status: { in: ["CONFIRMED", "BENCH"] } },
        orderBy: { position: "asc" },
        select: { userId: true, status: true },
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
  const benchIds = benchRows.filter((a) => !left.has(a.userId)).map((a) => a.userId);
  const lineLang = lang ?? m.activity.org?.language ?? null;
  const labels = await loadOrganiserNames(m.activity.orgId, lineLang, benchIds);
  const unnamed = t(lineLang).unnamed;
  return {
    confirmed: m.attendances.filter((a) => a.status === "CONFIRMED").length,
    maxPlayers: m.maxPlayers,
    bench: benchIds.map((id) => labels.get(id)?.admin ?? unnamed),
    benchPickMode: m.activity.org?.benchPickMode ?? null,
  };
}
