/**
 * GO-LIVE SLICE S3: the organiser's ONE setup DM, the database half,
 * against a mocked database (go-live plan 2.4). No model anywhere: the SDK
 * is mocked and its calls counted. The real-Postgres checks (two runs
 * racing for one DM, the 2-hour cap, the cancel) are in
 * e2e/api/setup-hold-approval.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  alerts: [] as Row[],
  dueOrgs: [] as Row[],
  findManyArgs: [] as Row[],
  orgUpdates: [] as Array<{ where: Row; data: Row }>,
}));

const dbMock = vi.hoisted(() => {
  const m = {
    organisation: {
      findFirst: vi.fn(async (args: Row) => {
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
    clubSetupLearning: {
      findUnique: vi.fn(async () => (state.org?.setupLearning ? { ...(state.org.setupLearning as Row) } : null)),
    },
    clubConnect: { findFirst: vi.fn(async () => (state.connect ? { ...state.connect } : null)) },
    user: { findFirst: vi.fn(async () => (state.knownUser ? { id: "u-ali" } : null)) },
    platformJob: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        state.jobs.push(data);
        return { id: `pj-${state.jobs.length}`, ...data };
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
    // The one "close the reading for good" statement: an absent, running
    // or deferred row becomes skipped with the given reason; a final row is
    // left alone and nothing is returned.
    $queryRaw: vi.fn(async (q: TemplateStringsArray, ...values: unknown[]) => {
      state.raw.push(q.join("?"));
      const l = state.org?.setupLearning as Row | null | undefined;
      if (l && l.status !== "running" && l.status !== "deferred") return [];
      state.org!.setupLearning = { ...(l ?? {}), status: "skipped", reason: values[2], applied: null, suggestions: null, noted: null };
      return [{ inserted: !l }];
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

import {
  SETUP_ASK_DM_PURPOSE,
  runSetupAfterApproval,
  runSetupDmSweep,
  sendSetupDm,
  setupAskRefId,
} from "../club-setup-dm";
import { SETUP_ALERT_KIND } from "../ops-alerts";
import { STILL_READING_WINDOW_MS } from "../club-setup-rules";

const DAY = new Date("2026-10-12T11:00:00Z"); // 12:00 London
const NIGHT = new Date("2026-10-12T22:30:00Z"); // 23:30 London (BST)
const NINE_NEXT = new Date("2026-10-13T08:00:00Z"); // 09:00 London
const MIN = 60 * 1000;
/** Approved a minute before DAY unless a test says otherwise. */
const JUST_APPROVED = new Date(DAY.getTime() - MIN);

const heldOrg = (over: Row = {}): Row => ({
  id: "org-riverside",
  name: "Riverside FC",
  language: "en",
  approvalStatus: "approved",
  approvedAt: JUST_APPROVED,
  setupStage: "setting-up",
  setupAskedAt: null,
  setupRemovedAt: null,
  rollingSquadEnabled: false,
  benchPickMode: "first-come",
  dropOutDeadlineDay: null,
  dropOutDeadlineTime: null,
  listPublishDay: null,
  listPublishTime: null,
  paymentTrackingEnabled: false,
  squadMode: "weekly",
  featureAttendance: true,
  featureBench: true,
  featureSquadFromList: false,
  setupLearning: null,
  billingStatus: "exempt",
  billingPlan: "standard",
  clubBilling: null,
  ...over,
});

let logs: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  sdkCalls.n = 0;
  process.env.NEXTAUTH_URL = "https://matchtime.ai";
  state.org = heldOrg();
  state.connect = { id: "cc-ali", userId: "u-ali", phone: "447700900123", groupSubject: "Riverside Tuesday 5s" };
  state.knownUser = true;
  state.jobs = [];
  state.raw = [];
  state.alerts = [];
  state.dueOrgs = [];
  state.findManyArgs = [];
  state.orgUpdates = [];
  dbMock.$transaction.mockImplementation(async (fn: (tx: typeof dbMock) => unknown) => fn(dbMock));
  logs = [];
  const keep = (...a: unknown[]) => void logs.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(" "));
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
  vi.spyOn(console, "warn").mockImplementation(keep);
});

