/**
 * An `admin-group-message` that carries an `imageUrl` (2026-10-14): a
 * club's list poster or team sheet. The scheduler fetches the PNG from the
 * server, posts it in the admin group with the text as its caption, and
 * acks with the image's id. A fetch that fails posts nothing (not the
 * caption alone, which would announce a picture nobody can see) and is
 * acked so the queue moves on; the admin can ask again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WaDriver } from "./driver.js";

const getDuePosts = vi.fn();
const ackInstruction = vi.fn(async () => undefined);
const releaseInstruction = vi.fn(async () => undefined);
vi.mock("./api.js", () => ({
  getDuePosts: (...a: unknown[]) => getDuePosts(...a),
  ackInstruction: (...a: unknown[]) => ackInstruction(...a),
  releaseInstruction: (...a: unknown[]) => releaseInstruction(...a),
  getPlatformJobs: async () => null,
  reportPlatformJob: async () => undefined,
}));
const fetchGraphic = vi.fn();
vi.mock("./graphic-fetch.js", () => ({ fetchGraphic: (...a: unknown[]) => fetchGraphic(...a) }));

const { initScheduler, stopScheduler } = await import("./scheduler.js");
const { setAdminGroups } = await import("./handlers.js");
const { config } = await import("./config.js");

const GID = "447525334985-1607872139@g.us";
const HQ = "120363900000000001@g.us";
const URL_OK = `${config.apiUrl}/api/graphics/abc.def`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fakeDriver() {
  const calls: Array<[string, ...unknown[]]> = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return { id: { _serialized: `${name}-1` } };
    };
  const driver = { name: "fake", sendText: record("sendText"), sendImage: record("sendImage") } as unknown as WaDriver;
  return { driver, calls };
}

async function dispatch(instruction: Record<string, unknown>) {
  const { driver, calls } = fakeDriver();
  getDuePosts.mockResolvedValue({ instructions: [instruction] });
  initScheduler(driver, [{ groupId: GID, orgName: "FNF" }]);
  await vi.advanceTimersByTimeAsync(0);
  return calls;
}

const INSTR = { kind: "admin-group-message", key: "botjob-g1", groupId: HQ, text: "Ready to post: FNF list for Fri 16 Oct", matchId: "m-1", imageUrl: URL_OK };

beforeEach(() => {
  vi.useFakeTimers();
  getDuePosts.mockReset();
  ackInstruction.mockClear();
  releaseInstruction.mockClear();
  fetchGraphic.mockReset();
  setAdminGroups([{ groupId: HQ, orgId: "org-fnf" }]);
});

afterEach(() => {
  stopScheduler();
  setAdminGroups([]);
  vi.useRealTimers();
});

describe("admin-group-message with an imageUrl", () => {
  it("fetches the PNG from the Pi's own server and posts it with the caption, then acks with its id", async () => {
    fetchGraphic.mockResolvedValue(PNG);
    const calls = await dispatch(INSTR);
    expect(fetchGraphic).toHaveBeenCalledWith(URL_OK, expect.objectContaining({ apiUrl: config.apiUrl }));
    expect(calls).toEqual([["sendImage", HQ, PNG, "Ready to post: FNF list for Fri 16 Oct"]]);
    expect(ackInstruction).toHaveBeenCalledWith(
      expect.objectContaining({ key: "botjob-g1", kind: "admin-group-message", matchId: "m-1", waMessageId: "sendImage-1" }),
    );
    expect(releaseInstruction).not.toHaveBeenCalled();
  });

  it("a failed fetch posts nothing, not even the caption, and is acked so the queue moves on; the log has no URL", async () => {
    fetchGraphic.mockRejectedValue(new Error("graphic fetch answered 404"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const calls = await dispatch(INSTR);
      expect(calls).toEqual([]);
      const logged = err.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
      expect(logged).toMatch(/botjob-g1/);
      expect(logged).not.toContain("abc.def");
    } finally {
      err.mockRestore();
    }
    expect(ackInstruction).toHaveBeenCalledWith(expect.objectContaining({ key: "botjob-g1", kind: "admin-group-message" }));
    expect((ackInstruction.mock.calls[0] as unknown as [{ waMessageId?: string }])[0].waMessageId).toBeUndefined();
  });

  it("still only ever to a known admin group: otherwise released, nothing fetched", async () => {
    setAdminGroups([]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await dispatch(INSTR)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
    expect(fetchGraphic).not.toHaveBeenCalled();
    expect(releaseInstruction).toHaveBeenCalledWith("botjob-g1");
  });

  it("without an imageUrl: the text, exactly as before", async () => {
    const { imageUrl: _drop, ...plain } = INSTR;
    const calls = await dispatch(plain);
    expect(calls).toEqual([["sendText", HQ, INSTR.text]]);
    expect(fetchGraphic).not.toHaveBeenCalled();
  });
});
