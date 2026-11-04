/**
 * WHAT THE ADMIN GROUP (HQ) AND THE DMs DECIDE AND SEND TO EACH MODEL TODAY,
 * PINNED (club summary, slice A3, MDs/club-summary-design-2026-11-04.md
 * section 4.2).
 *
 * Written FIRST, on the HQ door and the DM route as they were before A3,
 * and run green there: A3 moves their club facts onto the club summary and
 * must leave every value exactly as it was, so this snapshot must not
 * change.
 *
 * For each club shape of the summary's fixtures (each given an admin group,
 * plus a Turkish-speaking Sutton), at a few instants:
 *   - the real `POST /api/whatsapp/admin-group`, one message at a time,
 *     from the club's organiser (and one from a player): untagged chat, and
 *     tagged questions on the squad, the club's setup and payments, help,
 *     making and showing the teams, the poster and team sheet, a pasted
 *     squad, a one-line squad change, a score, an ask for a player, a YES;
 *   - the real `POST /api/whatsapp/dm-reply`, one DM at a time: a cold IN,
 *     a question, a help question, a payment claim, an organiser's ask to
 *     invite players.
 * Recorded per request:
 *   - the response the Pi is handed;
 *   - every model request, exactly as it is built (label, model, the user
 *     turn in full, a hash of the system prompt and the schema; raw SDK
 *     calls as their whole body); a recording model, no network;
 *   - every write the request made (model, method, arguments).
 * The database is a fake world (fixtures/hq-dm-world.ts) that answers every
 * read before and after A3 from the same rows. It also counts the reads one
 * request makes; the last test reports them.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FNF, MUTED, RATINGS, SUTTON, VETS, featuresFor, orgRow } from "../club-summary/__tests__/fixtures";
import type { ClubRows } from "../club-summary/derive";
import { fakeHqDmDb, hqDmWorld, phoneOf, withHq, type Call } from "./fixtures/hq-dm-world";

const state: { db: unknown } = { db: null };
const calls: Call[] = [];
const modelCalls: Array<Record<string, unknown>> = [];

vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
}));

/** What the request's raw SDK calls are answered with: the first needle
 *  found in the call's body picks the text. Set per request. */
const raw: { answers: Array<[string, string]> } = { answers: [] };

/** Every raw SDK call (the DM classifiers, the six `messages.create` call
 *  sites): recorded whole, answered from `raw`. No network. */
vi.mock("@anthropic-ai/sdk", () => {
  class Anthropic {
    messages = {
      create: async (body: Record<string, unknown>) => {
        const text = JSON.stringify(body);
        modelCalls.push({ raw: true, model: body.model, body: text });
        const answer = raw.answers.find(([needle]) => text.includes(needle))?.[1] ?? "";
        return { content: [{ type: "text", text: answer }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } };
      },
    };
  }
  return { default: Anthropic, Anthropic };
});

/** The router's answer, by the message's real id; every other pipeline
 *  model's, by its label (`extractor:<route>`, `hq-squad-reader`, ...).
 *  Set per request. */
const script: { routes: Record<string, string>; byLabel: Record<string, unknown> } = { routes: {}, byLabel: {} };

const sha = (s: unknown) => createHash("sha256").update(typeof s === "string" ? s : JSON.stringify(s ?? null)).digest("hex").slice(0, 16);

