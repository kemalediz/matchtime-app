/**
 * POST /api/whatsapp/bot-added, club fee billing slice B5: MatchTime ADDED
 * BACK to the group of a club paused because it was removed.
 *
 * The re-add step runs first, for the Pi's real self-add only (never the
 * reconnect sweep's `discovered`), with self-join on or off, and never
 * changes what the route answers: an approved club's group is still
 * "live-org", no intro. The step itself is mocked; its own tests are
 * lib/__tests__/club-billing-removal.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "test-wa-key";
const GROUP = "120363400000000777@g.us";

const billing = vi.hoisted(() => ({ reAdd: vi.fn() }));
vi.mock("@/lib/club-billing-removal", () => ({ handleBillingReAdd: (...a: unknown[]) => billing.reAdd(...a) }));
const groupAdd = vi.hoisted(() => ({ handleSelfJoinGroupAdd: vi.fn(), markOwnerDmQueued: vi.fn() }));
vi.mock("@/lib/group-add", async (orig) => ({
  ...(await orig<typeof import("@/lib/group-add")>()),
  handleSelfJoinGroupAdd: (...a: unknown[]) => groupAdd.handleSelfJoinGroupAdd(...a),
  markOwnerDmQueued: (...a: unknown[]) => groupAdd.markOwnerDmQueued(...a),
}));
vi.mock("@/lib/owner-dm", () => ({ queueOwnerDm: vi.fn() }));
const dbMock = vi.hoisted(() => ({
  organisation: { findFirst: vi.fn(), findMany: vi.fn() },
  clubConnect: { findMany: vi.fn() },
  unsolicitedGroup: { findMany: vi.fn() },
  onboardingSession: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/admin-group-link", () => ({
  detectAdminGroupCandidate: vi.fn(async () => false),
  recordAdminGroupCandidate: vi.fn(async () => ({ id: "ug-1" })),
}));

import { POST } from "../route";

const ENV = {
  key: process.env.WHATSAPP_API_KEY,
  autostart: process.env.ONBOARDING_AUTOSTART,
  selfJoin: process.env.SELF_JOIN_ENABLED,
  billing: process.env.BILLING_ENABLED,
};

async function post(body: Record<string, unknown> = {}) {
  const res = await POST(
    new Request("http://x/api/whatsapp/bot-added", {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify({ groupId: GROUP, groupSubject: "Paying FC", addedByPhone: "447700900123", ...body }),
    }),
  );
  expect(res.status).toBe(200);
  return res.json();
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WHATSAPP_API_KEY = KEY;
  process.env.SELF_JOIN_ENABLED = "1";
  process.env.BILLING_ENABLED = "1";
  delete process.env.ONBOARDING_AUTOSTART;
  billing.reAdd.mockResolvedValue({ kind: "resumed", orgId: "org-paying", to: "trial" });
  groupAdd.handleSelfJoinGroupAdd.mockResolvedValue({ kind: "live-org", orgId: "org-paying" });
  dbMock.organisation.findFirst.mockResolvedValue(null);
});
afterAll(() => {
  for (const [k, v] of [
    ["WHATSAPP_API_KEY", ENV.key],
    ["ONBOARDING_AUTOSTART", ENV.autostart],
    ["SELF_JOIN_ENABLED", ENV.selfJoin],
    ["BILLING_ENABLED", ENV.billing],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("bot-added: the slice B5 re-add step", () => {
  it("runs for the self-add with the group and the flag, and the answer is unchanged (live-org, no intro)", async () => {
    const body = await post();
    expect(billing.reAdd).toHaveBeenCalledWith(GROUP, { flagOn: true });
    expect(body).toMatchObject({ ok: true, ignored: "live-org", introText: null, silent: false });
    // The rest of the route still sees the whole body.
    expect(groupAdd.handleSelfJoinGroupAdd).toHaveBeenCalledWith(expect.objectContaining({ groupId: GROUP, groupSubject: "Paying FC" }));
  });

  it("with BILLING_ENABLED off the step is told so (it then does nothing)", async () => {
    delete process.env.BILLING_ENABLED;
    await post();
    expect(billing.reAdd).toHaveBeenCalledWith(GROUP, { flagOn: false });
  });

  it("runs with self-join off too (today's route below is unchanged)", async () => {
    delete process.env.SELF_JOIN_ENABLED;
    const body = await post();
    expect(billing.reAdd).toHaveBeenCalledWith(GROUP, { flagOn: true });
    expect(body).toMatchObject({ ignored: "autostart-disabled", introText: null });
  });

  it("never for the reconnect sweep's discovered groups", async () => {
    await post({ discovered: true });
    expect(billing.reAdd).not.toHaveBeenCalled();
  });

  it("a failing step never breaks the add", async () => {
    billing.reAdd.mockRejectedValue(new Error("db down"));
    const body = await post();
    expect(body).toMatchObject({ ok: true, ignored: "live-org" });
  });

  it("no group id: 400 as before, no step", async () => {
    const res = await POST(
      new Request("http://x/api/whatsapp/bot-added", {
        method: "POST",
        headers: { "x-api-key": KEY, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
    expect(billing.reAdd).not.toHaveBeenCalled();
  });

  it("unauthorised: nothing runs", async () => {
    const res = await POST(new Request("http://x/api/whatsapp/bot-added", { method: "POST", body: JSON.stringify({ groupId: GROUP }) }));
    expect(res.status).toBe(401);
    expect(billing.reAdd).not.toHaveBeenCalled();
  });
});
