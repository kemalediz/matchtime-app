/**
 * "WHO SHALL I ASK FOR PLAYERS?" IN THE PLAYERS' GROUP (2026-10-28):
 * finding an organiser's answer by the safe-YES rule's positional tests on
 * the group's log, and reading it with the shared admin extractor. The real
 * parser; the model and the database stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest, PipelineModel } from "../pipeline/llm";
import type { HqLogRow } from "../admin-group-log";

const dbMock = vi.hoisted(() => ({ membership: { findMany: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: dbMock }));
const log = vi.hoisted(() => ({ groupLogSince: vi.fn(), recordGroupOrganiserLine: vi.fn() }));
vi.mock("@/lib/admin-group-log", () => log);

import { groupSourceAnswers, type GroupAnswerCandidate } from "../ask-source-group";

const NOW = new Date("2026-10-28T11:10:00Z");
const ASKED = new Date("2026-10-28T11:05:00Z");
const Q = "Who shall I ask for players: your recent players, your partner clubs, or the MatchTime player pool?";
const question: HqLogRow = { waMessageId: "mt:group:ask-source:club+partners+pool:1", fromMatchTime: true, senderUserId: null, text: Q, askRef: "ask-source:club+partners+pool", createdAt: ASKED };

const requests: ModelRequest[] = [];
const extractor = (playersFrom: string[] | null, action = "recruit"): PipelineModel => ({
  name: "stub",
  async complete(req) {
    requests.push(req);
    return {
      text: JSON.stringify({ action, payerRef: "", count: 0, coveredRefs: [], undo: false, matchDay: "", pastGame: false, phrase: "", note: "", lookbackMatches: 0, playersFrom: playersFrom ?? [], clubRef: "", toMatchTime: true }),
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      ms: 0,
    };
  },
});
const msg = (over: Partial<GroupAnswerCandidate> = {}): GroupAnswerCandidate => ({
  id: "wa-1",
  body: "the pool",
  authorName: "Kemal",
  senderUserId: "u-admin",
  quoted: null,
  tagged: false,
  ...over,
});
const run = (messages: GroupAnswerCandidate[], model: PipelineModel) => groupSourceAnswers({ orgId: "org-1", messages, now: NOW, model });

beforeEach(() => {
  vi.clearAllMocks();
  requests.length = 0;
  log.groupLogSince.mockResolvedValue([question]);
  dbMock.membership.findMany.mockResolvedValue([{ userId: "u-admin" }]);
});

describe("groupSourceAnswers", () => {
  it("the next organiser message after the question: read against it, the places it picks", async () => {
    const r = await run([msg()], extractor(["pool"]));
    expect(r.get("wa-1")).toEqual({ sources: ["pool"], clubRef: null });
    expect(requests).toHaveLength(1);
    expect(requests[0].label).toBe("extractor:admin");
    expect(requests[0].user).toContain(Q);
    expect(log.recordGroupOrganiserLine).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1", waMessageId: "wa-1", senderUserId: "u-admin" }));
  });

  it("\"both\": the partners and the pool", async () => {
    const r = await run([msg({ body: "both" })], extractor(["partners", "pool"]));
    expect(r.get("wa-1")?.sources).toEqual(["partners", "pool"]);
  });

  it("a player who is not an organiser: never read, never logged", async () => {
    dbMock.membership.findMany.mockResolvedValue([]);
    const r = await run([msg({ senderUserId: "u-player" })], extractor(["pool"]));
    expect(r.size).toBe(0);
    expect(requests).toHaveLength(0);
    expect(log.recordGroupOrganiserLine).not.toHaveBeenCalled();
  });

  it("players chatting in between do not close it: only organisers' lines are in the log", async () => {
    // The players' own messages are never logged, so the organiser's is still the next.
    const r = await run([msg({ id: "wa-p", senderUserId: "u-player", body: "anyone got bibs" }), msg({ id: "wa-2" })], extractor(["pool"]));
    expect(r.has("wa-p")).toBe(false);
    expect(r.get("wa-2")?.sources).toEqual(["pool"]);
  });

  it("only the FIRST organiser message after it is in the place of an answer", async () => {
    const r = await run([msg({ id: "wa-a", body: "Naim is out" }), msg({ id: "wa-b", body: "the pool" })], extractor(null, "other"));
    expect(r.size).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it("an organiser line already logged after the question: the next one is not an answer", async () => {
    log.groupLogSince.mockResolvedValue([question, { waMessageId: "group:wa-0", fromMatchTime: false, senderUserId: "u-admin", text: "hmm", askRef: null, createdAt: new Date(ASKED.getTime() + 60_000) }]);
    const r = await run([msg()], extractor(["pool"]));
    expect(r.size).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("a reply quoting the question, after other organiser chat and past the window: the answer", async () => {
    log.groupLogSince.mockResolvedValue([question, { waMessageId: "group:wa-0", fromMatchTime: false, senderUserId: "u-admin", text: "hmm", askRef: null, createdAt: new Date(ASKED.getTime() + 60_000) }]);
    const r = await groupSourceAnswers({
      orgId: "org-1",
      messages: [msg({ quoted: { fromMatchTime: true, text: Q, messageId: "3EB0ABC" } })],
      now: new Date(ASKED.getTime() + 40 * 60_000),
      model: extractor(["partners"]),
    });
    expect(r.get("wa-1")?.sources).toEqual(["partners"]);
  });

  it("past 15 minutes, not a reply: not an answer", async () => {
    const r = await groupSourceAnswers({ orgId: "org-1", messages: [msg()], now: new Date(ASKED.getTime() + 16 * 60_000), model: extractor(["pool"]) });
    expect(r.size).toBe(0);
  });

  it("read, but not a place (\"Naim is out\", or nowhere said again): not an answer", async () => {
    expect((await run([msg({ body: "Naim is out" })], extractor(null, "other"))).size).toBe(0);
    expect((await run([msg({ body: "just find someone" })], extractor([]))).size).toBe(0);
  });

  it("no question in the log: no model call, no membership read", async () => {
    log.groupLogSince.mockResolvedValue([]);
    const r = await run([msg()], extractor(["pool"]));
    expect(r.size).toBe(0);
    expect(requests).toHaveLength(0);
    expect(dbMock.membership.findMany).not.toHaveBeenCalled();
  });

  it("a failed read never throws", async () => {
    log.groupLogSince.mockRejectedValue(new Error("db down"));
    expect((await run([msg()], extractor(["pool"]))).size).toBe(0);
  });
});
