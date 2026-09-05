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
 * These tests assert on the REQUEST that goes on the wire (system +
 * user prompt), not on model output — the prompt is the thing we own.
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
const ORG = { id: "org-1", name: "Sutton Football Club", teamLabels: null };
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

/** The system prompt actually sent (CHASE_SYSTEM_PROMPT is module-private). */
function systemText(args: CreateArgs): string {
  return args.system.map((b) => b.text).join("\n");
}

/** The per-kind compose instruction: the LAST uncached user text block. */
function composePrompt(args: CreateArgs): string {
  const blocks: Block[] = [];
  for (const m of args.messages) {
    if (typeof m.content === "string") continue;
    for (const c of m.content) if (!c.cache_control) blocks.push(c);
  }
  return blocks[blocks.length - 1]?.text ?? "";
}

/** Fire one chase and return what went on the wire. */
async function request(kind: ChaseKind): Promise<CreateArgs> {
  captured.length = 0;
  await composeChaseText({ groupId: "g1", kind });
  expect(create, `composeChaseText(${kind}) issued no request`).toHaveBeenCalled();
  return captured[0];
}

beforeEach(() => {
  captured.length = 0;
  create.mockClear();
  process.env.ANTHROPIC_API_KEY = "sk-test";
  delete process.env.MT_TEST_LLM_STUB_FILE;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
});
afterEach(() => vi.useRealTimers());

describe("daily-in-list no longer suggests a clock-time opener", () => {
  it("does not hand the model the '🗓 Quick 5pm update' example", async () => {
    const prompt = composePrompt(await request("daily-in-list"));
    expect(prompt).not.toContain("Quick 5pm update");
    expect(prompt).not.toContain("5pm");
  });

  it("suggests no am/pm opener at all", async () => {
    const prompt = composePrompt(await request("daily-in-list"));
    // The whole instruction, label included, must be free of a wall-clock
    // opener the model can copy. ("17:00 London" on the type line is the
    // schedule slot, not an opener — see the send-time rule test below.)
    expect(
      prompt,
      "any am/pm time in the daily chase instruction is an opener the model will copy",
    ).not.toMatch(/\d{1,2}\s*(?:am|pm)\b/i);
  });

  it("keeps the rest of the instruction intact", async () => {
    const prompt = composePrompt(await request("daily-in-list"));
    // Substance that must survive the edit: an opening one-liner, the
    // lead (who's out / count vs needed) and the closing roster block.
    expect(prompt).toContain("one-liner");
    expect(prompt).toContain("who's out");
    expect(prompt).toContain("count vs needed");
    expect(prompt).toContain("End with the roster block.");
  });
});

describe("the chase system prompt bans a send-time stamp", () => {
  it("forbids stamping the message with the time it was sent", async () => {
    const system = systemText(await request("daily-in-list"));
    expect(
      system,
      "CHASE_SYSTEM_PROMPT must carry an explicit no-send-time-stamp rule",
    ).toMatch(/never .{0,80}time of day .{0,40}sent/i);
  });

  it("names the shapes the model actually produced", async () => {
    const system = systemText(await request("daily-in-list"));
    for (const banned of ["Quick 5pm update", "17:00 update", "Evening update", "Morning update"]) {
      expect(system, `the rule should name "${banned}" as banned`).toContain(banned);
    }
  });

  it("carves out the KICKOFF time as explicitly allowed", async () => {
    const system = systemText(await request("daily-in-list"));
    // The ban and the carve-out have to sit together, or the model
    // generalises the ban onto the kickoff time three kinds require.
    const rule = system
      .split("\n")
      .find((l) => /time of day .{0,40}sent/i.test(l));
    expect(rule, "no send-time rule found in the system prompt").toBeTruthy();
    expect(
      rule,
      "the send-time ban must say, in the same breath, that the KICKOFF time is fine",
    ).toMatch(/kickoff/i);
  });

  it("leaves the separate proximity rule untouched", async () => {
    const system = systemText(await request("daily-in-list"));
    expect(system).toContain(
      'NEVER write "tonight", "this evening", "tomorrow" or similar temporal references in the LEAD text unless "proximity=" in the Match Context confirms it.',
    );
  });
});

describe("REGRESSION: the pre-kickoff kinds still demand the kickoff time", () => {
  it("chase-pre-kickoff still says to mention kickoff time", async () => {
    const prompt = composePrompt(await request("chase-pre-kickoff"));
    expect(prompt).toContain("Mention kickoff time.");
  });

  it("pre-kickoff-full still leads with kickoff time + venue", async () => {
    const prompt = composePrompt(await request("pre-kickoff-full"));
    expect(prompt).toContain("Lead with kickoff time + venue");
  });

  it("pre-kickoff-short still leads with kickoff time + venue", async () => {
    const prompt = composePrompt(await request("pre-kickoff-short"));
    expect(prompt).toContain("Lead with kickoff time + venue");
  });

  it("match-day-morning keeps its greeting (a greeting is not a clock stamp)", async () => {
    const prompt = composePrompt(await request("match-day-morning"));
    expect(prompt).toContain("☀️ Morning all —");
  });
});
