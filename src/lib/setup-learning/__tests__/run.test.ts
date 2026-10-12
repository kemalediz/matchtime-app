/**
 * F3, learned setup: `learnClubSetup` and the sweep against a mocked
 * database and a STUB model. No model is ever called (the SDK is mocked
 * and its calls counted); the stub returns each fixture's canned answer.
 * The real-Postgres path is e2e/api/learned-setup.spec.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdkCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: () => {
        sdkCalls.n++;
        throw new Error("no real model in unit tests");
      },
    };
  },
}));

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  org: null as Row | null,
  learning: null as Row | null,
  connect: null as Row | null,
  activities: [] as Row[],
  jobs: [] as Row[],
  raw: [] as string[],
  orgUpdates: [] as Array<{ where: Row; data: Row }>,
  dueOrgs: [] as Row[],
  findManyArgs: [] as Row[],
}));

const dbMock = vi.hoisted(() => ({
  organisation: {
    findFirst: vi.fn(async () => (state.org ? { ...state.org } : null)),
    findMany: vi.fn(async (args: Row) => {
      state.findManyArgs.push(args);
      return state.dueOrgs;
    }),
    updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
      state.orgUpdates.push(args);
      const o = state.org!;
      const set = (o.settingsSetByOrganiser as string[]) ?? [];
      const blocked = ((args.where.NOT as Row)?.settingsSetByOrganiser as { hasSome: string[] })?.hasSome ?? [];
      for (const [k, v] of Object.entries(args.where)) {
        if (k === "id" || k === "NOT" || k === "approvalStatus") continue;
        if (o[k] !== v) return { count: 0 };
      }
      if (blocked.some((b) => set.includes(b))) return { count: 0 };
      Object.assign(o, args.data);
      return { count: 1 };
    }),
  },
  clubSetupLearning: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      if (state.learning) throw Object.assign(new Error("unique"), { code: "P2002" });
      state.learning = { attempts: 1, updatedAt: new Date(0), ...data };
      return state.learning;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const l = state.learning;
      if (!l) return { count: 0 };
      // The reading's own writes: a compare-and-set on the status it holds.
      if (where.attempts === undefined) {
        if (l.status !== where.status) return { count: 0 };
        Object.assign(l, data);
        return { count: 1 };
      }
      const attempts = l.attempts as number;
      if (attempts >= ((where.attempts as Row).lt as number)) return { count: 0 };
      const ok = (where.OR as Row[]).some(
        (c) => c.status === l.status && (!c.updatedAt || (l.updatedAt as Date) < ((c.updatedAt as Row).lt as Date)),
      );
      if (!ok) return { count: 0 };
      l.status = data.status;
      l.attempts = attempts + 1;
      return { count: 1 };
    }),
    update: vi.fn(async ({ data }: { data: Row }) => {
      Object.assign(state.learning!, data);
      return state.learning;
    }),
    findUnique: vi.fn(async () => (state.learning ? { ...state.learning } : null)),
  },
  clubConnect: { findFirst: vi.fn(async () => (state.connect ? { ...state.connect } : null)) },
  activity: { findMany: vi.fn(async () => state.activities) },
  platformJob: { findFirst: vi.fn(async () => null) },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(dbMock)),
  $executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
    state.raw.push(strings.join("?"));
    if (strings.join("?").includes(`"capturedHistory" = NULL`) && state.connect) state.connect.capturedHistory = null;
    if (strings.join("?").includes(`"capturedDescription" = NULL`) && state.connect) state.connect.capturedDescription = null;
    return 1;
  }),
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));

const budget = vi.hoisted(() => ({ capped: false, keys: [] as string[] }));
vi.mock("@/lib/ai-budget", async () => {
  const { AiBudgetExceededError } = await import("@/lib/ai-budget-context");
  return {
    // The reading spends through its own scope (go-live S1): the one path a
    // setting-up club may pay for. The ordinary scope must not be used.
    withOrgAiBudget: async () => {
      throw new Error("the setup reading must use withSetupReadingAiBudget");
    },
    withSetupReadingAiBudget: async (key: string, fn: () => Promise<unknown>) => {
      budget.keys.push(key);
      if (budget.capped) throw new AiBudgetExceededError(key, "setup-learning");
      return fn();
    },
  };
});

vi.mock("@/lib/admin-link", async (orig) => ({
  ...(await orig<typeof import("@/lib/admin-link")>()),
  buildAdminLink: vi.fn(async (a: { nextPath: string }) => `https://mt.link${a.nextPath}`),
}));

const dms = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/lib/platform-jobs", async (orig) => ({
  ...(await orig<typeof import("@/lib/platform-jobs")>()),
  queuePlatformDm: vi.fn(async (a: Record<string, unknown>) => {
    dms.push(a);
    return { id: `job-${dms.length}` };
  }),
}));

import { learnClubSetup, runSetupLearningSweep, MAX_ATTEMPTS } from "../run";
import type { PipelineModel } from "../../pipeline/llm";
import { FIXTURE_NAMES, loadFixture, STUB_ANSWERS } from "./stubs";

const ORG = "org-riverside";
const ORGANISER_PHONE = "447700900123";
const DAYTIME = new Date("2026-10-05T11:00:00Z"); // 12:00 London
const NIGHT = new Date("2026-10-05T22:30:00Z"); // 23:30 London

function stub(answer: unknown, opts: { fail?: boolean } = {}): PipelineModel & { calls: number } {
  const m = {
    name: "stub",
    calls: 0,
    async complete() {
      m.calls++;
      if (opts.fail) throw new Error("529 overloaded");
      return {
        text: JSON.stringify(answer),
        stopReason: "end_turn",
        usage: { inputTokens: 9_000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.011,
        ms: 5,
      };
    },
  };
  return m;
}

function setup(name: (typeof FIXTURE_NAMES)[number], org: Row = {}) {
  const fx = loadFixture(name);
  state.org = {
    id: ORG,
    name: "Riverside FC",
    language: fx.language,
    approvedAt: new Date("2026-10-05T09:00:00Z"),
    whatsappBotEnabled: true,
    // Every club that never passed through setting-up has no go-live stamp.
    liveAt: null,
    rollingSquadEnabled: false,
    benchPickMode: "first-come",
    dropOutDeadlineDay: null,
    dropOutDeadlineTime: null,
    listPublishDay: null,
    listPublishTime: null,
    paymentTrackingEnabled: false,
    settingsSetByOrganiser: [],
    ...org,
  };
  state.connect = {
    id: "cc-1",
    userId: "u-ali",
    phone: ORGANISER_PHONE,
    groupSubject: fx.groupSubject,
    capturedHistory: fx.history.length ? fx.history : null,
    capturedDescription: fx.description ?? null,
  };
  state.activities = [
    {
      dayOfWeek: fx.weeklyGame.dayOfWeek,
      time: fx.weeklyGame.time,
      venue: fx.weeklyGame.venue,
      sport: { playersPerTeam: fx.weeklyGame.playersPerSide },
    },
  ];
  return fx;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, {
    org: null,
    learning: null,
    connect: null,
    activities: [],
    jobs: [],
    raw: [],
    orgUpdates: [],
    dueOrgs: [],
    findManyArgs: [],
  });
  dms.length = 0;
  budget.capped = false;
  budget.keys = [];
  sdkCalls.n = 0;
});

describe("learnClubSetup, fixture by fixture (one stub call each, no real model)", () => {
  for (const name of FIXTURE_NAMES) {
    it(`${name}: does what the fixture expects`, async () => {
      const fx = setup(name);
      const model = stub(STUB_ANSWERS[name] ?? {});
      const out = await learnClubSetup(ORG, { now: DAYTIME, model });

      if (fx.expect.skipped) {
        expect(out).toEqual({ kind: "skipped", reason: fx.expect.skipped });
        expect(model.calls).toBe(0);
        expect(state.orgUpdates).toEqual([]);
        expect(dms).toEqual([]);
      } else {
        expect(model.calls).toBe(1);
        expect(budget.keys).toEqual([ORG]);
        expect((state.learning!.applied as Array<{ key: string }>).map((a) => a.key)).toEqual(fx.expect.applied);
        expect((state.learning!.noted as Array<{ key: string }>).map((a) => a.key)).toEqual(fx.expect.noted);
        expect((state.learning!.suggestions as Array<{ key: string }>).map((a) => a.key)).toEqual(fx.expect.suggestions);
        expect(dms.length).toBe(fx.expect.dm ? 1 : 0);
        expect(state.learning).toMatchObject({ model: "claude-haiku-4-5", costUsd: 0.011, inputTokens: 9_000, outputTokens: 400 });
      }
      // The chat is deleted once read, whatever came of it, and the group
      // description in the same statement (captured-chat.ts).
      expect(state.connect!.capturedHistory).toBeNull();
      expect(state.connect!.capturedDescription).toBeNull();
      expect(state.raw).toContain(`UPDATE "ClubConnect" SET "capturedHistory" = NULL, "capturedDescription" = NULL WHERE "id" = ?`);
      expect(sdkCalls.n).toBe(0);
    });
  }
});

// Go-live slice D3 (2026-10-12): the description stored beside the chat.
describe("learnClubSetup: the group description", () => {
  /** A stub that keeps what it was sent. */
  function capturing(answer: unknown) {
    const sent: Array<{ system: string; user: string }> = [];
    const model: PipelineModel = {
      name: "stub",
      async complete(req: { system: string; user: string }) {
        sent.push({ system: req.system, user: req.user });
        return {
          text: JSON.stringify(answer),
          stopReason: "end_turn",
          usage: { inputTokens: 9_000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0.011,
          ms: 5,
        };
      },
    } as PipelineModel;
    return { model, sent };
  }

  it("is sent to the model as its own labelled block, with the chat, in ONE call", async () => {
    const fx = setup("description-supports");
    const { model, sent } = capturing(STUB_ANSWERS["description-supports"]);
    await learnClubSetup(ORG, { now: DAYTIME, model });
    expect(sent).toHaveLength(1);
    expect(sent[0].user).toContain(`Group description (one source, written by a group admin, maybe long ago):\n"""\n${fx.description}\n"""`);
    expect(sent[0].user).toContain("Messages (30, oldest first, London time):");
    expect(sent[0].user).toContain("Pay Kemal [number removed]");
  });

  it("a club with no description is told so, and reads exactly as before", async () => {
    setup("rolling");
    const { model, sent } = capturing(STUB_ANSWERS.rolling);
    await learnClubSetup(ORG, { now: DAYTIME, model });
    expect(sent[0].user).toContain("Group description: (none)");
    expect(JSON.stringify(state.learning)).not.toContain("fromDescription");
  });

  it("records which quote is the description's, switches the setting on two sources, and only suggests the fee", async () => {
    setup("description-supports");
    await learnClubSetup(ORG, { now: DAYTIME, model: stub(STUB_ANSWERS["description-supports"]) });
    expect(state.org).toMatchObject({ dropOutDeadlineDay: 2, dropOutDeadlineTime: "18:00" });
    expect(state.learning!.applied).toMatchObject([
      { key: "dropOutDeadline", fromDescription: ["Drop out by Tuesday 6pm or you still pay."] },
    ]);
    expect(state.learning!.suggestions).toEqual([
      {
        key: "matchFee",
        current: "",
        detected: "6",
        evidence: ["£6 a player, pay before kick off."],
        fromDescription: ["£6 a player, pay before kick off."],
      },
    ]);
    // No write touches the weekly game: the fee is the organiser's to enter.
    expect(state.orgUpdates).toHaveLength(1);
    expect(state.orgUpdates[0].data).toEqual({ dropOutDeadlineDay: 2, dropOutDeadlineTime: "18:00" });
    // The DM: both labels, the fee with a link minted to the fee field.
    const text = dms[0].text as string;
    expect(text).toContain(
      `From messages like: "drop out by Tuesday 6pm or you still pay, that hasn't changed"\n` +
        `From your group description: "Drop out by Tuesday 6pm or you still pay."\n`,
    );
    expect(text).toContain(
      `🔎 The match fee looks like £6 a player; your weekly game has no fee set.\n` +
        `From your group description: "£6 a player, pay before kick off."\n` +
        `Set it here: https://mt.link/admin/activities?edit=fee`,
    );
    expect(text).not.toMatch(/removed\]|Pay Kemal/);
  });

  it("the weekly game already has that fee: nothing is suggested", async () => {
    setup("description-supports");
    state.activities[0].feePerPlayer = 6;
    await learnClubSetup(ORG, { now: DAYTIME, model: stub(STUB_ANSWERS["description-supports"]) });
    expect(state.learning!.suggestions).toEqual([]);
  });

  it("a club whose stored squad mode is monthly is never asked about a fee (review fix 5)", async () => {
    setup("description-supports", { squadMode: "monthly" });
    await learnClubSetup(ORG, { now: DAYTIME, model: stub(STUB_ANSWERS["description-supports"]) });
    expect(state.learning!.suggestions).toEqual([]);
    // The deadline is still switched: only the fee is held back.
    expect(state.org).toMatchObject({ dropOutDeadlineDay: 2, dropOutDeadlineTime: "18:00", squadMode: "monthly" });
    expect(state.orgUpdates.every((u) => !("squadMode" in u.data))).toBe(true);
  });

  it("the description twice is one source: nothing is switched", async () => {
    setup("description-stale");
    const wrong = {
      ...STUB_ANSWERS["description-stale"],
      squad: { answer: "rolling", confidence: "high", evidence: ["Squad is the same every week", "only message if you can't play"] },
      drop_out_deadline: { day: "wednesday", time: "12:00", confidence: "high", evidence: ["Drop out by Wednesday noon", "Drop out by Wednesday noon."] },
    };
    await learnClubSetup(ORG, { now: DAYTIME, model: stub(wrong) });
    expect(state.orgUpdates).toEqual([]);
    expect(state.org).toMatchObject({ rollingSquadEnabled: false, dropOutDeadlineDay: null });
    expect(state.learning!.kept).toEqual([
      { key: "rollingSquad", reason: "thin-evidence" },
      { key: "dropOutDeadline", reason: "thin-evidence" },
    ]);
  });

  it("NO READING FROM THE DESCRIPTION ALONE: a chat that fails the gate is not read, and both are deleted", async () => {
    const fx = setup("description-supports");
    state.connect!.capturedHistory = fx.history.slice(0, 5);
    const { model, sent } = capturing(STUB_ANSWERS["description-supports"]);
    expect(await learnClubSetup(ORG, { now: DAYTIME, model })).toEqual({ kind: "skipped", reason: "too-short" });
    expect(sent).toEqual([]);
    expect(state.orgUpdates).toEqual([]);
    expect(dms).toEqual([]);
    expect(state.connect).toMatchObject({ capturedHistory: null, capturedDescription: null });
  });

  it("is deleted with the chat when the model fails for the last time", async () => {
    setup("description-supports");
    state.learning = { status: "deferred", attempts: MAX_ATTEMPTS - 1, updatedAt: new Date(0) };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await learnClubSetup(ORG, { now: DAYTIME, model: stub({}, { fail: true }) })).toMatchObject({ kind: "failed" });
    } finally {
      err.mockRestore();
    }
    expect(state.connect).toMatchObject({ capturedHistory: null, capturedDescription: null });
  });

  it("no log line carries the description, a message, a quote, a name or a number from them", async () => {
    const fx = setup("description-supports");
    const lines: string[] = [];
    const keep = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    const log = vi.spyOn(console, "log").mockImplementation(keep);
    const err = vi.spyOn(console, "error").mockImplementation(keep);
    try {
      await learnClubSetup(ORG, { now: DAYTIME, model: stub(STUB_ANSWERS["description-supports"]) });
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
    const all = lines.join("\n");
    expect(all).toContain("with group description");
    for (const line of fx.description!.split("\n")) expect(all).not.toContain(line);
    for (const leak of ["Kemal", "£6", "Tuesday 6pm", "removed]", "Powerleague", "kick off"]) expect(all, leak).not.toContain(leak);
  });
});

