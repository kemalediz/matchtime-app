/**
 * THE WIRING BETWEEN A REFRESH AND THE CATCH-UPS (club-catch-up.ts).
 *
 * This is what index.ts used to do inline and untested: note the stamp a
 * snapshot was read at, re-read what was said in a group that has just
 * become a club's (from its go-live, and never before it), and put the
 * same floor under the restart catch-up. It is built here exactly as
 * index.ts builds it (`wireClubCatchUp`), round a fake `recover` function,
 * so the arguments the real `recoverGroupMessages` gets are pinned.
 *
 * No socket, no network, no timers that are not faked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CATCH_UP_MAX_AGE_MS } from "./org-refresh.js";
import { MAX_PENDING_CATCH_UPS, runPendingCatchUps, setActiveClubCatchUp, wireClubCatchUp } from "./club-catch-up.js";

const DRIVER = { name: "fake-driver" } as never;
const G1 = "120363900000000201@g.us";
const G2 = "120363900000000202@g.us";
const T0 = Date.parse("2026-10-13T12:00:00.000Z");

type RecoverCall = { groupIds: string[]; argCount: number; window: unknown; floors: Record<string, number | null | undefined> | null };

function harness() {
  let now = T0;
  let sweepRunning = false;
  const monitored = new Set<string>();
  const calls: RecoverCall[] = [];
  const versions: Array<string | null> = [];
  const lines: string[] = [];
  const recover = vi.fn(async (...args: unknown[]) => {
    const [, groupIds, window, opts] = args as [unknown, string[], unknown, { notBeforeMs?: (g: string) => number | null | undefined } | undefined];
    calls.push({
      groupIds: [...groupIds],
      argCount: args.length,
      window,
      floors: opts?.notBeforeMs ? Object.fromEntries(groupIds.map((g) => [g, opts.notBeforeMs!(g)])) : null,
    });
  });
  const catchUp = wireClubCatchUp({
    driver: DRIVER,
    recoverGroupMessages: recover as never,
    isRecoverySweepRunning: () => sweepRunning,
    isMonitoredGroup: (g) => monitored.has(g),
    noteSnapshotClubSetVersion: (v) => void versions.push(v),
    now: () => now,
    log: (l) => void lines.push(l),
    error: (l) => void lines.push(l),
  });
  /** An /orgs body with these clubs; `liveAgoMs` null means no liveAt. */
  const orgsBody = (clubs: Array<[string, number | null]>, clubSetVersion?: string) => ({
    orgs: clubs.map(([whatsappGroupId, ago], i) => ({
      id: `o${i}`,
      name: `Club ${i} (a name that must never be logged)`,
      whatsappGroupId,
      liveAt: ago === null ? null : new Date(now - ago).toISOString(),
    })),
    ...(clubSetVersion ? { clubSetVersion } : {}),
  });
  /** What index.ts's refreshOrgs does on success. */
  const refreshed = (reason: string, clubs: Array<[string, number | null]>, added: string[], extra: { shadow?: boolean; version?: string } = {}) => {
    monitored.clear();
    for (const [g] of clubs) monitored.add(g);
    catchUp.onRefreshed({
      reason,
      data: orgsBody(clubs, extra.version),
      addedOrgs: added.map((groupId) => ({ groupId, orgName: "a name that must never be logged" })),
      shadow: extra.shadow,
    });
  };
  return {
    catchUp,
    calls,
    versions,
    lines,
    recover,
    monitored,
    refreshed,
    advance: (ms: number) => void (now += ms),
    now: () => now,
    setSweepRunning: (v: boolean) => void (sweepRunning = v),
  };
}

beforeEach(() => setActiveClubCatchUp(null));

describe("the snapshot's stamp", () => {
  it("every successful refresh notes the stamp /orgs carried, whatever asked for the refresh", () => {
    const h = harness();
    h.refreshed("ready", [[G1, null]], [G1], { version: "v1" });
    h.refreshed("periodic", [[G1, null]], [], { version: "v2" });
    h.refreshed("club set changed", [[G1, null]], [], { version: "v3" });
    expect(h.versions).toEqual(["v1", "v2", "v3"]);
  });

  it("an older server's /orgs has none: null is noted, so nothing is ever compared", () => {
    const h = harness();
    h.refreshed("periodic", [[G1, null]], []);
    expect(h.versions).toEqual([null]);
  });
});

