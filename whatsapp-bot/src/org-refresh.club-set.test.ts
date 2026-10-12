/**
 * REFRESH WHEN THE SERVER SAYS THE CLUB SET CHANGED (2026-10-13).
 *
 * Until now a club that went live was invisible to the Pi until its next
 * refresh of /orgs, up to five minutes later: its hello was not posted and
 * every message in its group was dropped. The server now puts a "club set
 * version" on the response the Pi polls every tick and on /orgs itself.
 * When the two differ, the Pi refreshes at once.
 *
 * These pin the trigger (one refresh per changed stamp, a failed one tried
 * again on the next tick, nothing at all against an older server) and the
 * catch-up that follows for a group that has just become a club's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CATCH_UP_CLOCK_SKEW_MS,
  CATCH_UP_MAX_AGE_MS,
  CLUB_SET_BACKOFF_AFTER_TICKS,
  CLUB_SET_BACKOFF_MS,
  CLUB_SET_REFRESH_TIMEOUT_MS,
  _test_resetOrgRefresh,
  catchUpTargets,
  notePolledClubSetVersion,
  noteSnapshotClubSetVersion,
  parseClubSetVersion,
  parseLiveSince,
  refreshIfClubSetChanged,
  requestOrgRefresh,
  setOrgRefresher,
} from "./org-refresh.js";

beforeEach(() => {
  _test_resetOrgRefresh();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A refresher that behaves like index.ts: on success the snapshot's version is the server's. */
function refresherReturning(version: () => string | null) {
  const fn = vi.fn(async () => {
    noteSnapshotClubSetVersion(version());
  });
  setOrgRefresher(fn);
  return fn;
}

describe("parseClubSetVersion", () => {
  it("reads the stamp from an /orgs or a platform-jobs body", () => {
    expect(parseClubSetVersion({ orgs: [], clubSetVersion: "abc123" })).toBe("abc123");
    expect(parseClubSetVersion({ jobs: [], clubSetVersion: "abc123" })).toBe("abc123");
  });

  it("an OLDER server sends none: null, and so does anything that is not a non-empty string", () => {
    for (const body of [{ orgs: [] }, { jobs: [] }, null, undefined, "x", { clubSetVersion: "" }, { clubSetVersion: 7 }, { clubSetVersion: null }]) {
      expect(parseClubSetVersion(body)).toBeNull();
    }
  });
});

