/**
 * WHAT THE DM ROUTE DECIDES, WRITES AND ASKS EACH MODEL TODAY, PINNED
 * (Cloud API plan C3, MDs/whatsapp-cloud-api-plan-2026-11-04.md section
 * 5.3: the DM pipeline moves out of `POST /api/whatsapp/dm-reply` into
 * `handleInboundDm` in `src/lib/inbound-dm.ts`, with no change at all).
 *
 * Written FIRST, on the route as it was before C3, and run green there:
 * C3 only moves code, so this snapshot must not change. The approach and
 * the fake world are the club summary branch's slice A3
 * (`hq-dm-club-summary-characterisation.test.ts` on `refactor/club-summary`),
 * copied for main (`fixtures/inbound-dm-clubs.ts`, `fixtures/inbound-dm-world.ts`)
 * and widened to more kinds of DM and to the transport's own answers.
 *
 * For each club shape (each given an admin group, plus a Turkish-speaking
 * Sutton), at a few instants, the real `POST /api/whatsapp/dm-reply`, one
 * DM at a time, from the club's player, its organiser or a stranger.
 * Recorded per request:
 *   - the HTTP status and the response the Pi is handed;
 *   - every model request, exactly as it is built (label, model, the user
 *     turn in full, a hash of the system prompt and the schema; raw SDK
 *     calls as their whole body); a recording model, no network;
 *   - every write the request made (model, method, arguments).
 * The database is a fake world that answers every read from the same rows
 * and changes nothing on a write. `fetch` is replaced by one that records
 * and fails, so nothing leaves the process. No model is called: $0.
 *
 * RE-RECORDED 2026-11-09 (#566, "@Match Time DM these people"), for two
 * intended changes and nothing else, checked line by line (the old and new
 * snapshots are the same multiset of lines once both are normalised):
 *   1. the admin extractor's system prompt and schema hashes (its recruit
 *      section was rewritten: `playersFrom` gains "named");
 *   2. the recruit invite's writes (`recruit.ts` `queueRecruitInviteDm`):
 *      the unique recruit-dm marker is now created BEFORE the short link
 *      and the BotJob, so two racing requests can never DM one person
 *      twice, and the marker and the job carry one explicit `createdAt`
 *      (142 lines: 71 markers, 71 jobs), so the recruit chase's "DM'd since
 *      the invite" test never counts the invite itself.
 */
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FNF, MUTED, RATINGS, SUTTON, VETS, featuresFor, orgRow, type ClubRows } from "./fixtures/inbound-dm-clubs";
import { fakeHqDmDb, hqDmWorld, phoneOf, withHq, type Call } from "./fixtures/inbound-dm-world";

const state: { db: unknown } = { db: null };
const calls: Call[] = [];
const modelCalls: Array<Record<string, unknown>> = [];
const fetches: string[] = [];

vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
}));

/** What the request's raw SDK calls are answered with: the first needle
 *  found in the call's body picks the text. Set per request. */
const raw: { answers: Array<[string, string]> } = { answers: [] };

/** Every raw SDK call (the DM classifiers): recorded whole, answered from
 *  `raw`. No network. */
vi.mock("@anthropic-ai/sdk", () => {
  class Anthropic {
    messages = {
      create: async (body: Record<string, unknown>) => {
        const text = JSON.stringify(body);
        // The system prompt and the output schema as hashes (they are the
        // prompts' own text, pinned by their own tests); everything else of
        // the call, the user turn included, in full.
        const { system, output_config, ...rest } = body;
        modelCalls.push({ raw: true, model: body.model, system: sha(system), schema: sha(output_config), rest });
        const answer = raw.answers.find(([needle]) => text.includes(needle))?.[1] ?? "";
        return { content: [{ type: "text", text: answer }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } };
      },
    };
  }
  return { default: Anthropic, Anthropic };
});

/** Every pipeline model's answer, by its label (`extractor:question`, ...).
 *  Set per request. */
const script: { byLabel: Record<string, unknown> } = { byLabel: {} };

const sha = (s: unknown) => createHash("sha256").update(typeof s === "string" ? s : JSON.stringify(s ?? null)).digest("hex").slice(0, 16);

vi.mock("@/lib/pipeline/llm", async (orig) => {
  const actual = await orig<typeof import("@/lib/pipeline/llm")>();
  return {
    ...actual,
    anthropicModel: () => ({
      name: "recorder",
      async complete(req: { label: string; model: string; user: string; system: string; schema?: unknown }) {
        modelCalls.push({ label: req.label, model: req.model, system: sha(req.system), schema: sha(req.schema), user: req.user });
        const text = req.label in script.byLabel ? JSON.stringify(script.byLabel[req.label]) : "{}";
        return { text, stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 };
      },
    }),
  };
});

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
  /** The club's organiser and one of its players. */
  organiser: string;
  player: string;
}

