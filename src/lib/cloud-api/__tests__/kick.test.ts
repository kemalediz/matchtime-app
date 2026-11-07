/**
 * THE AFTER() KICK (WhatsApp Cloud API plan, PR C4): a cloud job queued
 * inside a request is dispatched once the response has gone; outside a
 * request (a script, a test) nothing throws and the sweep sends it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const later = vi.hoisted(() => ({ tasks: [] as Array<() => unknown>, outside: false }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    if (later.outside) throw new Error("`after` was called outside a request scope");
    later.tasks.push(fn);
  },
}));
const dispatch = vi.hoisted(() => ({ dispatchCloudJobs: vi.fn() }));
vi.mock("../dispatch", () => dispatch);

import { scheduleCloudDispatch } from "../kick";

beforeEach(() => {
  vi.clearAllMocks();
  later.tasks.length = 0;
  later.outside = false;
});

describe("scheduleCloudDispatch", () => {
  it("schedules the dispatcher after the response, and does not run it inline", async () => {
    scheduleCloudDispatch();
    expect(dispatch.dispatchCloudJobs).not.toHaveBeenCalled();
    expect(later.tasks).toHaveLength(1);
    await later.tasks[0]();
    expect(dispatch.dispatchCloudJobs).toHaveBeenCalledTimes(1);
  });

  it("a dispatcher that throws is caught: the sweep sends it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    dispatch.dispatchCloudJobs.mockRejectedValueOnce(new Error("db"));
    scheduleCloudDispatch();
    await expect(Promise.resolve(later.tasks[0]())).resolves.toBeUndefined();
  });

  it("outside a request scope: no throw, nothing scheduled", () => {
    later.outside = true;
    expect(() => scheduleCloudDispatch()).not.toThrow();
    expect(later.tasks).toHaveLength(0);
  });
});
