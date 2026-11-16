/**
 * /play's game line LOADER (review fixes, 2026-11-15/16): which match it
 * names and when it names none.
 *
 * 1. This week's match is still this week's game once its teams are made
 *    (TEAMS_GENERATED, TEAMS_PUBLISHED), as every other "live match" check
 *    counts it. The loader read only UPCOMING, so on the day of the game
 *    the page jumped to next week's. Full this week: no line, never next
 *    week's.
 * 2. A campaign code switched off (PoolCampaign.active false), or one with
 *    no row, is no campaign: no game line and no offer.
 * 3. The pool's cut-off: past the club's cut-off (the one the ask round
 *    refuses a new ask by, `poolAskCutoffOf`), nobody new can be asked for
 *    the game, so it is not named. Nor is next week's.
 * 4. A cancelled game holds next week's line until its London day is over,
 *    as the bot holds next week's announcement (`isNextUpcomingForPosting`,
 *    rule 3), for the same fixture only (org, venue, weekday).
 * 5. The pool switch: when no ask could go out for the club at all (the
 *    platform switch off, or the club's own pool flag off,
 *    `poolOffersOpenForClub`), the game is not named.
 * 6. A dormant club names nothing.
 *
 * The database is a small in-memory fake that honours the where clauses
 * the loader sends; no database, no model: $0.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { poolSwitchEnv } from "../flags";

type Row = {
  id: string;
  orgId: string;
  activityId: string;
  /** The activity's weekday, 0=Sun..6=Sat. */
  dayOfWeek: number;
  status: string;
  isHistorical: boolean;
  date: Date;
  maxPlayers: number;
  venue: string;
  placesOpen: number;
};

const state = vi.hoisted(() => ({
  matches: [] as Row[],
  campaigns: [] as { code: string; active: boolean }[],
  orgs: {} as Record<string, { dormantAt: Date | null; featurePlayerPool: boolean }>,
  cutoffHours: 2 as number,
}));

vi.mock("@/lib/db", () => {
  type Where = { activity: { orgId: string; org?: { dormantAt?: null } }; isHistorical: boolean; date: { gte: Date } };
  const orgOf = (id: string) => state.orgs[id] ?? { dormantAt: null, featurePlayerPool: false };
  const view = (m: Row) => ({
    id: m.id,
    date: m.date,
    status: m.status,
    activityId: m.activityId,
    isHistorical: m.isHistorical,
    maxPlayers: m.maxPlayers,
    activity: { orgId: m.orgId, venue: m.venue, dayOfWeek: m.dayOfWeek, org: { featurePlayerPool: orgOf(m.orgId).featurePlayerPool } },
  });
  return {
    db: {
      poolCampaign: {
        findFirst: vi.fn(async ({ where }: { where: { code: string; active?: boolean } }) => {
          const c = state.campaigns.find((r) => r.code === where.code && (where.active === undefined || r.active === where.active));
          return c ? { code: c.code } : null;
        }),
      },
      match: {
        findMany: vi.fn(async ({ where }: { where: Where }) =>
          state.matches
            .filter(
              (m) =>
                m.orgId === where.activity.orgId &&
                // `org: { dormantAt: null }`: only a club that is not dormant.
                (where.activity.org?.dormantAt !== null || orgOf(m.orgId).dormantAt === null) &&
                m.isHistorical === where.isHistorical &&
                m.date.getTime() >= where.date.gte.getTime(),
            )
            .map(view),
        ),
      },
    },
  };
});

vi.mock("@/lib/club-partnership", () => ({
  loadPartnerAskSettings: vi.fn(async () => ({ cutoffHours: state.cutoffHours })),
}));

vi.mock("@/lib/monthly-week-asks", () => ({
  askPlacesOpen: vi.fn(async (id: string) => state.matches.find((m) => m.id === id)?.placesOpen ?? 0),
}));

import { loadCampaignGame } from "../campaign-game-line-loader";

