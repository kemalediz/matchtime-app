/**
 * A DEAD END HANDED TO THE UNIFIED ANSWER (2026-11-17).
 *
 * A tagged message MatchTime took no action on (the admin extractor's
 * "other", a team change it cannot make, nothing at all) used to get a
 * canned line. The Vets organiser deleted "can't do that" twice on 16 Nov.
 * `runAnswerBatch` now takes such messages as `deadEnds`: no extractor is
 * asked again (it already read the message, and found nothing to do), and
 * each is answered by the ONE unified answer, told NOT DONE and shown this
 * group's help menu. A failed or refused answer is not owned, so the caller
 * keeps its line. Made-up people; no database; the model is a stub.
 */
import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelResponse, PipelineModel } from "../llm";
import { runAnswerBatch, type AnswerBatchMessage } from "../answer-batch";
import type { OrgFeatures } from "../../org-features";
import type { Route, SquadState } from "../types";
import { NOW, fullName, world } from "./helpers";

const FEATURES = {
  botEnabled: true,
  attendance: true,
  bench: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  reminders: true,
  statsQa: false,
  paymentTracking: false,
  paymentCollection: false,
  squadFromList: false,
  language: "en",
} as OrgFeatures;

const MENU = "ℹ️ *MatchTime help*\n🗓️ *schedule*: when and where you play";

function stubModel(answer: string | Error) {
  const reqs: ModelRequest[] = [];
  const model: PipelineModel = {
    name: "stub",
    async complete(req: ModelRequest): Promise<ModelResponse> {
      reqs.push(req);
      if (req.label === "unified-answer" && answer instanceof Error) throw answer;
      const text =
        req.label === "unified-answer"
          ? JSON.stringify({ answer })
          : JSON.stringify({ kind: "other", personRef: "", feature: "none", badge: "none" });
      return { text, stopReason: "end_turn", usage: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.0005, ms: 10 };
    },
  };
  return { model, reqs };
}

const message = (over: Partial<AnswerBatchMessage> = {}): AnswerBatchMessage => ({
  waMessageId: "wa-1",
  body: "@Match Time book the pitch for Friday",
  authorName: fullName("sait"),
  senderUserId: "u-sait",
  senderName: fullName("sait"),
  tagged: true,
  addressed: true,
  route: "admin_ops" as Route,
  gated: false,
  ...over,
});

async function run(
  opts: { answer?: string | Error; state?: SquadState; deadEnds?: Array<[string, string | null]>; senderUserId?: string; audience?: "players" | "organisers"; body?: string } = {},
) {
  const state = opts.state ?? world({ confirmed: ["kemal", "sait", "idris"], bench: ["erdal"] });
  const { model, reqs } = stubModel(opts.answer ?? "I can't book pitches. I can cancel or move a game: tag me and say which.");
  const help: Array<{ topic: string | null; admin: boolean }> = [];
  const res = await runAnswerBatch({
    orgId: "org-1",
    now: NOW,
    messages: [message({ ...(opts.senderUserId ? { senderUserId: opts.senderUserId } : {}), ...(opts.body ? { body: opts.body } : {}) })],
    history: [],
    expectedMatchId: state.matchId,
    enabled: new Set<Route>(["question"]),
    deadEnds: new Map((opts.deadEnds ?? [["wa-1", null]]).map(([id, why]) => [id, { why }])),
    ...(opts.audience ? { audience: opts.audience } : {}),
    deps: {
      model,
      loadState: async () => state,
      loadFeatures: async () => FEATURES,
      loadResults: async () => ({ since: null, more: false, rows: [] }),
      loadClubFacts: async () => ({ pool: { open: false, platformOpen: false, clubFlag: false }, partners: { active: 2 } }),
      helpReply: async (req, _f, asker) => (help.push({ topic: req.topic, admin: asker.admin }), MENU),
    },
  });
  return { res, reqs, help, outcome: res.outcomes.get("wa-1") };
}

