/**
 * A scheduled chase must never stamp itself with the time of day it was
 * SENT — but must still be free to state the time the match KICKS OFF.
 *
 * The incident (2026-09-04): the 17:00 chase actually fired at 20:06
 * London and opened "🗓 Quick 5pm update". Two faults in one line —
 * the clock was wrong, and Kemal never wanted a send-time stamp at all
 * ("we don't need the time on the updates going forward").
 *
 * The source was `buildChaseComposePrompt("daily-in-list")`, whose
 * example opener literally read '🗓 Quick 5pm update'; the model copied
 * it verbatim. The static fallback in bot-scheduler.ts carries no
 * timestamp, so the prompt was the only source.
 *
 * EXTENDED 2026-09-16: the same fault came back as a GREETING. The
 * rating promo opened "🎯 Morning all" at 16:05 London after an outage
 * delayed it, and `match-day-morning` was the one chase kind still being
 * handed "☀️ Morning all —" as an example opener. A greeting is a coarse
 * clock, so it falls under the same rule; the carve-out this file used
 * to grant it is gone. The static half of that fix lives in
 * `no-time-of-day-greeting.test.ts`.
 *
 * These tests assert on the REQUEST that goes on the wire (system +
 * user prompt), not on model output — the prompt is the thing we own.
 * REWRITTEN 2026-10-20 with the prompt (`chase-lead.ts`): the user turn
 * is now the facts alone, so "no opener to copy" is asserted over it,
 * and the rules are asserted over the one system prompt.
 * The regression half is the important half: three chase kinds REQUIRE
 * the kickoff time, and a ban written too broadly would silently strip
 * it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Anthropic SDK capture seam ────────────────────────────────────
type Block = { type: string; text: string; cache_control?: unknown };
type CreateArgs = {
  system: Block[];
  messages: Array<{ role: string; content: string | Block[] }>;
};
const captured: CreateArgs[] = [];
const create = vi.fn(async (args: CreateArgs) => {
  captured.push(args);
  return {
    content: [{ type: "text", text: "Need 10 more for Tuesday." }],
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

// ── DB seam ───────────────────────────────────────────────────────
const KICKOFF = new Date("2026-09-01T20:30:00.000Z");
// A live club well past its first four weeks, so the daily AI cap
// (lib/ai-budget.ts) allows the composer's call; the usage table's
// statements below always grant.
const ORG = {
  id: "org-1",
  name: "Sutton Football Club",
  teamLabels: null,
  whatsappBotEnabled: true,
  whatsappGroupId: "g1",
  createdAt: new Date("2026-04-01T00:00:00Z"),
  aiDailyCapUsd: null,
  aiWindowStartAt: null,
  // Approved by the migration default, like every club that predates self-join.
  approvalStatus: "approved",
  approvedAt: null,
};
const MATCH = {
  id: "m1",
  date: KICKOFF,
  status: "UPCOMING",
  maxPlayers: 14,
  activity: {
    name: "Tuesday 7-a-side",
    venue: "Sim Arena",
    sport: { name: "Football 7-a-side", playersPerTeam: 7, teamLabels: null },
  },
  attendances: ["Elvin", "Mustafa"].map((name, i) => ({
    status: "CONFIRMED",
    user: { id: `u${i}`, name, phoneNumber: "+447700900000" },
  })),
};

vi.mock("@/lib/db", () => ({
  db: {
    organisation: { findFirst: async () => ORG, findUnique: async () => ORG },
    $queryRaw: async () => [{ ok: 1 }],
    $executeRaw: async () => 1,
    match: { findFirst: async () => MATCH },
    activity: { findMany: async () => [] },
    benchSlotOffer: { findMany: async () => [] },
    user: { findMany: async () => [], findUnique: async () => null },
  },
}));
vi.mock("@/lib/org-features", () => ({
  getOrgFeatures: async () => ({ attendance: true, statsQa: false }),
}));

import { composeChaseText, type ChaseKind } from "@/lib/message-analyzer";

/** The system prompt actually sent. */
function systemText(args: CreateArgs): string {
  return args.system.map((b) => b.text).join("\n");
}

/** The user turn: the facts of this chase. */
function composePrompt(args: CreateArgs): string {
  const c = args.messages[0]?.content;
  return typeof c === "string" ? c : (c ?? []).map((b) => b.text).join("\n");
}

/** Fire one chase and return what went on the wire. */
async function request(kind: ChaseKind): Promise<CreateArgs> {
  captured.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  await composeChaseText({ groupId: "g1", kind });
  expect(create, `composeChaseText(${kind}) issued no request`).toHaveBeenCalled();
  return captured[0];
}

beforeEach(() => {
  captured.length = 0;
  create.mockClear();
  process.env.ANTHROPIC_API_KEY = "sk-test";
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

const KINDS: ChaseKind[] = ["daily-in-list", "match-day-morning", "chase-pre-kickoff", "pre-kickoff-short"];

describe("no chase hands the model a clock-time opener", () => {
  for (const kind of KINDS) {
    it(`${kind}: no am/pm time, no schedule slot, no time-of-day word in the facts`, async () => {
      const prompt = composePrompt(await request(kind));
      expect(prompt).not.toContain("5pm");
      expect(prompt).not.toMatch(/\d{1,2}\s*(?:am|pm)\b/i);
      expect(prompt).not.toContain("17:00 London");
      expect(prompt).not.toContain("8-9am");
      expect(prompt, `${kind}'s facts suggest a greeting the scheduler cannot guarantee`).not.toMatch(
        /\b(morning|afternoon|evening)\b/i,
      );
    });
  }
});

describe("the chase system prompt bans a send-time stamp and a greeting", () => {
  it("forbids stamping the message with the time it was sent", async () => {
    expect(systemText(await request("daily-in-list"))).toMatch(/never the time the post is sent/i);
  });

  it("names the shapes the model actually produced", async () => {
    const system = systemText(await request("daily-in-list"));
    for (const banned of ["Morning all", "Evening update"]) {
      expect(system, `the rule should name "${banned}" as banned`).toContain(banned);
    }
    expect(system).toMatch(/no greeting and no time of day/i);
  });

  it("the day words follow the kickoff line, never the clock", async () => {
    expect(systemText(await request("daily-in-list"))).toContain(
      'Say "tonight", "today" or "tomorrow" only when the kickoff line says today or tomorrow',
    );
  });
});

describe("REGRESSION: the pre-kickoff kinds still ask for the kickoff time", () => {
  it("before-kickoff: the kickoff time", async () => {
    expect(systemText(await request("chase-pre-kickoff"))).toMatch(/before-kickoff: [^\n]*Give the kickoff time\./);
  });

  it("last-call: the kickoff time and the venue", async () => {
    expect(systemText(await request("pre-kickoff-short"))).toMatch(/last-call: [^\n]*Give the kickoff time and the venue\./);
  });

  it("every kind is handed the kickoff time to give", async () => {
    for (const kind of KINDS) expect(composePrompt(await request(kind))).toMatch(/^Kickoff: .*\b\d{2}:\d{2}\b/m);
  });
});
