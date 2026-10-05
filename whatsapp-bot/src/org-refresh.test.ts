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
  requestStaleGroupRecheck,
  STALE_RECHECK_GROUP_COOLDOWN_MS,
  STALE_RECHECK_MAX_PER_WINDOW,
  STALE_RECHECK_WINDOW_MS,
  STALE_RECHECK_TIMEOUT_MS,
  isOrgsResponseBody,
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
      adminGroups: [],
    });
  });
  it("garbage in, empty out", () => {
    const empty = { orgConfigs: [], onboardingGroups: [], silentGroups: [], legacySetupTrigger: true, selfJoinSweep: null, adminGroups: [] };
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

describe("parseOrgSnapshot: admin groups (slice 2a)", () => {
  it("an older server sends none: no admin groups", () => {
    expect(parseOrgSnapshot({ orgs: [{ name: "Sutton FC", whatsappGroupId: "a@g.us" }] }).adminGroups).toEqual([]);
  });

  it("reads them defensively, deduped; a live org's group is never one; an admin group is never silent or onboarding", () => {
    const s = parseOrgSnapshot({
      orgs: [{ name: "Sutton FC", whatsappGroupId: "a@g.us" }],
      silentGroups: ["hq@g.us", "u@g.us"],
      onboardingGroups: ["hq@g.us"],
      adminGroups: [
        { groupId: "hq@g.us", orgId: "org-fnf" },
        { groupId: "hq@g.us", orgId: "org-fnf" },
        { groupId: "a@g.us", orgId: "org-sutton" },
        { groupId: "not-a-group", orgId: "x" },
        { groupId: "b@g.us" },
        "junk",
      ],
    });
    expect(s.adminGroups).toEqual([{ groupId: "hq@g.us", orgId: "org-fnf" }]);
    expect(s.silentGroups).toEqual(["u@g.us"]);
    expect(s.onboardingGroups).toEqual([]);
    expect(s.orgConfigs).toEqual([{ groupId: "a@g.us", orgName: "Sutton FC" }]);
  });

  it("the reconnect sweep counts an admin group as known", () => {
    const s = parseOrgSnapshot({ orgs: [], adminGroups: [{ groupId: "hq@g.us", orgId: "o" }], selfJoinSweep: { knownGroups: [] } });
    expect(s.selfJoinSweep?.knownGroups).toEqual(["hq@g.us"]);
  });

  it("a linked or unlinked admin group is a change worth logging", () => {
    const before = parseOrgSnapshot({ orgs: [] });
    const after = parseOrgSnapshot({ orgs: [], adminGroups: [{ groupId: "hq@g.us", orgId: "o" }] });
    const diff = diffOrgSnapshot(before, after);
    expect(diff.changed).toBe(true);
    expect(describeOrgSnapshotDiff(diff)).toBe("+admin-group hq@g.us");
    expect(describeOrgSnapshotDiff(diffOrgSnapshot(after, before))).toBe("-admin-group hq@g.us");
  });
});

// ── F2 (2026-10-05): the one refresh before a self-add decision ───────

describe("requestStaleGroupRecheck: one rate-limited refresh before deciding a re-add", () => {
  beforeEach(() => _test_resetOrgRefresh());

  it("runs one refresh, with a reason naming the group", async () => {
    const fn = vi.fn(async () => undefined);
    setOrgRefresher(fn);
    await expect(requestStaleGroupRecheck("g1@g.us", 0)).resolves.toBe("refreshed");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toContain("g1@g.us");
  });

  it("the same group again within the cooldown: no second refresh (repeated adds)", async () => {
    const fn = vi.fn(async () => undefined);
    setOrgRefresher(fn);
    await requestStaleGroupRecheck("g1@g.us", 0);
    await expect(requestStaleGroupRecheck("g1@g.us", STALE_RECHECK_GROUP_COOLDOWN_MS - 1)).resolves.toBe("rate-limited");
    expect(fn).toHaveBeenCalledTimes(1);
    await expect(requestStaleGroupRecheck("g1@g.us", STALE_RECHECK_GROUP_COOLDOWN_MS + 1)).resolves.toBe("refreshed");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("many groups at once (a reconnect replaying adds): capped per window, no refresh storm", async () => {
    const fn = vi.fn(async () => undefined);
    setOrgRefresher(fn);
    const outcomes: string[] = [];
    for (let i = 0; i < STALE_RECHECK_MAX_PER_WINDOW + 5; i++) {
      outcomes.push(await requestStaleGroupRecheck(`g${i}@g.us`, i));
    }
    expect(fn).toHaveBeenCalledTimes(STALE_RECHECK_MAX_PER_WINDOW);
    expect(outcomes.filter((o) => o === "rate-limited")).toHaveLength(5);
    // the window rolls on
    await expect(requestStaleGroupRecheck("late@g.us", STALE_RECHECK_WINDOW_MS + 100)).resolves.toBe("refreshed");
  });

  it("concurrent re-adds share one refresh", async () => {
    let release: () => void = () => undefined;
    const fn = vi.fn(() => new Promise<void>((r) => (release = r)));
    setOrgRefresher(fn);
    const a = requestStaleGroupRecheck("a@g.us", 0);
    const b = requestStaleGroupRecheck("b@g.us", 0);
    await Promise.resolve();
    release();
    await Promise.all([a, b]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not trust a refresh already in flight (it may predate the delete): waits, then runs a fresh one", async () => {
    const releases: Array<() => void> = [];
    const fn = vi.fn(() => new Promise<void>((r) => releases.push(r)));
    setOrgRefresher(fn);
    const periodic = requestOrgRefresh("periodic");
    const recheck = requestStaleGroupRecheck("g1@g.us", 0);
    expect(fn).toHaveBeenCalledTimes(1);
    releases[0]();
    await periodic;
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    releases[1]();
    await expect(recheck).resolves.toBe("refreshed");
  });

  it("a failing refresh is reported, never thrown", async () => {
    setOrgRefresher(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(requestStaleGroupRecheck("g1@g.us", 0)).resolves.toBe("failed");
  });

  it("a refresh that hangs gives up after the timeout, so the join handler is never stuck", async () => {
    vi.useFakeTimers();
    try {
      setOrgRefresher(() => new Promise<void>(() => undefined));
      const p = requestStaleGroupRecheck("g1@g.us", 0);
      await vi.advanceTimersByTimeAsync(STALE_RECHECK_TIMEOUT_MS + 1);
      await expect(p).resolves.toBe("timed-out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("no refresher registered (before `ready`): nothing to do", async () => {
    await expect(requestStaleGroupRecheck("g1@g.us", 0)).resolves.toBe("no-refresher");
  });
});

describe("isOrgsResponseBody: a 200 without an org list is a failed refresh, not an empty one", () => {
  it("accepts a body with an orgs array (even an empty one)", () => {
    expect(isOrgsResponseBody({ orgs: [] })).toBe(true);
    expect(isOrgsResponseBody({ orgs: [{ name: "Sutton FC", whatsappGroupId: "a@g.us" }] })).toBe(true);
  });
  it("rejects anything else, so the old list is kept (Sutton FC never drops off on a bad body)", () => {
    expect(isOrgsResponseBody(null)).toBe(false);
    expect(isOrgsResponseBody({})).toBe(false);
    expect(isOrgsResponseBody({ orgs: "x" })).toBe(false);
    expect(isOrgsResponseBody({ error: "Unauthorized" })).toBe(false);
    expect(isOrgsResponseBody("<html>")).toBe(false);
  });
});

describe("index.ts wiring (F2)", () => {
  it("the group-join handler passes the rate-limited re-check, and a non-list /orgs body throws before any set changes", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(src).toContain("recheckMonitoredGroup: (gid) => requestStaleGroupRecheck(gid)");
    const guard = src.indexOf("if (!isOrgsResponseBody(data)) throw");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(src.indexOf("currentSnapshot = next;"));
  });
});
