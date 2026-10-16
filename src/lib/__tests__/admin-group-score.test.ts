/**
 * THE MATCH SCORE IN HQ (2026-10-16): the players' group's score handling
 * (`runScoreBatch`, the real engine and composer) behind HQ's rules: clear
 * or ask once, anyone reports, only an organiser changes a recorded one,
 * "Score saved: Yellow 7, Red 4." The score extractor is a stub (it says
 * what the model would have said); the writer and Elo are recorded, not
 * run. No database, no real model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest, ModelResponse, PipelineModel } from "../pipeline/llm";
import type { SquadState } from "../pipeline/types";
import type { ScoreApplyDeps } from "../score-engine";
import { NOW, world } from "../pipeline/__tests__/helpers";

vi.mock("@/lib/db", () => ({ db: {} }));
const hqLog = vi.hoisted(() => ({ recordMatchTimeQuestion: vi.fn() }));
vi.mock("@/lib/admin-group-log", () => hqLog);

import { answerHqScore, scoreAskRef } from "../admin-group-score";

const NO = { hasScore: false, first: 0, second: 0, firstTeam: "", secondTeam: "", winner: "", loser: "", correction: false, swapped: false, otherGame: false };
const FACTS: Record<string, unknown> = {
  "Yellow won 7-4": { ...NO, hasScore: true, first: 7, second: 4, winner: "Yellow" },
  "sarı 7-4 kazandı": { ...NO, hasScore: true, first: 7, second: 4, winner: "sarı" },
  "7-4": { ...NO, hasScore: true, first: 7, second: 4 },
  "no, it was 7-5 to yellow": { ...NO, hasScore: true, first: 7, second: 5, winner: "yellow", correction: true },
};

let calls: string[] = [];
const model: PipelineModel = {
  name: "stub",
  async complete(req: ModelRequest): Promise<ModelResponse> {
    const body = req.user.split("\n").slice(-1)[0];
    calls.push(body);
    const payload = Object.entries(FACTS).find(([k]) => body.endsWith(k))?.[1];
    if (!payload) throw new Error(`no stub for "${body}"`);
    return { text: JSON.stringify(payload), stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 };
  },
};

const recorded: Array<{ matchId: string; red: number; yellow: number; previous?: { red: number; yellow: number } }> = [];
const elo: string[] = [];
const asked: Array<{ first: number; second: number }> = [];
const apply: ScoreApplyDeps = {
  recordScore: async (a) => void recorded.push(a),
  reconcileElo: async (m) => (elo.push(m), { moved: 10 }),
  recordScoreAsk: async (a) => void asked.push(a),
};

/** The match played two hours before NOW, unscored unless said; kemal and elvin are the admins. */
function played(over: Partial<NonNullable<SquadState["completedMatch"]>> = {}, lang: "en" | "tr" = "en"): SquadState {
  return world({
    completedMatch: { id: "done-1", participantUserIds: ["u-sait", "u-mustafa"], ...over },
    features: { language: lang },
  });
}

