/**
 * GO-LIVE SLICE S3: the organiser's ONE setup DM, the database half,
 * against a mocked database (go-live plan 2.4). No model anywhere: the SDK
 * is mocked and its calls counted. The real-Postgres checks (two runs
 * racing for one DM) are in e2e/api/setup-hold-approval.spec.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdkCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: () => {
        sdkCalls.n++;
        throw new Error("no model in the setup DM path");
      },
    };
  },
}));

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  org: null as Row | null,
  connect: null as Row | null,
  knownUser: true,
  jobs: [] as Row[],
  raw: [] as string[],
  dueOrgs: [] as Row[],
  findManyArgs: [] as Row[],
  findFirstArgs: [] as Row[],
  orgUpdates: [] as Array<{ where: Row; data: Row }>,
}));

const dbMock = vi.hoisted(() => {
  const m = {
    organisation: {
      findFirst: vi.fn(async (args: Row) => {
        state.findFirstArgs.push(args);
        const o = state.org;
        if (!o) return null;
        const w = args.where as Row;
        // The "setup DM is due" rule: approved, setting up, never asked, not removed.
        if (w.setupAskedAt === null && o.setupAskedAt !== null) return null;
        if (w.setupRemovedAt === null && o.setupRemovedAt !== null) return null;
        if (w.approvalStatus && o.approvalStatus !== w.approvalStatus) return null;
        if (w.setupStage && o.setupStage !== w.setupStage) return null;
        return { ...o };
      }),
      findMany: vi.fn(async (args: Row) => {
        state.findManyArgs.push(args);
        return state.dueOrgs;
      }),
      updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
        state.orgUpdates.push(args);
        const o = state.org!;
        for (const [k, v] of Object.entries(args.where)) {
          if (k === "id") continue;
          if (o[k] !== v) return { count: 0 };
        }
        Object.assign(o, args.data);
        return { count: 1 };
      }),
    },
    clubConnect: { findFirst: vi.fn(async () => (state.connect ? { ...state.connect } : null)) },
    user: { findFirst: vi.fn(async () => (state.knownUser ? { id: "u-ali" } : null)) },
    platformJob: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        state.jobs.push(data);
        return { id: `pj-${state.jobs.length}`, ...data };
      }),
    },
    $executeRaw: vi.fn(async (q: TemplateStringsArray) => {
      state.raw.push(q.join("?"));
      return 1;
    }),
    $queryRaw: vi.fn(async (q: TemplateStringsArray) => {
      state.raw.push(q.join("?"));
      return [];
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

const learnMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/setup-learning/run", () => ({ learnClubSetup: learnMock }));

import { SETUP_ASK_DM_PURPOSE, runSetupAfterApproval, runSetupDmSweep, sendSetupDm, setupAskRefId } from "../club-setup-dm";

const DAY = new Date("2026-10-12T11:00:00Z"); // 12:00 London
const NIGHT = new Date("2026-10-12T22:30:00Z"); // 23:30 London (BST)
const NINE_NEXT = new Date("2026-10-13T08:00:00Z"); // 09:00 London

const heldOrg = (over: Row = {}): Row => ({
  id: "org-riverside",
  name: "Riverside FC",
  language: "en",
  approvalStatus: "approved",
  setupStage: "setting-up",
  setupAskedAt: null,
  setupRemovedAt: null,
  rollingSquadEnabled: false,
  benchPickMode: "first-come",
  squadMode: "weekly",
  setupLearning: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  sdkCalls.n = 0;
  process.env.NEXTAUTH_URL = "https://matchtime.ai";
  state.org = heldOrg();
  state.connect = { id: "cc-ali", userId: "u-ali", phone: "447700900123", groupSubject: "Riverside Tuesday 5s" };
  state.knownUser = true;
  state.jobs = [];
  state.raw = [];
  state.dueOrgs = [];
  state.findManyArgs = [];
  state.findFirstArgs = [];
  state.orgUpdates = [];
  dbMock.$transaction.mockImplementation(async (fn: (tx: typeof dbMock) => unknown) => fn(dbMock));
});

const learning = (status: string, over: Row = {}): Row => ({ status, applied: [], suggestions: [], noted: [], ...over });

describe("sendSetupDm: when it goes", () => {
  it("the reading is switched off: the DM goes at once, with no reading sentence", async () => {
    const r = await sendSetupDm("org-riverside", DAY, { learningEnabled: false });
    expect(r).toEqual({ kind: "sent", sendAfter: null });
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]).toMatchObject({
      kind: "dm",
      phone: "447700900123",
      purpose: SETUP_ASK_DM_PURPOSE,
      refId: "org-riverside:setup-ask",
      sendAfter: null,
      status: "queued",
    });
    const text = String(state.jobs[0].text);
    expect(text).toMatch(/^Good news: Riverside FC is approved\. I'm in "Riverside Tuesday 5s" and I'm staying quiet there/);
    expect(text).not.toContain("I read the recent messages");
    expect(text).toContain("Standard setup: ");
    expect(text).toContain("reply *GO* here");
    expect(text).toContain("https://mt.link/admin/settings");
    expect(text).toContain("https://mt.link/admin/activities");
    expect(text).toContain("https://mt.link/admin/players/ratings");
    expect(setupAskRefId("org-riverside")).toBe("org-riverside:setup-ask");
    expect(sdkCalls.n).toBe(0);
  });

  it("the reading is on and has not finished: nothing is sent, nothing is stamped", async () => {
    for (const row of [null, learning("running"), learning("deferred")]) {
      state.org = heldOrg({ setupLearning: row });
      expect(await sendSetupDm("org-riverside", DAY, { learningEnabled: true })).toEqual({ kind: "reading" });
    }
    expect(state.jobs).toEqual([]);
    expect(state.orgUpdates).toEqual([]);
  });

  it("each final reading outcome sends the DM", async () => {
    const applied = [{ key: "rollingSquad", from: false, to: true, evidence: ["Same lot as last week"] }];
    const cases: Array<[Row, RegExp]> = [
      [learning("applied", { applied }), /set MatchTime up the same way\.[\s\S]*Undo or change: https:\/\/mt\.link\/admin\/settings\?learned=rollingSquad#learned-setup/],
      [learning("nothing"), /found nothing that needs a setting changed, so MatchTime is on its standard setup\./],
      [learning("skipped", { reason: "too-few-messages" }), /I couldn't read your group's recent messages, so MatchTime is on its standard setup\./],
      [learning("failed", { reason: "model-error" }), /I couldn't read your group's recent messages, so MatchTime is on its standard setup\./],
    ];
    for (const [row, expected] of cases) {
      state.org = heldOrg({ setupLearning: row });
      state.jobs = [];
      expect(await sendSetupDm("org-riverside", DAY, { learningEnabled: true })).toMatchObject({ kind: "sent" });
      expect(state.jobs).toHaveLength(1);
      expect(String(state.jobs[0].text)).toMatch(expected);
    }
  });

  it("a final reading is reported even when the flag has been switched off since", async () => {
    state.org = heldOrg({ setupLearning: learning("nothing") });
    await sendSetupDm("org-riverside", DAY, { learningEnabled: false });
    expect(String(state.jobs[0].text)).toContain("found nothing that needs a setting changed");
  });

  it("speaks Turkish to a Turkish club", async () => {
    state.org = heldOrg({ language: "tr", setupLearning: learning("nothing") });
    await sendSetupDm("org-riverside", DAY, { learningEnabled: true });
    expect(String(state.jobs[0].text)).toMatch(/^Güzel haber: Riverside FC onaylandı\./);
    expect(String(state.jobs[0].text)).toContain("buraya *GO* yazın");
  });

  it("the organiser changed how the club runs while waiting: 'standard setup' is not claimed", async () => {
    state.org = heldOrg({ rollingSquadEnabled: true, setupLearning: learning("nothing") });
    await sendSetupDm("org-riverside", DAY, { learningEnabled: true });
    expect(String(state.jobs[0].text)).not.toMatch(/standard setup/i);
  });

  it("the links are the organiser's own, signed in to this club, good for a week", async () => {
    state.org = heldOrg({ setupLearning: learning("nothing") });
    await sendSetupDm("org-riverside", DAY, { learningEnabled: true });
    for (const [a] of adminLinkMock.mock.calls) {
      expect(a).toMatchObject({ userId: "u-ali", orgId: "org-riverside", ttlSeconds: 7 * 24 * 60 * 60 });
    }
    expect(adminLinkMock.mock.calls.map((c) => c[0].nextPath).sort()).toEqual([
      "/admin/activities",
      "/admin/players/ratings",
      "/admin/settings",
    ]);
  });
});

describe("sendSetupDm: message hours and the stamp", () => {
  it("in the daytime it goes at once and the stamp is now", async () => {
    await sendSetupDm("org-riverside", DAY, { learningEnabled: false });
    expect(state.jobs[0].sendAfter).toBeNull();
    expect(state.org!.setupAskedAt).toEqual(DAY);
  });

  it("at night it waits for 09:00 London, and the stamp is that due time", async () => {
    const r = await sendSetupDm("org-riverside", NIGHT, { learningEnabled: false });
    expect(r).toEqual({ kind: "sent", sendAfter: NINE_NEXT });
    expect(state.jobs[0].sendAfter).toEqual(NINE_NEXT);
    expect(state.org!.setupAskedAt).toEqual(NINE_NEXT);
  });

  it("the stamp is a compare-and-set on 'still setting up and never asked', in the job's own transaction", async () => {
    await sendSetupDm("org-riverside", DAY, { learningEnabled: false });
    expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
    expect(state.orgUpdates).toHaveLength(1);
    expect(state.orgUpdates[0].where).toEqual({
      id: "org-riverside",
      approvalStatus: "approved",
      setupStage: "setting-up",
      setupAskedAt: null,
      setupRemovedAt: null,
    });
    expect(state.orgUpdates[0].data).toEqual({ setupAskedAt: DAY });
  });
});

describe("sendSetupDm: at most one, ever", () => {
  it("a second call finds the club already asked: nothing is queued", async () => {
    await sendSetupDm("org-riverside", DAY, { learningEnabled: false });
    expect(await sendSetupDm("org-riverside", DAY, { learningEnabled: false })).toEqual({ kind: "not-due" });
    expect(state.jobs).toHaveLength(1);
  });

  it("two runs that both read 'due': the loser of the compare-and-set queues nothing", async () => {
    // Both read the club before either writes.
    const [a, b] = await Promise.all([
      sendSetupDm("org-riverside", DAY, { learningEnabled: false }),
      sendSetupDm("org-riverside", DAY, { learningEnabled: false }),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(["already", "sent"]);
    expect(state.jobs).toHaveLength(1);
  });

  it("not for a live club, an unapproved one, or one MatchTime was removed from", async () => {
    for (const over of [{ setupStage: "live" }, { approvalStatus: "suspended" }, { setupRemovedAt: DAY }]) {
      state.org = heldOrg(over);
      expect(await sendSetupDm("org-riverside", DAY, { learningEnabled: false })).toEqual({ kind: "not-due" });
    }
    expect(state.jobs).toEqual([]);
  });

  it("no closed connect request (nobody to tell): nothing sent, nothing stamped", async () => {
    state.connect = null;
    expect(await sendSetupDm("org-riverside", DAY, { learningEnabled: false })).toEqual({ kind: "no-organiser" });
    expect(state.orgUpdates).toEqual([]);
  });

  it("a number MatchTime does not know: refused, logged, stamped (never retried for ever)", async () => {
    state.knownUser = false;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sendSetupDm("org-riverside", DAY, { learningEnabled: false })).toMatchObject({ kind: "refused" });
    expect(state.jobs).toEqual([]);
    expect(state.org!.setupAskedAt).toEqual(DAY);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("sendSetupDm with the reading off: a later reading can never change the club behind the DM", () => {
  it("an unfinished or absent reading is closed for good, and the stored chat deleted, in the same transaction", async () => {
    await sendSetupDm("org-riverside", DAY, { learningEnabled: false });
    expect(state.raw.some((q) => /INSERT INTO "ClubSetupLearning"/.test(q) && /'skipped'/.test(q) && /'reading-off'/.test(q))).toBe(true);
    expect(state.raw.some((q) => /UPDATE "ClubConnect" SET "capturedHistory" = NULL/.test(q))).toBe(true);
  });

  it("a finished reading is left exactly as it was", async () => {
    state.org = heldOrg({ setupLearning: learning("applied", { applied: [{ key: "rollingSquad", from: false, to: true, evidence: [] }] }) });
    await sendSetupDm("org-riverside", DAY, { learningEnabled: false });
    expect(state.raw).toEqual([]);
  });
});

describe("runSetupDmSweep (the cron's half, and the retry)", () => {
  it("selects approved, setting-up clubs never asked and not removed; with the reading on, only those whose reading is final", async () => {
    await runSetupDmSweep(DAY, { learningEnabled: true });
    const where = state.findManyArgs[0].where as Row;
    expect(where).toMatchObject({
      approvalStatus: "approved",
      setupStage: "setting-up",
      setupAskedAt: null,
      setupRemovedAt: null,
      setupLearning: { is: { status: { in: ["applied", "nothing", "skipped", "failed"] } } },
    });
  });

  it("with the reading off, every such club", async () => {
    await runSetupDmSweep(DAY, { learningEnabled: false });
    expect((state.findManyArgs[0].where as Row).setupLearning).toBeUndefined();
  });

  it("sends one DM per due club and reports it; one club failing does not stop the next", async () => {
    state.dueOrgs = [{ id: "org-gone" }, { id: "org-riverside" }];
    dbMock.organisation.findFirst.mockImplementationOnce(async () => {
      throw new Error("db hiccup");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await runSetupDmSweep(DAY, { learningEnabled: false });
    expect(r).toEqual({ considered: 2, sent: 1 });
    expect(state.jobs).toHaveLength(1);
    err.mockRestore();
  });

  it("no club is setting up (every club today): one query, nothing else", async () => {
    expect(await runSetupDmSweep(DAY, { learningEnabled: true })).toEqual({ considered: 0, sent: 0 });
    expect(dbMock.organisation.findMany).toHaveBeenCalledTimes(1);
    expect(dbMock.organisation.findFirst).not.toHaveBeenCalled();
  });
});

describe("runSetupAfterApproval (what `after()` runs for the one club just approved)", () => {
  it("reading on: reads this club, then sends its DM once the reading is final", async () => {
    learnMock.mockImplementation(async () => {
      state.org!.setupLearning = learning("nothing");
      return { kind: "done", status: "nothing", applied: 0, suggestions: 0, noted: 0, dmQueued: false };
    });
    const r = await runSetupAfterApproval("org-riverside", { now: DAY, learningEnabled: true });
    expect(learnMock).toHaveBeenCalledWith("org-riverside", { now: DAY, model: undefined });
    expect(r.dm).toMatchObject({ kind: "sent" });
    expect(state.jobs).toHaveLength(1);
  });

  it("reading on and deferred: no DM yet (the cron retries)", async () => {
    learnMock.mockImplementation(async () => {
      state.org!.setupLearning = learning("deferred");
      return { kind: "deferred", reason: "model-error" };
    });
    const r = await runSetupAfterApproval("org-riverside", { now: DAY, learningEnabled: true });
    expect(r.dm).toEqual({ kind: "reading" });
    expect(state.jobs).toEqual([]);
  });

  it("reading off: no reading, the DM at once", async () => {
    const r = await runSetupAfterApproval("org-riverside", { now: DAY, learningEnabled: false });
    expect(learnMock).not.toHaveBeenCalled();
    expect(r.dm).toMatchObject({ kind: "sent" });
  });

  it("a reading that throws never stops the DM pass, and never throws out of `after()`", async () => {
    learnMock.mockRejectedValue(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await runSetupAfterApproval("org-riverside", { now: DAY, learningEnabled: true });
    expect(r.dm).toEqual({ kind: "reading" });
    err.mockRestore();
  });
});
