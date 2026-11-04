/**
 * WHAT THE ANALYZE PATH DECIDES AND SENDS TO EACH MODEL TODAY, PINNED (club
 * summary, slice A2, MDs/club-summary-design-2026-11-04.md section 4.2).
 *
 * Written FIRST, on the analyze route as it was before A2, and run green
 * there: A2 moves the route, `loadSquadState` and the batch loaders onto the
 * club summary and must leave every value exactly as it was, so this
 * snapshot must not change.
 *
 * For each club shape of the summary's fixtures (plus a Turkish-speaking
 * Sutton), at a few instants, the real `POST /api/whatsapp/analyze` is sent
 * one message at a time: an IN, and tagged questions about the squad, the
 * club's setup, payments and a smaller format, and a request to make the
 * teams. Recorded per request:
 *   - the response the Pi is handed (replies, reactions, who handled it);
 *   - every model request, exactly as the pipeline builds it (label, model,
 *     the user turn in full, a hash of the system prompt and the schema);
 *   - every write the request made (model, method, arguments).
 * The model is a recorder: it answers each call with canned facts chosen
 * by the message (the router by the message's id, an extractor by the
 * message's body), so no network and no key. The database is a fake world
 * (fixtures/analyze-world.ts) that answers every read before and after A2
 * from the same rows.
 *
 * Also pinned: `loadSquadState` itself, the whole value, per shape and
 * instant, called as the analyze path calls it.
 *
 * The same fake counts the reads one request makes; the last test prints
 * them (the query count before and after A2).
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FNF, MUTED, RATINGS, SUTTON, VETS, featuresFor, orgRow } from "../club-summary/__tests__/fixtures";
import type { ClubRows } from "../club-summary/derive";
import { analyzeWorld, fakeAnalyzeDb, type Call } from "./fixtures/analyze-world";

const state: { db: unknown } = { db: null };
const calls: Call[] = [];
const modelCalls: Array<Record<string, unknown>> = [];

vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
}));

/** Every raw SDK call (the six `messages.create` call sites): recorded,
 *  answered with an empty text. No network. */
vi.mock("@anthropic-ai/sdk", () => {
  class Anthropic {
    messages = {
      create: async (body: Record<string, unknown>) => {
        modelCalls.push({ raw: true, model: body.model, body: JSON.stringify(body) });
        return { content: [{ type: "text", text: "" }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } };
      },
    };
  }
  return { default: Anthropic, Anthropic };
});

/** The router's answer, by the message's real id; the extractors', by the
 *  message's body. Set per request. */
const script: { routes: Record<string, string>; facts: Record<string, Record<string, unknown>> } = { routes: {}, facts: {} };

const sha = (s: unknown) => createHash("sha256").update(typeof s === "string" ? s : JSON.stringify(s ?? null)).digest("hex").slice(0, 16);

vi.mock("@/lib/pipeline/llm", async (orig) => {
  const actual = await orig<typeof import("@/lib/pipeline/llm")>();
  // `extractor-stub.ts`'s `messageBodyOf`, inline: importing it here would
  // import this very module while it is being mocked.
  const messageBodyOf = (user: string) => {
    const m = /^THE MESSAGE \(from .*\):\n([\s\S]*)$/m.exec(user);
    return (m ? m[1] : user).trim();
  };
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
        } else if (req.label.startsWith("extractor:")) {
          text = JSON.stringify(script.facts[messageBodyOf(req.user)] ?? {});
        }
        return { text, stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 };
      },
    }),
  };
});

import { POST } from "@/app/api/whatsapp/analyze/route";
import { loadSquadState } from "@/lib/pipeline/load-state";

const d = (iso: string) => new Date(iso);

// ── The shapes ─────────────────────────────────────────────────────────

/** Sutton, spoken to in Turkish. */
const SUTTON_TR_ORG = orgRow({ ...SUTTON.org, language: "tr" });
const SUTTON_TR: ClubRows = { ...SUTTON, org: SUTTON_TR_ORG, features: featuresFor(SUTTON_TR_ORG) };

const SHAPES: Record<string, { rows: ClubRows; instants: Date[]; sender: { phone: string; name: string } }> = {
  sutton: { rows: SUTTON, instants: [d("2026-11-04T12:00:00Z"), d("2026-11-10T18:00:00Z")], sender: { phone: "+44775", name: "Zed" } },
  "sutton-tr": { rows: SUTTON_TR, instants: [d("2026-11-04T12:00:00Z")], sender: { phone: "+44775", name: "Zed" } },
  fnf: { rows: FNF, instants: [d("2026-11-04T12:00:00Z"), d("2026-11-07T10:00:00Z")], sender: { phone: "+44779", name: "Rafi" } },
  // 9 November: the week seeded; 16 November: November running, not seeded;
  // 7 December: no month at all (the IN is held).
  vets: { rows: VETS, instants: [d("2026-11-04T12:00:00Z"), d("2026-11-13T12:00:00Z"), d("2026-12-03T12:00:00Z")], sender: { phone: "+44776", name: "Nabz" } },
  ratings: { rows: RATINGS, instants: [d("2026-11-04T12:00:00Z")], sender: { phone: "+447700900111", name: "Tom" } },
  muted: { rows: MUTED, instants: [d("2026-11-04T12:00:00Z")], sender: { phone: "+447700900111", name: "Tom" } },
};

