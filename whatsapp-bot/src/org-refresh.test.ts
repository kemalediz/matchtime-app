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
      silentGroups: [],
      legacySetupTrigger: true,
      selfJoinSweep: null,
    });
  });
  it("garbage in, empty out", () => {
    const empty = { orgConfigs: [], onboardingGroups: [], silentGroups: [], legacySetupTrigger: true, selfJoinSweep: null };
    expect(parseOrgSnapshot(null)).toEqual(empty);
    expect(parseOrgSnapshot({ orgs: "x", onboardingGroups: "y", silentGroups: "z" })).toEqual(empty);
  });
});

describe("parseOrgSnapshot: silence rails (self-join slice 1)", () => {
  it("an OLDER server (no new fields) reads as today's behaviour: nothing silent, trigger on", () => {
    const s = parseOrgSnapshot({ orgs: [{ name: "Sutton FC", whatsappGroupId: "a@g.us" }], onboardingGroups: [] });
    expect(s.silentGroups).toEqual([]);
    expect(s.legacySetupTrigger).toBe(true);
  });

  it("reads silent groups, deduped, and a silent group is never an onboarding group", () => {
    const s = parseOrgSnapshot({
      orgs: [],
      onboardingGroups: ["p@g.us", "b@g.us"],
      silentGroups: ["p@g.us", "u@g.us", "p@g.us", 3, ""],
    });
    expect(s.silentGroups.sort()).toEqual(["p@g.us", "u@g.us"]);
    expect(s.onboardingGroups).toEqual(["b@g.us"]);
  });

  it("a live org is NEVER silenced on the Pi, even if the server listed it in both", () => {
    const s = parseOrgSnapshot({
      orgs: [{ name: "Sutton FC", whatsappGroupId: "a@g.us" }],
      silentGroups: ["a@g.us", "p@g.us"],
    });
    expect(s.orgConfigs).toEqual([{ groupId: "a@g.us", orgName: "Sutton FC" }]);
    expect(s.silentGroups).toEqual(["p@g.us"]);
  });

  it("legacySetupTrigger is off only on an explicit false", () => {
    expect(parseOrgSnapshot({ legacySetupTrigger: false }).legacySetupTrigger).toBe(false);
    expect(parseOrgSnapshot({ legacySetupTrigger: "false" }).legacySetupTrigger).toBe(true);
    expect(parseOrgSnapshot({ legacySetupTrigger: true }).legacySetupTrigger).toBe(true);
  });
});

describe("parseOrgSnapshot: the reconnect sweep (self-join slice 6)", () => {
  it("an older server, or self-join off, sends none: no sweep", () => {
    expect(parseOrgSnapshot({ orgs: [] }).selfJoinSweep).toBeNull();
    expect(parseOrgSnapshot({ selfJoinSweep: null }).selfJoinSweep).toBeNull();
    expect(parseOrgSnapshot({ selfJoinSweep: "yes" }).selfJoinSweep).toBeNull();
  });

  it("reads the known groups, and adds every live org's group to them", () => {
    const s = parseOrgSnapshot({
      orgs: [{ name: "Sutton FC", whatsappGroupId: "a@g.us" }],
      selfJoinSweep: { knownGroups: ["p@g.us", 7, "", "p@g.us"] },
    });
    expect(s.selfJoinSweep?.knownGroups.sort()).toEqual(["a@g.us", "p@g.us"]);
  });

  it("a sweep with no list still sweeps, knowing only the live orgs", () => {
    const s = parseOrgSnapshot({ orgs: [{ name: "Sutton FC", whatsappGroupId: "a@g.us" }], selfJoinSweep: {} });
    expect(s.selfJoinSweep).toEqual({ knownGroups: ["a@g.us"] });
  });
});

function snap(
  orgConfigs: Array<{ groupId: string; orgName: string }>,
  onboardingGroups: string[] = [],
  silentGroups: string[] = [],
) {
  return { orgConfigs, onboardingGroups, silentGroups, legacySetupTrigger: true, selfJoinSweep: null };
}

describe("diffOrgSnapshot", () => {
  it("a setup that completed moves the group from onboarding to org", () => {
    const prev = snap([{ groupId: "a@g.us", orgName: "Sutton FC" }], ["b@g.us"]);
    const next = snap([
      { groupId: "a@g.us", orgName: "Sutton FC" },
      { groupId: "b@g.us", orgName: "Cuma Halı Saha" },
    ]);
    const d = diffOrgSnapshot(prev, next);
    expect(d.changed).toBe(true);
    expect(d.addedOrgs).toEqual([{ groupId: "b@g.us", orgName: "Cuma Halı Saha" }]);
    expect(d.removedOnboarding).toEqual(["b@g.us"]);
    expect(describeOrgSnapshotDiff(d)).toBe("+org Cuma Halı Saha (b@g.us); -onboarding b@g.us");
  });
  it("no change is no change", () => {
    const s = snap([{ groupId: "a@g.us", orgName: "Sutton FC" }]);
    const d = diffOrgSnapshot(s, s);
    expect(d.changed).toBe(false);
    expect(describeOrgSnapshotDiff(d)).toBe("no change");
  });
  it("the first read (no previous) lists everything as added", () => {
    const d = diffOrgSnapshot(null, snap([{ groupId: "a@g.us", orgName: "Sutton FC" }], ["b@g.us"]));
    expect(d.addedOrgs).toHaveLength(1);
    expect(d.addedOnboarding).toEqual(["b@g.us"]);
  });
  it("a group turning silent (or no longer silent) is a change, and says so", () => {
    const prev = snap([], [], ["p@g.us"]);
    const next = snap([], [], ["u@g.us"]);
    const d = diffOrgSnapshot(prev, next);
    expect(d.changed).toBe(true);
    expect(describeOrgSnapshotDiff(d)).toBe("+silent u@g.us; -silent p@g.us");
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
