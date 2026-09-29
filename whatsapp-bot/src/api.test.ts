/**
 * The two transport rules that the rest of the Pi's error handling
 * silently depends on.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { getDuePosts, getPlatformJobs, postAnalyzeFull, postDmReply, postHeartbeat, reportPlatformJob } from "./api.js";
import { emptyCounters } from "./heartbeat.js";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function res(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

describe("postAnalyzeFull", () => {
  it("returns the results on success", async () => {
    fetchMock.mockResolvedValue(res(200, { results: [{ waMessageId: "a" }], nextKickoffMs: 5 }));
    const out = await postAnalyzeFull({ groupId: "g@g.us", messages: [] });
    expect(out.results).toHaveLength(1);
    expect(out.nextKickoffMs).toBe(5);
  });

  it("THROWS on an HTTP error instead of pretending the batch was handled", async () => {
    // The 2026-08-30 audit, §4.1: this used to `console.error` and return
    // `{results: [], nextKickoffMs: null}`. `flushGroup` clears the buffer
    // optimistically and requeues only from a `catch`, so a catch that a
    // non-throwing function can never trigger made `planFlushRetry` dead
    // code — and a 500 from the analyze route, a Vercel 504 on a slow LLM
    // call, or a 401 on a stale API key silently binned an entire batch of
    // IN/OUT messages while the flush logged "sent N, 0/0 actionable".
    fetchMock.mockResolvedValue(res(500, { error: "boom" }));
    await expect(postAnalyzeFull({ groupId: "g@g.us", messages: [] })).rejects.toThrow(/500/);
  });

  it("throws on a 401 too — a rejected key is not an empty batch", async () => {
    fetchMock.mockResolvedValue(res(401, { error: "Unauthorized" }));
    await expect(postAnalyzeFull({ groupId: "g@g.us", messages: [] })).rejects.toThrow(/401/);
  });

  it("still returns an empty result set for a 200 with no results key", async () => {
    fetchMock.mockResolvedValue(res(200, {}));
    const out = await postAnalyzeFull({ groupId: "g@g.us", messages: [] });
    expect(out).toEqual({ results: [], nextKickoffMs: null });
  });
});

describe("postHeartbeat", () => {
  const payload = {
    groupId: "g@g.us",
    processStartedAt: null,
    botVersion: null,
    counters: emptyCounters(),
    degradedCapabilities: [],
  };

  it("POSTs the payload", async () => {
    fetchMock.mockResolvedValue(res(200, { ok: true }));
    await postHeartbeat(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/whatsapp/heartbeat");
    expect(JSON.parse((init as { body: string }).body).groupId).toBe("g@g.us");
  });

  it("NEVER throws on a 404 — an older server has no such route", async () => {
    // Wire compatibility in the new-Pi → old-server direction. The server
    // ships on merge and the Pi is deployed by hand, so a new Pi WILL run
    // against an older server. A monitoring call that throws there would
    // be a monitoring call that breaks the thing it monitors.
    fetchMock.mockResolvedValue(res(404, { error: "not found" }));
    await expect(postHeartbeat(payload)).resolves.toBeUndefined();
  });

  it("NEVER throws when the network is down", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(postHeartbeat(payload)).resolves.toBeUndefined();
  });

  it("says something the FIRST time it fails and then goes quiet", async () => {
    // A heartbeat that cannot be delivered must not print a line every
    // ten minutes forever: that is how a log stops being readable, which
    // is the failure this whole feature exists to fix.
    // The "log once" flag is module-level and deliberately survives calls,
    // so start from a SUCCESS — which re-arms it, proving a later outage
    // still gets its line rather than being silenced forever by an earlier
    // one.
    fetchMock.mockResolvedValue(res(200, { ok: true }));
    await postHeartbeat(payload);
    const spy = console.warn as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();
    fetchMock.mockResolvedValue(res(404, {}));
    await postHeartbeat(payload);
    const afterFirst = spy.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    await postHeartbeat(payload);
    await postHeartbeat(payload);
    expect(spy.mock.calls.length).toBe(afterFirst);
  });
});

describe("platform channel (self-join slice 3)", () => {
  it("every due-posts poll says this build polls platform jobs itself", async () => {
    fetchMock.mockResolvedValue(res(200, { instructions: [] }));
    await getDuePosts("g@g.us");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["x-mt-platform-jobs"]).toBe("1");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBeDefined();
  });

  it("returns the jobs the server claimed for us", async () => {
    fetchMock.mockResolvedValue(res(200, { jobs: [{ id: "pj1", kind: "dm", phone: "447700900123", text: "x" }] }));
    expect(await getPlatformJobs()).toEqual([{ id: "pj1", kind: "dm", phone: "447700900123", text: "x" }]);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/whatsapp\/platform-jobs$/);
  });

  it("an OLDER server's 404 is a quiet no-op, logged once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(res(404, "not found"));
    expect(await getPlatformJobs()).toBeNull();
    expect(await getPlatformJobs()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a 500 or an unreachable server is 'nothing this tick', never a throw", async () => {
    fetchMock.mockResolvedValueOnce(res(500, { error: "boom" }));
    expect(await getPlatformJobs()).toBeNull();
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await getPlatformJobs()).toBeNull();
  });

  it("reports an outcome as a POST with the job id", async () => {
    fetchMock.mockResolvedValue(res(200, { ok: true }));
    await reportPlatformJob({ id: "pj1", outcome: "failed", error: "not on WhatsApp" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/whatsapp\/platform-jobs$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ id: "pj1", outcome: "failed", error: "not on WhatsApp" });
  });
});

describe("postDmReply (self-join slice 5)", () => {
  it("forwards the sender's LID and alt phone alongside today's fields", async () => {
    fetchMock.mockResolvedValue(res(200, { ok: true }));
    await postDmReply({
      phone: "447700900123",
      body: "Connect Riverside FC, code 7KQ2",
      waMessageId: "wa-1",
      authorName: "Ali",
      senderLid: "158055467598020",
      senderAltPhone: "447700900123",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/whatsapp\/dm-reply$/);
    expect(JSON.parse(String(init.body))).toEqual({
      phone: "447700900123",
      body: "Connect Riverside FC, code 7KQ2",
      waMessageId: "wa-1",
      authorName: "Ali",
      senderLid: "158055467598020",
      senderAltPhone: "447700900123",
    });
  });
});
