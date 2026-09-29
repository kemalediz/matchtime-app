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
  });
  afterAll(() => {
    process.env.WHATSAPP_API_KEY = ENV.key;
    if (ENV.selfJoin === undefined) delete process.env.SELF_JOIN_ENABLED;
    else process.env.SELF_JOIN_ENABLED = ENV.selfJoin;
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

  it("a live club's group is never reported silent, even if the loader were wrong", async () => {
    silentMock.loadSilentGroupIds.mockResolvedValue([SUTTON_GROUP, "g-pending"]);
    const body = await call();
    expect(body.silentGroups).toEqual(["g-pending"]);
  });
});
