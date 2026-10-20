/**
 * THE CHASE COMPOSER END TO END, WITH THE MODEL STUBBED (2026-10-20).
 *
 * `composeChaseText` reads the match the scheduler is chasing, asks the
 * model for the opening line only, and posts that line over the squad
 * list code renders. These pin the seams: what reaches the model, what
 * the post is built from, and that a failed or fact-breaking line is
 * replaced by the fixed copy rather than posted or dropped.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Block = { type: string; text: string; cache_control?: unknown };
type CreateArgs = {
  model: string;
  max_tokens: number;
  system: Block[];
  messages: Array<{ role: string; content: string | Block[] }>;
  thinking?: { type: string };
  output_config?: { format?: { type: string; schema: unknown }; effort?: string };
};
const captured: CreateArgs[] = [];
let reply: () => unknown = () => ({ lead: "🗓 *Tuesday 7-a-side* needs *8 more*. Say *IN* ⚽" });
const create = vi.fn(async (args: CreateArgs) => {
  captured.push(args);
  const r = reply();
  if (r instanceof Error) throw r;
  return {
    model: args.model,
    content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r) }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
});
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create };
    constructor(_opts: unknown) {}
  }
  return { default: FakeAnthropic };
});

const KICKOFF = new Date("2026-09-08T20:30:00.000Z"); // Tue 21:30 London
const NOW = new Date("2026-09-05T16:00:00.000Z"); // Sat 17:00 London, 3 days out
const ORG = {
  id: "org-1",
  name: "Riverside FC",
  language: "en",
  whatsappBotEnabled: true,
  whatsappGroupId: "g1",
  createdAt: new Date("2026-04-01T00:00:00Z"),
  aiDailyCapUsd: null,
  aiWindowStartAt: null,
  approvalStatus: "approved",
  approvedAt: null,
};
const NAMES = ["Ali Kaya", "Dan Moore", "Sam Price", "Joe Hart", "Tom Reed", "Ben Cole", "Luke Shaw", "Matt Fox", "Ravi Shah", "Owen Hale"];
function rows(confirmed: number, bench = 0) {
  return NAMES.slice(0, confirmed + bench).map((name, i) => ({
    status: i < confirmed ? "CONFIRMED" : "BENCH",
    user: { id: `u${i}`, name, phoneNumber: "+447700900000" },
  }));
}
const MATCH = {
  id: "m1",
  date: KICKOFF,
  status: "UPCOMING",
  maxPlayers: 14,
  activity: { name: "Tuesday 7-a-side", venue: "Sim Arena", sport: { name: "Football 7-a-side", playersPerTeam: 7 } },
  attendances: rows(6, 1),
};
const findMatch = vi.fn(async (_args: unknown) => MATCH as typeof MATCH | null);
let siblings: Array<{ sport: { name: string; playersPerTeam: number } }> = [];

vi.mock("@/lib/db", () => ({
  db: {
    organisation: { findFirst: async () => ORG, findUnique: async () => ORG },
    $queryRaw: async () => [{ ok: 1 }],
    $executeRaw: async () => 1,
    match: { findFirst: (a: unknown) => findMatch(a) },
    activity: { findMany: async () => siblings },
  },
}));

import { composeChaseText, composeChaseFromMatch, CHASE_COMPOSER_CALL } from "@/lib/message-analyzer";
import { CHASE_LEAD_SYSTEM, chaseLeadUserTurn, chaseFallbackLead } from "@/lib/chase-lead";
import { buildSquadRosterBlock } from "@/lib/scheduler-copy";
import { t } from "@/lib/i18n/t";

const ROSTER_EN = buildSquadRosterBlock({
  confirmed: NAMES.slice(0, 6).map((name) => ({ name })),
  bench: [{ name: NAMES[6] }],
  maxPlayers: 14,
  lang: "en",
});

function userText(a: CreateArgs): string {
  const c = a.messages[0].content;
  return typeof c === "string" ? c : c.map((b) => b.text).join("\n");
}

beforeEach(() => {
  captured.length = 0;
  create.mockClear();
  findMatch.mockClear();
  reply = () => ({ lead: "🗓 *Tuesday 7-a-side* needs *8 more*. Say *IN* ⚽" });
  siblings = [];
  ORG.language = "en";
  MATCH.attendances = rows(6, 1);
  process.env.ANTHROPIC_API_KEY = "sk-test";
});

describe("the post: the model's line over the squad list code renders", () => {
  it("is the lead, a blank line, then buildSquadRosterBlock", async () => {
    const text = await composeChaseText({ groupId: "g1", kind: "daily-in-list", matchId: "m1", now: NOW });
    expect(text).toBe(`🗓 *Tuesday 7-a-side* needs *8 more*. Say *IN* ⚽\n\n${ROSTER_EN}`);
  });

  it("leaves the list out when the group has just seen it", async () => {
    const text = await composeChaseText({ groupId: "g1", kind: "daily-in-list", matchId: "m1", now: NOW, withRoster: false });
    expect(text).toBe("🗓 *Tuesday 7-a-side* needs *8 more*. Say *IN* ⚽");
  });

  it("reads the match the scheduler is chasing, by id", async () => {
    await composeChaseText({ groupId: "g1", kind: "daily-in-list", matchId: "m1", now: NOW });
    expect(JSON.stringify(findMatch.mock.calls[0][0])).toContain('"id":"m1"');
  });

  it("Turkish: the list in Turkish", async () => {
    ORG.language = "tr";
    reply = () => ({ lead: "🗓 *Tuesday 7-a-side* için *8 kişi* daha lazım, *VARIM* yazın ⚽" });
    const text = await composeChaseText({ groupId: "g1", kind: "daily-in-list", matchId: "m1", now: NOW });
    expect(text).toContain(t("tr").roster_confirmed_header({ confirmed: 6, maxPlayers: 14 }));
    expect(text).toContain(t("tr").bench_header({ count: 1 }));
  });

  it("adds the server's format-switch line when it applies", async () => {
    siblings = [{ sport: { name: "Football 5-a-side", playersPerTeam: 5 } }];
    MATCH.attendances = rows(10);
    const now = new Date(KICKOFF.getTime() - 20 * 3600_000);
    reply = () => ({ lead: "Need *4 more* for Tue 8 Sept, say *IN*." });
    const text = await composeChaseText({ groupId: "g1", kind: "daily-in-list", matchId: "m1", now });
    expect(text).toMatch(/\n\nIf we don't find 4 more, we could switch to 5-a-side \(10 players\)[^\n]*\n\n\*Confirmed \(10\/14\):\*/);
  });
});

