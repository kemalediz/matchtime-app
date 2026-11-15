/**
 * /play's game line LOADER (review fixes, 2026-11-15): which match it names
 * and when it names none.
 *
 * 1. This week's match is still this week's game once its teams are made
 *    (TEAMS_GENERATED, TEAMS_PUBLISHED), as every other "live match" check
 *    counts it. The loader read only UPCOMING, so on the day of the game
 *    the page jumped to next week's. Full this week: no line, never next
 *    week's.
 * 2. A campaign code switched off (PoolCampaign.active false), or one with
 *    no row, is no campaign anywhere else on /play (its visits and sign-ups
 *    count as direct), so it gets no game line and no offer either.
 *
 * The database is a small in-memory fake that honours the where clause the
 * loader sends; no database, no model: $0.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; orgId: string; status: string; isHistorical: boolean; date: Date; maxPlayers: number; venue: string; placesOpen: number };

const state = vi.hoisted(() => ({
  matches: [] as Row[],
  campaigns: [] as { code: string; active: boolean }[],
}));

vi.mock("../../db", () => {
  const statusMatches = (want: unknown, status: string) =>
    typeof want === "string" ? want === status : !!want && typeof want === "object" && "in" in want && (want as { in: string[] }).in.includes(status);
  return {
    db: {
      poolCampaign: {
        findFirst: vi.fn(async ({ where }: { where: { code: string; active?: boolean } }) => {
          const c = state.campaigns.find((r) => r.code === where.code && (where.active === undefined || r.active === where.active));
          return c ? { code: c.code } : null;
        }),
      },
      match: {
        findFirst: vi.fn(
          async ({ where }: { where: { activity: { orgId: string }; status: unknown; isHistorical: boolean; date: { gt: Date } } }) => {
            const hit = state.matches
              .filter(
                (m) =>
                  m.orgId === where.activity.orgId &&
                  statusMatches(where.status, m.status) &&
                  m.isHistorical === where.isHistorical &&
                  m.date.getTime() > where.date.gt.getTime(),
              )
              .sort((a, b) => a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id))[0];
            return hit ? { id: hit.id, date: hit.date, maxPlayers: hit.maxPlayers, activity: { venue: hit.venue } } : null;
          },
        ),
      },
    },
  };
});

vi.mock("../../monthly-week-asks", () => ({
  askPlacesOpen: vi.fn(async (id: string) => state.matches.find((m) => m.id === id)?.placesOpen ?? 0),
}));

import { loadCampaignGame } from "../campaign-game-line-loader";

const SUTTON_FC = "cmnnwhdx30000zfr85q18lyy9";
/** Tuesday 17 Nov 2026, midday: tonight's game at 21:30, next week's 7 days on. */
const NOW = new Date("2026-11-17T12:00:00Z");
const THIS_WEEK = new Date("2026-11-17T21:30:00Z");
const NEXT_WEEK = new Date("2026-11-24T21:30:00Z");

function row(over: Partial<Row> & Pick<Row, "id" | "date" | "status">): Row {
  return { orgId: SUTTON_FC, isHistorical: false, maxPlayers: 14, venue: "Goals North Cheam", placesOpen: 3, ...over };
}

beforeEach(() => {
  state.campaigns = [{ code: "fb1", active: true }];
  state.matches = [row({ id: "m-next", date: NEXT_WEEK, status: "UPCOMING" })];
});

describe("this week's game stays this week's once its teams are made", () => {
  for (const status of ["TEAMS_GENERATED", "TEAMS_PUBLISHED"]) {
    it(`${status} with places open: this week's game is the one named`, async () => {
      state.matches.push(row({ id: "m-this", date: THIS_WEEK, status }));
      const game = await loadCampaignGame("fb1", "en", NOW);
      expect(game?.line).toBe("Tuesday 7-a-side in Sutton: Tue 17 Nov, 9:30pm, Goals North Cheam");
      expect(game?.offer).toBe("First game free for new players");
    });

    it(`${status} and full: no line, and never next week's`, async () => {
      state.matches.push(row({ id: "m-this", date: THIS_WEEK, status, placesOpen: 0 }));
      expect(await loadCampaignGame("fb1", "en", NOW)).toBeNull();
    });
  }

  it("an UPCOMING game is still named, as before", async () => {
    state.matches.push(row({ id: "m-this", date: THIS_WEEK, status: "UPCOMING" }));
    expect((await loadCampaignGame("fb1", "en", NOW))?.line).toContain("Tue 17 Nov");
  });

  it("a cancelled or completed game this week is not the game: next week's is", async () => {
    state.matches.push(row({ id: "m-this", date: THIS_WEEK, status: "CANCELLED" }));
    expect((await loadCampaignGame("fb1", "en", NOW))?.line).toContain("Tue 24 Nov");
  });

  it("a co-timed ghost loses to the lower id, whatever its status", async () => {
    state.matches.push(row({ id: "m-a", date: THIS_WEEK, status: "TEAMS_GENERATED", placesOpen: 2 }));
    state.matches.push(row({ id: "m-b", date: THIS_WEEK, status: "UPCOMING", placesOpen: 0, venue: "Ghost" }));
    expect((await loadCampaignGame("fb1", "en", NOW))?.line).toBe("Tuesday 7-a-side in Sutton: Tue 17 Nov, 9:30pm, Goals North Cheam");
  });
});

describe("a code switched off is no campaign: no line, no offer", () => {
  beforeEach(() => {
    state.matches.push(row({ id: "m-this", date: THIS_WEEK, status: "UPCOMING" }));
  });

  it("an inactive campaign gets nothing", async () => {
    state.campaigns = [{ code: "fb1", active: false }];
    expect(await loadCampaignGame("fb1", "en", NOW)).toBeNull();
  });

  it("a code with no campaign row gets nothing", async () => {
    state.campaigns = [];
    expect(await loadCampaignGame("fb1", "en", NOW)).toBeNull();
  });

  it("only the code's own row counts", async () => {
    state.campaigns = [
      { code: "fb1", active: false },
      { code: "nd", active: true },
    ];
    expect(await loadCampaignGame("fb1", "en", NOW)).toBeNull();
    expect((await loadCampaignGame("nd", "en", NOW))?.line).toContain("Tue 17 Nov");
  });
});