const SHAPES: Record<string, Shape> = {
  sutton: { rows: withHq(SUTTON), instants: [d("2026-11-04T12:00:00Z"), d("2026-11-10T18:00:00Z")], organiser: "u-kemal", player: "u-zed" },
  "sutton-tr": { rows: withHq(SUTTON_TR), instants: [d("2026-11-04T12:00:00Z")], organiser: "u-kemal", player: "u-zed" },
  fnf: { rows: withHq(FNF), instants: [d("2026-11-04T12:00:00Z"), d("2026-11-07T10:00:00Z")], organiser: "u-fnf-org", player: "u-fnf-a" },
  vets: { rows: withHq(VETS), instants: [d("2026-11-04T12:00:00Z"), d("2026-11-13T12:00:00Z")], organiser: "u-davide", player: "u-nabz" },
  ratings: { rows: withHq(withRoster(RATINGS, "rt")), instants: [d("2026-11-04T12:00:00Z")], organiser: "u-rt-o", player: "u-rt-p" },
  muted: { rows: withHq(withRoster(MUTED, "mu")), instants: [d("2026-11-04T12:00:00Z")], organiser: "u-mu-o", player: "u-mu-p" },
};

// ── The DMs ────────────────────────────────────────────────────────────

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
const intent = (i: string) => JSON.stringify({ intent: i, intro: [], club_ref: "", confidence: 0.95, reasoning: "test" });

/** Phrases only the DM intent's, the match-availability and the
 *  payment-claim prompts carry. */
const DM_INTENT = "resume_ratings";
const AVAILABILITY = "whether THEY will play in THAT match";
const CLAIM = "will_pay_direct";
const availability = (decision: string) => JSON.stringify({ decision, confidence: 0.95, reasoning: "test" });
const claim = (i: string) => JSON.stringify({ intent: i, amount: null, confidence: 0.95, reasoning: "test" });
const helpOn = (feature: string) => ({ ...question("how_it_works"), feature });

interface DmRequest {
  name: string;
  body: string;
  /** Who sends it: the club's player or organiser, or a number MatchTime
   *  does not know. */
  from: "player" | "organiser" | "stranger";
  /** Raw SDK answers by needle. */
  raw: Array<[string, string]>;
  byLabel?: Record<string, unknown>;
  /** More fields of the Pi's envelope (a quote, a LID, a timestamp). */
  envelope?: Record<string, unknown>;
  /** The envelope without its phone (an @lid sender). */
  noPhone?: boolean;
}

