/**
 * A tiny in-memory stand-in for the Prisma calls the score writers make
 * (`match-elo.ts`, `membership-elo.ts`, `actions/matches.ts`).
 *
 * It keeps REAL STATE (matches and ratings), so a test asserts what the
 * ratings end up as, never which method was called. It understands both
 * ways a rating is written (an absolute number, and increment or
 * decrement) and both forms of `$transaction` (a callback, and an array
 * of promises), so the same test can be run against the code before and
 * after the 2026-10-07 change.
 */
export type Team = "RED" | "YELLOW";

export interface FakeMatch {
  id: string;
  orgId: string;
  date: Date;
  status: string;
  redScore: number | null;
  yellowScore: number | null;
  eloApplied: unknown;
  teams: Array<{ userId: string; team: Team }>;
}

export function fakeScoreDb(init: { matches: FakeMatch[]; ratings: Record<string, number> }) {
  const matches = new Map(init.matches.map((m) => [m.id, m]));
  const ratings = new Map(Object.entries(init.ratings));

  const view = (m: FakeMatch) => ({
    id: m.id,
    date: m.date,
    status: m.status,
    redScore: m.redScore,
    yellowScore: m.yellowScore,
    eloApplied: m.eloApplied,
    activity: { orgId: m.orgId, name: "Tuesday 7-a-side" },
    teamAssignments: m.teams,
    attendances: [],
  });

  const db = {
    async $transaction<T>(arg: ((tx: unknown) => Promise<T>) | Array<Promise<unknown>>): Promise<unknown> {
      if (Array.isArray(arg)) return Promise.all(arg);
      // All or nothing, like the real thing.
      const snapM = new Map([...matches].map(([k, v]) => [k, structuredClone(v)]));
      const snapR = new Map(ratings);
      try {
        return await arg(db);
      } catch (err) {
        matches.clear();
        for (const [k, v] of snapM) matches.set(k, v);
        ratings.clear();
        for (const [k, v] of snapR) ratings.set(k, v);
        throw err;
      }
    },
    async $queryRaw() {
      return [];
    },
    match: {
      async findUnique({ where }: { where: { id: string } }) {
        const m = matches.get(where.id);
        return m ? view(m) : null;
      },
      async update({ where, data }: { where: { id: string }; data: Partial<FakeMatch> }) {
        const m = matches.get(where.id)!;
        Object.assign(m, data);
        return view(m);
      },
      async findFirst({ where }: { where: { id: { not: string }; date: { gt: Date } } }) {
        const self = matches.get(where.id.not);
        for (const m of matches.values()) {
          if (m.id !== where.id.not && m.orgId === self?.orgId && m.date > where.date.gt && m.redScore !== null) {
            return { id: m.id };
          }
        }
        return null;
      },
    },
    membership: {
      async findMany({ where }: { where: { userId: { in: string[] } } }) {
        return where.userId.in
          .filter((u) => ratings.has(u))
          .map((u) => ({ userId: u, matchRating: ratings.get(u)! }));
      },
      async updateMany({
        where,
        data,
      }: {
        where: { userId: string };
        data: { matchRating: number | { increment?: number; decrement?: number } };
      }) {
        if (!ratings.has(where.userId)) return { count: 0 };
        const r = data.matchRating;
        ratings.set(
          where.userId,
          typeof r === "number" ? r : ratings.get(where.userId)! + (r.increment ?? 0) - (r.decrement ?? 0),
        );
        return { count: 1 };
      },
    },
  };
  return { db: db as never, matches, ratings };
}
