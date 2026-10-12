/**
 * GO-LIVE SLICE S6: the ONE reminder, 24 hours after the setup DM was due,
 * and the ONE note to the owner at 72 hours. Against a mocked database;
 * the real-Postgres proofs (concurrent cron runs, the cancel, the claim)
 * are in e2e/api/setup-followups.spec.ts and
 * e2e/helpers/setup-followups-lib-tests.ts. No model anywhere.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  org: null as Row | null,
  connect: null as Row | null,
  knownUser: true,
  setupDm: null as Row | null,
  jobs: [] as Row[],
  keys: [] as Row[],
  alerts: [] as Row[],
  raw: [] as string[],
  candidates: [] as Row[],
  findManyArgs: [] as Row[],
}));

const dbMock = vi.hoisted(() => {
  const orgMatches = (w: Row): boolean => {
    const o = state.org;
    if (!o) return false;
    for (const [k, v] of Object.entries(w)) {
      if (k === "id") {
        if (o.id !== v) return false;
      } else if (v === null) {
        if (o[k] !== null && o[k] !== undefined) return false;
      } else if (v && typeof v === "object" && "lte" in (v as Row)) {
        const have = o[k] as Date | null;
        if (!have || have.getTime() > ((v as Row).lte as Date).getTime()) return false;
      } else if (o[k] !== v) return false;
    }
    return true;
  };
  const m = {
    organisation: {
      findFirst: vi.fn(async (args: { where: Row }) => (orgMatches(args.where) ? { ...state.org } : null)),
      findMany: vi.fn(async (args: Row) => {
        state.findManyArgs.push(args);
        return state.candidates;
      }),
    },
    clubConnect: { findFirst: vi.fn(async () => (state.connect ? { ...state.connect } : null)) },
    user: { findFirst: vi.fn(async () => (state.knownUser ? { id: "u-ali" } : null)) },
    platformJob: {
      findFirst: vi.fn(async (args: { where: Row }) => {
        // The owner DM's own dedupe looks for its (purpose, refId, phone).
        if (args.where.purpose !== "setup-ask") {
          return state.jobs.find((j) => j.purpose === args.where.purpose && j.refId === args.where.refId && j.phone === args.where.phone) ?? null;
        }
        return state.setupDm ? { ...state.setupDm } : null;
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        state.jobs.push(data);
        return { id: `pj-${state.jobs.length}`, ...data };
      }),
    },
    sentNotification: {
      findUnique: vi.fn(async ({ where }: { where: Row }) => state.keys.find((k) => k.key === where.key) ?? null),
      findMany: vi.fn(async ({ where }: { where: { key: { in: string[] } } }) => state.keys.filter((k) => where.key.in.includes(String(k.key)))),
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        let count = 0;
        for (const d of data) {
          if (state.keys.some((k) => k.key === d.key)) continue;
          state.keys.push(d);
          count++;
        }
        return { count };
      }),
      deleteMany: vi.fn(async ({ where }: { where: Row }) => {
        const before = state.keys.length;
        state.keys = state.keys.filter((k) => k.key !== where.key);
        return { count: before - state.keys.length };
      }),
    },
    opsAlert: {
      findFirst: vi.fn(async ({ where }: { where: Row }) => state.alerts.find((a) => a.orgId === where.orgId && a.dedupeKey === where.dedupeKey) ?? null),
      create: vi.fn(async ({ data }: { data: Row }) => {
        state.alerts.push(data);
        return data;
      }),
    },
    $executeRaw: vi.fn(async (q: TemplateStringsArray) => {
      state.raw.push(q.join("?"));
      return 1;
    }),
    $transaction: vi.fn(),
  };
  return m;
});
vi.mock("@/lib/db", () => ({ db: dbMock }));

const adminLinkMock = vi.hoisted(() =>
  vi.fn(async (a: { userId: string; orgId: string; nextPath: string; ttlSeconds?: number }) => `https://mt.link${a.nextPath}`),
);
vi.mock("@/lib/admin-link", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-link")>()),
  buildAdminLink: adminLinkMock,
}));

import { runSetupReminderSweep, sendSetupReminder } from "../club-setup-reminder";
import { noteStuckClub, runSetupStuckSweep } from "../club-setup-stuck";
import { SETUP_ALERT_KIND } from "../ops-alerts";

const HOUR = 60 * 60 * 1000;
/** The setup DM was due at 12:00 London on Monday 12 October (BST). */
const ASKED = new Date("2026-10-12T11:00:00Z");
const AT_24H = new Date(ASKED.getTime() + 24 * HOUR);
const APPROVED = new Date(ASKED.getTime() - 10 * 60 * 1000);
const AT_72H = new Date(APPROVED.getTime() + 72 * HOUR);

