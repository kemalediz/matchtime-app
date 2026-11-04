/**
 * WHAT THE SCHEDULER DECIDES TODAY, PINNED (club summary, slice A1,
 * MDs/club-summary-design-2026-11-04.md section 4.2).
 *
 * Written FIRST, on the scheduler as it was before A1, and run green there:
 * A1 moves the scheduler onto the club summary and must leave every value
 * exactly as it was, so this snapshot must not change.
 *
 * For each club shape of the summary's fixtures (plus three variants that
 * reach the paths A1 touches: a drop-out deadline and payment tracking with
 * an admin group, a monthly club with a held month and a month in sign-up,
 * and a self-join club that has not been introduced yet) and twenty-six
 * instants from 2 November to 7 December:
 *   - `computeDuePosts` called directly (no preloaded months), every
 *     instruction it hands out;
 *   - the whole due-posts poll (the route, not in preview, so the sweeps,
 *     the drop-out deadline summary and the unpaid list run), every
 *     instruction the Pi is handed and every BotJob queued on the way.
 * The database is a fake world (fixtures/scheduler-world.ts) that answers
 * every read before and after A1 from the same rows. No model: the chase
 * composer is replaced by a fixed text.
 *
 * The same fake counts the reads one poll makes; the last test prints them
 * (the query count before and after A1).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FNF, MUTED, RATINGS, SUTTON, VETS, featuresFor, orgRow, month } from "../club-summary/__tests__/fixtures";
import type { ClubRows } from "../club-summary/derive";
import { fakeSchedulerDb, schedulerWorld, type Call } from "./fixtures/scheduler-world";

const state: { db: unknown } = { db: null };
const calls: Call[] = [];

vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
}));
vi.mock("@/lib/message-analyzer", () => ({
  composeChaseText: async (a: { kind: string; matchId: string }) => `COMPOSED ${a.kind} ${a.matchId}`,
}));
vi.mock("@/lib/short-link", () => ({ buildShortMagicLinkUrl: async (_u: unknown, next?: string) => `https://mt.test/l/${next ?? "x"}` }));
vi.mock("@/lib/magic-link", () => ({
  signMagicLinkToken: () => "token",
  MAGIC_LINK_TTL: { bookmark: 1, actionNudge: 1 },
}));

import { computeDuePosts } from "@/lib/bot-scheduler";
import { GET as duePosts } from "@/app/api/whatsapp/due-posts/route";

const d = (iso: string) => new Date(iso);

// ── The shapes ─────────────────────────────────────────────────────────

/** FNF with a drop-out deadline (Thursday 18:00, list Friday 09:00),
 *  payment tracking on and a completed game two days back: the deadline
 *  summary and the unpaid list are both due in the week. */
const FNF_RHYTHM_ORG = orgRow({
  ...FNF.org,
  dropOutDeadlineDay: 4,
  dropOutDeadlineTime: "18:00",
  listPublishDay: 5,
  listPublishTime: "09:00",
  paymentTrackingEnabled: true,
  paymentHolderId: "u-fnf-org",
});
const FNF_RHYTHM: ClubRows = {
  ...FNF,
  org: FNF_RHYTHM_ORG,
  features: featuresFor(FNF_RHYTHM_ORG),
  collectorName: "Rafi",
  matches: [
    { ...FNF.matches[0], id: "m-fnf-30oct", date: d("2026-10-30T20:00:00Z"), status: "COMPLETED", attendances: FNF.matches[0].attendances.map(() => ({ status: "CONFIRMED" })) },
    ...FNF.matches,
  ],
};

/** The Vets with December in sign-up (its list open) and a held key for
 *  January, plus a game in each. */
const VETS_DEC = month({ id: "sm-vets-dec", activityId: VETS.activities[0].id, monthStart: d("2026-12-01T00:00:00Z"), status: "open", listOpenedAt: d("2026-11-03T10:00:00Z"), createdAt: d("2026-11-03T10:00:00Z") }, { regulars: 9 });
const VETS_SIGNUP: ClubRows = {
  ...VETS,
  months: [...VETS.months, VETS_DEC],
  heldKeys: [],
};

/** A self-join club approved but never introduced, with a priced month. */
const SELF_JOIN_ORG = orgRow({ id: "org-new", name: "New Club", squadMode: "monthly", paymentTrackingEnabled: true, paygPricePence: 500 });

const SHAPES: Record<string, { rows: ClubRows; held?: string[]; approvedAt?: Date }> = {
  sutton: { rows: SUTTON },
  fnf: { rows: FNF },
  "fnf-rhythm": { rows: FNF_RHYTHM },
  vets: { rows: VETS },
  "vets-signup": { rows: VETS_SIGNUP, held: [`org-${VETS.org.id}:msu:held:2027-01-01:${VETS.activities[0].id}`] },
  ratings: { rows: RATINGS },
  muted: { rows: MUTED },
  "self-join": {
    rows: {
      ...VETS,
      org: SELF_JOIN_ORG,
      features: featuresFor(SELF_JOIN_ORG),
      collectorName: null,
      months: [month({ id: "sm-new-nov", activityId: VETS.activities[0].id, monthStart: d("2026-11-01T00:00:00Z"), status: "priced", pricedAt: d("2026-11-01T10:00:00Z") }, { regulars: 10 })],
    },
    approvedAt: d("2026-10-01T10:00:00Z"),
  },
};

