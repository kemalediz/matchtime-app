/**
 * THE CLUB SUMMARY'S LOADER (slice A0): which reads it makes, how many, and
 * that it hands them to `buildClubSummary` unchanged. The database is an
 * in-memory fake that records every call, so the QUERY COUNT is pinned per
 * club shape: a summary must stay a fixed, small set of indexed reads,
 * whatever reads it afterwards (plan section 3.3).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FNF, MUTED, NOW, RATINGS, SUTTON, VETS } from "./fixtures";
import type { ClubRows } from "../derive";

type Call = { model: string; method: string; args: Record<string, unknown> };
const calls: Call[] = [];
let world: ClubRows | null = null;

/** The Organisation row as Prisma returns it: the summary's columns plus the
 *  feature switches `getOrgFeatures` selects. */
function orgColumns(rows: ClubRows): Record<string, unknown> {
  const f = rows.features;
  return {
    ...rows.org,
    featureAttendance: f.attendance,
    featureBench: f.bench,
    featureTeamBalancing: f.teamBalancing,
    featureMomVoting: f.momVoting,
    featurePlayerRating: f.playerRating,
    featureReminders: f.reminders,
    featureStatsQa: f.statsQa,
    featureSquadFromList: f.squadFromList,
    featureBadgeAnnouncements: f.badgeAnnouncements,
    featureGearReminder: f.gearReminder ?? true,
  };
}

function handler(model: string, method: string) {
  return async (args: Record<string, unknown> = {}) => {
    calls.push({ model, method, args });
    const w = world;
    if (!w) return method.endsWith("Many") ? [] : null;
    switch (`${model}.${method}`) {
      case "organisation.findUnique":
        return (args.where as { id: string }).id === w.org.id ? orgColumns(w) : null;
      case "user.findUnique":
        return { name: w.collectorName };
      case "activity.findMany":
        return w.activities;
      case "match.findMany":
        return args.take === 10 ? w.lastPlayed : w.matches;
      case "squadMonth.findMany":
        return w.months;
      case "sentNotification.findMany":
        return w.heldKeys.map((key) => ({ key }));
      case "membership.findMany":
        // The roster read (ordered), else loadPlayerNames' guest lookup.
        return args.orderBy ? (w.members?.rows ?? []) : (w.members?.rows ?? []).map((r) => ({ userId: r.user.id, guestFromOrgId: null, guestMatchId: null }));
      case "user.findMany":
        return (w.members?.rows ?? []).map((r) => ({ id: r.user.id, name: r.user.name }));
      case "userAlias.findMany":
        return Object.entries(w.members?.aliases ?? {}).flatMap(([userId, list]) => list.map((alias) => ({ userId, orgId: w.org.id, alias })));
      case "analyzedMessage.findMany":
        return [];
      default:
        return method.endsWith("Many") ? [] : null;
    }
  };
}

const MODELS = ["organisation", "user", "activity", "match", "squadMonth", "sentNotification", "membership", "userAlias", "analyzedMessage"];
const METHODS = ["findUnique", "findFirst", "findMany", "count", "groupBy", "aggregate"];

vi.mock("@/lib/db", () => ({
  db: Object.fromEntries(MODELS.map((m) => [m, Object.fromEntries(METHODS.map((x) => [x, handler(m, x)]))])),
}));

beforeEach(() => {
  calls.length = 0;
  world = null;
});

async function load(rows: ClubRows, opts?: { members?: boolean }) {
  world = rows;
  const { loadClubSummary } = await import("../load");
  return loadClubSummary(rows.org.id, NOW, opts);
}

const reads = () => calls.map((c) => `${c.model}.${c.method}`);