describe("learnClubSetup: writes and the DM", () => {
  it("applies in ONE compare-and-set write that refuses settings the organiser saved", async () => {
    setup("deadlines");
    await learnClubSetup(ORG, { now: DAYTIME, model: stub(STUB_ANSWERS.deadlines) });
    expect(state.orgUpdates).toHaveLength(1);
    expect(state.orgUpdates[0].where).toMatchObject({
      id: ORG,
      approvalStatus: "approved",
      dropOutDeadlineDay: null,
      listPublishDay: null,
      paymentTrackingEnabled: false,
      NOT: { settingsSetByOrganiser: { hasSome: ["dropOutDeadline", "listPublish", "paymentTracking"] } },
    });
    expect(state.org).toMatchObject({ dropOutDeadlineDay: 1, dropOutDeadlineTime: "21:00", listPublishDay: 2, paymentTrackingEnabled: true });
    expect(state.learning).toMatchObject({ status: "applied", messageCount: 32, authorCount: 4 });
  });

  it("the DM goes to the organiser on the platform channel, once, with an undo link per setting", async () => {
    setup("rolling");
    await learnClubSetup(ORG, { now: DAYTIME, model: stub(STUB_ANSWERS.rolling) });
    expect(dms).toEqual([
      expect.objectContaining({ phone: ORGANISER_PHONE, purpose: "setup-learned", refId: `${ORG}:setup-learned`, sendAfter: null }),
    ]);
    expect(dms[0].text).toContain("Undo or change: https://mt.link/admin/settings?learned=rollingSquad#learned-setup");
    expect(dms[0].text).toContain("https://mt.link/admin/settings#learned-setup");
    expect(state.learning!.dmQueuedAt).toEqual(DAYTIME);
  });

  it("organisers pick: NO write to the club, status nothing, and the DM asks with a link to the suggestion", async () => {
    setup("organiser-picks");
    const out = await learnClubSetup(ORG, { now: DAYTIME, model: stub(STUB_ANSWERS["organiser-picks"]) });
    expect(state.orgUpdates).toEqual([]);
    expect(state.org!.benchPickMode).toBe("first-come");
    expect(out).toMatchObject({ kind: "done", status: "nothing", applied: 0, suggestions: 1, dmQueued: true });
    expect(state.learning).toMatchObject({ status: "nothing", applied: [], suggestions: [{ key: "organiserPicks" }] });
    expect(dms).toHaveLength(1);
    expect(dms[0].text).toContain("Switch it on here: https://mt.link/admin/settings?learned=organiserPicks#learned-setup");
    expect(dms[0].text).not.toContain("✅");
  });

  it("a night run queues the DM for 09:00 London", async () => {
    setup("rolling");
    await learnClubSetup(ORG, { now: NIGHT, model: stub(STUB_ANSWERS.rolling) });
    expect(dms[0].sendAfter).toEqual(new Date("2026-10-06T08:00:00Z"));
  });

  it("a 22:30 London run, night under the old 10:00 to 20:00 window, sends at once", async () => {
    setup("rolling");
    await learnClubSetup(ORG, { now: new Date("2026-10-05T21:30:00Z"), model: stub(STUB_ANSWERS.rolling) });
    expect(dms[0].sendAfter).toBeNull();
  });

  it("never a second DM: an existing setup-learned job for the club stops it", async () => {
    setup("rolling");
    dbMock.platformJob.findFirst.mockResolvedValueOnce({ id: "old" } as never);
    await learnClubSetup(ORG, { now: DAYTIME, model: stub(STUB_ANSWERS.rolling) });
    expect(dms).toEqual([]);
  });

  it("a setting the organiser saved on the website is never changed, and the club moving under us is re-planned", async () => {
    setup("rolling", { settingsSetByOrganiser: ["rollingSquad"] });
    await learnClubSetup(ORG, { now: DAYTIME, model: stub(STUB_ANSWERS.rolling) });
    expect(state.org!.rollingSquadEnabled).toBe(false);
    expect(state.learning).toMatchObject({ status: "nothing", kept: [{ key: "rollingSquad", reason: "organiser-set" }] });
    expect(dms).toEqual([]);
  });

  it("the organiser saving the setting between the read and the write: nothing is overwritten", async () => {
    setup("rolling");
    // The first read sees defaults; by the write the organiser has saved it.
    dbMock.organisation.findFirst.mockImplementationOnce(async () => {
      const snapshot = { ...state.org! };
      state.org!.settingsSetByOrganiser = ["rollingSquad"];
      return snapshot;
    });
    await learnClubSetup(ORG, { now: DAYTIME, model: stub(STUB_ANSWERS.rolling) });
    expect(state.org!.rollingSquadEnabled).toBe(false);
    expect(state.learning!.applied).toEqual([]);
  });
});