/** London is on GMT all week: UTC is London time. */
const INSTANTS = [
  "2026-11-02T09:05:00Z",
  "2026-11-02T10:05:00Z",
  "2026-11-02T17:05:00Z",
  "2026-11-02T18:05:00Z",
  "2026-11-02T21:30:00Z",
  "2026-11-03T10:05:00Z",
  "2026-11-03T17:05:00Z",
  "2026-11-03T18:30:00Z",
  "2026-11-03T23:00:00Z",
  "2026-11-04T09:05:00Z",
  "2026-11-04T12:00:00Z",
  "2026-11-04T18:05:00Z",
  "2026-11-05T10:05:00Z",
  "2026-11-05T17:05:00Z",
  "2026-11-05T18:05:00Z",
  "2026-11-06T10:05:00Z",
  "2026-11-06T16:30:00Z",
  "2026-11-06T18:05:00Z",
  "2026-11-08T10:05:00Z",
  "2026-11-08T18:05:00Z",
  // The Vets' later games: 16 November (November running, not seeded yet)
  // and 7 December (December in sign-up, or no month at all).
  "2026-11-13T10:05:00Z",
  "2026-11-15T17:05:00Z",
  "2026-11-16T10:05:00Z",
  "2026-12-03T10:05:00Z",
  "2026-12-06T17:05:00Z",
  "2026-12-07T18:05:00Z",
].map(d);

function worldFor(name: string) {
  const shape = SHAPES[name];
  const w = schedulerWorld(shape.rows);
  if (shape.approvedAt) w.org.approvedAt = shape.approvedAt;
  for (const key of [...(shape.rows.heldKeys ?? []), ...(shape.held ?? [])]) w.sent.push({ key, kind: "group-message", createdAt: d("2026-10-20T10:00:00Z") });
  // One player has paid for FNF's last game, so the unpaid list has
  // something honest to say (it says nothing while nobody has paid).
  if (name === "fnf-rhythm") {
    const done = w.matches.find((m) => m.id === "m-fnf-30oct")!;
    (done.attendances as Array<Record<string, unknown>>)[0].paidAt = d("2026-10-31T10:00:00Z");
  }
  return w;
}

const groupOf = (name: string) => String(SHAPES[name].rows.org.whatsappGroupId);

let env: Record<string, string | undefined>;
beforeAll(() => {
  env = { MT_TEST_MODE: process.env.MT_TEST_MODE, WHATSAPP_API_KEY: process.env.WHATSAPP_API_KEY };
  process.env.MT_TEST_MODE = "1";
  process.env.WHATSAPP_API_KEY = "test-key";
});
afterAll(() => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function direct(name: string, now: Date) {
  calls.length = 0;
  state.db = fakeSchedulerDb(worldFor(name), calls);
  const res = await computeDuePosts(groupOf(name), now);
  return res?.instructions ?? null;
}

async function poll(name: string, now: Date) {
  calls.length = 0;
  state.db = fakeSchedulerDb(worldFor(name), calls);
  const req = new Request(`http://localhost/api/whatsapp/due-posts?groupId=${encodeURIComponent(groupOf(name))}`, {
    headers: { "x-api-key": "test-key", "x-test-now": now.toISOString(), "x-mt-pi-caps": "admin-group" },
  });
  const res = await duePosts(req);
  const body = (await res.json()) as { instructions?: unknown[] };
  const queued = calls.filter((c) => c.model === "botJob" && c.method === "create").map((c) => c.args.data);
  const reads = calls.filter((c) => /^(find|count|aggregate|groupBy)/.test(c.method)).length;
  return { status: res.status, instructions: body.instructions ?? null, queued, reads };
}

describe("the scheduler's decisions, per club shape (must not change in A1)", () => {
  for (const name of Object.keys(SHAPES)) {
    it(`computeDuePosts: ${name}`, async () => {
      const out: Record<string, unknown> = {};
      for (const now of INSTANTS) out[now.toISOString()] = await direct(name, now);
      expect(out).toMatchSnapshot();
    });

    it(`the due-posts poll: ${name}`, async () => {
      const out: Record<string, unknown> = {};
      for (const now of INSTANTS) {
        const r = await poll(name, now);
        out[now.toISOString()] = { status: r.status, instructions: r.instructions, queued: r.queued };
      }
      expect(out).toMatchSnapshot();
    });
  }
});

describe("reads per poll (reported, not pinned here)", () => {
  it("counts every read of one due-posts poll, per shape, at three instants", async () => {
    const report: Record<string, number[]> = {};
    for (const name of Object.keys(SHAPES)) {
      report[name] = [];
      for (const now of [INSTANTS[3], INSTANTS[10], INSTANTS[16]]) report[name].push((await poll(name, now)).reads);
    }
    // MT_READS_REPORT=<file>: where to write the numbers.
    if (process.env.MT_READS_REPORT) (await import("node:fs")).writeFileSync(process.env.MT_READS_REPORT, JSON.stringify(report, null, 1));
    expect(Object.keys(report)).toHaveLength(Object.keys(SHAPES).length);
  });
});
