/**
 * The players' group: an organiser's answer to MatchTime's own list of
 * places, or a "try again" right after an ask, read by the admin extractor
 * whatever the router called it (2026-10-28 live check: "@Match Time 2"
 * and "@Match Time added the venue location" were routed `question`).
 */
import { describe, it, expect, vi } from "vitest";
import { groupAdminFollowups, RETRY_FOLLOWUP_MS, type GroupFollowupDeps } from "../group-admin-followups";
import { venuePickAskRef } from "../venue-from-words-rules";
import type { HqLogRow } from "../admin-group-log";
import type { ModelRequest, PipelineModel } from "../pipeline/llm";
import type { StoredAsk } from "../refused-ask-retry";

const NOW = new Date("2026-10-28T15:45:00Z");
const BASE = { payerRef: "", count: 0, coveredRefs: [], undo: false, matchDay: "", pastGame: false, phrase: "", note: "", lookbackMatches: 0, playersFrom: [], clubRef: "", venueName: "", venueChoice: 0, toMatchTime: true };

function model(facts: Record<string, unknown>) {
  const seen: ModelRequest[] = [];
  const m: PipelineModel = {
    name: "stub",
    async complete(req) {
      seen.push(req);
      return { text: JSON.stringify({ ...BASE, ...facts }), stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 };
    },
  };
  return { m, seen };
}
const LIST: HqLogRow = { waMessageId: "group-q:1", fromMatchTime: true, senderUserId: null, text: "I found more than one place for *Goals Sutton*. Which one is it?", askRef: venuePickAskRef("Goals Sutton"), createdAt: new Date(NOW.getTime() - 120_000) };
const ASKED: StoredAsk = { facts: { kind: "admin", action: "recruit", partnerClubs: true, pool: true, toMatchTime: true }, at: new Date(NOW.getTime() - 120_000) };

const deps = (over: Partial<GroupFollowupDeps> & { facts: Record<string, unknown> }) => {
  const { m, seen } = model(over.facts);
  const recorded: string[] = [];
  const d: GroupFollowupDeps = {
    log: async () => [],
    organisers: async (_org, ids) => new Set(ids.filter((x) => x === "u-kemal")),
    latestAsk: async () => null,
    recordLine: async (id) => void recorded.push(id),
    model: m,
    ...over,
  };
  return { d, seen, recorded };
};
const msg = (over: Partial<{ id: string; body: string; senderUserId: string; tagged: boolean }> = {}) => ({
  id: over.id ?? "wa-1",
  body: over.body ?? "@Match Time 2",
  authorName: "Kemal",
  senderUserId: over.senderUserId ?? "u-kemal",
  quoted: null,
  tagged: over.tagged ?? true,
});
const run = (d: GroupFollowupDeps, messages = [msg()]) => groupAdminFollowups({ orgId: "org-1", messages, now: NOW, deps: d });

describe("groupAdminFollowups", () => {
  it("an organiser's pick from MatchTime's list: the words come from the list's record, the number from the model", async () => {
    const { d, seen, recorded } = deps({ log: async () => [LIST], facts: { action: "set_venue", venueName: "something else", venueChoice: 2 } });
    const r = await run(d);
    expect(r.get("wa-1")).toEqual({ kind: "venue", words: "Goals Sutton", choice: 2 });
    expect(seen[0].user).toContain("MATCHTIME'S LAST POST: I found more than one place for *Goals Sutton*");
    expect(recorded).toEqual(["wa-1"]);
  });

  it("a tagged try again within 15 minutes of the organisers' pool and partner ask: the stored ask's places", async () => {
    const { d } = deps({ latestAsk: async () => ASKED, facts: { action: "retry_ask" } });
    expect((await run(d, [msg({ body: "@Match Time added the venue location" })])).get("wa-1")).toEqual({ kind: "retry", sources: ["partners", "pool"], clubRef: null });
  });

  it("the pitch named right after the ask is set too", async () => {
    const { d } = deps({ latestAsk: async () => ASKED, facts: { action: "set_venue", venueName: "Goals Sutton" } });
    expect((await run(d, [msg({ body: "@Match Time our pitch is Goals Sutton" })])).get("wa-1")).toEqual({ kind: "venue", words: "Goals Sutton", choice: null });
  });

  it("anything else the model reads is not a follow-up: the message carries on as it would have", async () => {
    const { d } = deps({ latestAsk: async () => ASKED, log: async () => [LIST], facts: { action: "other" } });
    expect((await run(d)).size).toBe(0);
  });

  it("nothing waiting, an old ask, an untagged try again, or a player: no model call at all", async () => {
    for (const over of [
      {},
      { latestAsk: async () => ({ ...ASKED, at: new Date(NOW.getTime() - RETRY_FOLLOWUP_MS - 1) }) },
    ] as Partial<GroupFollowupDeps>[]) {
      const { d, seen } = deps({ ...over, facts: { action: "retry_ask" } });
      expect((await run(d)).size).toBe(0);
      expect(seen).toHaveLength(0);
    }
    const untagged = deps({ latestAsk: async () => ASKED, facts: { action: "retry_ask" } });
    expect((await run(untagged.d, [msg({ tagged: false })])).size).toBe(0);
    expect(untagged.seen).toHaveLength(0);
    const player = deps({ latestAsk: async () => ASKED, log: async () => [LIST], facts: { action: "retry_ask" } });
    expect((await run(player.d, [msg({ senderUserId: "u-pete" })])).size).toBe(0);
    expect(player.seen).toHaveLength(0);
  });

  it("never throws: a failed read is no follow-up", async () => {
    const { d } = deps({ log: async () => { throw new Error("db down"); }, facts: {} });
    expect((await run(d)).size).toBe(0);
  });

  it("the retry window is 15 minutes", () => {
    expect(RETRY_FOLLOWUP_MS).toBe(15 * 60_000);
    vi.restoreAllMocks();
  });
});
