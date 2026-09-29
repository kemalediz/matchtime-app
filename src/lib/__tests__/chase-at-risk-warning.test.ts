/**
 * The 17:00 squad update gets louder when the match is actually at risk.
 *
 * Kemal, 2026-09-06: "if the match is close and there are many missing
 * players, the 5pm update should be more encouraging for people to
 * attend and kind of a warning that match will be cancelled if we can't
 * find enough players."
 *
 * THE CONSTRAINT THESE TESTS EXIST TO ENFORCE
 * -------------------------------------------
 * The model NEVER decides whether the match is at risk. "close" and
 * "many missing" are arithmetic, and arithmetic lives in code
 * (`computeChaseRisk`). The prompt is only ever handed the ANSWER — the
 * same shape as the format-switch block, which was moved into code after
 * the 2026-08-30 incident where the model did the subtraction itself and
 * named three real people as benched who weren't.
 *
 * A judgement call left to the model flips run to run. A cancellation
 * warning that shows up in 3 runs out of 6 is worse than one that never
 * shows up at all, and a spurious one on a healthy squad would be
 * alarming in a customer's group. So both directions are pinned here:
 * present when the arithmetic says so, and ABSENT byte-for-byte when it
 * doesn't.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeChaseRisk } from "@/lib/chase-risk";

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
// Mutable so one test can move the clock or the squad and re-compose.
const KICKOFF = new Date("2026-09-08T20:30:00.000Z");
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

function squad(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    status: "CONFIRMED",
    user: { id: `u${i}`, name: `Player${i + 1}`, phoneNumber: "+447700900000" },
  }));
}

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
  attendances: squad(6),
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

/** The per-kind compose instruction: the LAST uncached user text block. */
function composePrompt(args: CreateArgs): string {
  const blocks: Block[] = [];
  for (const m of args.messages) {
    if (typeof m.content === "string") continue;
    for (const c of m.content) if (!c.cache_control) blocks.push(c);
  }
  return blocks[blocks.length - 1]?.text ?? "";
}

/** Every content block carrying a cache_control marker, in order. */
function cachedTexts(args: CreateArgs): string[] {
  const out: string[] = [];
  for (const s of args.system) if (s.cache_control) out.push(s.text);
  for (const m of args.messages) {
    if (typeof m.content === "string") continue;
    for (const c of m.content) if (c.cache_control) out.push(c.text);
  }
  return out;
}

/** Fire one chase in a given world and return what went on the wire. */
async function request(
  kind: ChaseKind,
  world: { confirmed: number; hoursOut: number },
): Promise<CreateArgs> {
  MATCH.attendances = squad(world.confirmed);
  vi.setSystemTime(new Date(KICKOFF.getTime() - world.hoursOut * 3600_000));
  captured.length = 0;
  await composeChaseText({ groupId: "g1", kind });
  expect(create, `composeChaseText(${kind}) issued no request`).toHaveBeenCalled();
  return captured[0];
}

/** Worlds used throughout. 14-a-side, so `need` = 14 − confirmed. */
const AT_RISK = { confirmed: 6, hoursOut: 24 }; //  24h out, need 8
const HEALTHY = { confirmed: 6, hoursOut: 96 }; //  96h out, need 8 — too early
const NEARLY_FULL = { confirmed: 11, hoursOut: 24 }; // 24h out, need 3

beforeEach(() => {
  captured.length = 0;
  create.mockClear();
  process.env.ANTHROPIC_API_KEY = "sk-test";
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-06T12:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  MATCH.attendances = squad(6);
});

