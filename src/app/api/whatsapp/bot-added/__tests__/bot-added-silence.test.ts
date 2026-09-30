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
// Slice 2a: the admins' HQ group check has its own tests
// (lib/__tests__/admin-group-link.test.ts). Not a candidate unless a test says so.
const adminGroupLink = vi.hoisted(() => ({ detect: vi.fn(async () => false), record: vi.fn(async () => ({ id: "ug-1" })) }));
vi.mock("@/lib/admin-group-link", () => ({
  detectAdminGroupCandidate: (...a: unknown[]) => adminGroupLink.detect(...(a as [])),
  recordAdminGroupCandidate: (...a: unknown[]) => adminGroupLink.record(...(a as [])),
}));
// Slice 6: with self-join on, an add goes to the self-join linker (its own
// tests are bot-added-self-join.test.ts and lib/__tests__/group-add.test.ts).
const linker = vi.hoisted(() => ({ handleSelfJoinGroupAdd: vi.fn() }));
vi.mock("@/lib/group-add", async (orig) => ({
  ...(await orig<typeof import("@/lib/group-add")>()),
  handleSelfJoinGroupAdd: (...a: unknown[]) => linker.handleSelfJoinGroupAdd(...a),
}));

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

  it("slice 2a: an add by an owner or admin of an approved club (their HQ group) gets no intro and no session; silent, waiting for the code", async () => {
    adminGroupLink.detect.mockResolvedValueOnce(true);
    const body = await post("g-hq");
    expect(body).toMatchObject({ ignored: "admin-group-awaiting-code", silent: true, introText: null });
    expect(adminGroupLink.record).toHaveBeenCalledWith(expect.objectContaining({ groupId: "g-hq", addedByPhone: "447700900123" }));
    expect(dbMock.onboardingSession.create).not.toHaveBeenCalled();
  });

  it("slice 2a: a group already linked as a club's admin group is left alone, never a new club", async () => {
    dbMock.organisation.findFirst.mockImplementation(async (a: { where: Record<string, unknown> }) =>
      a.where.adminGroupId === "g-hq" ? { id: "org-fnf" } : null,
    );
    const body = await post("g-hq");
    expect(body).toMatchObject({ ignored: "admin-group", introText: null, adminGroup: { groupId: "g-hq", orgId: "org-fnf" } });
    expect(dbMock.onboardingSession.create).not.toHaveBeenCalled();
  });

  it("a silent group gets no intro and no onboarding session", async () => {
    const body = await post("g-pending");
    expect(body.introText).toBeNull();
    expect(body.ignored).toBe("silent-group");
    expect(dbMock.onboardingSession.create).not.toHaveBeenCalled();
    expect(dbMock.onboardingSession.update).not.toHaveBeenCalled();
  });

  it("with self-join on, no group gets the in-group setup intro (the add goes to the self-join linker)", async () => {
    process.env.SELF_JOIN_ENABLED = "1";
    linker.handleSelfJoinGroupAdd.mockResolvedValue({ kind: "unsolicited", recorded: true, id: "ug-1" });
    const body = await post("g-new");
    expect(body.introText).toBeNull();
    expect(body.ignored).toBe("unsolicited");
    expect(linker.handleSelfJoinGroupAdd).toHaveBeenCalledOnce();
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