// ── The requests ───────────────────────────────────────────────────────

const ATTENDANCE_IN = {
  claims: [
    { subject: "sender", personRef: "", personNamed: false, polarity: "in", contingent: false, conditionOn: "none", tense: "present", reported: false, confidence: 0.95 },
  ],
  affirmation: "none",
  sideRequests: [],
};
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

const REQUESTS: Array<{ name: string; body: string; route: string; facts: Record<string, unknown>; tagged: boolean }> = [
  { name: "in", body: "IN", route: "self_att", facts: ATTENDANCE_IN, tagged: false },
  { name: "squad", body: "@Match Time who's playing?", route: "question", facts: question("squad"), tagged: true },
  { name: "club", body: "@Match Time who collects the money?", route: "question", facts: question("club"), tagged: true },
  { name: "payments", body: "@Match Time who hasn't paid?", route: "question", facts: question("payments"), tagged: true },
  { name: "options", body: "@Match Time can we play a smaller game?", route: "question", facts: question("options"), tagged: true },
  { name: "teams", body: "@Match Time make the teams", route: "balancer", facts: { action: "generate" }, tagged: true },
];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const stable = (v: unknown) => JSON.parse(JSON.stringify(v ?? null).replace(UUID, "<uuid>"));

const WRITE = /^(create|createMany|update|updateMany|upsert|delete|deleteMany|\$executeRaw)/;
const READ = /^(find|count|aggregate|groupBy)/;

async function send(name: string, now: Date, r: (typeof REQUESTS)[number]) {
  const shape = SHAPES[name];
  calls.length = 0;
  modelCalls.length = 0;
  state.db = fakeAnalyzeDb(analyzeWorld(shape.rows), calls);
  vi.setSystemTime(now);
  const id = `wa-${name}-${r.name}`;
  script.routes = { [id]: r.route };
  script.facts = { [r.body.trim()]: r.facts };
  const req = new Request("http://localhost/api/whatsapp/analyze", {
    method: "POST",
    headers: { "x-api-key": "test-key", "content-type": "application/json" },
    body: JSON.stringify({
      groupId: shape.rows.org.whatsappGroupId,
      messages: [
        {
          waMessageId: id,
          body: r.body,
          authorPhone: shape.sender.phone.replace(/^\+/, ""),
          authorName: shape.sender.name,
          timestamp: new Date(now.getTime() - 60_000).toISOString(),
          ...(r.tagged ? { botMentioned: true } : {}),
        },
      ],
    }),
  });
  const res = await POST(req);
  const body = await res.json();
  return {
    status: res.status,
    response: stable(body),
    model: stable(modelCalls),
    writes: stable(calls.filter((c) => WRITE.test(c.method)).map((c) => ({ call: `${c.model}.${c.method}`, args: c.args }))),
    reads: calls.filter((c) => READ.test(c.method)).length,
  };
}

let env: Record<string, string | undefined>;
beforeAll(() => {
  env = { WHATSAPP_API_KEY: process.env.WHATSAPP_API_KEY };
  process.env.WHATSAPP_API_KEY = "test-key";
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterAll(() => {
  vi.useRealTimers();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("the analyze path, per club shape (must not change in A2)", () => {
  for (const name of Object.keys(SHAPES)) {
    it(`POST /api/whatsapp/analyze: ${name}`, async () => {
      const out: Record<string, unknown> = {};
      for (const now of SHAPES[name].instants) {
        for (const r of REQUESTS) {
          const { reads: _reads, ...rest } = await send(name, now, r);
          out[`${now.toISOString()} ${r.name}`] = rest;
        }
      }
      expect(out).toMatchSnapshot();
    });

    it(`loadSquadState: ${name}`, async () => {
      const out: Record<string, unknown> = {};
      for (const now of SHAPES[name].instants) {
        calls.length = 0;
        state.db = fakeAnalyzeDb(analyzeWorld(SHAPES[name].rows), calls);
        vi.setSystemTime(now);
        out[now.toISOString()] = stable(await loadSquadState(SHAPES[name].rows.org.id, now));
      }
      expect(out).toMatchSnapshot();
    });
  }
});

describe("reads per request (reported, not pinned here)", () => {
  it("counts every read of one analyze request, per shape and message", async () => {
    const report: Record<string, Record<string, number>> = {};
    for (const name of Object.keys(SHAPES)) {
      report[name] = {};
      const now = SHAPES[name].instants[0];
      for (const r of REQUESTS) report[name][r.name] = (await send(name, now, r)).reads;
    }
    // MT_READS_REPORT=<file>: where to write the numbers.
    if (process.env.MT_READS_REPORT) (await import("node:fs")).writeFileSync(process.env.MT_READS_REPORT, JSON.stringify(report, null, 1));
    expect(Object.keys(report)).toHaveLength(Object.keys(SHAPES).length);
  });
});