describe("a dead end goes to the unified answer", () => {
  it("answered by ONE unified answer, with no extractor call, told NOT DONE and shown the help menu", async () => {
    const { outcome, reqs, help } = await run();
    expect(outcome?.reply).toBe("I can't book pitches. I can cancel or move a game: tag me and say which.");
    expect(outcome?.intent).toBe("unified_answer");
    expect(reqs.map((r) => r.label)).toEqual(["unified-answer"]);
    const user = reqs[0].user;
    expect(user).toContain("NOT DONE:");
    expect(user).toContain("🗓️ *schedule*: when and where you play");
    expect(user.trimEnd().endsWith("@Match Time book the pitch for Friday")).toBe(true);
    // The players' menu, for a member.
    expect(help).toEqual([{ topic: null, admin: false }]);
  });

  it("an admin asking in the players' group is shown the organisers' menu", async () => {
    const { help } = await run({ senderUserId: "u-kemal" });
    expect(help).toEqual([{ topic: null, admin: true }]);
  });

  it("in HQ the menu is the organisers'", async () => {
    const { help, outcome } = await run({ audience: "organisers" });
    expect(help).toEqual([{ topic: null, admin: true }]);
    expect(outcome?.reply).toBeTruthy();
  });

  it("a group with no upcoming match is still answered", async () => {
    const { outcome } = await run({ state: world({ noMatch: true }), answer: "There's no game coming up, so there's nothing to book for." });
    expect(outcome?.reply).toBe("There's no game coming up, so there's nothing to book for.");
  });

  it("a failed call is not owned: the caller keeps its line", async () => {
    const { outcome, res } = await run({ answer: new Error("529 overloaded") });
    expect(outcome).toBeUndefined();
    expect(res.degradations.join(" ")).toMatch(/unified answer not used/);
  });

  it("a refused reply (an invented number) is not owned either", async () => {
    const { outcome } = await run({ answer: "Booked for 27 players." });
    expect(outcome).toBeUndefined();
  });

  it("the help menu failing to load still answers, without the menu", async () => {
    const state = world({ confirmed: ["kemal"] });
    const { model, reqs } = stubModel("What would you like me to do?");
    const res = await runAnswerBatch({
      orgId: "org-1",
      now: NOW,
      messages: [message({ body: "@Match Time do the thing" })],
      history: [],
      expectedMatchId: state.matchId,
      enabled: new Set<Route>(["question"]),
      deadEnds: new Map([["wa-1", { why: null }]]),
      deps: {
        model,
        loadState: async () => state,
        loadFeatures: async () => FEATURES,
        loadResults: async () => ({ since: null, more: false, rows: [] }),
        loadClubFacts: async () => ({ pool: { open: false, platformOpen: false, clubFlag: false }, partners: { active: 0 } }),
        helpReply: async () => {
          throw new Error("settings unread");
        },
      },
    });
    expect(res.outcomes.get("wa-1")?.reply).toBe("What would you like me to do?");
    expect(reqs[0].user).toContain("NOT DONE:");
    expect(reqs[0].user).not.toContain("WHAT MATCHTIME CAN DO");
  });

  it("a message not named a dead end is untouched (its own route, not owned here)", async () => {
    const { outcome, reqs } = await run({ deadEnds: [] });
    expect(outcome).toBeUndefined();
    expect(reqs).toEqual([]);
  });
});

describe("why the path stopped, and who is asking (Sutton 17 Nov 19:23: 'swap Sam with Alex' from admin Elvin)", () => {
  const WHY = 'neither "Sam" nor "Alex" is a name MatchTime can find among the players of the upcoming match, so nobody was swapped';

  it("the reason the path gave reaches the answer's context, under NOT DONE", async () => {
    const { reqs } = await run({ body: "@Match Time swap Sam with Alex", deadEnds: [["wa-1", WHY]], senderUserId: "u-kemal" });
    expect(reqs[0].user).toContain(`- Why: ${WHY}`);
  });

  it("an admin asking in the players' group is named as an organiser; a member is not", async () => {
    const admin = await run({ deadEnds: [["wa-1", WHY]], senderUserId: "u-kemal" });
    expect(admin.reqs[0].user).toContain("- The asker is one of the club's organisers");
    const member = await run({ deadEnds: [["wa-1", WHY]] });
    expect(member.reqs[0].user).toContain("- The asker is not an organiser.");
  });

  it("in HQ the asker is described by their own role: HQ answers members too (review of #626)", async () => {
    const member = await run({ audience: "organisers", deadEnds: [["wa-1", null]] });
    expect(member.reqs[0].user).toContain("- The asker is not an organiser.");
    const admin = await run({ audience: "organisers", deadEnds: [["wa-1", null]], senderUserId: "u-kemal" });
    expect(admin.reqs[0].user).toContain("- The asker is one of the club's organisers");
  });
});

describe("what the other parts of the same message already did (Sutton 17 Nov 12:53: 'switch the match to 7aside and tell us the current list')", () => {
  const BODY = "@Match Time switch the match to 7aside and tell us the current list";

  async function also(done: Array<{ text: string; done: boolean }> | null) {
    const state = world({ confirmed: ["kemal", "sait", "idris"], bench: ["erdal"] });
    const reqs: ModelRequest[] = [];
    const model: PipelineModel = {
      name: "stub",
      async complete(req: ModelRequest): Promise<ModelResponse> {
        reqs.push(req);
        const text = req.label === "unified-answer" ? JSON.stringify({ answer: "In the squad: 3." }) : JSON.stringify({ kind: "other", personRef: "", feature: "none", badge: "none" });
        return { text, stopReason: "end_turn", usage: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.0005, ms: 10 };
      },
    };
    const res = await runAnswerBatch({
      orgId: "org-1",
      now: NOW,
      messages: [message({ body: BODY, senderUserId: "u-kemal" })],
      history: [],
      expectedMatchId: state.matchId,
      enabled: new Set<Route>(["question", "admin_ops"]),
      alsoAsks: new Set(["wa-1"]),
      ...(done ? { alsoDone: new Map([["wa-1", done]]) } : {}),
      deps: {
        model,
        loadState: async () => state,
        loadFeatures: async () => FEATURES,
        loadResults: async () => ({ since: null, more: false, rows: [] }),
        loadClubFacts: async () => ({ pool: { open: false, platformOpen: false, clubFlag: false }, partners: { active: 0 } }),
      },
    });
    return { res, user: reqs.find((r) => r.label === "unified-answer")?.user ?? "" };
  }

  it("the replies already sent for THE MESSAGE are in the answer's context as ALREADY DONE, and the answer comes back as the also-answer", async () => {
    const { res, user } = await also([{ text: "Switched Tue 21:30 to 7 a side (14 players).", done: true }]);
    expect(user).toContain("ALREADY DONE:");
    expect(user).toContain("Switched Tue 21:30 to 7 a side (14 players).");
    expect(res.alsoAnswered.get("wa-1")?.reply).toBe("In the squad: 3.");
  });

  it("nothing done by another part: no such block", async () => {
    const { user } = await also(null);
    expect(user).not.toContain("ALREADY DONE");
  });
});
