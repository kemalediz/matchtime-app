/**
 * POST /api/whatsapp/bot-added never introduces MatchTime in a silent
 * group, and never while self-join is on (self-join slice 1, plan 4.3
 * layer 4). A silent group is one whose club is waiting for approval,
 * was rejected or suspended, or one nobody asked MatchTime into.
 *
 * With ONBOARDING_AUTOSTART on and self-join off, an ordinary unknown
 * group still gets today's intro: the unchanged path is asserted too.
 *
 * db is mocked. No DB, no network, no model.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "test-wa-key";

// The silent-group loader runs for real against these rows: one pending
// club's connect request names "g-pending".
const dbMock = vi.hoisted(() => ({
  organisation: { findFirst: vi.fn(), findMany: vi.fn() },
  clubConnect: { findMany: vi.fn() },
  unsolicitedGroup: { findMany: vi.fn() },
  onboardingSession: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import { POST } from "../route";

const ENV = {
  key: process.env.WHATSAPP_API_KEY,
  autostart: process.env.ONBOARDING_AUTOSTART,
  selfJoin: process.env.SELF_JOIN_ENABLED,
};

async function post(groupId: string) {
  const res = await POST(
    new Request("http://x/api/whatsapp/bot-added", {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify({ groupId, groupSubject: "Riverside Tuesday 5s", addedByPhone: "447700900123" }),
    }),
  );
  expect(res.status).toBe(200);
  return res.json();
}

describe("bot-added and silent groups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WHATSAPP_API_KEY = KEY;
    process.env.ONBOARDING_AUTOSTART = "1";
    delete process.env.SELF_JOIN_ENABLED;
    dbMock.organisation.findFirst.mockResolvedValue(null);
    dbMock.onboardingSession.findFirst.mockResolvedValue(null);
    dbMock.onboardingSession.create.mockResolvedValue({ id: "sess-1" });
    dbMock.organisation.findMany.mockResolvedValue([]);
    dbMock.clubConnect.findMany.mockResolvedValue([{ groupId: "g-pending" }]);
    dbMock.unsolicitedGroup.findMany.mockResolvedValue([]);
  });
  afterAll(() => {
    for (const [k, v] of [
      ["WHATSAPP_API_KEY", ENV.key],
      ["ONBOARDING_AUTOSTART", ENV.autostart],
      ["SELF_JOIN_ENABLED", ENV.selfJoin],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("a silent group gets no intro and no onboarding session", async () => {
    const body = await post("g-pending");
    expect(body.introText).toBeNull();
    expect(body.ignored).toBe("silent-group");
    expect(dbMock.onboardingSession.create).not.toHaveBeenCalled();
    expect(dbMock.onboardingSession.update).not.toHaveBeenCalled();
  });

  it("with self-join on, no group gets the in-group setup intro", async () => {
    process.env.SELF_JOIN_ENABLED = "1";
    const body = await post("g-new");
    expect(body.introText).toBeNull();
    expect(body.ignored).toBe("self-join-mode");
    expect(dbMock.onboardingSession.create).not.toHaveBeenCalled();
  });

  it("unchanged: an ordinary unknown group still gets today's intro with self-join off", async () => {
    const body = await post("g-new");
    expect(typeof body.introText).toBe("string");
    expect(body.introText.length).toBeGreaterThan(0);
    expect(dbMock.onboardingSession.create).toHaveBeenCalledOnce();
  });

  it("unchanged: a live club's group is ignored as before, before any silence check", async () => {
    dbMock.organisation.findFirst.mockResolvedValue({ id: "sutton" });
    const body = await post("g-sutton");
    expect(body.ignored).toBe("live-org");
    expect(dbMock.clubConnect.findMany).not.toHaveBeenCalled();
  });
});
