/**
 * POST /api/whatsapp/bot-removed (self-join slice 6, plan 5.7): the Pi
 * saw MatchTime removed from a group it was silent in.
 *
 * The handler is mocked; lib/__tests__/group-add.test.ts pins what it does.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "test-wa-key";
const lib = vi.hoisted(() => ({ handleBotRemoved: vi.fn() }));
vi.mock("@/lib/group-add", () => ({ handleBotRemoved: (...a: unknown[]) => lib.handleBotRemoved(...a) }));
vi.mock("@/lib/db", () => ({ db: {} }));
// Slice 2a: removal from a linked admin group is handled first (its own
// tests are lib/__tests__/admin-group-link.test.ts).
const adminGroup = vi.hoisted(() => ({ removed: vi.fn() }));
vi.mock("@/lib/admin-group-link", () => ({
  handleAdminGroupRemoved: (...a: unknown[]) => adminGroup.removed(...a),
}));

// Club fee billing, slice B5: a live club's group goes to the billing
// handler (lib/__tests__/club-billing-removal.test.ts pins what it does).
// "no-club" by default, so every test above B5 runs today's path.
const billing = vi.hoisted(() => ({ removal: vi.fn() }));
vi.mock("@/lib/club-billing-removal", async (orig) => ({
  ...(await orig<typeof import("@/lib/club-billing-removal")>()),
  handleBillingRemoval: (...a: unknown[]) => billing.removal(...a),
}));

import { POST } from "../route";

const ENV = {
  key: process.env.WHATSAPP_API_KEY,
  selfJoin: process.env.SELF_JOIN_ENABLED,
  billing: process.env.BILLING_ENABLED,
  testMode: process.env.MT_TEST_MODE,
};

function post(body: unknown, key = KEY, extra: Record<string, string> = {}) {
  return POST(
    new Request("http://x/api/whatsapp/bot-removed", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json", ...extra },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WHATSAPP_API_KEY = KEY;
  process.env.SELF_JOIN_ENABLED = "1";
  lib.handleBotRemoved.mockResolvedValue({ returnedToDraft: 1, unsolicitedLeft: 0 });
  adminGroup.removed.mockResolvedValue({ unlinked: false });
  billing.removal.mockResolvedValue({ kind: "no-club" });
  process.env.BILLING_ENABLED = "1";
  delete process.env.MT_TEST_MODE;
});
afterAll(() => {
  for (const [k, v] of [
    ["WHATSAPP_API_KEY", ENV.key],
    ["SELF_JOIN_ENABLED", ENV.selfJoin],
    ["BILLING_ENABLED", ENV.billing],
    ["MT_TEST_MODE", ENV.testMode],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("slice 2a: removed from a linked admin group", () => {
  it("is unlinked whatever the self-join switch says, and the self-join handler is not called", async () => {
    delete process.env.SELF_JOIN_ENABLED;
    adminGroup.removed.mockResolvedValue({ unlinked: true, orgId: "org-fnf" });
    const res = await post({ groupId: "hq@g.us" });
    expect(await res.json()).toEqual({ ok: true, adminGroup: "unlinked", orgId: "org-fnf" });
    expect(lib.handleBotRemoved).not.toHaveBeenCalled();
  });
});

describe("POST /api/whatsapp/bot-removed", () => {
  it("refuses without the API key", async () => {
    expect((await post({ groupId: "g@g.us" }, "nope")).status).toBe(401);
    expect(lib.handleBotRemoved).not.toHaveBeenCalled();
  });

  it("needs a group id", async () => {
    expect((await post({})).status).toBe(400);
  });

  it("hands the removal to the self-join handler", async () => {
    const res = await post({ groupId: "120363400000000001@g.us" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, returnedToDraft: 1, unsolicitedLeft: 0 });
    expect(lib.handleBotRemoved).toHaveBeenCalledWith("120363400000000001@g.us");
  });

  it("with self-join off, does nothing at all", async () => {
    delete process.env.SELF_JOIN_ENABLED;
    const res = await post({ groupId: "120363400000000001@g.us" });
    expect(await res.json()).toEqual({ ok: true, ignored: "self-join-disabled" });
    expect(lib.handleBotRemoved).not.toHaveBeenCalled();
  });
});

describe("club fee billing, slice B5: MatchTime removed from a LIVE club's group", () => {
  const LIVE = "120363400000000777@g.us";

  it("a billed club is paused: the Pi is told 'paused', and the self-join path is not run", async () => {
    billing.removal.mockResolvedValue({ kind: "paused", orgId: "org-paying", stripe: "cancel-at-period-end" });
    const res = await post({ groupId: LIVE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, billing: "paused", orgId: "org-paying" });
    expect(billing.removal).toHaveBeenCalledWith(LIVE, { flagOn: true });
    expect(lib.handleBotRemoved).not.toHaveBeenCalled();
  });

  it("a repeated event: 'already-paused'", async () => {
    billing.removal.mockResolvedValue({ kind: "already-paused", orgId: "org-paying", stripe: "already-cancelling" });
    expect(await (await post({ groupId: LIVE })).json()).toEqual({ ok: true, billing: "already-paused", orgId: "org-paying" });
  });

  it("Sutton FC (never billed): logged only, answered 'exempt'", async () => {
    billing.removal.mockResolvedValue({ kind: "logged", orgId: "org-sutton", why: "exempt-club" });
    expect(await (await post({ groupId: LIVE })).json()).toEqual({ ok: true, billing: "exempt", orgId: "org-sutton" });
    expect(lib.handleBotRemoved).not.toHaveBeenCalled();
  });

  it("BILLING_ENABLED off: the handler is told the flag is off (it only logs), and the request is accepted", async () => {
    delete process.env.BILLING_ENABLED;
    billing.removal.mockResolvedValue({ kind: "logged", orgId: "org-paying", why: "flag-off" });
    const res = await post({ groupId: LIVE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, billing: "flag-off", orgId: "org-paying" });
    expect(billing.removal).toHaveBeenCalledWith(LIVE, { flagOn: false });
  });

  it("billing does not depend on the self-join switch", async () => {
    delete process.env.SELF_JOIN_ENABLED;
    billing.removal.mockResolvedValue({ kind: "paused", orgId: "org-paying", stripe: "no-subscription" });
    expect(await (await post({ groupId: LIVE })).json()).toEqual({ ok: true, billing: "paused", orgId: "org-paying" });
  });

  it("no approved club owns the group (a pending club, an unsolicited group): today's self-join path, unchanged", async () => {
    const res = await post({ groupId: "120363400000000001@g.us" });
    expect(await res.json()).toEqual({ ok: true, returnedToDraft: 1, unsolicitedLeft: 0 });
    expect(lib.handleBotRemoved).toHaveBeenCalledWith("120363400000000001@g.us");
  });

  it("a linked admin group is still handled first, before billing", async () => {
    adminGroup.removed.mockResolvedValue({ unlinked: true, orgId: "org-fnf" });
    await post({ groupId: "hq@g.us" });
    expect(billing.removal).not.toHaveBeenCalled();
  });

  it("test seam: the billing header turns the flag off only under MT_TEST_MODE=1", async () => {
    await post({ groupId: LIVE }, KEY, { "x-mt-test-billing": "0" });
    expect(billing.removal).toHaveBeenLastCalledWith(LIVE, { flagOn: true });
    process.env.MT_TEST_MODE = "1";
    await post({ groupId: LIVE }, KEY, { "x-mt-test-billing": "0" });
    expect(billing.removal).toHaveBeenLastCalledWith(LIVE, { flagOn: false });
  });

  it("refuses without the API key before anything is read", async () => {
    expect((await post({ groupId: LIVE }, "nope")).status).toBe(401);
    expect(billing.removal).not.toHaveBeenCalled();
  });
});