const SUTTON_FC = "cmnnwhdx30000zfr85q18lyy9";
const HOUR = 3600_000;
const TUESDAY = 2;
const THURSDAY = 4;
/** The platform switch on, as `poolEnvForRequest` resolves it. */
const OPEN = poolSwitchEnv(true);
/** Tuesday 17 Nov 2026, midday: tonight's game at 21:30, next week's 7 days on. */
const NOW = new Date("2026-11-17T12:00:00Z");
const THIS_WEEK = new Date("2026-11-17T21:30:00Z");
const NEXT_WEEK = new Date("2026-11-24T21:30:00Z");
const THIS_WEEK_LINE = "Tuesday 7-a-side in Sutton: Tue 17 Nov, 9:30pm, Goals North Cheam";
const NEXT_WEEK_LINE = "Tuesday 7-a-side in Sutton: Tue 24 Nov, 9:30pm, Goals North Cheam";

const load = (code: string | null, now: Date = NOW, env: Record<string, string | undefined> = OPEN) => loadCampaignGame(code, "en", { env, now });

function row(over: Partial<Row> & Pick<Row, "id" | "date" | "status">): Row {
  return {
    orgId: SUTTON_FC,
    activityId: "tuesday-7aside",
    dayOfWeek: TUESDAY,
    isHistorical: false,
    maxPlayers: 14,
    venue: "Goals North Cheam",
    placesOpen: 3,
    ...over,
  };
}

beforeEach(() => {
  state.campaigns = [{ code: "fb1", active: true }];
  state.orgs = { [SUTTON_FC]: { dormantAt: null, featurePlayerPool: true } };
  state.cutoffHours = 2;
  state.matches = [row({ id: "m-next", date: NEXT_WEEK, status: "UPCOMING" })];
});

describe("this week's game stays this week's once its teams are made", () => {
  for (const status of ["TEAMS_GENERATED", "TEAMS_PUBLISHED"]) {
    it(`${status} with places open: this week's game is the one named`, async () => {
      state.matches.push(row({ id: "m-this", date: THIS_WEEK, status }));
      const game = await load("fb1");
      expect(game?.line).toBe(THIS_WEEK_LINE);
      expect(game?.offer).toBe("First game free for new players");
    });

    it(`${status} and full: no line, and never next week's`, async () => {
      state.matches.push(row({ id: "m-this", date: THIS_WEEK, status, placesOpen: 0 }));
      expect(await load("fb1")).toBeNull();
    });
  }

  it("an UPCOMING game is still named, as before", async () => {
    state.matches.push(row({ id: "m-this", date: THIS_WEEK, status: "UPCOMING" }));
    expect((await load("fb1"))?.line).toBe(THIS_WEEK_LINE);
  });

  it("a co-timed ghost loses to the lower id, whatever its status", async () => {
    state.matches.push(row({ id: "m-a", date: THIS_WEEK, status: "TEAMS_GENERATED", placesOpen: 2 }));
    state.matches.push(row({ id: "m-b", activityId: "tuesday-5aside", date: THIS_WEEK, status: "UPCOMING", placesOpen: 0, venue: "Ghost" }));
    expect((await load("fb1"))?.line).toBe(THIS_WEEK_LINE);
  });
});

describe("a code switched off is no campaign: no line, no offer", () => {
  beforeEach(() => {
    state.matches.push(row({ id: "m-this", date: THIS_WEEK, status: "UPCOMING" }));
  });

  it("an inactive campaign gets nothing", async () => {
    state.campaigns = [{ code: "fb1", active: false }];
    expect(await load("fb1")).toBeNull();
  });

  it("a code with no campaign row gets nothing", async () => {
    state.campaigns = [];
    expect(await load("fb1")).toBeNull();
  });

  it("only the code's own row counts", async () => {
    state.campaigns = [
      { code: "fb1", active: false },
      { code: "nd", active: true },
    ];
    expect(await load("fb1")).toBeNull();
    expect((await load("nd"))?.line).toBe(THIS_WEEK_LINE);
  });
});