function hq(body: string, state: SquadState, over: Partial<Parameters<typeof answerHqScore>[0]> = {}) {
  return answerHqScore({
    orgId: "org-1",
    lang: state.features.language,
    messageId: "wa-1",
    body,
    senderUserId: "u-kemal",
    senderName: "Kemal",
    organiser: true,
    addressed: false,
    history: [],
    now: NOW,
    deps: { model, apply, loadState: async () => state },
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  recorded.length = 0;
  elo.length = 0;
  asked.length = 0;
});

describe("a clear score is recorded through the shared score handling", () => {
  it('"Yellow won 7-4": recorded Red 4, Yellow 7, Elo reconciled, "Score saved: Yellow 7, Red 4."', async () => {
    expect(await hq("Yellow won 7-4", played())).toEqual({ outcome: "hq-score-saved", replyText: "Score saved: Yellow 7, Red 4." });
    expect(recorded).toEqual([{ matchId: "done-1", red: 4, yellow: 7 }]);
    expect(elo).toEqual(["done-1"]);
  });

  it("Turkish: the club's own team names and words", async () => {
    const state = played({ teamLabels: ["Kırmızı", "Sarı"] }, "tr");
    expect(await hq("sarı 7-4 kazandı", state)).toEqual({ outcome: "hq-score-saved", replyText: "Skor kaydedildi: Sarı 7, Kırmızı 4." });
    expect(recorded).toEqual([{ matchId: "done-1", red: 4, yellow: 7 }]);
  });

  it("anyone in HQ may report a first result (information, like a question)", async () => {
    const r = await hq("Yellow won 7-4", played(), { organiser: false, senderUserId: "u-hamzah" });
    expect(r).toEqual({ outcome: "hq-score-saved", replyText: "Score saved: Yellow 7, Red 4." });
    expect(recorded).toHaveLength(1);
  });
});

describe("unclear: one short question, nothing recorded", () => {
  it('"7-4 or 7-5, Yellow won": several scorelines, asked once, no model call, no write', async () => {
    const r = await hq("7-4 or 7-5, Yellow won", played());
    expect(r).toEqual({ outcome: "hq-score-asked", replyText: "I can't tell the final score from that. What was it, and which team won?" });
    expect(calls).toEqual([]);
    expect(recorded).toEqual([]);
    expect(hqLog.recordMatchTimeQuestion).toHaveBeenCalledWith(expect.objectContaining({ askRef: scoreAskRef("done-1") }));
  });

  it('"7-4" with no team: the engine\'s own "which team won?", remembered for the answer', async () => {
    const r = await hq("7-4", played());
    expect(r).toEqual({ outcome: "hq-score-asked", replyText: "7 - 4: which team won? Reply with the winning team: Red or Yellow." });
    expect(recorded).toEqual([]);
    expect(asked).toEqual([expect.objectContaining({ first: 7, second: 4 })]);
    expect(hqLog.recordMatchTimeQuestion).toHaveBeenCalledWith(expect.objectContaining({ askRef: scoreAskRef("done-1") }));
  });

  it('the organiser\'s answer "Yellow" records it, with no model call', async () => {
    const state = played({ pendingScore: { first: 7, second: 4, askedAt: new Date(NOW.getTime() - 60_000).toISOString(), askerUserId: "u-kemal" } });
    expect(await hq("Yellow", state)).toEqual({ outcome: "hq-score-saved", replyText: "Score saved: Yellow 7, Red 4." });
    expect(calls).toEqual([]);
    expect(recorded).toEqual([{ matchId: "done-1", red: 4, yellow: 7 }]);
  });

  it("the Turkish ask", async () => {
    const r = await hq("7-4 ya da 7-5", played({}, "tr"));
    expect(r).toEqual({ outcome: "hq-score-asked", replyText: "Bundan son skoru çıkaramadım. Maç kaç kaç bitti ve hangi takım kazandı?" });
  });
});

describe("a recorded score is changed by an owner or admin only", () => {
  const done = () => played({ redScore: 4, yellowScore: 7 });

  it("an organiser's correction changes it", async () => {
    const r = await hq("no, it was 7-5 to yellow", done());
    expect(r).toEqual({ outcome: "hq-score-changed", replyText: "Score changed: Yellow 7, Red 5 (it was Yellow 7, Red 4)." });
    expect(recorded).toEqual([{ matchId: "done-1", red: 5, yellow: 7, previous: { red: 4, yellow: 7 } }]);
  });

  it("anyone else, addressed to MatchTime: refused (the caller names who can), nothing written", async () => {
    expect(await hq("@Match Time no, it was 7-5 to yellow", done(), { organiser: false, senderUserId: "u-sait", addressed: true })).toBe("organisers-only");
    expect(calls).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("anyone else, not addressed: their own chat, silent", async () => {
    expect(await hq("no, it was 7-5 to yellow", done(), { organiser: false, senderUserId: "u-sait" })).toBeNull();
    expect(recorded).toEqual([]);
  });
});

it("no played match waiting: one line for an organiser", async () => {
  expect(await hq("Yellow won 7-4", world())).toEqual({ outcome: "hq-score-no-match", replyText: "There's no finished match waiting for a score." });
});

it("the write fails: no cheerful words, one line", async () => {
  const failing = { ...apply, recordScore: async () => Promise.reject(new Error("db down")) };
  expect(await hq("Yellow won 7-4", played(), { deps: { model, apply: failing, loadState: async () => played() } })).toEqual({
    outcome: "hq-score-failed",
    replyText: "I couldn't save that score just now. Please send it again in a minute.",
  });
});