describe("query count, pinned per shape", () => {
  it("weekly, no collector, no members (FNF as the scheduler loads it): 5 reads", async () => {
    await load(FNF);
    expect(reads().sort()).toEqual(["activity.findMany", "match.findMany", "match.findMany", "organisation.findUnique", "organisation.findUnique"]);
  });

  it("weekly with a collector (Sutton): 6, the collector's name is one more", async () => {
    await load(SUTTON);
    expect(calls).toHaveLength(6);
    expect(reads()).toContain("user.findUnique");
  });

  it("monthly with a collector (the Vets): 8, the months and the held keys", async () => {
    await load(VETS);
    expect(calls).toHaveLength(8);
    expect(reads().filter((r) => r === "squadMonth.findMany" || r === "sentNotification.findMany")).toHaveLength(2);
  });

  it("a weekly club never reads months or held keys", async () => {
    for (const shape of [SUTTON, FNF, RATINGS, MUTED]) {
      calls.length = 0;
      await load(shape);
      expect(reads()).not.toContain("squadMonth.findMany");
      expect(reads()).not.toContain("sentNotification.findMany");
      expect(reads()).not.toContain("membership.findMany");
    }
  });

  it("members are read only when asked: the roster, loadPlayerNames' reads and the aliases", async () => {
    await load(SUTTON, { members: true });
    // 6 club reads + the roster + loadPlayerNames (users, memberships, aliases) + withAliases.
    expect(calls).toHaveLength(11);
    expect(reads().filter((r) => r === "membership.findMany")).toHaveLength(2);
    expect(reads().filter((r) => r === "userAlias.findMany")).toHaveLength(2);
  });

  it("slice A1: the club's row handed in (the poll found the club by its group with CLUB_ORG_SELECT) is not read again", async () => {
    world = SUTTON;
    const { loadClubSummary, CLUB_ORG_SELECT } = await import("../load");
    expect(CLUB_ORG_SELECT).toMatchObject({ id: true, approvedAt: true, liveAt: true, squadMode: true, paygPricePence: true });
    const handedIn = (await load(SUTTON))!;
    calls.length = 0;
    const s = await loadClubSummary(SUTTON.org.id, NOW, { org: SUTTON.org });
    // getOrgFeatures still reads its own select; the club's row is not read.
    expect(calls.filter((c) => c.model === "organisation")).toHaveLength(1);
    expect(calls.filter((c) => c.model === "organisation" && (c.args.select as Record<string, unknown>)?.paygPricePence)).toHaveLength(0);
    // The switches, the collector, the games, the match window, the last played.
    expect(calls).toHaveLength(5);
    expect(s).toEqual(handedIn);
  });

  it("slice A1: a row of ANOTHER club handed in is ignored, and the right one read", async () => {
    world = SUTTON;
    const { loadClubSummary } = await import("../load");
    const s = await loadClubSummary(SUTTON.org.id, NOW, { org: FNF.org });
    expect(s!.orgId).toBe("org-sutton");
    expect(s!.name).toBe("Sutton FC");
  });

  it("slice A1: re-read after the month sweeps' writes, keeping the rows they cannot change: the matches, the months and the held keys only (3 reads for the Vets)", async () => {
    world = VETS;
    const { loadClubSummary } = await import("../load");
    const full = (await load(VETS))!;
    calls.length = 0;
    const again = await loadClubSummary(VETS.org.id, NOW, {
      org: VETS.org,
      keep: { features: VETS.features, collectorName: VETS.collectorName, activities: VETS.activities, lastPlayed: VETS.lastPlayed },
    });
    expect(reads().sort()).toEqual(["match.findMany", "sentNotification.findMany", "squadMonth.findMany"]);
    expect(calls.find((c) => c.model === "match")!.args.take).toBeUndefined();
    expect(again).toEqual(full);
  });

  it("a nameless member costs loadPlayerNames one more read (his WhatsApp name)", async () => {
    await load(FNF, { members: true });
    expect(reads()).toContain("analyzedMessage.findMany");
    // 5 club reads + the roster + loadPlayerNames (users, memberships, aliases, WhatsApp names) + withAliases.
    expect(calls).toHaveLength(11);
  });
});