const heldOrg = (over: Row = {}): Row => ({
  id: "org-riverside",
  name: "Riverside FC",
  language: "en",
  approvalStatus: "approved",
  approvedAt: APPROVED,
  setupStage: "setting-up",
  setupAskedAt: ASKED,
  setupRemovedAt: null,
  ...over,
});

const ENV = process.env.SELF_JOIN_APPROVER_PHONES;
afterAll(() => {
  if (ENV === undefined) delete process.env.SELF_JOIN_APPROVER_PHONES;
  else process.env.SELF_JOIN_APPROVER_PHONES = ENV;
});

let logs: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXTAUTH_URL = "https://matchtime.ai";
  process.env.SELF_JOIN_APPROVER_PHONES = "447700900001";
  state.org = heldOrg();
  state.connect = { id: "cc-ali", userId: "u-ali", phone: "447700900123", groupSubject: "Riverside Tuesday 5s" };
  state.knownUser = true;
  state.setupDm = { status: "sent" };
  state.jobs = [];
  state.keys = [];
  state.alerts = [];
  state.raw = [];
  state.candidates = [];
  state.findManyArgs = [];
  dbMock.$transaction.mockImplementation(async (fn: (tx: typeof dbMock) => unknown) => fn(dbMock));
  logs = [];
  const keep = (...a: unknown[]) => void logs.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(" "));
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
  vi.spyOn(console, "warn").mockImplementation(keep);
});

describe("sendSetupReminder: when it goes", () => {
  it("24 hours after the setup DM was due, inside message hours: queued at once, with a fresh signed-in settings link", async () => {
    expect(await sendSetupReminder("org-riverside", AT_24H)).toEqual({ kind: "sent", sendAfter: null });
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]).toMatchObject({
      kind: "dm",
      phone: "447700900123",
      purpose: "setup-reminder",
      refId: "org-riverside:setup-reminder",
      status: "queued",
      sendAfter: null,
    });
    expect(state.jobs[0].text).toBe(
      'Just checking: Riverside FC is approved, but I\'m still quiet in "Riverside Tuesday 5s". Reply *GO* when you\'re ready and I\'ll introduce myself, or check the settings first: https://mt.link/admin/settings\nI won\'t remind you again.',
    );
    expect(adminLinkMock).toHaveBeenCalledTimes(1);
    expect(adminLinkMock.mock.calls[0][0]).toMatchObject({
      userId: "u-ali",
      orgId: "org-riverside",
      nextPath: "/admin/settings",
      ttlSeconds: 7 * 24 * 60 * 60,
    });
    expect(state.keys).toEqual([{ key: "org-org-riverside:setup-reminder:2026-10-12T11:00:00.000Z", kind: "setup-reminder" }]);
  });

  it("a minute before the 24 hours are up: nothing", async () => {
    expect(await sendSetupReminder("org-riverside", new Date(AT_24H.getTime() - 60_000))).toEqual({ kind: "not-due" });
    expect(state.jobs).toEqual([]);
    expect(state.keys).toEqual([]);
  });

  it("due outside message hours (a late cron run): queued for the next 09:00 London", async () => {
    // Asked at 22:50 London; the cron that finds it due runs at 23:05.
    state.org = heldOrg({ setupAskedAt: new Date("2026-10-12T21:50:00Z") });
    const r = await sendSetupReminder("org-riverside", new Date("2026-10-13T22:05:00Z"));
    expect(r).toEqual({ kind: "sent", sendAfter: new Date("2026-10-14T08:00:00Z") });
    expect(state.jobs[0].sendAfter).toEqual(new Date("2026-10-14T08:00:00Z"));
  });

  it("Turkish club: Turkish, asking for BAŞLA", async () => {
    state.org = heldOrg({ language: "tr" });
    await sendSetupReminder("org-riverside", AT_24H);
    expect(String(state.jobs[0].text)).toMatch(/^Küçük bir hatırlatma: Riverside FC onaylandı/);
    expect(String(state.jobs[0].text)).toContain("*BAŞLA*");
    expect(String(state.jobs[0].text)).toMatch(/Bir daha hatırlatmayacağım\.$/);
  });
});