describe("a group that has just become a club's", () => {
  it("added by a stamp-triggered refresh, live 20 seconds ago: caught up ONCE, with exactly that floor", async () => {
    const h = harness();
    const liveAt = h.now() - 20_000;
    h.refreshed("club set changed", [[G1, 20_000]], [G1]);
    await h.catchUp.runPending();
    expect(h.calls).toEqual([{ groupIds: [G1], argCount: 4, window: undefined, floors: { [G1]: liveAt } }]);
    expect(h.recover.mock.calls[0][0]).toBe(DRIVER);
    // Later ticks and later refreshes: nothing more.
    await h.catchUp.runPending();
    h.refreshed("periodic", [[G1, 20_000]], []);
    await h.catchUp.runPending();
    expect(h.calls).toHaveLength(1);
    expect(h.catchUp.pending()).toEqual([]);
  });

  it("the periodic refresh that finds it first does the same: the catch-up belongs to the go-live, not to what noticed it", async () => {
    const h = harness();
    h.refreshed("periodic", [[G1, 200_000]], [G1]);
    await h.catchUp.runPending();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].floors).toEqual({ [G1]: h.now() - 200_000 });
  });

  // PR #250 review, fix 2. The sweep can wait behind another one. The floor
  // used to be looked up AGAIN at sweep time, from the latest snapshot: a
  // club dropped in the wait had no floor any more, and the sweep then fed
  // two hours of its group, the time before go-live included.
  it("DROPPED BEFORE THE SWEEP RUNS (suspended, paused, muted): it is NOT swept, and the reason is logged", async () => {
    const h = harness();
    h.setSweepRunning(true);
    h.refreshed("club set changed", [[G1, 20_000]], [G1]);
    await h.catchUp.runPending();
    expect(h.calls).toEqual([]);
    expect(h.catchUp.pending()).toHaveLength(1);
    // A refresh in the wait drops the club.
    h.refreshed("club set changed", [], []);
    h.setSweepRunning(false);
    await h.catchUp.runPending();
    expect(h.calls).toEqual([]);
    expect(h.catchUp.pending()).toEqual([]);
    expect(h.lines.join("\n")).toContain("not-monitored");
  });

  it("the floor is the one CAPTURED when the group was added, even if a later snapshot gives another or none", async () => {
    const h = harness();
    const liveAt = h.now() - 20_000;
    h.setSweepRunning(true);
    h.refreshed("club set changed", [[G1, 20_000]], [G1]);
    await h.catchUp.runPending();
    // The next snapshot still has the club, with NO liveAt (an older server instance, say).
    h.refreshed("periodic", [[G1, null]], []);
    h.setSweepRunning(false);
    await h.catchUp.runPending();
    expect(h.calls).toEqual([{ groupIds: [G1], argCount: 4, window: undefined, floors: { [G1]: liveAt } }]);
  });

  it("NO FLOOR, NO SWEEP: a group added with no go-live time is never caught up by this (an unmuted club, an older server)", async () => {
    const h = harness();
    h.refreshed("club set changed", [[G1, null]], [G1]);
    await h.catchUp.runPending();
    expect(h.calls).toEqual([]);
    expect(h.catchUp.pending()).toEqual([]);
    expect(h.lines.join("\n")).toContain("no-live-at");
  });

  it("a club back from a pause that went live long ago: nothing, and it says why", async () => {
    const h = harness();
    h.refreshed("club set changed", [[G1, CATCH_UP_MAX_AGE_MS + 60_000]], [G1]);
    await h.catchUp.runPending();
    expect(h.calls).toEqual([]);
    expect(h.lines.join("\n")).toContain("too-old");
  });

  it("the refresh at `ready` queues nothing: the restart catch-up covers every club", async () => {
    const h = harness();
    h.refreshed("ready", [[G1, 20_000]], [G1]);
    await h.catchUp.runPending();
    expect(h.calls).toEqual([]);
    expect(h.catchUp.pending()).toEqual([]);
  });

  it("shadow mode: nothing is queued or swept", async () => {
    const h = harness();
    h.refreshed("club set changed", [[G1, 20_000]], [G1], { shadow: true });
    await h.catchUp.runPending();
    expect(h.calls).toEqual([]);
  });

  // PR #250 review, fix 6. Mute then unmute (or pause then resume) inside
  // fifteen minutes of go-live re-adds the group with the same recent
  // liveAt. The catch-up is for the go-live, once.
  it("ONCE PER GO-LIVE: the same group re-added with the same go-live time is not caught up again", async () => {
    const h = harness();
    h.refreshed("club set changed", [[G1, 20_000]], [G1]);
    await h.catchUp.runPending();
    expect(h.calls).toHaveLength(1);
    // Muted: gone. Unmuted a minute later: added again, same liveAt.
    h.refreshed("club set changed", [], []);
    h.advance(60_000);
    h.refreshed("club set changed", [[G1, 80_000]], [G1]);
    await h.catchUp.runPending();
    expect(h.calls).toHaveLength(1);
    expect(h.lines.join("\n")).toContain("already-caught-up");
  });

  it("a NEW go-live of the same group (a different time) is a new catch-up", async () => {
    const h = harness();
    h.refreshed("club set changed", [[G1, 20_000]], [G1]);
    await h.catchUp.runPending();
    h.refreshed("club set changed", [], []);
    h.advance(5 * 60_000);
    h.refreshed("club set changed", [[G1, 10_000]], [G1]);
    await h.catchUp.runPending();
    expect(h.calls).toHaveLength(2);
  });

  it("two clubs go live in one refresh: each swept on its own, each with its own floor", async () => {
    const h = harness();
    h.refreshed("club set changed", [[G1, 20_000], [G2, 5_000]], [G1, G2]);
    await h.catchUp.runPending();
    expect(h.calls).toEqual([
      { groupIds: [G1], argCount: 4, window: undefined, floors: { [G1]: h.now() - 20_000 } },
      { groupIds: [G2], argCount: 4, window: undefined, floors: { [G2]: h.now() - 5_000 } },
    ]);
  });
});