describe("refreshIfClubSetChanged: the trigger", () => {
  it("the stamp is the one this snapshot was read at: ONE comparison, no refresh", async () => {
    const refresh = refresherReturning(() => "v1");
    noteSnapshotClubSetVersion("v1");
    notePolledClubSetVersion("v1");
    for (let tick = 0; tick < 20; tick++) expect(await refreshIfClubSetChanged()).toBe("unchanged");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("the stamp changed (a club went live): the Pi refreshes at once, and then it is quiet again", async () => {
    let server = "v1";
    const refresh = refresherReturning(() => server);
    noteSnapshotClubSetVersion("v1");
    server = "v2";
    notePolledClubSetVersion("v2");
    expect(await refreshIfClubSetChanged()).toBe("refreshed");
    expect(refresh).toHaveBeenCalledTimes(1);
    for (let tick = 0; tick < 10; tick++) expect(await refreshIfClubSetChanged()).toBe("unchanged");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("it changes back the other way too (a club suspended or paused): the same trigger", async () => {
    let server = "v2";
    const refresh = refresherReturning(() => server);
    noteSnapshotClubSetVersion("v2");
    server = "v3";
    notePolledClubSetVersion("v3");
    expect(await refreshIfClubSetChanged()).toBe("refreshed");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("an OLDER SERVER (no stamp on the poll): nothing at all, ever", async () => {
    const refresh = refresherReturning(() => null);
    noteSnapshotClubSetVersion(null);
    for (const polled of [undefined, null, "", 7]) {
      notePolledClubSetVersion(polled);
      expect(await refreshIfClubSetChanged()).toBe("no-stamp");
    }
    expect(refresh).not.toHaveBeenCalled();
  });

  it("the poll has a stamp but /orgs gave none (a server mid-deploy): no refresh, so it can never loop", async () => {
    const refresh = refresherReturning(() => null);
    noteSnapshotClubSetVersion(null);
    notePolledClubSetVersion("v2");
    for (let tick = 0; tick < 10; tick++) expect(await refreshIfClubSetChanged()).toBe("no-stamp");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a FAILED refresh is tried again on the next tick, once per tick, and stops the moment one works", async () => {
    let server = "v2";
    let fail = true;
    const refresh = vi.fn(async () => {
      if (fail) throw new Error("ECONNREFUSED");
      noteSnapshotClubSetVersion(server);
    });
    setOrgRefresher(refresh);
    noteSnapshotClubSetVersion("v1");
    notePolledClubSetVersion("v2");
    expect(await refreshIfClubSetChanged()).toBe("failed");
    expect(await refreshIfClubSetChanged()).toBe("failed");
    expect(refresh).toHaveBeenCalledTimes(2); // one per tick, never more
    fail = false;
    server = "v2";
    expect(await refreshIfClubSetChanged()).toBe("refreshed");
    expect(await refreshIfClubSetChanged()).toBe("unchanged");
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("NO STORM: a refresh that worked but still does not match the polled stamp is not repeated for that stamp", async () => {
    // Two server instances that disagree, say. Without this the Pi would
    // re-read /orgs on every tick for ever.
    const refresh = refresherReturning(() => "v1-as-orgs-sees-it");
    noteSnapshotClubSetVersion("v1");
    notePolledClubSetVersion("v2");
    expect(await refreshIfClubSetChanged()).toBe("refreshed");
    for (let tick = 0; tick < 10; tick++) expect(await refreshIfClubSetChanged()).toBe("already-refreshed");
    expect(refresh).toHaveBeenCalledTimes(1);
    // A NEW stamp is a new change: one more refresh, and only one.
    notePolledClubSetVersion("v3");
    expect(await refreshIfClubSetChanged()).toBe("refreshed");
    expect(await refreshIfClubSetChanged()).toBe("already-refreshed");
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("a refresh that hangs does not hold the tick for ever, and is not started a second time while it runs", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            noteSnapshotClubSetVersion("v2");
            resolve();
          };
        }),
    );
    setOrgRefresher(refresh);
    noteSnapshotClubSetVersion("v1");
    notePolledClubSetVersion("v2");
    const first = refreshIfClubSetChanged();
    await vi.advanceTimersByTimeAsync(CLUB_SET_REFRESH_TIMEOUT_MS + 1);
    expect(await first).toBe("timed-out");
    // The next tick: the same refresh is still running, so it is waited on, not doubled.
    const second = refreshIfClubSetChanged();
    await vi.advanceTimersByTimeAsync(10);
    finish();
    await vi.advanceTimersByTimeAsync(10);
    expect(await second).toBe("refreshed");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await refreshIfClubSetChanged()).toBe("unchanged");
  });

  it("the periodic refresh keeps the snapshot's stamp current too, so it never causes a second one", async () => {
    let server = "v1";
    const refresh = refresherReturning(() => server);
    noteSnapshotClubSetVersion("v1");
    server = "v2";
    await requestOrgRefresh("periodic"); // the 5-minute backstop got there first
    notePolledClubSetVersion("v2");
    expect(await refreshIfClubSetChanged()).toBe("unchanged");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("never throws, whatever the refresher does", async () => {
    setOrgRefresher(() => {
      throw new Error("sync throw");
    });
    noteSnapshotClubSetVersion("v1");
    notePolledClubSetVersion("v2");
    await expect(refreshIfClubSetChanged()).resolves.toBe("failed");
  });

  it("with no refresher wired (shadow mode, tests) it does nothing", async () => {
    noteSnapshotClubSetVersion("v1");
    notePolledClubSetVersion("v2");
    expect(await refreshIfClubSetChanged()).toBe("no-stamp");
  });

  it("LOGS: says that it refreshed, never a stamp's content, a group or a name", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    refresherReturning(() => "v2-secret-hash");
    noteSnapshotClubSetVersion("v1-secret-hash");
    notePolledClubSetVersion("v2-secret-hash");
    await refreshIfClubSetChanged();
    expect(lines.join("\n")).toContain("[org-refresh]");
    expect(lines.join("\n")).not.toContain("secret-hash");
  });
});

describe("parseLiveSince: when each club's group went live", () => {
  it("reads `liveAt` per club group, as milliseconds", () => {
    const since = parseLiveSince({
      orgs: [
        { whatsappGroupId: "a@g.us", liveAt: "2026-10-13T12:00:00.000Z" },
        { whatsappGroupId: "b@g.us", liveAt: null },
        { whatsappGroupId: "c@g.us" },
      ],
    });
    expect([...since]).toEqual([["a@g.us", Date.parse("2026-10-13T12:00:00.000Z")]]);
  });

  it("an older server, garbage, or an unreadable date: no entry, so nothing is caught up", () => {
    expect(parseLiveSince({ orgs: [{ whatsappGroupId: "a@g.us" }] }).size).toBe(0);
    expect(parseLiveSince({ orgs: [{ whatsappGroupId: "a@g.us", liveAt: "soon" }, { liveAt: "2026-10-13T12:00:00Z" }, 7] }).size).toBe(0);
    expect(parseLiveSince(null).size).toBe(0);
    expect(parseLiveSince({ orgs: "x" }).size).toBe(0);
  });
});

describe("catchUpTargets: which newly monitored groups get their missed messages re-read", () => {
  const NOW = Date.parse("2026-10-13T12:05:00Z");
  const org = (groupId: string) => ({ groupId, orgName: "a name that is never logged" });
  const targets = (...a: Parameters<typeof catchUpTargets>) => catchUpTargets(...a).targets;

  it("a club that went live a moment ago: its group, from the instant it went live", () => {
    const liveAt = NOW - 40_000;
    expect(catchUpTargets([org("a@g.us")], new Map([["a@g.us", liveAt]]), NOW)).toEqual({
      targets: [{ groupId: "a@g.us", sinceMs: liveAt }],
      skipped: [],
    });
  });

  it("a group that became a club's with NO go-live time (an older server, a club that was never held, an unmuted club): nothing, as today, and it says why", () => {
    expect(catchUpTargets([org("a@g.us")], new Map(), NOW)).toEqual({ targets: [], skipped: [{ groupId: "a@g.us", reason: "no-live-at" }] });
  });

  it("a club that went live long ago and is back from a pause or a mute: nothing. Its group was deliberately not listened to", () => {
    expect(CATCH_UP_MAX_AGE_MS).toBe(15 * 60 * 1000);
    const old = NOW - CATCH_UP_MAX_AGE_MS - 1;
    expect(catchUpTargets([org("a@g.us")], new Map([["a@g.us", old]]), NOW)).toEqual({ targets: [], skipped: [{ groupId: "a@g.us", reason: "too-old" }] });
    const edge = NOW - CATCH_UP_MAX_AGE_MS;
    expect(targets([org("a@g.us")], new Map([["a@g.us", edge]]), NOW)).toHaveLength(1);
  });

  // PR #250 review, fix 3. `liveAt` is the SERVER's clock. A Pi two seconds
  // behind it saw a go-live "in the future" and silently caught up on nothing.
  it("THE PI'S CLOCK IS BEHIND THE SERVER'S: a go-live up to two minutes 'in the future' is caught up, from the server's own time", () => {
    expect(CATCH_UP_CLOCK_SKEW_MS).toBe(2 * 60 * 1000);
    for (const ahead of [1, 2_000, 60_000, CATCH_UP_CLOCK_SKEW_MS]) {
      const liveAt = NOW + ahead;
      // The floor stays the server's liveAt: nothing is moved to the Pi's clock.
      expect(targets([org("a@g.us")], new Map([["a@g.us", liveAt]]), NOW)).toEqual([{ groupId: "a@g.us", sinceMs: liveAt }]);
    }
  });

  it("further ahead than that is not a clock that is slightly out: nothing, and it says why", () => {
    const liveAt = NOW + CATCH_UP_CLOCK_SKEW_MS + 1;
    expect(catchUpTargets([org("a@g.us")], new Map([["a@g.us", liveAt]]), NOW)).toEqual({ targets: [], skipped: [{ groupId: "a@g.us", reason: "clock-ahead" }] });
  });

  it("only the groups that are NEW in this refresh: a club already monitored is never re-read by this", () => {
    const since = new Map([
      ["old@g.us", NOW - 10_000],
      ["new@g.us", NOW - 10_000],
    ]);
    expect(targets([org("new@g.us")], since, NOW)).toEqual([{ groupId: "new@g.us", sinceMs: NOW - 10_000 }]);
    expect(catchUpTargets([], since, NOW)).toEqual({ targets: [], skipped: [] });
  });
});

// PR #250 review, fix 8. Two server instances that alternate stamps (a flag
// that differs mid-rollout) would have the Pi re-read /orgs on every tick.
// A refresh makes no WhatsApp call, so it is only server load: capped anyway.
describe("refreshIfClubSetChanged: the back-off", () => {
  const T0 = Date.parse("2026-10-13T12:00:00Z");
  const TICK = 30_000;

  /** A server whose /orgs always answers with a stamp the poll then contradicts. */
  function flapping() {
    let n = 0;
    const refresh = vi.fn(async () => {
      noteSnapshotClubSetVersion(`orgs-${++n}`);
    });
    setOrgRefresher(refresh);
    noteSnapshotClubSetVersion("orgs-0");
    return { refresh, tick: async (i: number) => {
      notePolledClubSetVersion(`poll-${i}`);
      return refreshIfClubSetChanged(T0 + i * TICK);
    } };
  }

  it("five ticks in a row that each needed a refresh: the sixth backs off, to one stamp-triggered refresh per two minutes", async () => {
    expect([CLUB_SET_BACKOFF_AFTER_TICKS, CLUB_SET_BACKOFF_MS]).toEqual([5, 2 * 60 * 1000]);
    const { refresh, tick } = flapping();
    for (let i = 1; i <= 5; i++) expect(await tick(i)).toBe("refreshed");
    expect(refresh).toHaveBeenCalledTimes(5);
    // Ticks 6 to 8 are inside two minutes of the last refresh (tick 5).
    for (let i = 6; i <= 8; i++) expect(await tick(i)).toBe("backed-off");
    expect(refresh).toHaveBeenCalledTimes(5);
    // Tick 9 is two minutes after tick 5: one refresh, then quiet again.
    expect(await tick(9)).toBe("refreshed");
    for (let i = 10; i <= 12; i++) expect(await tick(i)).toBe("backed-off");
    expect(await tick(13)).toBe("refreshed");
    expect(refresh).toHaveBeenCalledTimes(7);
  });

  it("says so ONCE when the back-off starts, not on every held tick", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    const { tick } = flapping();
    for (let i = 1; i <= 12; i++) await tick(i);
    expect(lines.filter((l) => l.includes("backing off"))).toHaveLength(1);
  });

  it("a tick that sees an UNCHANGED stamp ends it: the next change is refreshed at once", async () => {
    const { refresh, tick } = flapping();
    for (let i = 1; i <= 7; i++) await tick(i);
    expect(await tick(8)).toBe("backed-off");
    // The servers agree again.
    noteSnapshotClubSetVersion("settled");
    notePolledClubSetVersion("settled");
    expect(await refreshIfClubSetChanged(T0 + 9 * TICK)).toBe("unchanged");
    const before = refresh.mock.calls.length;
    expect(await tick(10)).toBe("refreshed");
    expect(refresh).toHaveBeenCalledTimes(before + 1);
  });

  it("four changes in a row, then quiet, never backs off: an ordinary busy few minutes is not a storm", async () => {
    const { tick } = flapping();
    for (let i = 1; i <= 4; i++) expect(await tick(i)).toBe("refreshed");
    noteSnapshotClubSetVersion("settled");
    notePolledClubSetVersion("settled");
    expect(await refreshIfClubSetChanged(T0 + 5 * TICK)).toBe("unchanged");
    for (let i = 6; i <= 9; i++) expect(await tick(i)).toBe("refreshed");
  });
});