// ───────────────────────────────────────────────────────────────────
// 1. The arithmetic. Table-driven, at the boundaries.
// ───────────────────────────────────────────────────────────────────
describe("computeChaseRisk — the server, not the model, decides", () => {
  const NOW = new Date("2026-09-06T12:00:00.000Z");
  const at = (hoursOut: number) => new Date(NOW.getTime() + hoursOut * 3600_000);

  const TABLE: Array<{
    what: string;
    hoursOut: number;
    confirmed: number;
    maxPlayers: number;
    atRisk: boolean;
  }> = [
    // ── the hours boundary: 48 is in, 49 is out ──────────────────
    { what: "48h out, need 10", hoursOut: 48, confirmed: 4, maxPlayers: 14, atRisk: true },
    { what: "49h out, need 10", hoursOut: 49, confirmed: 4, maxPlayers: 14, atRisk: false },
    { what: "47.9h out, need 10", hoursOut: 47.9, confirmed: 4, maxPlayers: 14, atRisk: true },
    { what: "48.1h out, need 10", hoursOut: 48.1, confirmed: 4, maxPlayers: 14, atRisk: false },
    // ── the shortfall boundary: 4 is in, 3 is out ────────────────
    { what: "24h out, need 4", hoursOut: 24, confirmed: 10, maxPlayers: 14, atRisk: true },
    { what: "24h out, need 3", hoursOut: 24, confirmed: 11, maxPlayers: 14, atRisk: false },
    { what: "24h out, need 5", hoursOut: 24, confirmed: 9, maxPlayers: 14, atRisk: true },
    // ── a full (or over-full) squad is never at risk ─────────────
    { what: "1h out, need 0", hoursOut: 1, confirmed: 14, maxPlayers: 14, atRisk: false },
    { what: "48h out, need 0", hoursOut: 48, confirmed: 14, maxPlayers: 14, atRisk: false },
    { what: "1h out, over-full", hoursOut: 1, confirmed: 16, maxPlayers: 14, atRisk: false },
    // ── far out, however empty, is not "close" ───────────────────
    { what: "168h out, nobody in", hoursOut: 168, confirmed: 0, maxPlayers: 14, atRisk: false },
    // ── both conditions met at the very edge ─────────────────────
    { what: "48h out, need 4", hoursOut: 48, confirmed: 10, maxPlayers: 14, atRisk: true },
    { what: "49h out, need 4", hoursOut: 49, confirmed: 10, maxPlayers: 14, atRisk: false },
    { what: "48h out, need 3", hoursOut: 48, confirmed: 11, maxPlayers: 14, atRisk: false },
  ];

  for (const row of TABLE) {
    it(`${row.what} → ${row.atRisk ? "AT RISK" : "not at risk"}`, () => {
      const risk = computeChaseRisk({
        kickoff: at(row.hoursOut),
        confirmedCount: row.confirmed,
        maxPlayers: row.maxPlayers,
        now: NOW,
      });
      expect(risk.atRisk).toBe(row.atRisk);
      expect(risk.need).toBe(Math.max(0, row.maxPlayers - row.confirmed));
    });
  }

  it("never reports a negative shortfall", () => {
    const risk = computeChaseRisk({
      kickoff: at(2),
      confirmedCount: 20,
      maxPlayers: 14,
      now: NOW,
    });
    expect(risk.need).toBe(0);
    expect(risk.atRisk).toBe(false);
  });

  it("defaults `now` to the wall clock", () => {
    vi.setSystemTime(NOW);
    const risk = computeChaseRisk({
      kickoff: at(24),
      confirmedCount: 6,
      maxPlayers: 14,
    });
    expect(risk.atRisk).toBe(true);
    expect(risk.hoursToKickoff).toBeCloseTo(24, 5);
  });
});

// ───────────────────────────────────────────────────────────────────
// 2. What actually goes on the wire.
// ───────────────────────────────────────────────────────────────────
/** Markers of the at-risk block. None may leak into a healthy post. */
const AT_RISK_MARKERS = ["AT RISK", "call it off", "called off"];