describe("a catch-up that could not run yet (PR #250 review, fix 5)", () => {
  it("another sweep is running: it WAITS, is tried again on every tick, and runs when the sweep is over", async () => {
    const h = harness();
    setActiveClubCatchUp(h.catchUp);
    h.setSweepRunning(true);
    h.refreshed("club set changed", [[G1, 20_000]], [G1]);
    for (let tick = 0; tick < 4; tick++) {
      h.advance(30_000);
      await runPendingCatchUps();
    }
    expect(h.calls).toEqual([]);
    expect(h.catchUp.pending()).toHaveLength(1);
    h.setSweepRunning(false);
    h.advance(30_000);
    await runPendingCatchUps();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].floors).toEqual({ [G1]: T0 - 20_000 });
    expect(h.catchUp.pending()).toEqual([]);
  });

  it("it does not wait for ever: once its go-live is more than fifteen minutes old it is given up, and logged", async () => {
    const h = harness();
    h.setSweepRunning(true);
    h.refreshed("club set changed", [[G1, 20_000]], [G1]);
    // The first try, at once: the other sweep is running, so it waits.
    await h.catchUp.runPending();
    expect(h.catchUp.pending()).toHaveLength(1);
    h.advance(CATCH_UP_MAX_AGE_MS);
    await h.catchUp.runPending();
    expect(h.catchUp.pending()).toEqual([]);
    h.setSweepRunning(false);
    await h.catchUp.runPending();
    expect(h.calls).toEqual([]);
    expect(h.lines.join("\n")).toContain("expired");
  });

  it("a sweep that throws is tried again on the next tick", async () => {
    const h = harness();
    h.recover.mockRejectedValueOnce(new Error("page gone"));
    h.refreshed("club set changed", [[G1, 20_000]], [G1]);
    await h.catchUp.runPending();
    expect(h.catchUp.pending()).toHaveLength(1);
    await h.catchUp.runPending();
    expect(h.recover).toHaveBeenCalledTimes(2);
    expect(h.catchUp.pending()).toEqual([]);
  });

  it("BOUNDED: never more than a handful waiting; the oldest go first", () => {
    const h = harness();
    h.setSweepRunning(true);
    const many = Array.from({ length: MAX_PENDING_CATCH_UPS + 5 }, (_, i) => `1203639000000${String(1000 + i)}@g.us`);
    h.refreshed("club set changed", many.map((g) => [g, 20_000] as [string, number]), many);
    expect(h.catchUp.pending()).toHaveLength(MAX_PENDING_CATCH_UPS);
    expect(h.catchUp.pending().map((p) => p.groupId)).toEqual(many.slice(5));
  });

  it("with nothing waiting a tick does nothing at all", async () => {
    const h = harness();
    setActiveClubCatchUp(h.catchUp);
    await runPendingCatchUps();
    expect(h.recover).not.toHaveBeenCalled();
    // And with no catch-up wired (shadow mode, a test): a no-op, never a throw.
    setActiveClubCatchUp(null);
    await expect(runPendingCatchUps()).resolves.toBeUndefined();
  });

  it("two ticks at once do not sweep one group twice", async () => {
    const h = harness();
    h.refreshed("club set changed", [[G1, 20_000]], [G1]);
    await Promise.all([h.catchUp.runPending(), h.catchUp.runPending(), h.catchUp.runPending()]);
    expect(h.calls).toHaveLength(1);
  });
});

