import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseOrgSnapshot,
  diffOrgSnapshot,
  describeOrgSnapshotDiff,
  requestOrgRefresh,
  setOrgRefresher,
  startOrgRefreshTimer,
  stopOrgRefreshTimer,
  _test_resetOrgRefresh,
} from "./org-refresh.js";

describe("parseOrgSnapshot", () => {
  it("reads orgs and onboarding groups, dropping an onboarding group that is also an org", () => {
    const s = parseOrgSnapshot({
      orgs: [
        { id: "o1", name: "Sutton FC", whatsappGroupId: "a@g.us" },
        { id: "o2", name: "No group", whatsappGroupId: null },
      ],
      onboardingGroups: ["b@g.us", "a@g.us", "b@g.us", 7, ""],
    });
    expect(s).toEqual({
      orgConfigs: [{ groupId: "a@g.us", orgName: "Sutton FC" }],
      onboardingGroups: ["b@g.us"],
    });
  });
  it("garbage in, empty out", () => {
    expect(parseOrgSnapshot(null)).toEqual({ orgConfigs: [], onboardingGroups: [] });
    expect(parseOrgSnapshot({ orgs: "x", onboardingGroups: "y" })).toEqual({ orgConfigs: [], onboardingGroups: [] });
  });
});

describe("diffOrgSnapshot", () => {
  it("a setup that completed moves the group from onboarding to org", () => {
    const prev = { orgConfigs: [{ groupId: "a@g.us", orgName: "Sutton FC" }], onboardingGroups: ["b@g.us"] };
    const next = {
      orgConfigs: [
        { groupId: "a@g.us", orgName: "Sutton FC" },
        { groupId: "b@g.us", orgName: "Cuma Halı Saha" },
      ],
      onboardingGroups: [],
    };
    const d = diffOrgSnapshot(prev, next);
    expect(d.changed).toBe(true);
    expect(d.addedOrgs).toEqual([{ groupId: "b@g.us", orgName: "Cuma Halı Saha" }]);
    expect(d.removedOnboarding).toEqual(["b@g.us"]);
    expect(describeOrgSnapshotDiff(d)).toBe("+org Cuma Halı Saha (b@g.us); -onboarding b@g.us");
  });
  it("no change is no change", () => {
    const s = { orgConfigs: [{ groupId: "a@g.us", orgName: "Sutton FC" }], onboardingGroups: [] };
    const d = diffOrgSnapshot(s, s);
    expect(d.changed).toBe(false);
    expect(describeOrgSnapshotDiff(d)).toBe("no change");
  });
  it("the first read (no previous) lists everything as added", () => {
    const d = diffOrgSnapshot(null, { orgConfigs: [{ groupId: "a@g.us", orgName: "Sutton FC" }], onboardingGroups: ["b@g.us"] });
    expect(d.addedOrgs).toHaveLength(1);
    expect(d.addedOnboarding).toEqual(["b@g.us"]);
  });
});

describe("requestOrgRefresh", () => {
  beforeEach(() => _test_resetOrgRefresh());

  it("shares one in-flight refresh between concurrent callers", async () => {
    const resolvers: Array<() => void> = [];
    const fn = vi.fn(() => new Promise<void>((r) => resolvers.push(r)));
    setOrgRefresher(fn);
    const a = requestOrgRefresh("a");
    const b = requestOrgRefresh("b");
    expect(fn).toHaveBeenCalledTimes(1);
    resolvers[0]();
    await Promise.all([a, b]);
    const c = requestOrgRefresh("c");
    expect(fn).toHaveBeenCalledTimes(2);
    resolvers[1]();
    await c;
  });

  it("a failing refresh never throws to its caller", async () => {
    setOrgRefresher(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(requestOrgRefresh("x")).resolves.toBeUndefined();
  });

  it("no refresher registered is a no-op", async () => {
    await expect(requestOrgRefresh("x")).resolves.toBeUndefined();
  });

  it("the timer starts once and asks for a periodic refresh", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn(async () => undefined);
      setOrgRefresher(fn);
      startOrgRefreshTimer(1000);
      startOrgRefreshTimer(1000); // a repeat `ready` must not double it
      await vi.advanceTimersByTimeAsync(3500);
      expect(fn).toHaveBeenCalledTimes(3);
      stopOrgRefreshTimer();
      await vi.advanceTimersByTimeAsync(3000);
      expect(fn).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