describe("learnClubSetup and a club that is approved but setting up (go-live S1, plan 2.2 point 1)", () => {
  const HELD = { whatsappBotEnabled: false, approvalStatus: "approved", setupStage: "setting-up" };

  it("a held club (bot off) IS read, through the setup-reading budget scope", async () => {
    setup("rolling", HELD);
    const model = stub(STUB_ANSWERS.rolling);
    const out = await learnClubSetup(ORG, { now: DAYTIME, model });
    expect(out).toMatchObject({ kind: "done", status: "applied", applied: 1 });
    expect(model.calls).toBe(1);
    expect(budget.keys).toEqual([ORG]);
    expect(state.org!.rollingSquadEnabled).toBe(true);
  });

  it("go-live S3: a held club gets NO separate findings DM (its one setup DM carries the findings)", async () => {
    setup("rolling", HELD);
    const out = await learnClubSetup(ORG, { now: DAYTIME, model: stub(STUB_ANSWERS.rolling) });
    expect(out).toMatchObject({ kind: "done", status: "applied", applied: 1, dmQueued: false });
    expect(dms).toEqual([]);
    expect(state.learning!.dmQueuedAt).toBeUndefined();
    // What the setup DM needs is on the row.
    expect(state.learning!.applied).toEqual([expect.objectContaining({ key: "rollingSquad" })]);
  });

  it("its write is a compare-and-set on the club STILL setting up", async () => {
    setup("rolling", HELD);
    await learnClubSetup(ORG, { now: DAYTIME, model: stub(STUB_ANSWERS.rolling) });
    expect(state.orgUpdates).toHaveLength(1);
    expect(state.orgUpdates[0].where).toMatchObject({ id: ORG, approvalStatus: "approved", setupStage: "setting-up" });
  });

  it("the club went live between the read and the write: NOTHING is applied, even on the re-plan", async () => {
    setup("rolling", HELD);
    // The first read sees it held; by the write the organiser has said GO.
    dbMock.organisation.findFirst.mockImplementationOnce(async () => {
      const snapshot = { ...state.org! };
      Object.assign(state.org!, { setupStage: "live", whatsappBotEnabled: true });
      return snapshot;
    });
    const out = await learnClubSetup(ORG, { now: DAYTIME, model: stub(STUB_ANSWERS.rolling) });
    expect(state.org!.rollingSquadEnabled).toBe(false);
    expect(out).toMatchObject({ kind: "done", status: "nothing", applied: 0 });
    expect(state.learning).toMatchObject({ status: "nothing", applied: [], kept: [{ key: "rollingSquad", reason: "went-live" }] });
    // Both attempts carried the stage, so neither could land on a live club.
    expect(state.orgUpdates.length).toBeGreaterThanOrEqual(1);
    for (const u of state.orgUpdates) expect(u.where).toMatchObject({ setupStage: "setting-up" });
  });

  it("review fix 4: the club was SUSPENDED mid-reading: nothing applied, and the record says so (not 'went-live')", async () => {
    setup("rolling", HELD);
    // The read sees it held; the write is refused; the reload finds no approved club.
    dbMock.organisation.findFirst
      .mockImplementationOnce(async () => ({ ...state.org! }))
      .mockImplementationOnce(async () => null);
    dbMock.organisation.updateMany.mockImplementationOnce(async (args: { where: Row; data: Row }) => {
      state.orgUpdates.push(args);
      return { count: 0 };
    });
    const out = await learnClubSetup(ORG, { now: DAYTIME, model: stub(STUB_ANSWERS.rolling) });
    expect(out).toMatchObject({ kind: "done", status: "nothing", applied: 0 });
    expect(state.org!.rollingSquadEnabled).toBe(false);
    expect(state.learning).toMatchObject({ applied: [], kept: [{ key: "rollingSquad", reason: "no-longer-approved" }] });
    expect(state.orgUpdates).toHaveLength(1);
  });

  it("a club that was never held is written as before: no stage in the WHERE, and only while it has no go-live stamp", async () => {
    setup("rolling", { approvalStatus: "approved", setupStage: "live" });
    await learnClubSetup(ORG, { now: DAYTIME, model: stub(STUB_ANSWERS.rolling) });
    expect(state.orgUpdates).toHaveLength(1);
    expect(state.orgUpdates[0].where).not.toHaveProperty("setupStage");
    expect(state.orgUpdates[0].where).toMatchObject({ approvalStatus: "approved", liveAt: null });
    expect(state.org!.rollingSquadEnabled).toBe(true);
  });
});