describe("sendSetupReminder: once, and only when it is still true", () => {
  it("never twice: the second run finds the claim and queues nothing", async () => {
    await sendSetupReminder("org-riverside", AT_24H);
    expect(await sendSetupReminder("org-riverside", new Date(AT_24H.getTime() + 15 * 60_000))).toEqual({ kind: "already" });
    expect(await sendSetupReminder("org-riverside", new Date(AT_24H.getTime() + 30 * 24 * HOUR))).toEqual({ kind: "already" });
    expect(state.jobs).toHaveLength(1);
  });

  it("the claim and the job are one transaction, taken under the club's row lock", async () => {
    await sendSetupReminder("org-riverside", AT_24H);
    expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
    expect(state.raw.filter((q) => /FROM "Organisation" WHERE "id" = \? FOR UPDATE/.test(q))).toHaveLength(1);
  });

  it("a club that went live, was suspended, or was never asked is not due", async () => {
    for (const over of [{ setupStage: "live" }, { approvalStatus: "suspended" }, { setupAskedAt: null }]) {
      state.org = heldOrg(over);
      expect(await sendSetupReminder("org-riverside", AT_24H), JSON.stringify(over)).toEqual({ kind: "not-due" });
    }
    expect(state.jobs).toEqual([]);
    expect(state.keys).toEqual([]);
  });

  it("MatchTime was removed from the group: not sent, and NOT settled (an add back makes it due again)", async () => {
    state.org = heldOrg({ setupRemovedAt: new Date(ASKED.getTime() + HOUR) });
    expect(await sendSetupReminder("org-riverside", AT_24H)).toEqual({ kind: "not-due" });
    expect(state.jobs).toEqual([]);
    expect(state.keys).toEqual([]);
  });

  it("the club went live between the first read and the claim: nothing is queued or claimed", async () => {
    dbMock.$executeRaw.mockImplementationOnce(async () => {
      // The lock is granted AFTER the go-live committed.
      state.org = heldOrg({ setupStage: "live" });
      return 1;
    });
    expect(await sendSetupReminder("org-riverside", AT_24H)).toEqual({ kind: "not-due" });
    expect(state.jobs).toEqual([]);
    expect(state.keys).toEqual([]);
  });

  it("the setup DM was never sent (refused: no job; cancelled or failed): no reminder, ever", async () => {
    for (const dm of [null, { status: "failed" }]) {
      state.setupDm = dm;
      state.keys = [];
      expect(await sendSetupReminder("org-riverside", AT_24H)).toEqual({ kind: "never", reason: "setup-dm-not-sent" });
      expect(state.keys).toEqual([{ key: "org-org-riverside:setup-reminder:2026-10-12T11:00:00.000Z", kind: "setup-reminder-skipped" }]);
      // Settled: a later sweep does not look again, even if a job appeared.
      state.setupDm = { status: "sent" };
      expect(await sendSetupReminder("org-riverside", new Date(AT_24H.getTime() + HOUR))).toEqual({ kind: "already" });
    }
    expect(state.jobs).toEqual([]);
  });

  it("the setup DM is still waiting to go (the Pi has been down): no reminder before it; looked at again later", async () => {
    for (const status of ["queued", "claimed"]) {
      state.setupDm = { status };
      expect(await sendSetupReminder("org-riverside", AT_24H)).toEqual({ kind: "waiting-for-setup-dm" });
    }
    expect(state.jobs).toEqual([]);
    expect(state.keys).toEqual([]);
    state.setupDm = { status: "sent" };
    expect(await sendSetupReminder("org-riverside", new Date(AT_24H.getTime() + HOUR))).toMatchObject({ kind: "sent" });
  });

  it("the organiser's number is no longer a MatchTime user's: not sent, settled, only a code is logged", async () => {
    state.knownUser = false;
    expect(await sendSetupReminder("org-riverside", AT_24H)).toEqual({ kind: "never", reason: "number-not-known" });
    expect(state.jobs).toEqual([]);
    expect(state.keys).toHaveLength(1);
    expect(await sendSetupReminder("org-riverside", new Date(AT_24H.getTime() + HOUR))).toEqual({ kind: "already" });
  });

  it("no organiser on record: settled, nothing sent", async () => {
    state.connect = null;
    expect(await sendSetupReminder("org-riverside", AT_24H)).toEqual({ kind: "never", reason: "no-organiser" });
    expect(state.keys).toEqual([{ key: "org-org-riverside:setup-reminder:2026-10-12T11:00:00.000Z", kind: "setup-reminder-skipped" }]);
  });

  it("logs carry the club's id and codes only: no name, number, text or link", async () => {
    await sendSetupReminder("org-riverside", AT_24H);
    state.knownUser = false;
    state.keys = [];
    await sendSetupReminder("org-riverside", AT_24H);
    const all = logs.join("\n");
    expect(all).toContain("org-riverside");
    expect(all).not.toMatch(/Riverside|447700900123|mt\.link|Just checking|Tuesday 5s/);
  });
});