vi.mock("@/lib/pipeline/llm", async (orig) => {
  const actual = await orig<typeof import("@/lib/pipeline/llm")>();
  return {
    ...actual,
    anthropicModel: () => ({
      name: "recorder",
      async complete(req: { label: string; model: string; user: string; system: string; schema?: unknown; shortIds?: Record<string, string> }) {
        modelCalls.push({ label: req.label, model: req.model, system: sha(req.system), schema: sha(req.schema), user: req.user });
        let text = "{}";
        if (req.label === "router") {
          const routes = Object.entries(req.shortIds ?? {}).map(([id, real]) => ({ id, route: script.routes[real] ?? "none", to_bot: true, pasted_list: false }));
          text = JSON.stringify({ routes });
        } else if (req.label in script.byLabel) {
          text = JSON.stringify(script.byLabel[req.label]);
          // The HQ squad reader answers by ref ("p3"): the canned answer
          // names members, turned into the refs its user turn shows.
          if (req.label === "hq-squad-reader") {
            const refs = new Map<string, string>();
            for (const m of req.user.matchAll(/^ {2}(p\d+): (.+?)(?: \(also: .*\))?$/gm)) if (!refs.has(m[2])) refs.set(m[2], m[1]);
            text = text.replace(/"(member|replaces)":"([^"]*)"/g, (all, k: string, v: string) => (refs.has(v) ? `"${k}":"${refs.get(v)}"` : all));
          }
        }
        return { text, stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 };
      },
    }),
  };
});

/** While on, every club summary read fails, and so does every building of
 *  the summary's facts of a club's row (`clubRowFacts`, what the HQ door
 *  and the DM handlers read since A3): the fail-soft test below. */
const summaryDown = { on: false };
vi.mock("@/lib/club-summary/load", async (orig) => {
  const actual = await orig<typeof import("@/lib/club-summary/load")>();
  return {
    ...actual,
    loadClubSummary: (...args: Parameters<typeof actual.loadClubSummary>) =>
      summaryDown.on ? Promise.reject(new Error("club summary down (test)")) : actual.loadClubSummary(...args),
  };
});
vi.mock("@/lib/club-summary/derive", async (orig) => {
  const actual = await orig<typeof import("@/lib/club-summary/derive")>();
  return {
    ...actual,
    clubRowFacts: (...args: Parameters<typeof actual.clubRowFacts>) => {
      if (summaryDown.on) throw new Error("club summary down (test)");
      return actual.clubRowFacts(...args);
    },
  };
});

import { POST as HQ_POST } from "@/app/api/whatsapp/admin-group/route";
import { POST as DM_POST } from "@/app/api/whatsapp/dm-reply/route";

const d = (iso: string) => new Date(iso);

// ── The shapes ─────────────────────────────────────────────────────────

const SUTTON_TR_ORG = orgRow({ ...SUTTON.org, language: "tr" });
const SUTTON_TR: ClubRows = { ...SUTTON, org: SUTTON_TR_ORG, features: featuresFor(SUTTON_TR_ORG) };

/** A ratings-only and a muted club with a roster (the fixtures have none). */
const withRoster = (rows: ClubRows, prefix: string): ClubRows => ({
  ...rows,
  members: {
    rows: [
      { id: `mem-${prefix}-o`, createdAt: d("2026-01-01T00:00:00Z"), role: "OWNER", user: { id: `u-${prefix}-o`, name: "Owen", phoneNumber: null } },
      { id: `mem-${prefix}-p`, createdAt: d("2026-02-01T00:00:00Z"), role: "PLAYER", user: { id: `u-${prefix}-p`, name: "Pete", phoneNumber: null } },
    ],
    displayNames: { [`u-${prefix}-o`]: "Owen", [`u-${prefix}-p`]: "Pete" },
    aliases: {},
  },
});

interface Shape {
  rows: ClubRows;
  instants: Date[];
  /** The organiser who writes in HQ, and a player of the club. */
  organiser: string;
  player: string;
  /** The money collector, when the club has one. */
  collector?: string;
}

const SHAPES: Record<string, Shape> = {
  sutton: { rows: withHq(SUTTON), instants: [d("2026-11-04T12:00:00Z"), d("2026-11-10T18:00:00Z")], organiser: "u-kemal", player: "u-zed", collector: "u-kemal" },
  "sutton-tr": { rows: withHq(SUTTON_TR), instants: [d("2026-11-04T12:00:00Z")], organiser: "u-kemal", player: "u-zed", collector: "u-kemal" },
  fnf: { rows: withHq(FNF), instants: [d("2026-11-04T12:00:00Z"), d("2026-11-07T10:00:00Z")], organiser: "u-fnf-org", player: "u-fnf-a" },
  vets: { rows: withHq(VETS), instants: [d("2026-11-04T12:00:00Z"), d("2026-11-13T12:00:00Z")], organiser: "u-davide", player: "u-nabz", collector: "u-davide" },
  ratings: { rows: withHq(withRoster(RATINGS, "rt")), instants: [d("2026-11-04T12:00:00Z")], organiser: "u-rt-o", player: "u-rt-p" },
  muted: { rows: withHq(withRoster(MUTED, "mu")), instants: [d("2026-11-04T12:00:00Z")], organiser: "u-mu-o", player: "u-mu-p" },
};