const learning = (status: string, over: Row = {}): Row => ({ status, reason: null, applied: [], suggestions: [], noted: [], ...over });

describe("sendSetupDm: the free period is promised only when going live will start one", () => {
  const FREE = "Your first two months are free. The free period starts when I go live in the group.";
  const BILLING = process.env.BILLING_ENABLED;
  afterEach(() => {
    if (BILLING === undefined) delete process.env.BILLING_ENABLED;
    else process.env.BILLING_ENABLED = BILLING;
  });
  const sentText = async () => {
    expect((await sendSetupDm("org-riverside", DAY, { learningEnabled: false })).kind).toBe("sent");
    return String(state.jobs[0].text);
  };

  it("billing on, Standard plan, no free period yet: the last line promises it", async () => {
    process.env.BILLING_ENABLED = "1";
    expect((await sentText()).endsWith(FREE)).toBe(true);
  });

  it("billing switched OFF: no free period is mentioned, and the DM ends on the GO line", async () => {
    delete process.env.BILLING_ENABLED;
    const text = await sentText();
    expect(text).not.toMatch(/free period|months are free/i);
    expect(text.split("\n\n").at(-1)).toMatch(/^When you're happy, reply \*GO\* here/);
  });

  it("the Free plan: no free period is mentioned (there is nothing to pay after it)", async () => {
    process.env.BILLING_ENABLED = "1";
    state.org = heldOrg({ billingPlan: "free" });
    expect(await sentText()).not.toMatch(/free period|months are free/i);
  });

  it("a club that somehow already has a billing row: not promised a second one", async () => {
    process.env.BILLING_ENABLED = "1";
    state.org = heldOrg({ clubBilling: { orgId: "org-riverside" } });
    expect(await sentText()).not.toMatch(/free period|months are free/i);
  });
});

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
    expect(text).not.toContain("couldn't read");
    expect(text).toContain("Standard setup: ");
    expect(text).toContain("reply *GO* here");
    expect(text).toContain("https://mt.link/admin/settings");
    expect(text).toContain("https://mt.link/admin/activities");
    expect(text).toContain("https://mt.link/admin/players/ratings");
    expect(setupAskRefId("org-riverside")).toBe("org-riverside:setup-ask");
    expect(sdkCalls.n).toBe(0);
  });

  it("the reading is on and has not finished, inside the first two hours: nothing is sent, stamped or closed", async () => {
    for (const row of [null, learning("running"), learning("deferred")]) {
      state.org = heldOrg({ setupLearning: row });
      expect(await sendSetupDm("org-riverside", DAY, { learningEnabled: true })).toEqual({ kind: "reading" });
    }
    expect(state.jobs).toEqual([]);
    expect(state.orgUpdates).toEqual([]);
    expect(state.raw).toEqual([]);
  });

  it("each final reading outcome sends the DM", async () => {
    const applied = [{ key: "rollingSquad", from: false, to: true, evidence: ["Same lot as last week"] }];
    const cases: Array<[Row, Row, RegExp]> = [
      [learning("applied", { applied }), { rollingSquadEnabled: true }, /set MatchTime up the same way\.[\s\S]*Undo or change: https:\/\/mt\.link\/admin\/settings\?learned=rollingSquad#learned-setup/],
      [learning("nothing"), {}, /found nothing that needs a setting changed, so MatchTime is on its standard setup\./],
      [learning("skipped", { reason: "too-short" }), {}, /I couldn't read your group's recent messages, so MatchTime is on its standard setup\./],
      [learning("failed", { reason: "model-error" }), {}, /I couldn't read your group's recent messages, so MatchTime is on its standard setup\./],
    ];
    for (const [row, org, expected] of cases) {
      state.org = heldOrg({ ...org, setupLearning: row });
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

  it("speaks Turkish to a Turkish club, and asks for BAŞLA", async () => {
    state.org = heldOrg({ language: "tr", setupLearning: learning("nothing") });
    await sendSetupDm("org-riverside", DAY, { learningEnabled: true });
    expect(String(state.jobs[0].text)).toMatch(/^Güzel haber: Riverside FC onaylandı\./);
    expect(String(state.jobs[0].text)).toContain("buraya *BAŞLA* yazın");
    expect(String(state.jobs[0].text)).toContain("*Yayına al* düğmesine");
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

  // Review fix 6 (PR #238): the fee line linked to the plain activities
  // page, where the fee field is closed. It is minted as the findings DM
  // mints it (setup-learning/run.ts), in English and Turkish.
  it("a match fee suggestion gets its own link, straight to the fee field", async () => {
    const fee = { key: "matchFee", current: "", detected: "6", evidence: ["£6 a player"], fromDescription: ["£6 a player"] };
    state.org = heldOrg({ setupLearning: learning("nothing", { suggestions: [fee] }) });
    await sendSetupDm("org-riverside", DAY, { learningEnabled: true });
    expect(adminLinkMock.mock.calls.map((c) => c[0].nextPath)).toContain("/admin/activities?edit=fee");
    expect(String(state.jobs[0].text)).toContain(
      `🔎 The match fee looks like £6 a player; your weekly game has no fee set.\n` +
        `From your group description: "£6 a player"\n` +
        `Set it here: https://mt.link/admin/activities?edit=fee`,
    );

    state.jobs.length = 0;
    state.org = heldOrg({ language: "tr", setupLearning: learning("nothing", { suggestions: [fee] }) });
    await sendSetupDm("org-riverside", DAY, { learningEnabled: true });
    expect(String(state.jobs[0].text)).toContain(
      `Grup açıklamanızdan: "£6 a player"\nBuradan girebilirsiniz: https://mt.link/admin/activities?edit=fee`,
    );
  });

  it("with no fee suggestion no fee link is minted", async () => {
    const pick = { key: "organiserPicks", current: "first-come", detected: "organiser", evidence: ["I'll pick", "I pick the team"] };
    state.org = heldOrg({ setupLearning: learning("nothing", { suggestions: [pick] }) });
    await sendSetupDm("org-riverside", DAY, { learningEnabled: true });
    expect(adminLinkMock.mock.calls.map((c) => c[0].nextPath)).not.toContain("/admin/activities?edit=fee");
  });
});

describe("review fix 4: the DM never states something false about the club", () => {
  const applied = [
    { key: "rollingSquad", from: false, to: true, evidence: ["Same lot as last week"] },
    { key: "paymentTracking", from: false, to: true, evidence: ["sent £6"] },
  ];

  it("a setting the organiser UNDID before the DM went is not reported as on, and gets no undo link", async () => {
    const undone = [{ ...applied[0], undoneAt: "2026-10-12T10:30:00.000Z" }, applied[1]];
    state.org = heldOrg({ paymentTrackingEnabled: true, setupLearning: learning("applied", { applied: undone }) });
    await sendSetupDm("org-riverside", DAY, { learningEnabled: true });
    const text = String(state.jobs[0].text);
    expect(text).not.toContain("Rolling squad is on");
    expect(text).not.toContain("learned=rollingSquad");
    expect(text).toContain("Payment tracking is on");
  });

  it("a setting the organiser switched back by hand (it no longer holds what was set) is not reported as on", async () => {
    state.org = heldOrg({ rollingSquadEnabled: false, paymentTrackingEnabled: true, setupLearning: learning("applied", { applied }) });
    await sendSetupDm("org-riverside", DAY, { learningEnabled: true });
    const text = String(state.jobs[0].text);
    expect(text).not.toContain("Rolling squad is on");
    expect(text).toContain("Payment tracking is on");
  });

  it("'standard setup' is claimed only when EVERY describable setting is on its default", async () => {
    for (const moved of [
      { rollingSquadEnabled: true },
      { benchPickMode: "organiser" },
      { dropOutDeadlineDay: 1, dropOutDeadlineTime: "21:00" },
      { listPublishDay: 2, listPublishTime: "20:00" },
      { paymentTrackingEnabled: true },
      { squadMode: "monthly" },
      { featureAttendance: false },
    ]) {
      state.org = heldOrg({ ...moved, setupLearning: learning("nothing") });
      state.jobs = [];
      await sendSetupDm("org-riverside", DAY, { learningEnabled: true });
      expect(String(state.jobs[0].text), JSON.stringify(moved)).not.toMatch(/standard setup/i);
      expect(String(state.jobs[0].text)).toContain("so I changed nothing.");
    }
  });
});

describe("review fix 1: the 2-hour cap (a held club is never stranded waiting for a reading)", () => {
  const TWO_HOURS_AGO = new Date(DAY.getTime() - STILL_READING_WINDOW_MS);

  it("the cap is two hours, and it is the SAME constant that makes GO answer 'still reading'", () => {
    expect(STILL_READING_WINDOW_MS).toBe(2 * 60 * 60 * 1000);
  });

  it("the close takes the club's row BEFORE the reading row (the lock order go-live uses)", async () => {
    state.org = heldOrg({ approvedAt: TWO_HOURS_AGO, setupLearning: learning("running", { attempts: 3 }) });
    await sendSetupDm("org-riverside", DAY, { learningEnabled: true });
    const lock = state.raw.findIndex((q) => /FROM "Organisation" WHERE "id" = \? FOR UPDATE/.test(q));
    const close = state.raw.findIndex((q) => /INSERT INTO "ClubSetupLearning"/.test(q));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(close);
  });

  it("stuck 'running' with its attempts used up, two hours after approval: closed for good, chat deleted, DM says it could not be read", async () => {
    state.org = heldOrg({ approvedAt: TWO_HOURS_AGO, setupLearning: learning("running", { attempts: 3 }) });
    const r = await sendSetupDm("org-riverside", DAY, { learningEnabled: true });
    expect(r).toMatchObject({ kind: "sent" });
    expect(state.org!.setupLearning).toMatchObject({ status: "skipped", reason: "timed-out" });
    expect(state.raw.some((q) => /UPDATE "ClubConnect" SET "capturedHistory" = NULL/.test(q))).toBe(true);
    expect(String(state.jobs[0].text)).toContain("I couldn't read your group's recent messages, so MatchTime is on its standard setup.");
    expect(state.org!.setupAskedAt).toEqual(DAY);
  });

  it("'deferred', and approved four days ago (outside the reading sweep's 3-day window): the same", async () => {
    state.org = heldOrg({ approvedAt: new Date(DAY.getTime() - 4 * 24 * 60 * MIN), setupLearning: learning("deferred", { attempts: 2 }) });
    expect(await sendSetupDm("org-riverside", DAY, { learningEnabled: true })).toMatchObject({ kind: "sent" });
    expect(state.org!.setupLearning).toMatchObject({ status: "skipped", reason: "timed-out" });
    expect(String(state.jobs[0].text)).toContain("I couldn't read your group's recent messages");
  });

  it("no reading row at all after two hours (the sweep never got to it): the same", async () => {
    state.org = heldOrg({ approvedAt: TWO_HOURS_AGO, setupLearning: null });
    expect(await sendSetupDm("org-riverside", DAY, { learningEnabled: true })).toMatchObject({ kind: "sent" });
    expect(state.org!.setupLearning).toMatchObject({ status: "skipped", reason: "timed-out" });
  });

  it("at 1 hour 59 minutes an unfinished reading is still waited for: nothing closed, nothing sent", async () => {
    state.org = heldOrg({ approvedAt: new Date(TWO_HOURS_AGO.getTime() + MIN), setupLearning: learning("running", { attempts: 3 }) });
    expect(await sendSetupDm("org-riverside", DAY, { learningEnabled: true })).toEqual({ kind: "reading" });
    expect(state.raw).toEqual([]);
    expect(state.jobs).toEqual([]);
  });

  it("a reading that FINISHED at 1 hour 59 is used normally, cap or no cap", async () => {
    const applied = [{ key: "rollingSquad", from: false, to: true, evidence: ["Same lot as last week"] }];
    state.org = heldOrg({ approvedAt: new Date(DAY.getTime() - 3 * 60 * MIN), rollingSquadEnabled: true, setupLearning: learning("applied", { applied }) });
    await sendSetupDm("org-riverside", DAY, { learningEnabled: true });
    expect(String(state.jobs[0].text)).toContain("Rolling squad is on");
    expect(state.raw).toEqual([]);
    expect(state.org!.setupLearning).toMatchObject({ status: "applied" });
  });

  it("the reading finished in the instant before the cap closed it: the close does nothing, and the DM reports what was read", async () => {
    const applied = [{ key: "rollingSquad", from: false, to: true, evidence: ["Same lot as last week"] }];
    state.org = heldOrg({ approvedAt: TWO_HOURS_AGO, setupLearning: learning("running", { attempts: 3 }) });
    dbMock.$queryRaw.mockImplementationOnce(async (q: TemplateStringsArray) => {
      // Between our read and our close, the reading finished and applied.
      state.raw.push(q.join("?"));
      state.org!.rollingSquadEnabled = true;
      state.org!.setupLearning = learning("applied", { applied });
      return [];
    });
    await sendSetupDm("org-riverside", DAY, { learningEnabled: true });
    const text = String(state.jobs[0].text);
    expect(text).toContain("Rolling squad is on");
    expect(text).not.toContain("couldn't read");
    // A reading that finished keeps its record and its chat handling: nothing more is deleted here.
    expect(state.raw.some((q) => /"capturedHistory" = NULL/.test(q))).toBe(false);
  });
});

describe("sendSetupDm: message hours and the stamp", () => {
  it("in the daytime it goes at once and the stamp is now", async () => {
    await sendSetupDm("org-riverside", DAY, { learningEnabled: false });
    expect(state.jobs[0].sendAfter).toBeNull();
    expect(state.org!.setupAskedAt).toEqual(DAY);
  });

  it("at night it waits for 09:00 London, and the stamp is that due time", async () => {
    state.org = heldOrg({ approvedAt: new Date(NIGHT.getTime() - MIN) });
    const r = await sendSetupDm("org-riverside", NIGHT, { learningEnabled: false });
    expect(r).toEqual({ kind: "sent", sendAfter: NINE_NEXT });
    expect(state.jobs[0].sendAfter).toEqual(NINE_NEXT);
    expect(state.org!.setupAskedAt).toEqual(NINE_NEXT);
  });

  it("the stamp is a compare-and-set on 'still setting up and never asked', in the job's own transaction", async () => {
    await sendSetupDm("org-riverside", DAY, { learningEnabled: false });
    expect(dbMock.$transaction).toHaveBeenCalled();
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
});

describe("review fix 2: a setup DM that cannot be sent is visible to the owner, once, and is not retried for ever", () => {
  it("a number MatchTime does not know: no job, the club is stamped, ONE ops event with a reason code", async () => {
    state.knownUser = false;
    const r = await sendSetupDm("org-riverside", DAY, { learningEnabled: false });
    expect(r).toEqual({ kind: "refused", reason: "number-not-known" });
    expect(state.jobs).toEqual([]);
    expect(state.org!.setupAskedAt).toEqual(DAY);
    expect(state.alerts).toHaveLength(1);
    expect(state.alerts[0]).toMatchObject({
      orgId: "org-riverside",
      kind: SETUP_ALERT_KIND,
      severity: "warning",
      title: "Setup message not sent",
      dedupeKey: "setup-ask-not-sent",
    });
    expect(String(state.alerts[0].detail)).toContain("number-not-known");
    // Stamped: the next sweep does not come back to it.
    expect(await sendSetupDm("org-riverside", DAY, { learningEnabled: false })).toEqual({ kind: "not-due" });
    expect(state.alerts).toHaveLength(1);
  });

  it("a connect row whose phone is not a phone number: refused with a code, and the raw string is in no log and no event", async () => {
    state.connect = { ...state.connect!, phone: "not-a-number-07700 900123x" };
    const r = await sendSetupDm("org-riverside", DAY, { learningEnabled: false });
    expect(r).toEqual({ kind: "refused", reason: "not-a-phone-number" });
    const said = logs.join("\n") + JSON.stringify(state.alerts);
    expect(said).not.toContain("07700");
    expect(said).not.toContain("not-a-number");
    expect(said).toContain("not-a-phone-number");
  });

  it("no closed connect request (nobody to tell): stamped, ONE ops event, never looked at again", async () => {
    state.connect = null;
    expect(await sendSetupDm("org-riverside", DAY, { learningEnabled: false })).toEqual({ kind: "no-organiser" });
    expect(state.jobs).toEqual([]);
    expect(state.org!.setupAskedAt).toEqual(DAY);
    expect(state.alerts).toHaveLength(1);
    expect(state.alerts[0]).toMatchObject({ orgId: "org-riverside", kind: SETUP_ALERT_KIND, dedupeKey: "setup-ask-not-sent" });
    expect(String(state.alerts[0].detail)).toContain("no-organiser");
    expect(await sendSetupDm("org-riverside", DAY, { learningEnabled: false })).toEqual({ kind: "not-due" });
    expect(state.alerts).toHaveLength(1);
  });
});

describe("review fix 7: this module's logs carry ids and reason codes only", () => {
  it("a sent DM, a refused one and a missing organiser never log the club's name, a phone number, a link or the text", async () => {
    await sendSetupDm("org-riverside", DAY, { learningEnabled: false });
    state.org = heldOrg();
    state.knownUser = false;
    await sendSetupDm("org-riverside", DAY, { learningEnabled: false });
    state.org = heldOrg();
    state.connect = null;
    await sendSetupDm("org-riverside", DAY, { learningEnabled: false });
    const said = logs.join("\n");
    expect(said).toContain("org-riverside");
    for (const secret of ["Riverside", "447700900123", "mt.link", "Good news", "Tuesday 5s"]) {
      expect(said, secret).not.toContain(secret);
    }
  });
});

describe("sendSetupDm with the reading off: a later reading can never change the club behind the DM", () => {
  it("an unfinished or absent reading is closed for good and the stored chat deleted, BEFORE the DM is queued", async () => {
    await sendSetupDm("org-riverside", DAY, { learningEnabled: false });
    expect(state.org!.setupLearning).toMatchObject({ status: "skipped", reason: "reading-off" });
    expect(state.raw.some((q) => /INSERT INTO "ClubSetupLearning"/.test(q) && /'skipped'/.test(q))).toBe(true);
    expect(state.raw.some((q) => /UPDATE "ClubConnect" SET "capturedHistory" = NULL/.test(q))).toBe(true);
    expect(dbMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(dbMock.platformJob.create.mock.invocationCallOrder[0]);
  });

  it("a finished reading is left exactly as it was", async () => {
    state.org = heldOrg({
      rollingSquadEnabled: true,
      setupLearning: learning("applied", { applied: [{ key: "rollingSquad", from: false, to: true, evidence: [] }] }),
    });
    await sendSetupDm("org-riverside", DAY, { learningEnabled: false });
    expect(state.raw).toEqual([]);
  });
});

describe("runSetupDmSweep (the cron's half, and the retry)", () => {
  it("with the reading on: clubs whose reading is final, OR approved two hours ago or more (the cap)", async () => {
    await runSetupDmSweep(DAY, { learningEnabled: true });
    const where = state.findManyArgs[0].where as Row;
    expect(where).toMatchObject({
      approvalStatus: "approved",
      setupStage: "setting-up",
      setupAskedAt: null,
      setupRemovedAt: null,
      OR: [
        { setupLearning: { is: { status: { in: ["applied", "nothing", "skipped", "failed"] } } } },
        { approvedAt: { lte: new Date(DAY.getTime() - STILL_READING_WINDOW_MS) } },
      ],
    });
  });

  it("with the reading off, every such club", async () => {
    await runSetupDmSweep(DAY, { learningEnabled: false });
    const where = state.findManyArgs[0].where as Row;
    expect(where.OR).toBeUndefined();
    expect(where.setupLearning).toBeUndefined();
  });

  it("sends one DM per due club and reports it; one club failing does not stop the next", async () => {
    state.dueOrgs = [{ id: "org-gone" }, { id: "org-riverside" }];
    dbMock.organisation.findFirst.mockImplementationOnce(async () => {
      throw new Error("db hiccup");
    });
    const r = await runSetupDmSweep(DAY, { learningEnabled: false });
    expect(r).toEqual({ considered: 2, sent: 1 });
    expect(state.jobs).toHaveLength(1);
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
    const r = await runSetupAfterApproval("org-riverside", { now: DAY, learningEnabled: true });
    expect(r.dm).toEqual({ kind: "reading" });
  });
});