describe("removed from the group, added back, and sent a NEW setup DM: the reminder runs from the new one", () => {
  const NEW_ASKED = new Date(ASKED.getTime() + 30 * HOUR);

  it("the first setup DM was cancelled before it went (never reminded); the new one is reminded 24 hours after ITS due time", async () => {
    // Before the removal: nothing to remind about, settled for THAT setup DM.
    state.setupDm = { status: "failed" };
    expect(await sendSetupReminder("org-riverside", AT_24H)).toEqual({ kind: "never", reason: "setup-dm-not-sent" });
    // Added back: a new setup DM, with a new due time, and it was sent.
    state.org = heldOrg({ setupAskedAt: NEW_ASKED });
    state.setupDm = { status: "sent" };
    // Not on the OLD clock (24 hours after the cancelled one is long past) ...
    expect(await sendSetupReminder("org-riverside", new Date(NEW_ASKED.getTime() + 23 * HOUR))).toEqual({ kind: "not-due" });
    // ... on the new one.
    expect(await sendSetupReminder("org-riverside", new Date(NEW_ASKED.getTime() + 24 * HOUR))).toMatchObject({ kind: "sent" });
    expect(state.jobs).toHaveLength(1);
    // And once for it.
    expect(await sendSetupReminder("org-riverside", new Date(NEW_ASKED.getTime() + 48 * HOUR))).toEqual({ kind: "already" });
  });

  it("a reminder that already went for the first setup DM does not use up the second one's", async () => {
    await sendSetupReminder("org-riverside", AT_24H);
    state.org = heldOrg({ setupAskedAt: NEW_ASKED });
    expect(await sendSetupReminder("org-riverside", new Date(NEW_ASKED.getTime() + 24 * HOUR))).toMatchObject({ kind: "sent" });
    expect(state.jobs).toHaveLength(2);
    expect(state.keys.map((k) => k.key)).toEqual([
      "org-org-riverside:setup-reminder:2026-10-12T11:00:00.000Z",
      `org-org-riverside:setup-reminder:${NEW_ASKED.toISOString()}`,
    ]);
  });

  it("the due time changed between the first read and the claim (a removal and re-add in between): nothing is queued on the stale one", async () => {
    dbMock.$executeRaw.mockImplementationOnce(async () => {
      state.org = heldOrg({ setupAskedAt: new Date(ASKED.getTime() - HOUR) });
      return 1;
    });
    expect(await sendSetupReminder("org-riverside", AT_24H)).toEqual({ kind: "not-due" });
    expect(state.jobs).toEqual([]);
    expect(state.keys).toEqual([]);
  });
});