describe("what it reads", () => {
  it("the match window is the scheduler's: live of any date, completed in the lookback, cancelled in the last 24 hours, never historical", async () => {
    await load(SUTTON);
    const { POST_MATCH_LOOKBACK_DAYS } = await import("../../scheduler-windows");
    const window = calls.find((c) => c.model === "match" && c.method === "findMany" && c.args.take === undefined)!;
    const where = window.args.where as { activity: { orgId: string }; isHistorical: boolean; OR: Array<{ status: unknown; date?: { gte: Date } }> };
    expect(where.activity).toEqual({ orgId: "org-sutton" });
    expect(where.isHistorical).toBe(false);
    expect(where.OR[0]).toEqual({ status: { in: ["UPCOMING", "TEAMS_GENERATED", "TEAMS_PUBLISHED"] } });
    expect(where.OR[1]).toEqual({ status: "COMPLETED", date: { gte: new Date(NOW.getTime() - POST_MATCH_LOOKBACK_DAYS * 86_400_000) } });
    expect(where.OR[2]).toEqual({ status: "CANCELLED", date: { gte: new Date(NOW.getTime() - 86_400_000) } });
    expect(window.args.orderBy).toEqual({ date: "asc" });
  });

  it("the last played match: loadSquadState's read (ten most recent, kicked off by now, no date floor)", async () => {
    await load(SUTTON);
    const last = calls.find((c) => c.model === "match" && c.args.take === 10)!;
    expect(last.args.where).toEqual({ activity: { orgId: "org-sutton" }, status: { in: ["TEAMS_GENERATED", "TEAMS_PUBLISHED", "COMPLETED"] }, date: { lte: NOW } });
    expect(last.args.orderBy).toEqual({ date: "desc" });
  });

  it("the months: running, closed in the last two weeks, and every month of a loaded match, this one and the next", async () => {
    await load(VETS);
    const q = calls.find((c) => c.model === "squadMonth")!;
    const where = q.args.where as { orgId: string; OR: Array<Record<string, unknown>> };
    expect(where.orgId).toBe("org-vets");
    expect(where.OR).toContainEqual({ status: "running" });
    expect(where.OR).toContainEqual({ status: "closed", closedAt: { gte: new Date(NOW.getTime() - 14 * 86_400_000) } });
    const starts = (where.OR.find((o) => "monthStart" in o) as { monthStart: { in: Date[] } }).monthStart.in.map((d) => d.toISOString().slice(0, 10));
    expect(starts).toEqual(["2026-11-01", "2026-12-01"]);
  });

  it("the held keys: one prefix read", async () => {
    await load(VETS);
    const q = calls.find((c) => c.model === "sentNotification")!;
    expect(q.args.where).toEqual({ key: { startsWith: "org-org-vets:msu:held:" } });
  });

  it("the roster read: members still in the club, oldest first", async () => {
    await load(SUTTON, { members: true });
    const q = calls.find((c) => c.model === "membership" && c.args.orderBy)!;
    expect(q.args.where).toEqual({ orgId: "org-sutton", leftAt: null });
    expect(q.args.orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
  });
});

describe("what it returns", () => {
  it("an unknown club is null", async () => {
    world = SUTTON;
    const { loadClubSummary } = await import("../load");
    expect(await loadClubSummary("org-nobody", NOW)).toBeNull();
  });

  it("the summary is buildClubSummary's over the rows read, and features are getOrgFeatures'", async () => {
    const s = (await load(VETS, { members: true }))!;
    const { buildClubSummary } = await import("../derive");
    const { getOrgFeatures } = await import("../../org-features");
    const features = await getOrgFeatures("org-vets");
    expect(s.features).toEqual(features);
    expect(s).toEqual(
      buildClubSummary(
        {
          ...VETS,
          features,
          members: { rows: VETS.members!.rows, displayNames: Object.fromEntries(VETS.members!.rows.map((r) => [r.user.id, r.user.name!])), aliases: VETS.members!.aliases },
        },
        NOW,
      ),
    );
  });

  it("collection live is isPaymentCollectionLive's (Sutton yes, the Vets no)", async () => {
    expect((await load(SUTTON))!.payments.collectionLive).toBe(true);
    expect((await load(VETS))!.payments.collectionLive).toBe(false);
  });

  it("with no collector set, no collector read", async () => {
    await load(FNF);
    expect(reads()).not.toContain("user.findUnique");
  });
});