describe("what the model is asked", () => {
  it("the new system prompt, cached, on the shipped model with a schema", async () => {
    await composeChaseText({ groupId: "g1", kind: "daily-in-list", matchId: "m1", now: NOW });
    const a = captured[0];
    expect(a.system).toEqual([{ type: "text", text: CHASE_LEAD_SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } }]);
    expect(a.model).toBe(CHASE_COMPOSER_CALL.model);
    expect(a.output_config?.format?.type).toBe("json_schema");
  });

  it("the facts, and no name", async () => {
    await composeChaseText({ groupId: "g1", kind: "daily-in-list", matchId: "m1", now: NOW });
    const u = userText(captured[0]);
    expect(u).toBe(
      chaseLeadUserTurn({
        kind: "daily-in-list",
        lang: "en",
        activityName: "Tuesday 7-a-side",
        venue: "Sim Arena",
        kickoff: KICKOFF,
        now: NOW,
        confirmed: 6,
        maxPlayers: 14,
        bench: 1,
        atRisk: false,
      }),
    );
    for (const n of NAMES) expect(u).not.toContain(n);
  });

  it("at risk only on the daily post, and only when the server says so", async () => {
    const close = new Date(KICKOFF.getTime() - 24 * 3600_000);
    await composeChaseText({ groupId: "g1", kind: "daily-in-list", matchId: "m1", now: close });
    expect(userText(captured[0])).toContain("At risk: yes");
    await composeChaseText({ groupId: "g1", kind: "match-day-morning", matchId: "m1", now: close });
    expect(userText(captured[1])).toContain("At risk: no");
    await composeChaseText({ groupId: "g1", kind: "daily-in-list", matchId: "m1", now: NOW });
    expect(userText(captured[2])).toContain("At risk: no");
  });
});

describe("a line that cannot be posted is replaced by the fixed one", () => {
  const fallback = chaseFallbackLead({
    kind: "daily-in-list",
    lang: "en",
    activityName: "Tuesday 7-a-side",
    venue: "Sim Arena",
    kickoff: KICKOFF,
    now: NOW,
    confirmed: 6,
    maxPlayers: 14,
    bench: 1,
    atRisk: false,
  });

  it("a number the squad does not hold", async () => {
    reply = () => ({ lead: "Need *3 more*, say IN" });
    expect(await composeChaseText({ groupId: "g1", kind: "daily-in-list", matchId: "m1", now: NOW })).toBe(`${fallback}\n\n${ROSTER_EN}`);
  });

  it("a failed call", async () => {
    reply = () => new Error("529 overloaded");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await composeChaseText({ groupId: "g1", kind: "daily-in-list", matchId: "m1", now: NOW })).toBe(`${fallback}\n\n${ROSTER_EN}`);
    expect(errors.mock.calls.flat().join(" ")).toMatch(/chase/);
    errors.mockRestore();
  });

  it("a body that is not the schema", async () => {
    reply = () => "Here's your message!";
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await composeChaseText({ groupId: "g1", kind: "daily-in-list", matchId: "m1", now: NOW })).toBe(`${fallback}\n\n${ROSTER_EN}`);
  });

  it("no key: the fixed line, no call", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(await composeChaseText({ groupId: "g1", kind: "daily-in-list", matchId: "m1", now: NOW })).toBe(`${fallback}\n\n${ROSTER_EN}`);
    expect(create).not.toHaveBeenCalled();
  });

  it("composeChaseFromMatch says whether the line came from the model", async () => {
    const ok = await composeChaseFromMatch({ kind: "daily-in-list", match: MATCH, now: NOW });
    expect(ok.fromModel).toBe(true);
    reply = () => ({ lead: "Need *3 more*" });
    const bad = await composeChaseFromMatch({ kind: "daily-in-list", match: MATCH, now: NOW });
    expect(bad.fromModel).toBe(false);
    expect(bad.lead).toBe(fallback);
  });
});

describe("nothing to chase", () => {
  it("no match: null, and the scheduler sends its static copy", async () => {
    findMatch.mockResolvedValueOnce(null);
    expect(await composeChaseText({ groupId: "g1", kind: "daily-in-list", matchId: "m1", now: NOW })).toBeNull();
  });
});