// ── The HQ requests ────────────────────────────────────────────────────

const question = (topic: string) => ({
  topic,
  personRef: "",
  statedCount: -1,
  table: "none",
  listSize: -1,
  listEnd: "top",
  period: "none",
  periodCount: -1,
  periodUnit: "none",
  feature: "none",
});
const teams = (action: string) => ({ action, swaps: [], moves: [], pairings: [], swapSides: false, sides: { red: [], yellow: [] } });
const reader = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, lines: [], out: [], changes: [], alsoAsks: false, ...extra });

interface HqRequest {
  name: string;
  body: string;
  tagged: boolean;
  route: string;
  byLabel?: Record<string, unknown>;
  /** From the club's player, not its organiser. */
  fromPlayer?: boolean;
}

const HQ_REQUESTS: HqRequest[] = [
  { name: "chat", body: "see you all on the night", tagged: false, route: "none" },
  { name: "squad", body: "@Match Time who's playing?", tagged: true, route: "question", byLabel: { "extractor:question": question("squad") } },
  { name: "squad-player", body: "@Match Time how many have we got?", tagged: true, route: "question", fromPlayer: true, byLabel: { "extractor:question": question("squad") } },
  { name: "club", body: "@Match Time who collects the money?", tagged: true, route: "question", byLabel: { "extractor:question": question("club") } },
  { name: "payments", body: "@Match Time who hasn't paid?", tagged: true, route: "question", byLabel: { "extractor:question": question("payments") } },
  { name: "help", body: "@Match Time what can you do?", tagged: true, route: "help" },
  { name: "teams", body: "@Match Time make the teams", tagged: true, route: "balancer", byLabel: { "extractor:teams": teams("generate") } },
  { name: "show", body: "@Match Time show the teams", tagged: true, route: "balancer", byLabel: { "extractor:teams": teams("show") } },
  { name: "poster", body: "@Match Time send the poster", tagged: true, route: "poster" },
  { name: "sheet", body: "@Match Time send the team sheet", tagged: true, route: "team_sheet" },
  {
    name: "paste",
    body: "@Match Time squad for the game\n1. Rafi\n2. Player 1\n3. Player 2",
    tagged: true,
    route: "other_att",
    byLabel: {
      "hq-squad-reader": reader("squad", {
        lines: [
          { name: "Player 1", member: "Player 1", section: "playing", person: true },
          { name: "Player 2", member: "Player 2", section: "playing", person: true },
        ],
      }),
    },
  },
  {
    name: "out",
    body: "@Match Time Player 1 is out",
    tagged: true,
    route: "other_att",
    byLabel: { "hq-squad-reader": reader("change", { changes: [{ name: "Player 1", member: "Player 1", person: true, to: "out", replaces: "" }], alsoAsks: true }), "extractor:question": question("squad") },
  },
  { name: "score", body: "@Match Time we won 5-3", tagged: true, route: "score" },
  { name: "ask", body: "@Match Time ask the group for one more player", tagged: true, route: "ask_group" },
  { name: "yes", body: "@Match Time YES", tagged: true, route: "approve" },
];

// ── The DMs ────────────────────────────────────────────────────────────

const intent = (i: string) => JSON.stringify({ intent: i, intro: [], club_ref: "", confidence: 0.95, reasoning: "test" });

interface DmRequest {
  name: string;
  body: string;
  from: "player" | "organiser";
  /** Raw SDK answers by needle (the DM intent's schema names its intents). */
  raw: Array<[string, string]>;
  byLabel?: Record<string, unknown>;
}

