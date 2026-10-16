/**
 * Conversational replies before bulk sends, through the real
 * `computeDuePosts` with Prisma mocked (the proxy pattern of
 * seed-nudge-scheduler.test.ts). No model anywhere.
 *
 * The FNF case (2026-10-16): 16 pay-link BotJobs and the collector's
 * summary queued at 22:39, then Akram's "I've transferred already" at
 * 22:46 queued a reply and a collector notice. The Pi sends the FIRST DM
 * in the list once a minute, so the reply waited behind every pay link.
 *
 * Flag OFF: exactly today's single BotJob query and today's order.
 * Flag ON: the reply and the collector notice are the first DMs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Overrides = Record<string, Record<string, (...a: unknown[]) => unknown>>;
const overrides: Overrides = {};

function defaultFor(method: string) {
  if (method === "findMany" || method === "groupBy") return async () => [];
  if (method === "count") return async () => 0;
  if (method === "findFirst" || method === "findUnique") return async () => null;
  return async () => ({});
}

vi.mock("@/lib/db", () => ({
  db: new Proxy(
    {},
    {
      get: (_t, model: string) =>
        new Proxy({}, { get: (_t2, method: string) => overrides[model]?.[method] ?? defaultFor(method) }),
    },
  ),
}));

vi.mock("@/lib/org-features", () => ({
  getOrgFeatures: async () => ({
    botEnabled: true,
    attendance: true,
    bench: true,
    teamBalancing: true,
    momVoting: true,
    playerRating: true,
    reminders: true,
    statsQa: true,
    paymentTracking: true,
    paymentCollection: true,
    squadFromList: false,
    language: "en",
    rollingSquad: false,
    benchPickMode: "first-come",
    badgeAnnouncements: false,
    squadMode: "weekly",
  }),
}));
vi.mock("@/lib/message-analyzer", () => ({ composeChaseText: async () => "MODEL TEXT" }));
vi.mock("@/lib/team-proposal", () => ({ teamProposalJobs: async () => 0 }));

import { computeDuePosts } from "@/lib/bot-scheduler";

const GROUP = "group-fnf@g.us";
const ORG_ID = "org-fnf";
const NOW = new Date("2026-10-16T21:47:00.000Z"); // 22:47 London
const RELEASE = new Date("2026-10-16T21:39:00.000Z"); // 22:39 London
const CLAIM = new Date("2026-10-16T21:46:00.000Z"); // 22:46 London
const COLLECTOR = "447700222222";
const AKRAM = "447700555555";

interface Job {
  id: string;
  orgId: string;
  kind: string;
  phone: string | null;
  text: string;
  pollQuestion: null;
  pollOptions: string[];
  pollMulti: boolean;
  sendAfter: Date | null;
  sentAt: Date | null;
  createdAt: Date;
  priority: number;
}

const job = (id: string, over: Partial<Job>): Job => ({
  id,
  orgId: ORG_ID,
  kind: "dm",
  phone: null,
  text: id,
  pollQuestion: null,
  pollOptions: [],
  pollMulti: false,
  sendAfter: null,
  sentAt: null,
  createdAt: RELEASE,
  priority: 0,
  ...over,
});

/** A tiny in-memory BotJob table that honours the `where` shapes the
 *  scheduler uses, so the test is about ORDER, not about the mock. */
function matches(j: Job, where: Record<string, unknown>): boolean {
  if (where.orgId !== undefined && j.orgId !== where.orgId) return false;
  if ("sentAt" in where && where.sentAt === null && j.sentAt !== null) return false;
  if (where.kind !== undefined && j.kind !== where.kind) return false;
  const pr = where.priority as { gt?: number } | undefined;
  if (pr?.gt !== undefined && !(j.priority > pr.gt)) return false;
  const ph = where.phone as { in?: string[] } | undefined;
  if (ph?.in && !(j.phone !== null && ph.in.includes(j.phone))) return false;
  const ca = where.createdAt as { lte?: Date } | undefined;
  if (ca?.lte && !(j.createdAt.getTime() <= ca.lte.getTime())) return false;
  const or = where.OR as Array<Record<string, unknown>> | undefined;
  if (or) {
    const ok = or.some((c) => {
      if ("sendAfter" in c && c.sendAfter === null) return j.sendAfter === null;
      const sa = c.sendAfter as { lte?: Date } | undefined;
      if (sa?.lte) return j.sendAfter !== null && j.sendAfter.getTime() <= sa.lte.getTime();
      return false;
    });
    if (!ok) return false;
  }
  return true;
}

