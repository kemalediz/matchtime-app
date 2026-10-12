/**
 * GET /api/whatsapp/orgs: what the Pi listens to, and (self-join slice 1)
 * what it must never listen to.
 *
 *   orgs               approved, bot-enabled clubs with a group (as before;
 *                      the CHECK constraint already implies approved, the
 *                      filter is the second lock).
 *   onboardingGroups   mid-setup groups, minus any silent group, and none
 *                      at all while self-join is on (in-group setup retired).
 *   silentGroups       NEW. Groups MatchTime is in but must never forward.
 *   legacySetupTrigger NEW. false while self-join is on. An old Pi ignores
 *                      both new fields; a new Pi on an old server reads
 *                      them as [] and true, which is today's behaviour.
 *
 * db and the silent-group loader are mocked. No DB, no network, no model.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "test-wa-key";
const SUTTON_GROUP = "120363000000000001@g.us";

const dbMock = vi.hoisted(() => ({
  organisation: { findMany: vi.fn() },
  onboardingSession: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const silentMock = vi.hoisted(() => ({ loadSilentGroupIds: vi.fn(async (): Promise<string[]> => []) }));
vi.mock("@/lib/club-approval", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/club-approval")>()),
  loadSilentGroupIds: () => silentMock.loadSilentGroupIds(),
}));

const sweepMock = vi.hoisted(() => ({ loadSelfJoinSweep: vi.fn() }));
vi.mock("@/lib/group-add", () => ({ loadSelfJoinSweep: (...a: unknown[]) => sweepMock.loadSelfJoinSweep(...a) }));

// The club set version (2026-10-13) is one more query on `Organisation`,
// made before the sets are read. Mocked here so every assertion below on
// the route's own queries stands exactly as it was; the stamp itself is
// tested in src/lib/__tests__/club-set-version.test.ts and, against a real
// database, in e2e/api/club-set-version.spec.ts.
const versionMock = vi.hoisted(() => ({ order: [] as string[], loadClubSetVersion: vi.fn() }));
vi.mock("@/lib/club-set-version", () => ({ loadClubSetVersion: () => versionMock.loadClubSetVersion() }));

import { GET } from "../route";

const ENV = { key: process.env.WHATSAPP_API_KEY, selfJoin: process.env.SELF_JOIN_ENABLED };

async function call() {
  const res = await GET(new Request("http://x/api/whatsapp/orgs", { headers: { "x-api-key": KEY } }));
  expect(res.status).toBe(200);
  return res.json();
}

describe("GET /api/whatsapp/orgs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WHATSAPP_API_KEY = KEY;
    delete process.env.SELF_JOIN_ENABLED;
    dbMock.organisation.findMany.mockResolvedValue([
      { id: "sutton", name: "Sutton Football Club", slug: "sutton", whatsappGroupId: SUTTON_GROUP },
    ]);
    dbMock.onboardingSession.findMany.mockResolvedValue([
      { whatsappGroupId: "g-onboarding", groupName: null },
      { whatsappGroupId: "g-pending", groupName: null },
    ]);
    silentMock.loadSilentGroupIds.mockResolvedValue(["g-pending", "g-stranger"]);
    sweepMock.loadSelfJoinSweep.mockResolvedValue(null);
    versionMock.loadClubSetVersion.mockResolvedValue("0123456789abcdef");
  });
  afterAll(() => {
    process.env.WHATSAPP_API_KEY = ENV.key;
    if (ENV.selfJoin === undefined) delete process.env.SELF_JOIN_ENABLED;
    else process.env.SELF_JOIN_ENABLED = ENV.selfJoin;
  });

  it("carries the club set version, read BEFORE the sets (so it can only ever be older than the snapshot, never newer)", async () => {
    const order: string[] = [];
    versionMock.loadClubSetVersion.mockImplementation(async () => {
      order.push("version");
      return "0123456789abcdef";
    });
    dbMock.organisation.findMany.mockImplementation(async () => {
      order.push("orgs");
      return [{ id: "sutton", name: "Sutton Football Club", slug: "sutton", whatsappGroupId: SUTTON_GROUP, liveAt: null }];
    });
    const body = await call();
    expect(body.clubSetVersion).toBe("0123456789abcdef");
    // First of all: before the clubs, and before every other set too.
    expect(order[0]).toBe("version");
    expect(order.filter((o) => o === "version")).toHaveLength(1);
    expect(order).toContain("orgs");
  });

  it("the version cannot be read: the field is left out and everything else is as ever (the Pi then compares nothing)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    versionMock.loadClubSetVersion.mockRejectedValue(new Error("database hiccup"));
    const body = await call();
    expect("clubSetVersion" in body).toBe(false);
    expect(body.orgs).toHaveLength(1);
    expect(body.silentGroups.sort()).toEqual(["g-pending", "g-stranger"]);
    err.mockRestore();
  });

  it("a version read that never resolves does not hang /orgs: the snapshot goes without the field", async () => {
    vi.useFakeTimers();
    try {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      versionMock.loadClubSetVersion.mockImplementation(() => new Promise<string>(() => {}));
      const pending = call();
      await vi.advanceTimersByTimeAsync(1_500);
      const body = await pending;
      expect("clubSetVersion" in body).toBe(false);
      expect(body.orgs).toHaveLength(1);
      err.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for each club's go-live time, the floor of the Pi's catch-up", async () => {
    await call();
    expect(dbMock.organisation.findMany.mock.calls[0][0].select).toMatchObject({ whatsappGroupId: true, liveAt: true });
  });

  it("refuses a wrong key", async () => {
    const res = await GET(new Request("http://x", { headers: { "x-api-key": "nope" } }));
    expect(res.status).toBe(401);
  });

  it("lists Sutton FC exactly as before, and only approved bot-enabled clubs", async () => {
    const body = await call();
    expect(body.orgs).toEqual([
      { id: "sutton", name: "Sutton Football Club", slug: "sutton", whatsappGroupId: SUTTON_GROUP },
    ]);
    expect(dbMock.organisation.findMany.mock.calls[0][0].where).toEqual({
      approvalStatus: "approved",
      whatsappBotEnabled: true,
      whatsappGroupId: { not: null },
    });
  });

  it("hands the Pi the silent groups and keeps the legacy trigger on while self-join is off", async () => {
    const body = await call();
    expect(body.silentGroups.sort()).toEqual(["g-pending", "g-stranger"]);
    expect(body.legacySetupTrigger).toBe(true);
  });

  it("a silent group is never an onboarding group", async () => {
    const body = await call();
    expect(body.onboardingGroups).toEqual(["g-onboarding"]);
  });

  it("with self-join on: no onboarding groups at all, and the legacy trigger is off", async () => {
    process.env.SELF_JOIN_ENABLED = "1";
    const body = await call();
    expect(body.onboardingGroups).toEqual([]);
    expect(body.legacySetupTrigger).toBe(false);
    expect(body.orgs).toHaveLength(1);
  });

  it("self-join off: no reconnect sweep, and the response carries no sweep field at all", async () => {
    const body = await call();
    expect("selfJoinSweep" in body).toBe(false);
    expect(sweepMock.loadSelfJoinSweep).not.toHaveBeenCalled();
  });

  it("self-join on: the sweep instruction (slice 6), or null when no organiser is waiting for an add", async () => {
    process.env.SELF_JOIN_ENABLED = "1";
    expect((await call()).selfJoinSweep).toBeNull();
    sweepMock.loadSelfJoinSweep.mockResolvedValue({ knownGroups: [SUTTON_GROUP, "g-pending"] });
    expect((await call()).selfJoinSweep).toEqual({ knownGroups: [SUTTON_GROUP, "g-pending"] });
  });

  it("a failing sweep query never costs the Pi its org list", async () => {
    process.env.SELF_JOIN_ENABLED = "1";
    sweepMock.loadSelfJoinSweep.mockRejectedValue(new Error("db hiccup"));
    const body = await call();
    expect(body.selfJoinSweep).toBeNull();
    expect(body.orgs).toHaveLength(1);
  });

  it("a live club's group is never reported silent, even if the loader were wrong", async () => {
    silentMock.loadSilentGroupIds.mockResolvedValue([SUTTON_GROUP, "g-pending"]);
    const body = await call();
    expect(body.silentGroups).toEqual(["g-pending"]);
  });
});

describe("GET /api/whatsapp/orgs: club fee billing (B1, plan 4.3 point 2)", () => {
  const BILLING = process.env.BILLING_ENABLED;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WHATSAPP_API_KEY = KEY;
    delete process.env.SELF_JOIN_ENABLED;
    dbMock.organisation.findMany.mockResolvedValue([]);
    dbMock.onboardingSession.findMany.mockResolvedValue([]);
    silentMock.loadSilentGroupIds.mockResolvedValue([]);
  });
  afterAll(() => {
    if (BILLING === undefined) delete process.env.BILLING_ENABLED;
    else process.env.BILLING_ENABLED = BILLING;
  });

  it("flag off: the orgs query is exactly today's (no billing filter)", async () => {
    delete process.env.BILLING_ENABLED;
    await call();
    const where = dbMock.organisation.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ approvalStatus: "approved", whatsappBotEnabled: true, whatsappGroupId: { not: null } });
    expect("billingStatus" in where).toBe(false);
  });

  it("flag on: a billing-paused club is left out of the monitored orgs", async () => {
    process.env.BILLING_ENABLED = "1";
    await call();
    expect(dbMock.organisation.findMany.mock.calls[0][0].where).toEqual({
      approvalStatus: "approved",
      billingStatus: { not: "paused" },
      whatsappBotEnabled: true,
      whatsappGroupId: { not: null },
    });
  });
});
