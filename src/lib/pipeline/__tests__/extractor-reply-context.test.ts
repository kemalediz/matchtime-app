/**
 * WHAT A GROUP EXTRACTOR IS SHOWN OF A REPLY (quoted-reply context, slice
 * S4, 2026-10-20). Every extractor that reads a group message (attendance,
 * question, teams, score, admin) is shown the time now and, for a WhatsApp
 * reply, the message it quotes, whoever wrote it, in the block the DM
 * classifiers read. An owner acting on a match is shown a quoted MatchTime
 * post only when it names that match or none (`quoteForMatch`).
 */
import { describe, it, expect } from "vitest";
import { extractForRoute, type ExtractorMessage } from "../extractors";
import type { ModelRequest, ModelResponse, PipelineModel } from "../llm";
import type { Route, SquadState } from "../types";
import { runAttendanceEngineBatch, type EngineBatchMessage } from "../../attendance-engine-batch";
import { runScoreBatch } from "../../score-engine-batch";

const NOW = new Date("2026-10-20T18:00:00Z");

function recording(text: string): PipelineModel & { reqs: ModelRequest[] } {
  const reqs: ModelRequest[] = [];
  return {
    name: "fake",
    reqs,
    async complete(req): Promise<ModelResponse> {
      reqs.push(req);
      return { text, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 1 };
    },
  };
}

const NO_CLAIMS = JSON.stringify({ claims: [], affirmation: "none", sideRequests: [] });

const base: ExtractorMessage = {
  id: "wa-1",
  body: "same",
  authorName: "Bo",
  tagged: false,
  history: [{ author: "Ali Khan", body: "IN" }],
  lastBotPost: "Tuesday 7-a-side: 12/14",
  now: NOW,
};

describe("the extractor's user turn", () => {
  it("not a reply: RECENT CHAT, MatchTime's last post, the time now, then THE MESSAGE", async () => {
    const m = recording(NO_CLAIMS);
    await extractForRoute(m, "self_att", base);
    expect(m.reqs[0].user).toBe(
      "RECENT CHAT (context only, never extract from it):\n  Ali Khan: IN\n" +
        "MATCHTIME'S LAST POST: Tuesday 7-a-side: 12/14\n" +
        "NOW: Tuesday 20 October 2026, 19:00 (club time, London)\n\n" +
        "THE MESSAGE (from Bo):\nsame",
    );
  });

  it("a reply to a member: their message, named and timed, right above THE MESSAGE", async () => {
    const m = recording(NO_CLAIMS);
    await extractForRoute(m, "self_att", {
      ...base,
      reply: { author: { name: "Ali Khan" }, at: new Date("2026-10-20T17:59:00Z"), text: "IN", topic: null, match: null },
    });
    expect(m.reqs[0].user).toContain(
      "NOW: Tuesday 20 October 2026, 19:00 (club time, London)\nTHEY ARE REPLYING TO Ali Khan's message of Tue 20 Oct, 18:59:\n\"IN\"\n\nTHE MESSAGE (from Bo):\nsame",
    );
  });

  it("a reply to MatchTime's last post shows it once, as the post replied to", async () => {
    const m = recording(NO_CLAIMS);
    await extractForRoute(m, "self_att", { ...base, reply: { author: null, at: null, text: "Tuesday 7-a-side: 12/14", topic: null, match: null } });
    expect(m.reqs[0].user).not.toContain("MATCHTIME'S LAST POST");
    expect(m.reqs[0].user).toContain('THEY ARE REPLYING TO a MatchTime message (when it was sent is not known):\n"Tuesday 7-a-side: 12/14"');
  });

  it.each<[Route]>([["question"], ["balancer"], ["score"], ["admin_ops"]])("the %s extractor gets the same block", async (route) => {
    const m = recording("{}");
    await extractForRoute(m, route, { ...base, reply: { author: { name: "Ali Khan" }, at: null, text: "Tom is out", topic: null, match: null } });
    expect(m.reqs[0].user).toContain("THEY ARE REPLYING TO Ali Khan's message (when it was sent is not known):\n\"Tom is out\"");
    expect(m.reqs[0].user).toContain("NOW: ");
  });
});

function squadState(over: Partial<SquadState> = {}): SquadState {
  return {
    matchId: "m-tue",
    maxPlayers: 14,
    kickoffLabel: "Tue 20:00",
    venue: "The Pitch",
    rows: [],
    roster: [{ userId: "u-bo", name: "Bo", isAdmin: false, hasPhone: true }],
    openOffers: [],
    teams: [],
    teamLabels: ["Red", "Yellow"],
    completedMatch: null,
    payments: null,
    ratingProgress: null,
    lastBotPost: null,
    features: { attendance: true, paymentTracking: false, statsQa: false, reminders: false, language: "en" },
    smallerFormats: [],
    guestAskedUserIds: [],
    ...over,
  } as SquadState;
}

