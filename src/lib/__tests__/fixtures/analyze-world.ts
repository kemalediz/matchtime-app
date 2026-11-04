/**
 * A FAKE DATABASE FOR THE ANALYZE PATH'S CHARACTERISATION (club summary,
 * slice A2, MDs/club-summary-design-2026-11-04.md section 4.2).
 *
 * The scheduler's fake world (`scheduler-world.ts`, slice A1) for one club
 * of the summary's fixtures, plus the tables the analyze route and
 * `loadSquadState` read that the scheduler does not: each match's
 * attendance and team rows as tables of their own, and the club's aliases.
 * Every other table answers empty. Reads return full rows (a superset of
 * any select); writes succeed, are logged, and change nothing, so every
 * request of the characterisation sees the same world before and after
 * the slice.
 */
import type { ClubRows } from "../../club-summary/derive";
import { fakeSchedulerDb, schedulerWorld, type Call, type SchedulerWorld } from "./scheduler-world";

type Row = Record<string, unknown>;

export interface AnalyzeWorld extends SchedulerWorld {
  extra: Record<string, Row[]>;
}

export function analyzeWorld(rows: ClubRows): AnalyzeWorld {
  const w = schedulerWorld(rows);
  const attendance = w.matches.flatMap((m) => (m.attendances as Row[]).map((a) => ({ ...a })));
  const teamAssignment = w.matches.flatMap((m) =>
    (m.teamAssignments as Row[]).map((t, i) => ({ id: `ta-${m.id}-${String(i).padStart(2, "0")}`, matchId: m.id, userId: t.userId, team: t.team, user: t.user })),
  );
  const userAlias = Object.entries(rows.members?.aliases ?? {}).flatMap(([userId, list]) =>
    list.map((alias, i) => ({ id: `al-${userId}-${i}`, orgId: rows.org.id, userId, alias: alias.toLowerCase(), source: "manual", createdAt: new Date("2026-01-01T00:00:00Z") })),
  );
  // Every match carries the columns the squad state reads.
  for (const m of w.matches) {
    m.teamLabels = [];
    m.activity = { ...(m.activity as Row), sport: { ...((m.activity as Row).sport as Row), teamLabels: [] } };
  }
  w.org.teamLabels = [];
  for (const s of w.sports) s.teamLabels = [];
  return { ...w, extra: { attendance, teamAssignment, userAlias } };
}

export function fakeAnalyzeDb(world: AnalyzeWorld, calls: Call[]) {
  return fakeSchedulerDb(world, calls, world.extra, "per-model");
}

export type { Call };
