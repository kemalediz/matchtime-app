/**
 * The organisers' own teams, posted untagged in HQ (FNF HQ, 2026-11-27):
 * the real teams extractor parser and `teamCommandFromFacts`, a stubbed
 * model behind it, and the team code mocked at its boundary (its own
 * behaviour is `team-proposal.test.ts`). What is pinned: no game, no model
 * call; only a "set" reading reaches the team code; the extractor is told
 * the message was not tagged; the outcome, never anything to say.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest, PipelineModel } from "../pipeline/llm";

const teams = vi.hoisted(() => ({ postedTeamsGame: vi.fn(), setPostedTeams: vi.fn() }));
vi.mock("@/lib/team-proposal", () => teams);
vi.mock("../team-proposal", () => teams);

import { readPostedTeams } from "../hq-teams-posted";

const NOW = new Date("2026-11-27T19:30:00Z");
const INCIDENT =
  "Captains:\n\nAlamgir, Yorel, Wasim, Shehryar, Rafi, Feroz, Hamza, Mojib, Yaseen\n\nImti, Mo, Akram, Niro, Clarence, Imz, AH, Seb, Umar";
const RED = ["Alamgir", "Yorel", "Wasim", "Shehryar", "Rafi", "Feroz", "Hamza", "Mojib", "Yaseen"];
const YELLOW = ["Imti", "Mo", "Akram", "Niro", "Clarence", "Imz", "AH", "Seb", "Umar"];

const requests: ModelRequest[] = [];
const teamsModel = (facts: Record<string, unknown> | "fail"): PipelineModel => ({
  name: "stub",
  async complete(req) {
    requests.push(req);
    if (facts === "fail") throw new Error("529 overloaded");
    const raw = { action: "show", includeRefs: [], teamNames: [], swaps: [], moves: [], pairings: [], apart: [], sides: { red: [], yellow: [] }, form: [], toMatchTime: false, ...facts };
    return { text: JSON.stringify(raw), stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 };
  },
});

const read = (text: string, model: PipelineModel) =>
  readPostedTeams({
    orgId: "org-fnf",
    messageId: "wa-teams",
    body: async () => text,
    senderUserId: "u-raihan",
    senderName: "Raihan",
    now: NOW,
    members: async () => ["Alamgir", "Yorel"],
    deps: { extractorModel: model },
  });

beforeEach(() => {
  vi.clearAllMocks();
  requests.length = 0;
  teams.postedTeamsGame.mockResolvedValue("m-fri");
  teams.setPostedTeams.mockResolvedValue({ outcome: "teams-posted", applied: true });
});

describe("an organiser's untagged HQ message, read for the two teams", () => {
  it("the incident: both teams written out, read as set, handed to the team code as the two sides", async () => {
    const r = await read(INCIDENT, teamsModel({ action: "set", sides: { red: RED, yellow: YELLOW } }));
    expect(r).toEqual({ outcome: "hq-teams-posted" });
    expect(teams.setPostedTeams).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-fnf", red: RED, yellow: YELLOW, senderUserId: "u-raihan", messageId: "wa-teams", now: NOW, body: INCIDENT }),
    );
  });

  it("the extractor is told the truth: not tagged, with the members the message names", async () => {
    await read(INCIDENT, teamsModel({ action: "set", sides: { red: RED, yellow: YELLOW } }));
    expect(requests).toHaveLength(1);
    expect(requests[0].label).toBe("extractor:teams");
    expect(requests[0].user).not.toContain("who tagged the bot");
    expect(requests[0].user).toContain("Alamgir, Yorel");
  });

  it("no game to set teams for: no model call, nothing done", async () => {
    teams.postedTeamsGame.mockResolvedValue(null);
    expect(await read(INCIDENT, teamsModel({ action: "set", sides: { red: RED, yellow: YELLOW } }))).toBeNull();
    expect(requests).toHaveLength(0);
    expect(teams.setPostedTeams).not.toHaveBeenCalled();
  });

  it("every other reading is their own conversation: nothing done", async () => {
    for (const facts of [
      { action: "show" },
      { action: "swap", moves: ["Ali", "Can"], toMatchTime: true },
      { action: "swap", pairings: [["Ali", "Habib"]] },
      { action: "generate" },
      { action: "restore" },
      { action: "set", sides: { red: ["Ali"], yellow: [] } },
    ]) {
      expect(await read("words", teamsModel(facts))).toBeNull();
    }
    expect(teams.setPostedTeams).not.toHaveBeenCalled();
  });

  it("a failed extractor call: nothing done", async () => {
    expect(await read(INCIDENT, teamsModel("fail"))).toBeNull();
    expect(teams.setPostedTeams).not.toHaveBeenCalled();
  });

  it("not applied (a name it could not place, someone left out): its own outcome, never anything to say", async () => {
    teams.setPostedTeams.mockResolvedValue({ outcome: "teams-name-unclear", applied: false });
    expect(await read(INCIDENT, teamsModel({ action: "set", sides: { red: RED, yellow: YELLOW } }))).toEqual({ outcome: "hq-teams-posted-not-applied" });
  });

  it("exactly the teams as they stand: its own outcome", async () => {
    teams.setPostedTeams.mockResolvedValue({ outcome: "teams-posted-same", applied: true });
    expect(await read(INCIDENT, teamsModel({ action: "set", sides: { red: RED, yellow: YELLOW } }))).toEqual({ outcome: "hq-teams-posted-same" });
  });

  it("logs ids and counts, never the names", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await read(INCIDENT, teamsModel({ action: "set", sides: { red: RED, yellow: YELLOW } }));
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[admin-group]"));
    log.mockRestore();
    expect(lines).toEqual(["[admin-group] wa-teams: the organisers' own teams, untagged, on match m-fri (9 v 9): hq-teams-posted, silent"]);
  });
});