let table: Job[] = [];
let botJobCalls: unknown[] = [];

function setWorld(jobs: Job[]) {
  for (const k of Object.keys(overrides)) delete overrides[k];
  table = jobs;
  botJobCalls = [];
  overrides.organisation = {
    findFirst: async () => ({
      id: ORG_ID,
      name: "FNF",
      whatsappGroupId: GROUP,
      whatsappBotEnabled: true,
      approvedAt: null,
      setupStage: "live",
      language: "en",
    }),
  };
  overrides.botJob = {
    findMany: async (args: unknown) => {
      botJobCalls.push(args);
      const a = args as { where: Record<string, unknown>; take?: number };
      const rows = table
        .map((j, i) => ({ j, i }))
        .filter(({ j }) => matches(j, a.where))
        .sort((x, y) => x.j.createdAt.getTime() - y.j.createdAt.getTime() || x.i - y.i)
        .map(({ j }) => j);
      return a.take ? rows.slice(0, a.take) : rows;
    },
  };
}

/** The FNF night: 16 pay links + the collector's summary, then the claim. */
function fnfNight(): Job[] {
  const jobs: Job[] = [];
  for (let i = 0; i < 16; i++) {
    jobs.push(
      job(`pay${String(i).padStart(2, "0")}`, {
        phone: `4477009000${String(i).padStart(2, "0")}`,
        createdAt: new Date(RELEASE.getTime() + i),
      }),
    );
  }
  jobs.push(job("summary", { phone: COLLECTOR, createdAt: new Date(RELEASE.getTime() + 100) }));
  jobs.push(job("reply-akram", { phone: AKRAM, createdAt: CLAIM, priority: 1, text: "Thanks Akram, I've told Raihan..." }));
  jobs.push(
    job("collector-notice", { phone: COLLECTOR, createdAt: new Date(CLAIM.getTime() + 5), priority: 1 }),
  );
  return jobs;
}

const dmKeys = (r: Awaited<ReturnType<typeof computeDuePosts>>) =>
  (r?.instructions ?? []).filter((i) => i.kind === "dm").map((i) => i.key);

beforeEach(() => setWorld([]));

describe("flag OFF: byte-identical to today", () => {
  it("one BotJob query with today's exact arguments, and today's order", async () => {
    setWorld(fnfNight());
    const r = await computeDuePosts(GROUP, NOW);
    expect(botJobCalls).toEqual([
      {
        where: { orgId: ORG_ID, sentAt: null, OR: [{ sendAfter: null }, { sendAfter: { lte: NOW } }] },
        orderBy: { createdAt: "asc" },
        take: 20,
      },
    ]);
    const keys = dmKeys(r);
    expect(keys[0]).toBe("botjob-pay00");
    expect(keys.slice(-2)).toEqual(["botjob-reply-akram", "botjob-collector-notice"]);
  });

  it("passing the option as false is the same as not passing it", async () => {
    setWorld(fnfNight());
    const a = await computeDuePosts(GROUP, NOW);
    const callsA = botJobCalls;
    setWorld(fnfNight());
    const b = await computeDuePosts(GROUP, NOW, undefined, null, null, { replyPriority: false });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(botJobCalls).toEqual(callsA);
  });

  it("a reply queued beyond the first 20 is not even fetched (today's take: 20)", async () => {
    const jobs = fnfNight().filter((j) => j.priority === 0);
    for (let i = 0; i < 6; i++) jobs.push(job(`more${i}`, { phone: `44770080000${i}`, createdAt: new Date(RELEASE.getTime() + 200 + i) }));
    jobs.push(job("reply-akram", { phone: AKRAM, createdAt: CLAIM, priority: 1 }));
    setWorld(jobs);
    const keys = dmKeys(await computeDuePosts(GROUP, NOW));
    expect(keys).toHaveLength(20);
    expect(keys).not.toContain("botjob-reply-akram");
  });
});

