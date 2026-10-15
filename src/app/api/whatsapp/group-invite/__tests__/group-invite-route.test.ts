/**
 * POST /api/whatsapp/group-invite (2026-10-15): the Pi received a group
 * invite (WhatsApp's "Invite to group" message, or a pasted invite link)
 * by DM and asks whether to join. The rule is pinned in
 * lib/__tests__/group-invite-rules.test.ts; here, the route: auth, the
 * self-join switch, the database read, and an answer that never carries
 * a number.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "test-wa-key";
const db = vi.hoisted(() => ({ clubConnect: { findMany: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db }));

import { POST } from "../route";

const ENV = { key: process.env.WHATSAPP_API_KEY, selfJoin: process.env.SELF_JOIN_ENABLED };
const HOUR = 60 * 60 * 1000;

function post(body: unknown, key = KEY) {
  return POST(
    new Request("http://x/api/whatsapp/group-invite", {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function row(over: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: "cc1",
    status: "dm_verified",
    phone: "447700900123",
    dmLid: "123456789012",
    issuedAt: new Date(now - 2 * HOUR),
    expiresAt: new Date(now - HOUR),
    addWindowEndsAt: new Date(now + 20 * HOUR),
    org: { approvalStatus: "draft" },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WHATSAPP_API_KEY = KEY;
  process.env.SELF_JOIN_ENABLED = "1";
  db.clubConnect.findMany.mockResolvedValue([row()]);
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

describe("POST /api/whatsapp/group-invite", () => {
  it("401s without the bot key", async () => {
    const res = await post({ phone: "447700900123" }, "wrong");
    expect(res.status).toBe(401);
    expect(db.clubConnect.findMany).not.toHaveBeenCalled();
  });

  it("400s on a body that is not an object", async () => {
    const res = await POST(
      new Request("http://x/api/whatsapp/group-invite", {
        method: "POST",
        headers: { "x-api-key": KEY },
        body: "nope",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("accepts the verified organiser by phone", async () => {
    const res = await post({ phone: "447700900123", kind: "invite-message" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accept: true, match: "phone" });
  });

  it("accepts the verified organiser by LID", async () => {
    const res = await post({ senderLid: "123456789012@lid", kind: "invite-link" });
    expect(await res.json()).toEqual({ accept: true, match: "lid" });
  });

  it("only reads open DM-verified requests on draft clubs", async () => {
    await post({ phone: "447700900123" });
    const where = db.clubConnect.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("dm_verified");
    expect(where.addWindowEndsAt.gt).toBeInstanceOf(Date);
    expect(where.org).toEqual({ approvalStatus: "draft" });
  });

  it("refuses a stranger, and the answer names no request or number", async () => {
    const res = await post({ phone: "447700900999" });
    const body = await res.json();
    expect(body).toEqual({ accept: false, reason: "not-organiser" });
  });

  it("refuses when self-join is switched off, without reading the database", async () => {
    process.env.SELF_JOIN_ENABLED = "0";
    const res = await post({ phone: "447700900123" });
    expect(await res.json()).toEqual({ accept: false, reason: "self-join-off" });
    expect(db.clubConnect.findMany).not.toHaveBeenCalled();
  });

  it("never logs a phone number or a LID", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await post({ phone: "447700900123", senderLid: "123456789012@lid" });
    await post({ phone: "447700900999" });
    const all = [...spy.mock.calls, ...err.mock.calls].flat().map(String).join("\n");
    expect(all).not.toMatch(/447700900|123456789012/);
    spy.mockRestore();
    err.mockRestore();
  });

  it("answers no (and does not throw) when the database fails", async () => {
    db.clubConnect.findMany.mockRejectedValue(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ phone: "447700900123" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ accept: false, reason: "error" });
    err.mockRestore();
  });
});
