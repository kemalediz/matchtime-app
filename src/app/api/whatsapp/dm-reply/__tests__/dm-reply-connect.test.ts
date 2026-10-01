/**
 * POST /api/whatsapp/dm-reply and the self-join connect DM (slice 5,
 * plan 5.3): the deterministic connect handler runs FIRST, ahead of the
 * bench reply and every model path, and only while SELF_JOIN_ENABLED is
 * on. With the flag off the route never calls it and behaves as today.
 *
 * The handler itself is tested in src/lib/__tests__/connect-dm.test.ts;
 * here it is a spy. db is a recording stub: every model call resolves
 * empty. No DB, no network, no model.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "test-wa-key";

const calls = vi.hoisted(() => [] as string[]);
const dbMock = vi.hoisted(() => {
  const empty = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => async () => {
          calls.push(`${name}.${method}`);
          return method.startsWith("findMany") ? [] : method === "count" ? 0 : method === "updateMany" ? { count: 0 } : null;
        },
      },
    );
  return new Proxy({} as Record<string, unknown>, { get: (_t, model: string) => empty(model) });
});
vi.mock("@/lib/db", () => ({ db: dbMock }));

const connect = vi.hoisted(() => ({ handleConnectDm: vi.fn() }));
vi.mock("@/lib/connect-dm", () => connect);

import { POST } from "../route";

const ENV = { key: process.env.WHATSAPP_API_KEY, selfJoin: process.env.SELF_JOIN_ENABLED };

async function post(body: Record<string, unknown>) {
  const res = await POST(
    new Request("http://x/api/whatsapp/dm-reply", {
      method: "POST",
      headers: { "x-api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(res.status).toBe(200);
  return res.json();
}

const CONNECT = {
  phone: "447700900123",
  body: "Connect Riverside FC, code 7KQ2",
  waMessageId: "wa-1",
  authorName: "Ali",
  senderLid: "123456789012345@lid",
  senderAltPhone: "447700900123",
};

describe("dm-reply: the connect DM", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    process.env.WHATSAPP_API_KEY = KEY;
    delete process.env.SELF_JOIN_ENABLED;
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

  it("flag OFF: the handler is never called, and the route runs exactly as today", async () => {
    const body = await post(CONNECT);
    expect(connect.handleConnectDm).not.toHaveBeenCalled();
    expect(body).toEqual({ ok: true, ignored: "unknown-sender" });
    // Slice 2b: the organiser pick check (no round open: one cheap read,
    // then nothing) sits between the self-join handlers and the bench reply.
    expect(calls[0]).toBe("organiserPickRound.findFirst");
    expect(calls[1]).toBe("benchSlotOffer.findMany");
    expect(calls.some((c) => c.startsWith("clubConnect."))).toBe(false);
  });

  it("flag ON and the DM is a connect DM: handled first, before the bench reply or any lookup", async () => {
    process.env.SELF_JOIN_ENABLED = "1";
    connect.handleConnectDm.mockResolvedValue({ handled: "connect-dm", result: "verified", replied: true });
    const body = await post(CONNECT);
    expect(body).toEqual({ ok: true, handled: "connect-dm", result: "verified", replied: true });
    expect(calls).toEqual([]);
    expect(connect.handleConnectDm).toHaveBeenCalledWith({
      text: CONNECT.body,
      phone: CONNECT.phone,
      senderAltPhone: CONNECT.senderAltPhone,
      senderLid: CONNECT.senderLid,
      waMessageId: CONNECT.waMessageId,
    });
  });

  it("flag ON and not a connect DM (handler returns null): today's handling runs", async () => {
    process.env.SELF_JOIN_ENABLED = "1";
    connect.handleConnectDm.mockResolvedValue(null);
    const body = await post({ phone: "447700900123", body: "IN", waMessageId: "wa-2" });
    expect(connect.handleConnectDm).toHaveBeenCalledTimes(1);
    expect(body).toEqual({ ok: true, ignored: "unknown-sender" });
    // Slice 2b: the organiser pick check (no round open: one cheap read,
    // then nothing) sits between the self-join handlers and the bench reply.
    expect(calls[0]).toBe("organiserPickRound.findFirst");
    expect(calls[1]).toBe("benchSlotOffer.findMany");
  });

  it("an older Pi that forwards no LID still works: the fields are simply absent", async () => {
    process.env.SELF_JOIN_ENABLED = "1";
    connect.handleConnectDm.mockResolvedValue(null);
    await post({ phone: "447700900123", body: "Connect Riverside FC, code 7KQ2", waMessageId: "wa-3" });
    expect(connect.handleConnectDm).toHaveBeenCalledWith(
      expect.objectContaining({ senderLid: undefined, senderAltPhone: undefined }),
    );
  });
});