describe("runSetupReminderSweep", () => {
  it("asks for setting-up clubs, still in their group, whose setup DM was due 24 hours ago or more", async () => {
    await runSetupReminderSweep(AT_24H);
    expect(state.findManyArgs[0].where).toEqual({
      approvalStatus: "approved",
      setupStage: "setting-up",
      setupRemovedAt: null,
      setupAskedAt: { lte: ASKED },
    });
  });

  it("skips clubs already settled without reading them again, and sends the rest", async () => {
    state.candidates = [
      { id: "org-done", setupAskedAt: ASKED },
      { id: "org-riverside", setupAskedAt: ASKED },
    ];
    state.keys = [{ key: "org-org-done:setup-reminder:2026-10-12T11:00:00.000Z", kind: "setup-reminder" }];
    expect(await runSetupReminderSweep(AT_24H)).toEqual({ considered: 1, sent: 1 });
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0].refId).toBe("org-riverside:setup-reminder");
  });

  it("with no club setting up it is one query and nothing else", async () => {
    expect(await runSetupReminderSweep(AT_24H)).toEqual({ considered: 0, sent: 0 });
    expect(dbMock.organisation.findMany).toHaveBeenCalledTimes(1);
    expect(dbMock.sentNotification.findMany).not.toHaveBeenCalled();
    expect(dbMock.platformJob.create).not.toHaveBeenCalled();
  });

  it("one club failing does not stop the others", async () => {
    state.candidates = [
      { id: "org-broken", setupAskedAt: ASKED },
      { id: "org-riverside", setupAskedAt: ASKED },
    ];
    const real = dbMock.organisation.findFirst.getMockImplementation()!;
    dbMock.organisation.findFirst.mockImplementation(async (args: { where: Row }) => {
      if (args.where.id === "org-broken") throw new Error("connection reset");
      return real(args);
    });
    expect(await runSetupReminderSweep(AT_24H)).toEqual({ considered: 2, sent: 1 });
    dbMock.organisation.findFirst.mockImplementation(real);
  });
});