describe("PR #235 review fix 5: a reading that was CLOSED while it was in flight changes nothing", () => {
  const HELD = { whatsappBotEnabled: false, approvalStatus: "approved", setupStage: "setting-up" };
  /** The 2-hour cap (or go-live) closes the row while the model is still answering. */
  const closedMidCall = (answer: unknown, opts: { fail?: boolean } = {}): PipelineModel => ({
    name: "closed-mid-call",
    async complete() {
      state.learning = { ...state.learning!, status: "skipped", reason: "timed-out" };
      if (opts.fail) throw new Error("529 overloaded");
      return {
        text: JSON.stringify(answer),
        stopReason: "end_turn",
        usage: { inputTokens: 9_000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.011,
        ms: 5,
      };
    },
  });

  it("the late result applies NOTHING and does not overwrite the closed row", async () => {
    setup("rolling", HELD);
    const out = await learnClubSetup(ORG, { now: DAYTIME, model: closedMidCall(STUB_ANSWERS.rolling) });
    expect(out).toEqual({ kind: "skipped", reason: "closed" });
    // No settings write was even attempted, and the club is as it was.
    expect(state.orgUpdates).toEqual([]);
    expect(state.org!.rollingSquadEnabled).toBe(false);
    // The row is still the closed one: no detection, no applied list, no cost written over it.
    expect(state.learning).toMatchObject({ status: "skipped", reason: "timed-out" });
    expect(state.learning!.applied).toBeUndefined();
    expect(state.learning!.detected).toBeUndefined();
    expect(dms).toEqual([]);
  });

  it("a model error arriving after the close does not put the row back to 'deferred' (it would be read again)", async () => {
    setup("rolling", HELD);
    const out = await learnClubSetup(ORG, { now: DAYTIME, model: closedMidCall(null, { fail: true }) });
    expect(out).toEqual({ kind: "skipped", reason: "closed" });
    expect(state.learning).toMatchObject({ status: "skipped", reason: "timed-out" });
  });

  it("the settings write and the record are ONE transaction, taken on the reading row first", async () => {
    setup("rolling", HELD);
    await learnClubSetup(ORG, { now: DAYTIME, model: stub(STUB_ANSWERS.rolling) });
    expect(dbMock.$transaction).toHaveBeenCalledTimes(1);
    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder;
    // The reading row is locked (a compare-and-set on "running") before the club is written.
    const firstRowWrite = order(dbMock.clubSetupLearning.updateMany)[0];
    expect(firstRowWrite).toBeLessThan(order(dbMock.organisation.updateMany)[0]);
    expect(state.learning).toMatchObject({ status: "applied" });
    expect(state.org!.rollingSquadEnabled).toBe(true);
  });

  it("a club that was never held is read, switched and recorded exactly as before", async () => {
    setup("rolling");
    const out = await learnClubSetup(ORG, { now: DAYTIME, model: stub(STUB_ANSWERS.rolling) });
    expect(out).toMatchObject({ kind: "done", status: "applied", applied: 1, dmQueued: true });
    expect(state.learning).toMatchObject({ status: "applied" });
    expect(dms).toHaveLength(1);
  });
});

describe("review fix 1: a club that has been through the hold is never read once it is live", () => {
  const WENT_LIVE = {
    whatsappBotEnabled: true,
    approvalStatus: "approved",
    setupStage: "live",
    liveAt: new Date("2026-10-05T10:05:00Z"),
  };

  it("deferred at 10:00, live at 10:05, swept at 10:15: NOT read, nothing switched, the row not even claimed", async () => {
    setup("rolling", WENT_LIVE);
    state.learning = { status: "deferred", reason: "model-error", attempts: 1, updatedAt: new Date("2026-10-05T10:00:00Z") };
    const model = stub(STUB_ANSWERS.rolling);
    const out = await learnClubSetup(ORG, { now: new Date("2026-10-05T10:15:00Z"), model });
    expect(out).toEqual({ kind: "not-eligible" });
    expect(model.calls).toBe(0);
    expect(budget.keys).toEqual([]);
    expect(state.orgUpdates).toEqual([]);
    expect(state.org!.rollingSquadEnabled).toBe(false);
    expect(state.learning).toMatchObject({ status: "deferred", attempts: 1 });
    expect(dms).toEqual([]);
  });

  it("went live before its first sweep: NOT read, no row created", async () => {
    setup("rolling", WENT_LIVE);
    const model = stub(STUB_ANSWERS.rolling);
    expect(await learnClubSetup(ORG, { now: DAYTIME, model })).toEqual({ kind: "not-eligible" });
    expect(model.calls).toBe(0);
    expect(dbMock.clubSetupLearning.create).not.toHaveBeenCalled();
    expect(state.org!.rollingSquadEnabled).toBe(false);
  });

  it("an existing club (no go-live stamp, bot on) is read and switched exactly as before", async () => {
    setup("rolling");
    const out = await learnClubSetup(ORG, { now: DAYTIME, model: stub(STUB_ANSWERS.rolling) });
    expect(out).toMatchObject({ kind: "done", status: "applied", applied: 1 });
    expect(state.org!.rollingSquadEnabled).toBe(true);
  });
});

describe("learnClubSetup: once per club, and only for a newly approved self-join club", () => {
  it("a second run finds the row taken and calls nothing", async () => {
    setup("rolling");
    await learnClubSetup(ORG, { now: DAYTIME, model: stub(STUB_ANSWERS.rolling) });
    const again = stub(STUB_ANSWERS.rolling);
    expect(await learnClubSetup(ORG, { now: DAYTIME, model: again })).toEqual({ kind: "taken" });
    expect(again.calls).toBe(0);
  });

  it("Sutton FC (approved by the column default, no approvedAt) is never read", async () => {
    setup("rolling", { approvedAt: null });
    const model = stub(STUB_ANSWERS.rolling);
    expect(await learnClubSetup(ORG, { now: DAYTIME, model })).toEqual({ kind: "not-eligible" });
    expect(model.calls).toBe(0);
    expect(dbMock.clubSetupLearning.create).not.toHaveBeenCalled();
  });

  it("an unapproved club is never read (the query asks for approved only)", async () => {
    setup("rolling");
    state.org = null; // what the APPROVED_CLUB_WHERE query returns for a pending club
    expect(await learnClubSetup(ORG, { now: DAYTIME, model: stub({}) })).toEqual({ kind: "not-eligible" });
  });
});

describe("learnClubSetup: inside the club's AI cap, and failing safe", () => {
  it("at the cap: no call, deferred, the chat kept for a later sweep", async () => {
    setup("rolling");
    budget.capped = true;
    const model = stub(STUB_ANSWERS.rolling);
    expect(await learnClubSetup(ORG, { now: DAYTIME, model })).toEqual({ kind: "deferred", reason: "ai-cap" });
    expect(model.calls).toBe(0);
    expect(state.learning).toMatchObject({ status: "deferred", reason: "ai-cap" });
    expect(state.connect!.capturedHistory).not.toBeNull();
    expect(state.orgUpdates).toEqual([]);
  });

  it("a model error is retried by later sweeps, then given up after MAX_ATTEMPTS with nothing changed", async () => {
    setup("rolling");
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const out = await learnClubSetup(ORG, { now: DAYTIME, model: stub({}, { fail: true }) });
      expect(out).toEqual(i < MAX_ATTEMPTS ? { kind: "deferred", reason: "model-error" } : { kind: "failed", reason: "model-error" });
    }
    expect(state.learning).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
    expect(state.connect!.capturedHistory).toBeNull();
    expect(state.orgUpdates).toEqual([]);
    expect(dms).toEqual([]);
  });

  it("a response that is not JSON changes nothing", async () => {
    setup("rolling");
    const m: PipelineModel = {
      name: "stub",
      complete: async () => ({
        text: "I think it is rolling",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        ms: 1,
      }),
    };
    expect(await learnClubSetup(ORG, { now: DAYTIME, model: m })).toEqual({ kind: "deferred", reason: "model-error" });
    expect(state.orgUpdates).toEqual([]);
  });

  it("no closed connect request (no organiser to tell): skipped, no call", async () => {
    setup("rolling");
    state.connect = null;
    const model = stub(STUB_ANSWERS.rolling);
    expect(await learnClubSetup(ORG, { now: DAYTIME, model })).toEqual({ kind: "skipped", reason: "no-organiser" });
    expect(model.calls).toBe(0);
  });
});

