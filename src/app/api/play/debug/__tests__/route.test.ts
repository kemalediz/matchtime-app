/**
 * POST /api/play/debug (TEMPORARY, 2026-11-10): the /play funnel
 * diagnostic's endpoint. Logs one `[pool-funnel-debug]` line per valid
 * batch with the user agent; refuses big or malformed bodies and more than
 * 60 batches per IP per hour. Stores nothing.
 */
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { POST, resetDebugLimitForTests } from "../route";

const UA = "Mozilla/5.0 (Linux; Android 14) [FB_IAB/FB4A;FBAV/586.0.0.0;]";
const BATCH = { v: 1, sid: "abc123def456", seq: 1, why: "tick", ev: [{ t: 3, k: "boot", st: "ok" }] };
const req = (body: string, ip = "203.0.113.7") =>
  new Request("http://localhost/api/play/debug", { method: "POST", body, headers: { "user-agent": UA, "x-forwarded-for": `${ip}, 10.0.0.1` } });

let info: MockInstance<typeof console.info>;
beforeEach(() => {
  resetDebugLimitForTests();
  vi.restoreAllMocks();
  info = vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("POST /api/play/debug", () => {
  it("a valid batch: 204 and one log line with the user agent", async () => {
    const res = await POST(req(JSON.stringify(BATCH)));
    expect(res.status).toBe(204);
    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0][0]);
    expect(line.startsWith("[pool-funnel-debug] ")).toBe(true);
    expect(line).toContain("FB_IAB/FB4A");
    expect(line).toContain("abc123def456");
  });

  it("not JSON, or not a batch: 400 and nothing logged", async () => {
    expect((await POST(req("not json"))).status).toBe(400);
    expect((await POST(req(JSON.stringify({ hello: 1 })))).status).toBe(400);
    expect(info).not.toHaveBeenCalled();
  });

  it("a body over 16 KB: 413 and nothing logged", async () => {
    const big = JSON.stringify({ ...BATCH, pad: "x".repeat(17_000) });
    expect((await POST(req(big))).status).toBe(413);
    expect(info).not.toHaveBeenCalled();
  });

  it("more than 60 batches an hour from one IP: 429; another IP is unaffected", async () => {
    for (let i = 0; i < 60; i++) expect((await POST(req(JSON.stringify(BATCH)))).status).toBe(204);
    expect((await POST(req(JSON.stringify(BATCH)))).status).toBe(429);
    expect((await POST(req(JSON.stringify(BATCH), "198.51.100.9"))).status).toBe(204);
    expect(info).toHaveBeenCalledTimes(61);
  });
});