describe("the restart catch-up at `ready`", () => {
  it("clubs with NO go-live time: called exactly as on main, two arguments, no floor, the default two-hour lookback", async () => {
    const h = harness();
    h.refreshed("ready", [[G1, null], [G2, null]], [G1, G2]);
    await h.catchUp.readyCatchUp([G1, G2]);
    expect(h.recover).toHaveBeenCalledTimes(1);
    expect(h.recover.mock.calls[0]).toEqual([DRIVER, [G1, G2]]);
  });

  it("an older server (no liveAt anywhere): the same two-argument call", async () => {
    const h = harness();
    h.monitored.add(G1);
    h.catchUp.onRefreshed({ reason: "ready", data: { orgs: [{ name: "x", whatsappGroupId: G1 }] }, addedOrgs: [] });
    await h.catchUp.readyCatchUp([G1]);
    expect(h.recover.mock.calls[0]).toEqual([DRIVER, [G1]]);
  });

  it("a club that went live an hour ago: the floor is applied to it, and only to it; the lookback is still the default", async () => {
    const h = harness();
    const liveAt = h.now() - 3_600_000;
    h.refreshed("ready", [[G1, 3_600_000], [G2, null]], [G1, G2]);
    await h.catchUp.readyCatchUp([G1, G2]);
    expect(h.calls).toEqual([{ groupIds: [G1, G2], argCount: 4, window: undefined, floors: { [G1]: liveAt, [G2]: null } }]);
  });

  it("NOTHING IS FED FOR A GROUP THAT IS NOT MONITORED, whatever list it is handed", async () => {
    const h = harness();
    h.refreshed("ready", [[G1, null]], [G1]);
    await h.catchUp.readyCatchUp([G1, G2, "120363900000000299@g.us"]);
    expect(h.recover.mock.calls[0]).toEqual([DRIVER, [G1]]);
    // And with none monitored at all, the sweep is not even started.
    h.monitored.clear();
    h.recover.mockClear();
    await h.catchUp.readyCatchUp([G1, G2]);
    expect(h.recover).not.toHaveBeenCalled();
  });

  it("a restart after a go-live does not also run the newly-live catch-up for it", async () => {
    const h = harness();
    h.refreshed("ready", [[G1, 20_000]], [G1]);
    await h.catchUp.readyCatchUp([G1]);
    await h.catchUp.runPending();
    expect(h.calls).toHaveLength(1);
    // And a refresh a moment later that "adds" nothing changes nothing.
    h.refreshed("periodic", [[G1, 20_000]], []);
    await h.catchUp.runPending();
    expect(h.calls).toHaveLength(1);
  });
});

describe("LOGS", () => {
  it("carry group ids, counts and reason codes only: never a club's name", async () => {
    const h = harness();
    h.refreshed("club set changed", [[G1, 20_000], [G2, null]], [G1, G2]);
    await h.catchUp.runPending();
    const all = h.lines.join("\n");
    expect(all).toContain(G1);
    expect(all).not.toContain("a name that must never be logged");
  });
});