describe("only while a new player could still be asked: the pool's cut-off", () => {
  beforeEach(() => {
    state.matches.push(row({ id: "m-this", date: THIS_WEEK, status: "TEAMS_PUBLISHED" }));
  });

  it("a minute before the club's cut-off: named", async () => {
    expect((await load("fb1", new Date(THIS_WEEK.getTime() - 2 * HOUR - 60_000)))?.line).toBe(THIS_WEEK_LINE);
  });

  it("at the cut-off, as the ask round refuses: no line, and not next week's", async () => {
    expect(await load("fb1", new Date(THIS_WEEK.getTime() - 2 * HOUR))).toBeNull();
  });

  it("between the cut-off and kickoff: no line, and not next week's", async () => {
    expect(await load("fb1", new Date(THIS_WEEK.getTime() - 30 * 60_000))).toBeNull();
  });

  it("after kickoff, while the game is still live: not next week's", async () => {
    expect(await load("fb1", new Date(THIS_WEEK.getTime() + 30 * 60_000))).toBeNull();
  });

  it("the club's own cut-off counts: 4 hours", async () => {
    state.cutoffHours = 4;
    expect((await load("fb1", new Date(THIS_WEEK.getTime() - 4 * HOUR - 60_000)))?.line).toBe(THIS_WEEK_LINE);
    expect(await load("fb1", new Date(THIS_WEEK.getTime() - 3 * HOUR))).toBeNull();
  });

  it("once tonight's game is over (COMPLETED), next week's is named", async () => {
    state.matches = state.matches.map((m) => (m.id === "m-this" ? { ...m, status: "COMPLETED" } : m));
    expect((await load("fb1", new Date("2026-11-17T23:30:00Z")))?.line).toBe(NEXT_WEEK_LINE);
  });
});

describe("a cancelled game holds next week's line until its London day is over", () => {
  beforeEach(() => {
    state.matches.push(row({ id: "m-this", date: THIS_WEEK, status: "CANCELLED" }));
  });

  it("on the cancelled game's day: no line, not next week's", async () => {
    expect(await load("fb1")).toBeNull();
    expect(await load("fb1", new Date("2026-11-17T23:59:00Z"))).toBeNull();
  });

  it("from London midnight after it: next week's", async () => {
    expect((await load("fb1", new Date("2026-11-18T00:01:00Z")))?.line).toBe(NEXT_WEEK_LINE);
  });

  it("the same fixture under another activity (a format switch) still holds", async () => {
    state.matches = state.matches.map((m) => (m.id === "m-this" ? { ...m, activityId: "tuesday-5aside" } : m));
    expect(await load("fb1")).toBeNull();
  });

  it("a cancelled game at another venue holds nothing", async () => {
    state.matches = state.matches.map((m) => (m.id === "m-this" ? { ...m, activityId: "tuesday-elsewhere", venue: "Elsewhere" } : m));
    expect((await load("fb1"))?.line).toBe(NEXT_WEEK_LINE);
  });

  it("a cancelled game on another weekday at the same venue holds nothing", async () => {
    // Thursday's game at Goals North Cheam, cancelled for Thu 19 Nov: another fixture.
    state.matches = state.matches.map((m) =>
      m.id === "m-this" ? { ...m, activityId: "thursday-5aside", dayOfWeek: THURSDAY, date: new Date("2026-11-19T20:00:00Z") } : m,
    );
    expect((await load("fb1"))?.line).toBe(NEXT_WEEK_LINE);
  });
});

describe("only while an ask could go out for the club: the pool switch", () => {
  beforeEach(() => {
    state.matches.push(row({ id: "m-this", date: THIS_WEEK, status: "UPCOMING" }));
  });

  it("platform switch on and the club's pool on: named", async () => {
    expect((await load("fb1"))?.line).toBe(THIS_WEEK_LINE);
  });

  it("the platform switch off: nothing", async () => {
    expect(await load("fb1", NOW, poolSwitchEnv(false))).toBeNull();
  });

  it("the platform switch unread (never resolved for the call): nothing", async () => {
    expect(await load("fb1", NOW, {})).toBeNull();
  });

  it("the club's own pool flag off: nothing", async () => {
    state.orgs[SUTTON_FC].featurePlayerPool = false;
    expect(await load("fb1")).toBeNull();
  });
});

describe("a dormant club names nothing", () => {
  it("dormant: no line, even with a game and places", async () => {
    state.matches.push(row({ id: "m-this", date: THIS_WEEK, status: "UPCOMING" }));
    state.orgs[SUTTON_FC].dormantAt = new Date("2026-11-01T00:00:00Z");
    expect(await load("fb1")).toBeNull();
  });
});