describe("noteStuckClub: the ONE note to the owner, 72 hours after approval", () => {
  it("queues the owner's DM with the clubs page, and records one ops event", async () => {
    const r = await noteStuckClub("org-riverside", AT_72H);
    expect(r).toEqual({ kind: "noted", queued: 1 });
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]).toMatchObject({
      kind: "dm",
      phone: "447700900001",
      purpose: "owner-setup-stuck",
      refId: "org-riverside:setup-stuck",
      status: "queued",
      // 12:50 London: not quiet hours.
      sendAfter: null,
    });
    expect(state.jobs[0].text).toBe(
      "Riverside FC has been approved for 3 days and its organiser has not gone live. MatchTime is still silent in its group. You can take it live from the clubs page: https://matchtime.ai/admin/clubs",
    );
    expect(state.alerts).toHaveLength(1);
    expect(state.alerts[0]).toMatchObject({
      orgId: "org-riverside",
      kind: SETUP_ALERT_KIND,
      severity: "warning",
      title: "Still setting up after 3 days",
      dedupeKey: "setup-stuck-72h",
    });
    expect(String(state.alerts[0].detail)).toContain("its organiser has not gone live");
  });

  it("a minute before the 72 hours are up: nothing", async () => {
    expect(await noteStuckClub("org-riverside", new Date(AT_72H.getTime() - 60_000))).toEqual({ kind: "not-due" });
    expect(state.jobs).toEqual([]);
    expect(state.alerts).toEqual([]);
  });

  it("once per club: a second run, and a run a month later, add nothing", async () => {
    await noteStuckClub("org-riverside", AT_72H);
    expect(await noteStuckClub("org-riverside", new Date(AT_72H.getTime() + 15 * 60_000))).toEqual({ kind: "already" });
    expect(await noteStuckClub("org-riverside", new Date(AT_72H.getTime() + 30 * 24 * HOUR))).toEqual({ kind: "already" });
    expect(state.jobs).toHaveLength(1);
    expect(state.alerts).toHaveLength(1);
  });

  it("in the owner's quiet hours it waits for 09:00 London", async () => {
    // Approved at 23:30 London; 72 hours on is 23:30 London.
    state.org = heldOrg({ approvedAt: new Date("2026-10-12T22:30:00Z") });
    await noteStuckClub("org-riverside", new Date("2026-10-15T22:30:00Z"));
    expect(state.jobs[0].sendAfter).toEqual(new Date("2026-10-16T08:00:00Z"));
  });

  it("a club that went live or was suspended is not noted", async () => {
    for (const over of [{ setupStage: "live" }, { approvalStatus: "suspended" }]) {
      state.org = heldOrg(over);
      expect(await noteStuckClub("org-riverside", AT_72H)).toEqual({ kind: "not-due" });
    }
    expect(state.jobs).toEqual([]);
    expect(state.alerts).toEqual([]);
  });

  it("MatchTime was removed from its group: NO owner DM; one ops event that says so", async () => {
    state.org = heldOrg({ setupRemovedAt: new Date(APPROVED.getTime() + HOUR) });
    expect(await noteStuckClub("org-riverside", AT_72H)).toEqual({ kind: "removed" });
    expect(await noteStuckClub("org-riverside", new Date(AT_72H.getTime() + HOUR))).toEqual({ kind: "removed" });
    expect(state.jobs).toEqual([]);
    expect(state.alerts).toHaveLength(1);
    expect(state.alerts[0]).toMatchObject({ dedupeKey: "setup-stuck-72h-removed", title: "Still setting up after 3 days" });
    expect(String(state.alerts[0].detail)).toContain("was removed from its group");
    // Added back and still setting up: the owner is told then, once.
    state.org = heldOrg();
    expect(await noteStuckClub("org-riverside", new Date(AT_72H.getTime() + 2 * HOUR))).toEqual({ kind: "noted", queued: 1 });
    expect(state.jobs).toHaveLength(1);
  });

  it("no approver phone configured: the ops event stands and nothing is queued", async () => {
    delete process.env.SELF_JOIN_APPROVER_PHONES;
    expect(await noteStuckClub("org-riverside", AT_72H)).toEqual({ kind: "noted", queued: 0 });
    expect(state.jobs).toEqual([]);
    expect(state.alerts).toHaveLength(1);
  });

  it("a database failure while queueing releases the claim, so the next sweep tries again and still sends one", async () => {
    dbMock.platformJob.create.mockRejectedValueOnce(new Error("connection reset"));
    await expect(noteStuckClub("org-riverside", AT_72H)).rejects.toThrow("connection reset");
    expect(state.keys).toEqual([]);
    expect(await noteStuckClub("org-riverside", new Date(AT_72H.getTime() + 15 * 60_000))).toEqual({ kind: "noted", queued: 1 });
    expect(state.jobs).toHaveLength(1);
    expect(state.alerts).toHaveLength(1);
  });

  it("logs carry the club's id only: never its name or the owner's number", async () => {
    await noteStuckClub("org-riverside", AT_72H);
    const all = logs.join("\n");
    expect(all).toContain("org-riverside");
    expect(all).not.toMatch(/Riverside FC|447700900001|matchtime\.ai/);
  });
});

describe("runSetupStuckSweep", () => {
  it("asks for setting-up clubs approved 72 hours ago or more", async () => {
    await runSetupStuckSweep(AT_72H);
    expect(state.findManyArgs[0].where).toEqual({
      approvalStatus: "approved",
      setupStage: "setting-up",
      approvedAt: { lte: APPROVED },
    });
  });

  it("skips clubs already noted, and notes the rest", async () => {
    state.candidates = [{ id: "org-done" }, { id: "org-riverside" }];
    state.keys = [{ key: "org-org-done:setup-stuck-72h", kind: "setup-stuck" }];
    expect(await runSetupStuckSweep(AT_72H)).toEqual({ considered: 1, noted: 1 });
    expect(state.jobs).toHaveLength(1);
  });

  it("with no club setting up it is one query and nothing else", async () => {
    expect(await runSetupStuckSweep(AT_72H)).toEqual({ considered: 0, noted: 0 });
    expect(dbMock.organisation.findMany).toHaveBeenCalledTimes(1);
    expect(dbMock.sentNotification.findMany).not.toHaveBeenCalled();
  });
});
