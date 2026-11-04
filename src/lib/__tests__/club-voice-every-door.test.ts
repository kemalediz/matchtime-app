/**
 * EVERY DOOR ASKS THE ONE RULE (club summary, slice B6; plan D10, D15;
 * section 3.17): may MatchTime send this club anything now, and what.
 *
 * The real routes over the A3 fake world (fixtures/hq-dm-world.ts), with a
 * recording model (no network, no key): a club that is DORMANT with its bot
 * left on (dormancy never touches the mute switch, actions/org.ts) must get
 * nothing on any door, before any model is asked; a MUTED club's members
 * get nothing by DM either, as its players' group already does.
 *
 * Each case was red on the code before B6 (the door read the mute switch,
 * or the billing pause, but never dormancy; the DM door read none of them).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MUTED, SUTTON, orgRow, featuresFor } from "../club-summary/__tests__/fixtures";
import type { ClubRows } from "../club-summary/derive";
import { fakeHqDmDb, hqDmWorld, phoneOf, withHq, type Call } from "./fixtures/hq-dm-world";

const state: { db: unknown } = { db: null };
const calls: Call[] = [];
const modelCalls: string[] = [];

vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
}));

vi.mock("@anthropic-ai/sdk", () => {
  class Anthropic {
    messages = {
      create: async () => {
        modelCalls.push("raw");
        return { content: [{ type: "text", text: JSON.stringify({ intent: "question", intro: [], club_ref: "", confidence: 0.95, reasoning: "t" }) }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } };
      },
    };
  }
  return { default: Anthropic, Anthropic };
});

vi.mock("@/lib/pipeline/llm", async (orig) => {
  const actual = await orig<typeof import("@/lib/pipeline/llm")>();
  return {
    ...actual,
    anthropicModel: () => ({
      name: "recorder",
      async complete(req: { label: string; shortIds?: Record<string, string> }) {
        modelCalls.push(req.label);
        const text =
          req.label === "router"
            ? JSON.stringify({ routes: Object.keys(req.shortIds ?? {}).map((id) => ({ id, route: "question", to_bot: true, pasted_list: false })) })
            : "{}";
        return { text, stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 };
      },
    }),
  };
});

import { POST as ANALYZE_POST } from "@/app/api/whatsapp/analyze/route";
import { POST as HQ_POST } from "@/app/api/whatsapp/admin-group/route";
import { POST as DM_POST } from "@/app/api/whatsapp/dm-reply/route";
import { GET as DUE_GET } from "@/app/api/whatsapp/due-posts/route";

const d = (iso: string) => new Date(iso);
const NOW = d("2026-11-04T12:00:00Z");

/** Sutton FC declared dormant, its bot left on (dormancy does not mute). */
const DORMANT_ORG = orgRow({ ...SUTTON.org, dormantAt: d("2026-10-20T10:00:00Z") });
const DORMANT: ClubRows = withHq({ ...SUTTON, org: DORMANT_ORG, features: featuresFor(DORMANT_ORG) });
const ON: ClubRows = withHq(SUTTON);

const mutedRoster: ClubRows = withHq({
  ...MUTED,
  members: {
    rows: [
      { id: "mem-mu-o", createdAt: d("2026-01-01T00:00:00Z"), role: "OWNER", user: { id: "u-mu-o", name: "Owen", phoneNumber: null } },
      { id: "mem-mu-p", createdAt: d("2026-02-01T00:00:00Z"), role: "PLAYER", user: { id: "u-mu-p", name: "Pete", phoneNumber: null } },
    ],
    displayNames: { "u-mu-o": "Owen", "u-mu-p": "Pete" },
    aliases: {},
  },
});

const WRITE = /^(create|createMany|update|updateMany|upsert|delete|deleteMany|\$executeRaw)/;
const writesOf = () => calls.filter((c) => WRITE.test(c.method)).map((c) => `${c.model}.${c.method}`);

function fresh(rows: ClubRows) {
  calls.length = 0;
  modelCalls.length = 0;
  state.db = fakeHqDmDb(hqDmWorld(rows), calls);
  vi.setSystemTime(NOW);
}

const post = (url: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { "x-api-key": "test-key", "content-type": "application/json" }, body: JSON.stringify(body) });

async function analyze(rows: ClubRows) {
  fresh(rows);
  const res = await ANALYZE_POST(
    post("/api/whatsapp/analyze", {
      groupId: rows.org.whatsappGroupId,
      messages: [{ waMessageId: "wa-voice-1", body: "@Match Time who's playing?", authorPhone: "44775", authorName: "Zed", timestamp: new Date(NOW.getTime() - 60_000).toISOString(), botMentioned: true }],
    }),
  );
  return (await res.json()) as Record<string, unknown>;
}