describe("flag ON: the conversation goes first", () => {
  it("the reply and the collector notice are the first two DMs, the pay links follow in order", async () => {
    setWorld(fnfNight());
    const keys = dmKeys(await computeDuePosts(GROUP, NOW, undefined, null, null, { replyPriority: true }));
    // Precisely: Akram's reply first; the collector's own earlier summary
    // stays ahead of the collector's notice (per-recipient order), so the
    // collector's two DMs come next, in their own order.
    expect(keys.slice(0, 3)).toEqual(["botjob-reply-akram", "botjob-summary", "botjob-collector-notice"]);
    expect(keys.slice(3)).toEqual(Array.from({ length: 16 }, (_, i) => `botjob-pay${String(i).padStart(2, "0")}`));
  });

  it("a reply queued beyond the first 20 is fetched and goes first", async () => {
    const jobs = fnfNight().filter((j) => j.priority === 0);
    for (let i = 0; i < 6; i++) jobs.push(job(`more${i}`, { phone: `44770080000${i}`, createdAt: new Date(RELEASE.getTime() + 200 + i) }));
    jobs.push(job("reply-akram", { phone: AKRAM, createdAt: CLAIM, priority: 1 }));
    setWorld(jobs);
    const keys = dmKeys(await computeDuePosts(GROUP, NOW, undefined, null, null, { replyPriority: true }));
    expect(keys[0]).toBe("botjob-reply-akram");
    expect(keys).toHaveLength(21);
  });

  it("per recipient: Akram's own unsent pay link goes out just before his reply, even if it was not in the first 20", async () => {
    const jobs: Job[] = [];
    for (let i = 0; i < 20; i++) jobs.push(job(`pay${String(i).padStart(2, "0")}`, { phone: `4477009000${String(i).padStart(2, "0")}`, createdAt: new Date(RELEASE.getTime() + i) }));
    jobs.push(job("pay-akram", { phone: AKRAM, createdAt: new Date(RELEASE.getTime() + 50) }));
    jobs.push(job("reply-akram", { phone: AKRAM, createdAt: CLAIM, priority: 1 }));
    setWorld(jobs);
    const keys = dmKeys(await computeDuePosts(GROUP, NOW, undefined, null, null, { replyPriority: true }));
    expect(keys.slice(0, 2)).toEqual(["botjob-pay-akram", "botjob-reply-akram"]);
    expect(keys.slice(2)).toEqual(Array.from({ length: 20 }, (_, i) => `botjob-pay${String(i).padStart(2, "0")}`));
  });

  it("a future-dated priority job is still not due", async () => {
    const jobs = fnfNight().filter((j) => j.priority === 0);
    jobs.push(job("later", { phone: AKRAM, createdAt: CLAIM, priority: 1, sendAfter: new Date(NOW.getTime() + 60_000) }));
    setWorld(jobs);
    const keys = dmKeys(await computeDuePosts(GROUP, NOW, undefined, null, null, { replyPriority: true }));
    expect(keys).not.toContain("botjob-later");
    expect(keys[0]).toBe("botjob-pay00");
  });

  it("with no reply queued the order is today's", async () => {
    setWorld(fnfNight().filter((j) => j.priority === 0));
    const on = await computeDuePosts(GROUP, NOW, undefined, null, null, { replyPriority: true });
    setWorld(fnfNight().filter((j) => j.priority === 0));
    const off = await computeDuePosts(GROUP, NOW);
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
  });

  it("fails open: if the extra query throws, today's 20 rows are served (a reply among them still first)", async () => {
    // Reply beyond the first 20: the failed extra query means it waits, as today.
    const jobs = fnfNight().filter((j) => j.priority === 0);
    for (let i = 0; i < 6; i++) jobs.push(job(`more${i}`, { phone: `44770080000${i}`, createdAt: new Date(RELEASE.getTime() + 200 + i) }));
    jobs.push(job("reply-akram", { phone: AKRAM, createdAt: CLAIM, priority: 1 }));
    setWorld(jobs);
    const base = overrides.botJob.findMany;
    let n = 0;
    overrides.botJob.findMany = async (args: unknown) => {
      if (++n > 1) throw new Error("db hiccup");
      return base(args);
    };
    const far = dmKeys(await computeDuePosts(GROUP, NOW, undefined, null, null, { replyPriority: true }));
    expect(far).toHaveLength(20);
    expect(far[0]).toBe("botjob-pay00");
    expect(far).not.toContain("botjob-reply-akram");

    // Reply inside the first 20: still moved to the front.
    setWorld(fnfNight());
    const base2 = overrides.botJob.findMany;
    let m = 0;
    overrides.botJob.findMany = async (args: unknown) => {
      if (++m > 1) throw new Error("db hiccup");
      return base2(args);
    };
    const near = dmKeys(await computeDuePosts(GROUP, NOW, undefined, null, null, { replyPriority: true }));
    expect(near[0]).toBe("botjob-reply-akram");
    expect(near).toHaveLength(19);
  });
});
