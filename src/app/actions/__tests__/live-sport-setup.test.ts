/**
 * CLUB SETUP OFFERS ONLY LIVE SPORTS, AND THE SERVER HOLDS THE LINE
 * (Kemal, 2026-10-25: football only, behind `LIVE_SPORTS`).
 *
 * The pickers only show live sports, but a server action is called over
 * the network with whatever the caller sends. Each entry point that makes
 * a club's sport, or a weekly game on one, refuses a sport that is not
 * live. A club that already plays a sport that is not live keeps it: it
 * may still add games on it.
 *
 * db / auth / org / next-cache are mocked. No live DB, no model: $0.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const m = vi.hoisted(() => ({
  sports: [] as Array<{ id: string; orgId: string; preset: string | null; name: string; playersPerTeam: number }>,
  activities: [] as Array<{ id: string; orgId: string; sportId: string }>,
  transaction: vi.fn(),
  activityCreate: vi.fn(),
  activityUpdate: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "owner-a" } }) }));
vi.mock("@/lib/org", () => ({
  requireOrgAdmin: async () => undefined,
  setCurrentOrgId: async () => undefined,
  getUserOrg: async () => ({ orgId: "org-a" }),
}));
vi.mock("@/lib/self-join-flag", () => ({ selfJoinEnabledForRequest: async () => false }));
vi.mock("@/lib/venue-location", () => ({ dropOrphanPin: vi.fn() }));
vi.mock("@/lib/venue-location-schedule", () => ({
  scheduleVenueResolve: vi.fn(),
  scheduleVenuePickResolve: vi.fn(),
  scheduleVenueResolveForOrg: vi.fn(),
}));
vi.mock("@/lib/ai-budget", () => ({ onboardingUserKey: () => "k", withOrgAiBudget: async () => null }));
vi.mock("@/lib/onboarding-analyzer", () => ({ analyzeForOnboarding: vi.fn() }));
vi.mock("@/lib/db", () => {
  const where = (w: Record<string, unknown>) => (r: Record<string, unknown>) =>
    Object.entries(w).every(([k, v]) => r[k] === v);
  return {
    db: {
      organisation: { findUnique: async () => null },
      user: { findMany: async () => [] },
      sport: {
        findFirst: async ({ where: w }: { where: Record<string, unknown> }) => m.sports.find(where(w)) ?? null,
        findMany: async ({ where: w }: { where: Record<string, unknown> }) => m.sports.filter(where(w)),
      },
      activity: {
        findUnique: async ({ where: w }: { where: { id: string } }) => m.activities.find((a) => a.id === w.id) ?? null,
        findFirst: async ({ where: w }: { where: Record<string, unknown> }) => m.activities.find(where(w)) ?? null,
        findMany: async ({ where: w }: { where: Record<string, unknown> }) => m.activities.filter(where(w)),
        create: async (a: unknown) => {
          m.activityCreate(a);
          return { id: "act-new" };
        },
        update: async (a: unknown) => {
          m.activityUpdate(a);
          return {};
        },
      },
      $transaction: (...a: unknown[]) => m.transaction(...a),
    },
  };
});

import { analyzeOnboardingChat, createOrgFromWizard, listSportPresets } from "@/app/actions/onboarding";
import { createActivity, updateActivity } from "@/app/actions/activities";
import { GET as getSports } from "@/app/api/sports/route";

beforeEach(() => {
  vi.clearAllMocks();
  m.transaction.mockRejectedValue(new Error("reached the transaction"));
  m.sports = [
    { id: "s-7", orgId: "org-a", preset: "football-7aside", name: "Football 7-a-side", playersPerTeam: 7 },
    { id: "s-futsal", orgId: "org-a", preset: "futsal", name: "Futsal", playersPerTeam: 5 },
    { id: "s-net", orgId: "org-a", preset: "netball", name: "Netball", playersPerTeam: 7 },
    { id: "s-bb", orgId: "org-a", preset: "basketball-5v5", name: "Basketball 5-on-5", playersPerTeam: 5 },
    { id: "s-cricket", orgId: "org-a", preset: "cricket", name: "Cricket", playersPerTeam: 11 },
    { id: "s-6", orgId: "org-a", preset: null, name: "Football 6-a-side", playersPerTeam: 6 },
  ];
  // The club already plays cricket: it keeps it.
  m.activities = [
    { id: "act-7", orgId: "org-a", sportId: "s-7" },
    { id: "act-cricket", orgId: "org-a", sportId: "s-cricket" },
  ];
});

const ACTIVITY = { name: "Tuesday 7s", dayOfWeek: 2, time: "21:30", venue: "Goals Wembley" };

describe("the web onboarding wizard", () => {
  it("lists only the live presets", async () => {
    const keys = (await listSportPresets()).map((p) => p.key);
    expect(keys).toEqual(["football-7aside", "football-8aside", "football-9aside", "football-11aside", "football-5aside", "futsal"]);
  });

  it.each(["basketball-5v5", "basketball-3v3", "netball", "volleyball", "cricket"])("refuses %s", async (sportKey) => {
    await expect(
      createOrgFromWizard({
        orgName: "New Club",
        players: [{ name: "Yeni" }],
        activity: { ...ACTIVITY, sportKey, matchDurationMins: 60 },
      }),
    ).rejects.toThrow("Pick a sport");
    expect(m.transaction).not.toHaveBeenCalled();
  });

  it("goes on with a football preset", async () => {
    await expect(
      createOrgFromWizard({
        orgName: "New Club",
        players: [{ name: "Yeni" }],
        activity: { ...ACTIVITY, sportKey: "futsal", matchDurationMins: 60 },
      }),
    ).rejects.toThrow("reached the transaction");
  });

  it("the chat analysis refuses a sport that is not live", async () => {
    await expect(analyzeOnboardingChat("x", "volleyball", [])).rejects.toThrow("Unknown sport");
  });
});

describe("admin activities: a new weekly game", () => {
  it("/api/sports lists the club's live sports and the ones it already plays", async () => {
    const res = await getSports();
    const ids = ((await res.json()) as Array<{ id: string }>).map((s) => s.id).sort();
    expect(ids).toEqual(["s-6", "s-7", "s-cricket", "s-futsal"]);
  });

  it.each(["s-7", "s-futsal", "s-6", "s-cricket"])("createActivity accepts %s", async (sportId) => {
    await createActivity({ orgId: "org-a", sportId, ...ACTIVITY });
    expect(m.activityCreate).toHaveBeenCalledOnce();
  });

  it.each(["s-net", "s-bb"])("createActivity refuses %s (not live, not played by the club)", async (sportId) => {
    await expect(createActivity({ orgId: "org-a", sportId, ...ACTIVITY })).rejects.toThrow("not offered");
    expect(m.activityCreate).not.toHaveBeenCalled();
  });

  it("createActivity still refuses another club's sport", async () => {
    m.sports.push({ id: "s-other", orgId: "org-b", preset: "football-7aside", name: "Football 7-a-side", playersPerTeam: 7 });
    await expect(createActivity({ orgId: "org-a", sportId: "s-other", ...ACTIVITY })).rejects.toThrow("Sport not found");
  });

  it("updateActivity refuses moving a game onto a sport that is not live", async () => {
    await expect(updateActivity("act-7", { sportId: "s-net" })).rejects.toThrow("not offered");
    expect(m.activityUpdate).not.toHaveBeenCalled();
  });
});