describe("runSetupLearningSweep", () => {
  it("flag off: reads nothing at all", async () => {
    const r = await runSetupLearningSweep(DAYTIME, { enabled: false });
    expect(r).toEqual({ enabled: false, considered: 0, outcomes: [] });
    expect(dbMock.organisation.findMany).not.toHaveBeenCalled();
  });

  it("flag on: approved, serving, live clubs approved in the last 3 days and not read yet, 5 at a time", async () => {
    setup("rolling");
    state.dueOrgs = [{ id: ORG }];
    const r = await runSetupLearningSweep(DAYTIME, { enabled: true, model: stub(STUB_ANSWERS.rolling) });
    expect(r.considered).toBe(1);
    expect(r.outcomes[0].outcome).toMatchObject({ kind: "done", status: "applied", applied: 1, dmQueued: true });
    const args = state.findManyArgs[0] as { where: Row; take: number };
    expect(args.take).toBe(5);
    expect(args.where).toMatchObject({
      approvalStatus: "approved",
      approvedAt: { gte: new Date(DAYTIME.getTime() - 3 * 24 * 60 * 60 * 1000) },
    });
    expect(JSON.stringify(args.where.OR)).toContain('"is":null');
  });

  it("go-live S1: the selection is 'bot on, OR approved and setting up' (a held club has its bot off)", async () => {
    await runSetupLearningSweep(DAYTIME, { enabled: true, model: stub(STUB_ANSWERS.rolling) });
    const where = (state.findManyArgs[0] as { where: Row }).where;
    // "Bot on" counts only for a club that was never held (review fix 1): a
    // club that has gone live is never selected again.
    expect(where.AND).toEqual([
      { OR: [{ whatsappBotEnabled: true, liveAt: null }, { approvalStatus: "approved", setupStage: "setting-up" }] },
    ]);
    // Never "any club whose bot is off": a muted live club is still left out.
    expect(where).not.toHaveProperty("whatsappBotEnabled");
  });

  it("the env flag is off unless explicitly on", async () => {
    const { isSetupLearningEnabled } = await import("../flag");
    expect(isSetupLearningEnabled({})).toBe(false);
    expect(isSetupLearningEnabled({ SETUP_LEARNING_ENABLED: "0" })).toBe(false);
    expect(isSetupLearningEnabled({ SETUP_LEARNING_ENABLED: "on" })).toBe(true);
  });
});
