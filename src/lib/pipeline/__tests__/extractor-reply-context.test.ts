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

async function attendanceTurn(reply: EngineBatchMessage["reply"]): Promise<string> {
  const model = recording(NO_CLAIMS);
  await runAttendanceEngineBatch({
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
      registerAttendance: async () => ({ status: "CONFIRMED" as const, position: 1, slot: 1, confirmedCount: 1, maxPlayers: 14 }),
      cancelAttendance: async () => ({ status: "DROPPED" as const }),
      resolveOrProvision: async (name: string) => ({ userId: `new:${name}` }),
    } as never,
  });
  return model.reqs[0]?.user ?? "";
}

describe("an owner acting on a match is shown a quoted MatchTime post only for that match", () => {
  const post = (matchId: string | null) => ({ author: null, at: null, text: "Squad list", topic: "attendance" as const, matchId, match: null });

  it("this match's post, or one naming no match: shown", async () => {
    expect(await attendanceTurn(post("m-tue"))).toContain("THEY ARE REPLYING TO");
    expect(await attendanceTurn(post(null))).toContain("THEY ARE REPLYING TO");
  });

  it("an older match's post (last week's squad list): not shown, the IN is read as it always was", async () => {
    const turn = await attendanceTurn(post("m-last-week"));
    expect(turn).not.toContain("THEY ARE REPLYING TO");
    expect(turn).toContain("NOW: ");
  });

  it("a member's message is always shown: it names no match", async () => {
    expect(await attendanceTurn({ author: { name: "Ali" }, at: null, text: "IN", topic: null, matchId: null, match: null })).toContain(
      "THEY ARE REPLYING TO Ali's message",
    );
  });

  it("the score owner narrows to the PLAYED match", async () => {
    const model = recording(JSON.stringify({ hasScore: true, first: 7, second: 5, firstTeam: "", secondTeam: "", winner: "yellow", loser: "", momRef: "", correction: true, swapped: false, otherGame: false }));
    const played = { id: "m-last", date: new Date("2026-10-13T19:00:00Z"), redScore: 5, yellowScore: 7, teamLabels: ["Red", "Yellow"] };
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
            reply: { author: null, at: null, text: "Result saved: Red 7, Yellow 5", topic: null, matchId, match: null },
          },
        ],
        history: [],
        enabled: new Set<Route>(["score"]),
        deps: { model, loadState: async () => squadState({ completedMatch: played as never }), decide: () => ({ outcomes: [], writes: [] }) as never } as never,
      }).catch(() => null);
    await run("m-last");
    await run("m-tue");
    expect(model.reqs[0].user).toContain("THEY ARE REPLYING TO");
    expect(model.reqs[1].user).not.toContain("THEY ARE REPLYING TO");
  });
});
