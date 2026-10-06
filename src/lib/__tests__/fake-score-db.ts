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
  /** Prisma's `@updatedAt`. Defaults to kickoff plus two hours, and is
   *  bumped by every `match.update`, as the real column is. */
  updatedAt?: Date;
}

export function fakeScoreDb(init: { matches: FakeMatch[]; ratings: Record<string, number>; language?: string }) {
  const matches = new Map(
    init.matches.map((m) => [m.id, { ...m, updatedAt: m.updatedAt ?? new Date(m.date.getTime() + 2 * 3600_000) }]),
  );
  const ratings = new Map(Object.entries(init.ratings));
  /** What was done, in order: "lock:match", "lock:memberships",
   *  "rating:<userId>". For the tests about ORDER; everything else
   *  asserts on state. */
  const log: string[] = [];
  /** `SentNotification`, as far as the score writers touch it: the
   *  open "which team won?" question (`pipeline/score-ask.ts`). */
  const notifications: Array<{ key: string; kind: string; matchId: string | null; targetUser?: string | null }> = [];
  /** A clock that only moves forward, for `updatedAt`. */
  let tick = Math.max(...[...matches.values()].map((m) => m.updatedAt!.getTime()), 0);

  const view = (m: FakeMatch) => ({
    id: m.id,
    date: m.date,
    status: m.status,
    redScore: m.redScore,
    yellowScore: m.yellowScore,
    eloApplied: m.eloApplied,
    updatedAt: m.updatedAt,
    activity: { orgId: m.orgId, name: "Tuesday 7-a-side", org: { language: init.language ?? "en" } },
    teamAssignments: m.teams,
    attendances: [],
  });

  const db = {
    async $transaction<T>(arg: ((tx: unknown) => Promise<T>) | Array<Promise<unknown>>): Promise<unknown> {
      if (Array.isArray(arg)) return Promise.all(arg);
      // All or nothing, like the real thing.
      const snapM = new Map([...matches].map(([k, v]) => [k, structuredClone(v)]));
      const snapR = new Map(ratings);
      const snapN = notifications.map((n) => ({ ...n }));
      try {
        return await arg(db);
      } catch (err) {
        matches.clear();
        for (const [k, v] of snapM) matches.set(k, v);
        ratings.clear();
        for (const [k, v] of snapR) ratings.set(k, v);
        notifications.splice(0, notifications.length, ...snapN);
        throw err;
      }
    },
    async $queryRaw(strings: TemplateStringsArray) {
      log.push(strings.join("?").includes('"Membership"') ? "lock:memberships" : "lock:match");
      return [];
    },
    match: {
      async findUnique({ where }: { where: { id: string } }) {
        const m = matches.get(where.id);
        return m ? view(m) : null;
      },
      async update({ where, data }: { where: { id: string }; data: Partial<FakeMatch> }) {
        const m = matches.get(where.id)!;
        tick += 1000;
        Object.assign(m, data, { updatedAt: new Date(tick) });
        return view(m);
      },
      // "Is there another scored match of this club that is later, by
      // kickoff or by when it was last written?"
      async findFirst({
        where,
      }: {
        where: { id: { not: string }; OR: [{ date: { gt: Date } }, { updatedAt: { gt: Date } }] };
      }) {
        const self = matches.get(where.id.not);
        const afterKickoff = where.OR[0].date.gt;
        const afterWrite = where.OR[1].updatedAt.gt;
        for (const m of matches.values()) {
          if (m.id === where.id.not || m.orgId !== self?.orgId || m.redScore === null) continue;
          if (m.date > afterKickoff || m.updatedAt! > afterWrite) return { id: m.id };
        }
        return null;
      },
    },
    sentNotification: {
      async deleteMany({ where }: { where: { kind: string; matchId: string } }) {
        const before = notifications.length;
        for (let i = notifications.length - 1; i >= 0; i--) {
          if (notifications[i].kind === where.kind && notifications[i].matchId === where.matchId) notifications.splice(i, 1);
        }
        return { count: before - notifications.length };
      },
      async upsert({ where, create }: { where: { key: string }; create: { key: string; kind: string; matchId: string } }) {
        if (!notifications.some((n) => n.key === where.key)) notifications.push({ ...create });
        return create;
      },
      async create({ data }: { data: { key: string; kind: string; matchId: string; targetUser?: string | null } }) {
        if (notifications.some((n) => n.key === data.key)) throw new Error("Unique constraint failed on key");
        notifications.push({ ...data });
        return data;
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
        log.push(`rating:${where.userId}`);
        const r = data.matchRating;
        ratings.set(
          where.userId,
          typeof r === "number" ? r : ratings.get(where.userId)! + (r.increment ?? 0) - (r.decrement ?? 0),
        );
        return { count: 1 };
      },
    },
  };
  return { db: db as never, matches, ratings, log, notifications };
}
