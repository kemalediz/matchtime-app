/**
 * POST /api/whatsapp/message-change (2026-11-15): the Pi says a group
 * message was deleted for everyone, or edited. The route checks the API
 * key and the body and hands it to `applyMessageChange`. It answers with
 * counts only, and it never sends, replies, reacts or analyses: the only
 * thing it may call is the housekeeping itself (proved by the spies).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "test-wa-key";
const apply = vi.hoisted(() => vi.fn());
vi.mock("@/lib/message-change", async (orig) => ({
  ...(await orig<typeof import("@/lib/message-change")>()),
  applyMessageChange: apply,
}));
// Nothing else may be reached: a db touched here would be a send or an analysis.
const touched = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/db", () => ({
  db: new Proxy({}, { get: (_t, model: string) => { touched.push(model); throw new Error(`db.${model} reached from the route`); } }),
}));

import { POST } from "../route";

const ENV = process.env.WHATSAPP_API_KEY;
const G = "120363000000000111@g.us";

async function post(body: unknown, key = KEY) {
  const res = await POST(
    new Request("http://x/api/whatsapp/message-change", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  process.env.WHATSAPP_API_KEY = KEY;
  apply.mockReset();
  apply.mockResolvedValue({ analyzed: 1, archived: 0, hq: 0, mentions: 0, notes: 0, refused: 0 });
  touched.length = 0;
});
afterAll(() => {
  process.env.WHATSAPP_API_KEY = ENV;
});

describe("POST /api/whatsapp/message-change", () => {
  it("401 without the Pi's key, and nothing is changed", async () => {
    expect((await post({ kind: "revoke", chatId: G, messageId: "3EB0AAAA" }, "wrong")).status).toBe(401);
    expect(apply).not.toHaveBeenCalled();
  });

  it("400 for a body that is not a group message change", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post({ kind: "revoke", chatId: "447700900123@c.us", messageId: "3EB0AAAA" })).status).toBe(400);
    expect((await post({ kind: "edit", chatId: G })).status).toBe(400);
    expect(apply).not.toHaveBeenCalled();
  });

  it("a revoke is applied by id and group, and the answer is counts only", async () => {
    const r = await post({ kind: "revoke", chatId: G, messageId: "3EB0AAAA" });
    expect(r.status).toBe(200);
    expect(apply).toHaveBeenCalledWith({ kind: "revoke", chatId: G, messageId: "3EB0AAAA", byAdmin: false, senderJids: [], senderPhone: null });
    expect(r.json).toEqual({ ok: true, kind: "revoke", analyzed: 1, archived: 0, hq: 0, mentions: 0, notes: 0, refused: 0 });
    expect(touched).toEqual([]);
  });

  it("an edit is a purge: applied with its sender, and any words the Pi sent are never passed on or answered back", async () => {
    const r = await post({ kind: "edit", chatId: G, messageId: "3EB0AAAA", text: "late, sorry", senderJids: ["447700900123@c.us"], senderPhone: "447700900123" });
    expect(r.status).toBe(200);
    expect(apply).toHaveBeenCalledWith({ kind: "edit", chatId: G, messageId: "3EB0AAAA", byAdmin: false, senderJids: ["447700900123@c.us"], senderPhone: "447700900123" });
    expect(JSON.stringify(apply.mock.calls)).not.toContain("late, sorry");
    expect(JSON.stringify(r.json)).not.toContain("late, sorry");
  });

  it("a store failure is a 500 the Pi logs; it says nothing about the message", async () => {
    apply.mockRejectedValueOnce(new Error("db down"));
    const r = await post({ kind: "revoke", chatId: G, messageId: "3EB0AAAA" });
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ ok: false, error: "not applied" });
  });
});