const DM_INTENT = "resume_ratings";
/** Phrases only the match-availability and payment-claim prompts carry. */
const AVAILABILITY = "whether THEY will play in THAT match";
const CLAIM = "will_pay_direct";
const availability = (decision: string) => JSON.stringify({ decision, confidence: 0.95, reasoning: "test" });
const claim = (i: string) => JSON.stringify({ intent: i, amount: null, confidence: 0.95, reasoning: "test" });
const helpOn = (feature: string) => ({ ...question("how_it_works"), feature });

const DM_REQUESTS: DmRequest[] = [
  { name: "in", body: "IN", from: "player", raw: [[DM_INTENT, intent("other")], [AVAILABILITY, availability("in")]] },
  { name: "question", body: "what time is kick off?", from: "player", raw: [[DM_INTENT, intent("question")]], byLabel: { "extractor:question": question("fixture") } },
  { name: "help", body: "how does the bench work?", from: "organiser", raw: [[DM_INTENT, intent("question")]], byLabel: { "extractor:question": helpOn("bench") } },
  { name: "help-player", body: "how do ratings work?", from: "player", raw: [[DM_INTENT, intent("question")]], byLabel: { "extractor:question": helpOn("ratings") } },
  { name: "paid", body: "paid", from: "player", raw: [[DM_INTENT, intent("other")], [CLAIM, claim("paid")]] },
  { name: "invite", body: "invite players for the next game", from: "organiser", raw: [[DM_INTENT, intent("recruit_blast")]] },
  { name: "partners", body: "ask our partner clubs for a player", from: "organiser", raw: [[DM_INTENT, intent("partner_ask")]] },
];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** A short link's code is random (crypto): masked, in the row and the URL. */
const SHORT_CODE = /("code":"|\/r\/)[A-Za-z0-9]{6,12}\b/g;
const stable = (v: unknown) =>
  JSON.parse(
    JSON.stringify(v ?? null)
      .replace(UUID, "<uuid>")
      .replace(SHORT_CODE, "$1<code>"),
  );

const WRITE = /^(create|createMany|update|updateMany|upsert|delete|deleteMany|\$executeRaw)/;
const READ = /^(find|count|aggregate|groupBy)/;

/** Math.random, seeded per request: ids MatchTime makes up (an HQ log
 *  line's) come out the same on every run. */
let seed = 1;
const seeded = () => {
  seed = (seed * 48271) % 2147483647;
  return seed / 2147483647;
};

function fresh(name: string, now: Date) {
  seed = 1;
  calls.length = 0;
  modelCalls.length = 0;
  state.db = fakeHqDmDb(hqDmWorld(SHAPES[name].rows), calls);
  vi.setSystemTime(now);
}

function recorded(status: number, body: unknown) {
  // MT_CHAR_DUMP=<file>: one line per request (what it did, which models it
  // asked), to read the characterisation's coverage. Not part of the pin.
  if (process.env.MT_CHAR_DUMP) {
    const labels = modelCalls.map((m) => (m.raw ? "raw" : m.label));
    (require("node:fs") as typeof import("node:fs")).appendFileSync(process.env.MT_CHAR_DUMP, `${JSON.stringify(body).slice(0, 220)} | ${labels.join(",")}\n`);
  }
  return {
    status,
    response: stable(body),
    model: stable(modelCalls),
    writes: stable(calls.filter((c) => WRITE.test(c.method)).map((c) => ({ call: `${c.model}.${c.method}`, args: c.args }))),
    reads: calls.filter((c) => READ.test(c.method)).length,
  };
}

async function sendHq(name: string, now: Date, r: HqRequest) {
  const shape = SHAPES[name];
  fresh(name, now);
  const id = `wa-hq-${name}-${r.name}`;
  script.routes = { [id]: r.route };
  script.byLabel = r.byLabel ?? {};
  raw.answers = [];
  const sender = r.fromPlayer ? shape.player : shape.organiser;
  const req = new Request("http://localhost/api/whatsapp/admin-group", {
    method: "POST",
    headers: { "x-api-key": "test-key", "content-type": "application/json" },
    body: JSON.stringify({
      channel: "admin-group",
      groupId: shape.rows.org.adminGroupId,
      messageId: id,
      text: r.body,
      botMentioned: r.tagged,
      senderPhone: phoneOf(shape.rows, sender).replace(/^\+/, ""),
      timestamp: String(Math.floor((now.getTime() - 60_000) / 1000)),
    }),
  });
  const res = await HQ_POST(req);
  return recorded(res.status, await res.json());
}

async function sendDm(name: string, now: Date, r: DmRequest) {
  const shape = SHAPES[name];
  fresh(name, now);
  script.routes = {};
  script.byLabel = r.byLabel ?? {};
  raw.answers = r.raw;
  const sender = r.from === "player" ? shape.player : shape.organiser;
  const req = new Request("http://localhost/api/whatsapp/dm-reply", {
    method: "POST",
    headers: { "x-api-key": "test-key", "content-type": "application/json" },
    body: JSON.stringify({
      phone: phoneOf(shape.rows, sender).replace(/^\+/, ""),
      body: r.body,
      waMessageId: `wa-dm-${name}-${r.name}`,
      authorName: "Someone",
    }),
  });
  const res = await DM_POST(req);
  return recorded(res.status, await res.json());
}

let env: Record<string, string | undefined>;
beforeAll(() => {
  env = { WHATSAPP_API_KEY: process.env.WHATSAPP_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, AUTH_SECRET: process.env.AUTH_SECRET };
  process.env.WHATSAPP_API_KEY = "test-key";
  // Every model door checks a key is set before it asks; the recorder above
  // answers every call, so nothing leaves the process.
  process.env.ANTHROPIC_API_KEY = "test-recorder-no-network";
  // The admin links in an organiser's DM help are signed with it.
  process.env.AUTH_SECRET = "test-secret";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.spyOn(Math, "random").mockImplementation(seeded);
});
afterAll(() => {
  vi.useRealTimers();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const without = <T extends { reads: number }>(x: T): Omit<T, "reads"> => {
  const { reads: _r, ...rest } = x;
  return rest;
};

describe("the admin group (HQ), per club shape (must not change in A3)", () => {
  for (const name of Object.keys(SHAPES)) {
    it(`POST /api/whatsapp/admin-group: ${name}`, async () => {
      const out: Record<string, unknown> = {};
      for (const now of SHAPES[name].instants) {
        for (const r of HQ_REQUESTS) out[`${now.toISOString()} ${r.name}`] = without(await sendHq(name, now, r));
      }
      expect(out).toMatchSnapshot();
    });
  }
});

describe("the DMs, per club shape (must not change in A3)", () => {
  for (const name of Object.keys(SHAPES)) {
    it(`POST /api/whatsapp/dm-reply: ${name}`, async () => {
      const out: Record<string, unknown> = {};
      for (const now of SHAPES[name].instants) {
        for (const r of DM_REQUESTS) out[`${now.toISOString()} ${r.name}`] = without(await sendDm(name, now, r));
      }
      expect(out).toMatchSnapshot();
    });
  }
});

/**
 * FAIL-SOFT: when the club summary cannot be read, the request carries on
 * exactly as the code before A3 did, each consumer reading its fact itself.
 * Every shape, instant and request: the same response, model requests and
 * writes as with the summary, which the snapshots above pin as the old
 * code's. The error is logged once per HQ message (the door builds the row
 * facts once, for every message) and once per DM handler that reads a
 * club's row facts (the cold IN's match and the help: at most two; each
 * club here has one membership per sender).
 */
describe("the club summary cannot be read (HQ and DMs still run as before A3)", () => {
  for (const name of Object.keys(SHAPES)) {
    it(`summary down: ${name}`, async () => {
      const errors = vi.spyOn(console, "error");
      try {
        for (const now of SHAPES[name].instants) {
          const sends: Array<[string, () => ReturnType<typeof sendHq>]> = [
            ...HQ_REQUESTS.map((r): [string, () => ReturnType<typeof sendHq>] => [`hq ${r.name}`, () => sendHq(name, now, r)]),
            ...DM_REQUESTS.map((r): [string, () => ReturnType<typeof sendHq>] => [`dm ${r.name}`, () => sendDm(name, now, r)]),
          ];
          for (const [label, send] of sends) {
            const normal = without(await send());
            errors.mockClear();
            summaryDown.on = true;
            let down: Omit<Awaited<ReturnType<typeof sendHq>>, "reads">;
            try {
              down = without(await send());
            } finally {
              summaryDown.on = false;
            }
            expect(down, `${now.toISOString()} ${label}`).toEqual(normal);
            const logged = errors.mock.calls.filter((c) => String(c[0]).includes("club summary could not be read"));
            if (label.startsWith("hq ")) expect(logged.length, `${now.toISOString()} ${label}`).toBe(1);
            else expect(logged.length, `${now.toISOString()} ${label}`).toBeLessThanOrEqual(2);
          }
        }
      } finally {
        errors.mockRestore();
      }
    });
  }
});

/**
 * The loaders the HQ owners call take the summary's facts of the club's row
 * (`clubRowFacts`, what the door builds since A3) exactly as they take the
 * whole summary: with them or without, the same squad state, payment
 * snapshot and club answer, on every shape and instant, and fewer reads.
 */
describe("the HQ owners' loaders, with the row facts and without (one answer)", () => {
  for (const name of Object.keys(SHAPES)) {
    it(`loadSquadState, loadPaymentSnapshot, loadClubSnapshot: ${name}`, async () => {
      const { loadSquadState, loadPaymentSnapshot, loadClubSnapshot } = await import("@/lib/pipeline/load-state");
      const { clubRowFacts } = await import("@/lib/club-summary/derive");
      const { orgFeaturesFromRow } = await import("@/lib/org-features");
      for (const now of SHAPES[name].instants) {
        fresh(name, now);
        const world = hqDmWorld(SHAPES[name].rows);
        const row = world.org as unknown as Parameters<typeof clubRowFacts>[0] & Parameters<typeof orgFeaturesFromRow>[0];
        const facts = clubRowFacts(row, orgFeaturesFromRow(row));
        const orgId = facts.orgId;
        const before = calls.length;
        const plain = stable(await loadSquadState(orgId, now));
        const plainReads = calls.length - before;
        const mid = calls.length;
        expect(stable(await loadSquadState(orgId, now, { summary: facts })), `${now.toISOString()} state`).toEqual(plain);
        expect(calls.length - mid, `${now.toISOString()} state reads`).toBeLessThan(plainReads);
        expect(await loadPaymentSnapshot(orgId, plain.completedMatch, { summary: facts })).toEqual(await loadPaymentSnapshot(orgId, plain.completedMatch));
        for (const matchId of [plain.matchId, null]) {
          expect(await loadClubSnapshot(orgId, matchId, { club: facts }), `${now.toISOString()} club ${matchId}`).toEqual(await loadClubSnapshot(orgId, matchId));
        }
      }
    });
  }
});

describe("reads per request (reported, not pinned here)", () => {
  it("counts every read of one HQ message and one DM, per shape and request", async () => {
    const report: Record<string, Record<string, number>> = {};
    for (const name of Object.keys(SHAPES)) {
      report[name] = {};
      const now = SHAPES[name].instants[0];
      for (const r of HQ_REQUESTS) report[name][`hq ${r.name}`] = (await sendHq(name, now, r)).reads;
      for (const r of DM_REQUESTS) report[name][`dm ${r.name}`] = (await sendDm(name, now, r)).reads;
    }
    // MT_READS_REPORT=<file>: where to write the numbers.
    if (process.env.MT_READS_REPORT) (await import("node:fs")).writeFileSync(process.env.MT_READS_REPORT, JSON.stringify(report, null, 1));
    expect(Object.keys(report)).toHaveLength(Object.keys(SHAPES).length);
  });
});