describe("daily-in-list carries the at-risk block when the squad is short and the match is close", () => {
  it("tells the model the match is at risk — and that the SERVER decided", async () => {
    const prompt = composePrompt(await request("daily-in-list", AT_RISK));
    expect(prompt).toContain("AT RISK");
    expect(prompt.toLowerCase()).toMatch(/server (decided|worked)/);
    expect(
      prompt,
      "the model must be told never to do the counting itself",
    ).toMatch(/never count the squad/i);
  });

  it("asks for a harder push and a plain call-off warning", async () => {
    const prompt = composePrompt(await request("daily-in-list", AT_RISK));
    expect(prompt).toMatch(/called off/i);
    expect(prompt, "no guilt-tripping the people already out").toMatch(/guilt/i);
  });

  it("forbids MatchTime claiming it is the one cancelling", async () => {
    const prompt = composePrompt(await request("daily-in-list", AT_RISK));
    // Kemal cancels; MatchTime reports. Precedent from the real group,
    // 18 July: "if we can't find 3 more by end of tomorrow, i will
    // cancel the match" — that is a human speaking, not the bot.
    expect(prompt).toContain("we'll have to call it off");
    expect(prompt).toMatch(/never .{0,60}"?I will cancel/i);
  });

  it("keeps the format-switch line verbatim and coherent with the warning", async () => {
    const prompt = composePrompt(await request("daily-in-list", AT_RISK));
    expect(prompt).toMatch(/VERBATIM/);
    expect(prompt).toMatch(/alternative to calling it off/i);
  });

  it("does not reintroduce a send-time stamp (PR #47)", async () => {
    const prompt = composePrompt(await request("daily-in-list", AT_RISK));
    expect(prompt).not.toContain("5pm");
    expect(prompt).not.toMatch(/\d{1,2}\s*(?:am|pm)\b/i);
  });

  it("still asks for the one-liner, the lead and the roster block", async () => {
    const prompt = composePrompt(await request("daily-in-list", AT_RISK));
    expect(prompt).toContain("one-liner");
    expect(prompt).toContain("who's out");
    expect(prompt).toContain("count vs needed");
    expect(prompt).toContain("End with the roster block.");
  });
});

describe("a healthy squad gets the ORIGINAL prompt, byte for byte", () => {
  it("says nothing about cancellation when the match is still far off", async () => {
    const prompt = composePrompt(await request("daily-in-list", HEALTHY));
    for (const marker of AT_RISK_MARKERS) {
      expect(prompt, `"${marker}" must not reach a healthy post`).not.toContain(marker);
    }
    expect(prompt.toLowerCase()).not.toContain("cancel");
  });

  it("says nothing about cancellation when only 3 are missing", async () => {
    const prompt = composePrompt(await request("daily-in-list", NEARLY_FULL));
    for (const marker of AT_RISK_MARKERS) {
      expect(prompt, `"${marker}" must not reach a nearly-full post`).not.toContain(marker);
    }
    expect(prompt.toLowerCase()).not.toContain("cancel");
  });

  it("is byte-identical to the prompt the daily chase sent before this feature", async () => {
    // The block is additive or it is nothing. Anything else means the
    // healthy path changed, and the healthy path is 51 weeks of the year.
    const BASELINE = [
      "## Chase type",
      "daily-in-list",
      "",
      "Purpose: quick squad-state recap so the group sees where the numbers are.",
      "Open with a one-liner that sets the scene (e.g. '🗓 Squad update') followed by the lead (who's out / count vs needed). End with the roster block.",
    ].join("\n");
    const prompt = composePrompt(await request("daily-in-list", HEALTHY));
    // The clock block is prepended by composeChaseText; the chase-type
    // instruction is everything from its header on.
    expect(prompt.slice(prompt.indexOf("## Chase type"))).toBe(BASELINE);
  });

  it("adds the block, and only the block, when the state flips", async () => {
    const healthy = composePrompt(await request("daily-in-list", HEALTHY));
    const risky = composePrompt(await request("daily-in-list", AT_RISK));
    const healthyInstruction = healthy.slice(healthy.indexOf("## Chase type"));
    const riskyInstruction = risky.slice(risky.indexOf("## Chase type"));
    expect(riskyInstruction.startsWith(healthyInstruction)).toBe(true);
    expect(riskyInstruction.length).toBeGreaterThan(healthyInstruction.length);
  });
});

describe("the other four chase kinds are untouched", () => {
  const OTHERS: ChaseKind[] = [
    "match-day-morning",
    "chase-pre-kickoff",
    "pre-kickoff-full",
    "pre-kickoff-short",
  ];

  for (const kind of OTHERS) {
    it(`${kind} carries no at-risk block even in the at-risk state`, async () => {
      const prompt = composePrompt(await request(kind, AT_RISK));
      for (const marker of AT_RISK_MARKERS) {
        expect(prompt, `${kind} must not gain "${marker}"`).not.toContain(marker);
      }
    });
  }

  it("pre-kickoff-short keeps its own last-chance wording", async () => {
    const prompt = composePrompt(await request("pre-kickoff-short", AT_RISK));
    expect(prompt).toContain("last chance to jump in");
    expect(prompt).toContain("Lead with kickoff time + venue");
  });
});

// ───────────────────────────────────────────────────────────────────
// 3. Prompt caching. The block rides in the UNCACHED tail.
// ───────────────────────────────────────────────────────────────────
describe("the at-risk block does not move a cache prefix", () => {
  it("sends a byte-identical cached prefix either side of the 48h line", async () => {
    // Same squad, same everything — only the clock moves, from 49h out
    // (healthy) to 47h out (at risk). If the block had landed in a
    // cached block, this flip would turn a $0.30/MTok cache READ into a
    // $6/MTok cache WRITE on every scheduled chase. See
    // prompt-cache-request-shape.test.ts for the original incident.
    const before = await request("daily-in-list", { confirmed: 6, hoursOut: 49 });
    const after = await request("daily-in-list", { confirmed: 6, hoursOut: 47 });
    expect(cachedTexts(after)).toEqual(cachedTexts(before));
    // …and the block really did flip, so the assertion above has teeth.
    expect(composePrompt(before)).not.toContain("AT RISK");
    expect(composePrompt(after)).toContain("AT RISK");
  });

  it("keeps the at-risk block out of every cached block", async () => {
    const args = await request("daily-in-list", AT_RISK);
    const cached = cachedTexts(args).join("\n");
    expect(cached).not.toContain("AT RISK");
    expect(cached).not.toContain("call it off");
  });
});