async function hq(rows: ClubRows, sender: string) {
  fresh(rows);
  const res = await HQ_POST(
    post("/api/whatsapp/admin-group", {
      channel: "admin-group",
      groupId: rows.org.adminGroupId,
      messageId: "wa-voice-hq",
      text: "@Match Time who's playing?",
      botMentioned: true,
      senderPhone: phoneOf(rows, sender).replace(/^\+/, ""),
      timestamp: String(Math.floor((NOW.getTime() - 60_000) / 1000)),
    }),
  );
  return (await res.json()) as Record<string, unknown>;
}

async function dm(rows: ClubRows, sender: string, body: string) {
  fresh(rows);
  const res = await DM_POST(post("/api/whatsapp/dm-reply", { phone: phoneOf(rows, sender).replace(/^\+/, ""), body, waMessageId: `wa-voice-dm-${body}`, authorName: "Someone" }));
  return (await res.json()) as Record<string, unknown>;
}

let env: Record<string, string | undefined>;
beforeAll(() => {
  env = { WHATSAPP_API_KEY: process.env.WHATSAPP_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, AUTH_SECRET: process.env.AUTH_SECRET };
  process.env.WHATSAPP_API_KEY = "test-key";
  process.env.ANTHROPIC_API_KEY = "test-recorder-no-network";
  process.env.AUTH_SECRET = "test-secret";
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterAll(() => {
  vi.useRealTimers();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("the players' group door (analyze)", () => {
  it("a dormant club with its bot on: ignored, no model asked, nothing written", async () => {
    const out = await analyze(DORMANT);
    expect(out).toMatchObject({ ok: true, ignored: "unknown-or-disabled-group" });
    expect(modelCalls).toEqual([]);
    expect(writesOf()).toEqual([]);
  });
  it("control: the same club awake reads the message", async () => {
    const out = await analyze(ON);
    expect(out.ignored).toBeUndefined();
    expect(modelCalls).toContain("router");
  });
});

describe("the admin group door (HQ)", () => {
  it("a dormant club: ignored before anything is read for it, no model asked", async () => {
    const out = await hq(DORMANT, "u-kemal");
    expect(out).toMatchObject({ handled: false, ignored: "club-dormant" });
    expect(modelCalls).toEqual([]);
    expect(writesOf()).toEqual([]);
  });
  it("control: awake, the question is read", async () => {
    await hq(ON, "u-kemal");
    expect(modelCalls).toContain("router");
  });
  it("muted with no open pick round: the admins' own conversation, unchanged", async () => {
    const out = await hq(mutedRoster, "u-mu-o");
    expect(out).toMatchObject({ handled: false, ignored: "no-open-pick" });
    expect(modelCalls).toEqual([]);
  });
});

describe("the DM door", () => {
  it("a member of a dormant club only: ignored before any model, nothing queued", async () => {
    const out = await dm(DORMANT, "u-zed", "what time is kick off?");
    expect(out).toMatchObject({ ok: true, ignored: "club-dormant" });
    expect(modelCalls).toEqual([]);
    expect(writesOf().filter((w) => w.startsWith("botJob"))).toEqual([]);
  });
  it("a member of a muted club only: ignored, as the club's players' group is", async () => {
    const out = await dm(mutedRoster, "u-mu-p", "what time is kick off?");
    expect(out).toMatchObject({ ok: true, ignored: "club-muted" });
    expect(modelCalls).toEqual([]);
  });
  it("control: a member of a club that speaks is read", async () => {
    const out = await dm(ON, "u-zed", "what time is kick off?");
    expect(out.ignored).toBeUndefined();
    expect(modelCalls.length).toBeGreaterThan(0);
  });
});

describe("the picture reader (a model reads an organiser's picture in the players' group)", () => {
  it("a dormant club's group: no club found, so no model is asked", async () => {
    fresh(DORMANT);
    const { prismaPictureDeps } = await import("@/lib/picture-reading-db");
    const deps = prismaPictureDeps({ name: "none" } as never);
    expect(await deps.findClub(String(DORMANT.org.whatsappGroupId))).toBeNull();
    fresh(ON);
    expect(await deps.findClub(String(ON.org.whatsappGroupId))).toMatchObject({ id: ON.org.id });
  });
});

describe("the drain (due-posts): every queued and scheduled message leaves here", () => {
  it("a dormant club with its bot on gets a 404 and no post", async () => {
    fresh(DORMANT);
    const res = await DUE_GET(new Request(`http://localhost/api/whatsapp/due-posts?groupId=${encodeURIComponent(String(DORMANT.org.whatsappGroupId))}`, { headers: { "x-api-key": "test-key" } }));
    expect(res.status).toBe(404);
    expect(writesOf()).toEqual([]);
  });
});
