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

import { POST } from "../route";

const ENV = { key: process.env.WHATSAPP_API_KEY, selfJoin: process.env.SELF_JOIN_ENABLED };

function post(body: unknown, key = KEY) {
  return POST(
    new Request("http://x/api/whatsapp/bot-removed", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
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
});
afterAll(() => {
  for (const [k, v] of [
    ["WHATSAPP_API_KEY", ENV.key],
    ["SELF_JOIN_ENABLED", ENV.selfJoin],
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