const DM_REQUESTS: DmRequest[] = [
  { name: "in", body: "IN", from: "player", raw: [[DM_INTENT, intent("other")], [AVAILABILITY, availability("in")]] },
  { name: "out", body: "can't make it this week, sorry", from: "player", raw: [[DM_INTENT, intent("other")], [AVAILABILITY, availability("out")]] },
  { name: "maybe", body: "might be late, probably in", from: "player", raw: [[DM_INTENT, intent("other")], [AVAILABILITY, availability("tentative")]] },
  { name: "question", body: "what time is kick off?", from: "player", raw: [[DM_INTENT, intent("question")]], byLabel: { "extractor:question": question("fixture") } },
  { name: "question-squad", body: "how many have we got?", from: "organiser", raw: [[DM_INTENT, intent("question")]], byLabel: { "extractor:question": question("squad") } },
  { name: "help", body: "how does the bench work?", from: "organiser", raw: [[DM_INTENT, intent("question")]], byLabel: { "extractor:question": helpOn("bench") } },
  { name: "help-player", body: "how do ratings work?", from: "player", raw: [[DM_INTENT, intent("question")]], byLabel: { "extractor:question": helpOn("ratings") } },
  { name: "help-pay", body: "how do I pay?", from: "player", raw: [[DM_INTENT, intent("question")]], byLabel: { "extractor:question": helpOn("payments") } },
  { name: "paid", body: "paid", from: "player", raw: [[DM_INTENT, intent("other")], [CLAIM, claim("paid")]] },
  { name: "pay-direct", body: "I'll give you cash on the night", from: "player", raw: [[DM_INTENT, intent("other")], [CLAIM, claim("will_pay_direct")]] },
  { name: "stop-ratings", body: "stop sending me rating messages", from: "player", raw: [[DM_INTENT, intent("stop_ratings")]] },
  { name: "stop-all", body: "stop messaging me", from: "player", raw: [[DM_INTENT, intent("stop_messages")]] },
  { name: "resume", body: "you can message me again", from: "player", raw: [[DM_INTENT, intent("resume_messages")]] },
  { name: "invite", body: "invite players for the next game", from: "organiser", raw: [[DM_INTENT, intent("recruit_blast")]] },
  { name: "partners", body: "ask our partner clubs for a player", from: "organiser", raw: [[DM_INTENT, intent("partner_ask")]] },
  { name: "progress", body: "how many have rated so far?", from: "organiser", raw: [[DM_INTENT, intent("rating_progress")]] },
  { name: "go", body: "GO", from: "organiser", raw: [[DM_INTENT, intent("go_live")]] },
  { name: "pick", body: "2", from: "organiser", raw: [[DM_INTENT, intent("other")]], envelope: { timestamp: "1762257600" } },
  { name: "chat", body: "cheers mate", from: "player", raw: [[DM_INTENT, intent("other")], [AVAILABILITY, availability("unclear")]] },
  {
    name: "quoted",
    body: "yes",
    from: "player",
    raw: [[DM_INTENT, intent("other")], [AVAILABILITY, availability("in")]],
    envelope: { quotedMessageId: "3EB0QUOTED", quotedText: "Are you in for Tuesday?", quotedFromMatchTime: true },
  },
  { name: "lid-only", body: "IN", from: "player", noPhone: true, envelope: { senderLid: "123456789012345@lid" }, raw: [[DM_INTENT, intent("other")], [AVAILABILITY, availability("in")]] },
  { name: "pool-code", body: "Hi MatchTime, sign me up to play. Code K7QP", from: "stranger", raw: [[DM_INTENT, intent("other")]] },
  { name: "connect", body: "Connect Riverside FC, code 7KQ2", from: "stranger", raw: [[DM_INTENT, intent("connect_club")]] },
  { name: "stranger", body: "hello, is this the football?", from: "stranger", raw: [[DM_INTENT, intent("question")]] },
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

/** Math.random, seeded per request: ids MatchTime makes up come out the
 *  same on every run. */
let seed = 1;
const seeded = () => {
  seed = (seed * 48271) % 2147483647;
  return seed / 2147483647;
};

function fresh(name: string, now: Date) {
  seed = 1;
  calls.length = 0;
  modelCalls.length = 0;
  fetches.length = 0;
  state.db = fakeHqDmDb(hqDmWorld(SHAPES[name].rows), calls);
  vi.setSystemTime(now);
}

function recorded(status: number, body: unknown) {
  // MT_CHAR_DUMP=<file>: one line per request (what it did, which models it
  // asked, how many writes), to read the characterisation's coverage. Not
  // part of the pin.
  if (process.env.MT_CHAR_DUMP) {
    const labels = modelCalls.map((m) => (m.raw ? "raw" : m.label));
    const writes = calls.filter((c) => WRITE.test(c.method)).map((c) => `${c.model}.${c.method}`);
    appendFileSync(process.env.MT_CHAR_DUMP, `${status} ${JSON.stringify(body).slice(0, 160)} | ${labels.join(",")} | ${writes.join(",")}\n`);
  }
  return {
    status,
    response: stable(body),
    model: stable(modelCalls),
    writes: stable(calls.filter((c) => WRITE.test(c.method)).map((c) => ({ call: `${c.model}.${c.method}`, args: c.args }))),
    fetches: [...fetches],
  };
}

const STRANGER_PHONE = "447700900777";

async function sendDm(name: string, now: Date, r: DmRequest, headers: Record<string, string> = {}) {
  const shape = SHAPES[name];
  fresh(name, now);
  script.byLabel = r.byLabel ?? {};
  raw.answers = r.raw;
  const phone =
    r.from === "stranger" ? STRANGER_PHONE : phoneOf(shape.rows, r.from === "player" ? shape.player : shape.organiser).replace(/^\+/, "");
  const req = new Request("http://localhost/api/whatsapp/dm-reply", {
    method: "POST",
    headers: { "x-api-key": "test-key", "content-type": "application/json", ...headers },
    body: JSON.stringify({
      ...(r.noPhone ? {} : { phone }),
      body: r.body,
      waMessageId: `wa-dm-${name}-${r.name}`,
      authorName: "Someone",
      ...(r.envelope ?? {}),
    }),
  });
  const res = await DM_POST(req);
  return recorded(res.status, await res.json());
}

const ENV_KEYS = ["WHATSAPP_API_KEY", "ANTHROPIC_API_KEY", "AUTH_SECRET", "SELF_JOIN_ENABLED", "SELF_JOIN_APPROVER_PHONES", "MT_TEST_MODE"] as const;
let env: Record<string, string | undefined>;
beforeAll(() => {
  env = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.WHATSAPP_API_KEY = "test-key";
  // Every model door checks a key is set before it asks; the recorders
  // above answer every call, so nothing leaves the process.
  process.env.ANTHROPIC_API_KEY = "test-recorder-no-network";
  // The admin links in an organiser's DM help are signed with it.
  process.env.AUTH_SECRET = "test-secret";
  delete process.env.SELF_JOIN_ENABLED;
  delete process.env.SELF_JOIN_APPROVER_PHONES;
  delete process.env.MT_TEST_MODE;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.spyOn(Math, "random").mockImplementation(seeded);
  vi.stubGlobal("fetch", async (url: unknown) => {
    fetches.push(String(url));
    throw new Error("no network in the characterisation");
  });
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("the DMs, per club shape (must not change in C3)", () => {
  for (const name of Object.keys(SHAPES)) {
    it(`POST /api/whatsapp/dm-reply: ${name}`, async () => {
      const out: Record<string, unknown> = {};
      for (const now of SHAPES[name].instants) {
        for (const r of DM_REQUESTS) out[`${now.toISOString()} ${r.name}`] = await sendDm(name, now, r);
      }
      expect(out).toMatchSnapshot();
    });
  }
});

describe("the DMs with self-join on (must not change in C3)", () => {
  it("POST /api/whatsapp/dm-reply: sutton, self-join on, an approver", async () => {
    const shape = SHAPES.sutton;
    process.env.SELF_JOIN_ENABLED = "1";
    process.env.SELF_JOIN_APPROVER_PHONES = phoneOf(shape.rows, shape.organiser).replace(/^\+/, "");
    try {
      const out: Record<string, unknown> = {};
      const now = shape.instants[0];
      const extra: DmRequest[] = [
        { name: "approve", body: "APPROVE 7KQ2", from: "organiser", raw: [[DM_INTENT, JSON.stringify({ intent: "approve_club", intro: [], club_ref: "7KQ2", confidence: 0.95, reasoning: "test" })]] },
        { name: "reject", body: "REJECT 7KQ2", from: "organiser", raw: [[DM_INTENT, JSON.stringify({ intent: "reject_club", intro: [], club_ref: "7KQ2", confidence: 0.95, reasoning: "test" })]] },
      ];
      for (const r of [...extra, ...DM_REQUESTS]) out[r.name] = await sendDm("sutton", now, r);
      expect(out).toMatchSnapshot();
    } finally {
      delete process.env.SELF_JOIN_ENABLED;
      delete process.env.SELF_JOIN_APPROVER_PHONES;
    }
  });
});

describe("the transport's own answers (must not change in C3)", () => {
  const post = async (init: { key?: string; body: string }) => {
    fresh("sutton", SHAPES.sutton.instants[0]);
    const res = await DM_POST(
      new Request("http://localhost/api/whatsapp/dm-reply", {
        method: "POST",
        headers: { "x-api-key": init.key ?? "test-key", "content-type": "application/json" },
        body: init.body,
      }),
    );
    return { status: res.status, body: await res.json(), dbCalls: calls.length, modelCalls: modelCalls.length };
  };

  it("401 on a wrong key, before anything is read", async () => {
    expect(await post({ key: "wrong", body: JSON.stringify({ phone: "447700900001", body: "IN", waMessageId: "w" }) })).toEqual({
      status: 401,
      body: { error: "Unauthorized" },
      dbCalls: 0,
      modelCalls: 0,
    });
  });

  it("400 on a body that is not JSON, or not an object", async () => {
    for (const body of ["not json", "null", "42"]) {
      expect(await post({ body }), body).toEqual({ status: 400, body: { error: "invalid body" }, dbCalls: 0, modelCalls: 0 });
    }
  });

  it("400 without the text or the message id", async () => {
    for (const b of [{ phone: "447700900001", waMessageId: "w" }, { phone: "447700900001", body: "IN" }, { body: "", waMessageId: "w" }]) {
      expect(await post({ body: JSON.stringify(b) }), JSON.stringify(b)).toEqual({
        status: 400,
        body: { error: "body, waMessageId required" },
        dbCalls: 0,
        modelCalls: 0,
      });
    }
  });
});