const engineMsg = (over: Partial<EngineBatchMessage> = {}): EngineBatchMessage => ({
  waMessageId: "wa-1",
  body: "IN",
  authorName: "Bo",
  senderUserId: "u-bo",
  senderName: "Bo",
  senderIsAdmin: false,
  tagged: true,
  route: "self_att",
  gated: false,
  ...over,
});

async function attendanceRun(reply: EngineBatchMessage["reply"]) {
  const model = recording(SELF_IN);
  const registered: string[] = [];
  const res = await runAttendanceEngineBatch({
    orgId: "org-1",
    now: NOW,
    messages: [engineMsg({ reply })],
    history: [],
    expectedMatchId: "m-tue",
    enabled: true,
    deps: {
      model,
      loadState: async () => squadState(),
      openBenchPromptUserIds: async () => [],
      claimGuestNameAsk: async () => true,
      registerAttendance: async (userId: string) => {
        registered.push(userId);
        return { status: "CONFIRMED" as const, position: 1, slot: 1, confirmedCount: 1, maxPlayers: 14 };
      },
      cancelAttendance: async () => ({ status: "DROPPED" as const }),
      resolveOrProvision: async (name: string) => ({ userId: `new:${name}` }),
    } as never,
  });
  return { turn: model.reqs[0]?.user ?? "", calls: model.reqs.length, registered, owned: res.ownedIds.has("wa-1"), degradations: res.degradations };
}

const SELF_IN = JSON.stringify({
  claims: [{ subject: "sender", personRef: "", personNamed: false, polarity: "in", contingent: false, conditionOn: "none", tense: "present", basis: "decision", reported: false, replaces: "", confidence: 0.95 }],
  affirmation: "none",
  sideRequests: [],
});

// REVIEW OF #341, FINDING 8: a reply to MatchTime's post about ANOTHER match
// keeps its evidence; the owner acting on THIS match writes nothing to it.
describe("a reply quoting MatchTime's post about another match is never written to this one", () => {
  const post = (matchId: string | null) => ({ author: null, at: null, text: "Squad list", topic: "attendance" as const, matchId, match: null, found: true });

  it("this match's post, or one naming no match: shown, and the IN is registered", async () => {
    for (const q of [post("m-tue"), post(null)]) {
      const r = await attendanceRun(q);
      expect(r.turn).toContain("THEY ARE REPLYING TO");
      expect(r.registered).toEqual(["u-bo"]);
    }
  });

  it("an older match's post (last week's squad list): not owned, nothing written, the reason kept", async () => {
    const r = await attendanceRun(post("m-last-week"));
    expect(r.owned).toBe(false);
    expect(r.registered).toEqual([]);
    expect(r.calls).toBe(0);
    expect(r.degradations.join(" ")).toMatch(/another match \(m-last-week\); nothing written to m-tue/);
  });

  it("a member's message names no match: shown and registered", async () => {
    const r = await attendanceRun({ author: { name: "Ali", userId: "u-ali" }, at: null, text: "IN", topic: null, matchId: null, match: null, found: true });
    expect(r.turn).toContain("THEY ARE REPLYING TO Ali's message");
    expect(r.registered).toEqual(["u-bo"]);
  });

  it("the score owner: a correction quoting LAST week's result never touches the match just played", async () => {
    const model = recording(JSON.stringify({ hasScore: true, first: 7, second: 5, firstTeam: "", secondTeam: "", winner: "yellow", loser: "", momRef: "", correction: true, swapped: false, otherGame: false }));
    const played = { id: "m-tue-played", date: new Date("2026-10-20T19:00:00Z"), redScore: 5, yellowScore: 7, teamLabels: ["Red", "Yellow"] };
    const decided: unknown[] = [];
    const run = (matchId: string) =>
      runScoreBatch({
        orgId: "org-1",
        now: NOW,
        messages: [
          {
            waMessageId: "wa-s",
            body: "no, it was 7-5 to yellow",
            authorName: "Bo",
            senderUserId: "u-bo",
            senderName: "Bo",
            tagged: true,
            route: "score",
            gated: false,
            reply: { author: null, at: null, text: "That match is already recorded: Red 7 - 5 Yellow.", topic: null, matchId, match: null, found: true },
          },
        ],
        history: [],
        enabled: new Set<Route>(["score"]),
        deps: {
          model,
          loadState: async () => squadState({ completedMatch: played as never }),
          decide: (input: { messages: unknown[] }) => (decided.push(input.messages), { outcomes: [], writes: [] }) as never,
        } as never,
      });
    const last = await run("m-last-week");
    expect(model.reqs).toHaveLength(0);
    expect(last.ownedIds.size).toBe(0);
    expect(last.scoredMatchId).toBeNull();
    expect(last.degradations.join(" ")).toMatch(/another match \(m-last-week\); nothing written to m-tue-played/);
    await run("m-tue-played").catch(() => null);
    expect(model.reqs).toHaveLength(1);
    expect(model.reqs[0].user).toContain("THEY ARE REPLYING TO");
  });
});
