/**
 * A TAGGED QUESTION IN A MIXED BATCH IS ANSWERED (Vets sandbox, 2026-11-03,
 * scenario D).
 *
 * "@Match Time what happens if 14 don't confirm?" arrived in a 22-message
 * batch beside INs. The question extractor read it as `options` (3 of 4 live
 * runs); the mixed-batch hand-back refused every topic but `squad` and
 * `count` when ANY other kind of message was in the batch, so nobody
 * answered it, and since 2026-10-29 a tagged message nobody answers gets the
 * not-understood line ("I didn't catch what you'd like me to do").
 *
 * The hand-back guards against a write that lands AFTER the answer is
 * composed. Attendance writes have already landed when this module loads its
 * state (and in a monthly club with no month they write nothing at all), so
 * beside attendance traffic only `bench` and `person_status` still wait:
 * the batch's squad post answers those two by name when it goes out.
 *
 * And in a monthly club whose month is not started, "we're 0 of 14, need 14
 * more" is not true (the squad starts from the month's list, #501), so an
 * `options` question is answered with how the monthly squad works.
 */
import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelResponse, PipelineModel } from "../llm";
import { runAnswerBatch, type AnswerBatchMessage } from "../answer-batch";
import type { OrgFeatures } from "../../org-features";
import type { HelpRequest, Route } from "../types";
import { NOW, fullName, world } from "./helpers";

const FEATURES = {
  botEnabled: true,
  attendance: true,
  bench: true,
  teamBalancing: true,
  momVoting: true,
  playerRating: true,
  reminders: true,
  statsQa: true,
  paymentTracking: false,
  paymentCollection: false,
  squadFromList: false,
  language: "en",
} as OrgFeatures;

const Q = "@Match Time what happens if 14 don't confirm?";

const facts = (topic: string, personRef = "") => ({
  topic,
  personRef,
  statedCount: -1,
  table: "none",
  listSize: -1,
  listEnd: "top",
  period: "none",
  periodCount: -1,
  periodUnit: "none",
  feature: "none",
  badge: "none",
});

function stubModel(payload: unknown): PipelineModel {
  return {
    name: "stub",
    async complete(_req: ModelRequest): Promise<ModelResponse> {
      return {
        text: JSON.stringify(payload),
        stopReason: "end_turn",
        usage: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.002,
        ms: 10,
      };
    },
  };
}

const msg = (o: Partial<AnswerBatchMessage> & { body: string; route: Route }): AnswerBatchMessage => ({
  waMessageId: o.waMessageId ?? "wa-q",
  body: o.body,
  authorName: fullName("sait"),
  senderUserId: "u-sait",
  senderName: fullName("sait"),
  tagged: o.tagged ?? true,
  route: o.route,
  gated: o.gated ?? false,
});

async function run(opts: { topic: string; neighbours: AnswerBatchMessage[]; monthNotStarted?: boolean; personRef?: string }) {
  const st = world({ confirmed: ["kemal", "sait"], bench: ["zair"] });
  const asked: HelpRequest[] = [];
  const res = await runAnswerBatch({
    orgId: "org-1",
    now: NOW,
    messages: [msg({ body: Q, route: "question" }), ...opts.neighbours],
    history: [],
    expectedMatchId: st.matchId,
    enabled: new Set<Route>(["question"]),
    ...(opts.monthNotStarted ? { monthNotStarted: true } : {}),
    deps: {
      model: stubModel(facts(opts.topic, opts.personRef)),
      loadState: async () => st,
      loadFeatures: async () => FEATURES,
      helpReply: async (req) => {
        asked.push(req);
        return `HELP ${req.topic ?? "menu"}`;
      },
    },
  });
  return { res, asked, st };
}

const IN = msg({ body: "IN", route: "self_att", waMessageId: "wa-in", tagged: false });
const OTHER_IN = msg({ body: "David Stark is in", route: "other_att", waMessageId: "wa-other", tagged: false });
const UNSURE = msg({ body: "No need to say IN if we move it to monthly squad", route: "unsure", waMessageId: "wa-unsure", tagged: false });
const SCORE = msg({ body: "we won 5-3", route: "score", waMessageId: "wa-score", tagged: false });

describe("a tagged question beside attendance traffic is answered", () => {
  it("THE SANDBOX FAILURE: an `options` question beside INs, an other_att and an unsure is answered", async () => {
    const { res, st } = await run({ topic: "options", neighbours: [IN, OTHER_IN, UNSURE] });
    expect([...res.ownedIds]).toEqual(["wa-q"]);
    const reply = res.outcomes.get("wa-q")?.reply ?? "";
    expect(reply).toContain(`We're 2 of ${st.maxPlayers}`);
  });

  it.each(["phones", "fixture"])("a `%s` question beside an IN is answered too", async (topic) => {
    const { res } = await run({ topic, neighbours: [IN] });
    expect([...res.ownedIds]).toEqual(["wa-q"]);
    expect(res.outcomes.get("wa-q")?.reply).toBeTruthy();
  });

  it.each([
    ["bench", ""],
    ["person_status", "Zair"],
  ])("UNCHANGED: a `%s` question beside an IN still waits for the batch's squad post, which answers it by name", async (topic, personRef) => {
    const { res } = await run({ topic, neighbours: [IN], personRef });
    expect([...res.ownedIds]).toEqual([]);
  });

  it("UNCHANGED: a question beside a writer that runs AFTER this step (a score) is still handed back", async () => {
    const { res } = await run({ topic: "options", neighbours: [SCORE] });
    expect([...res.ownedIds]).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/does not own/);
  });
});

describe("a monthly club whose month is not started", () => {
  it("an `options` question is answered with how the monthly squad works (the availability help), never a count", async () => {
    const { res, asked } = await run({ topic: "options", neighbours: [IN], monthNotStarted: true });
    expect([...res.ownedIds]).toEqual(["wa-q"]);
    expect(asked.map((a) => a.topic)).toEqual(["availability"]);
    const o = res.outcomes.get("wa-q");
    expect(o?.reply).toBe("HELP availability");
    expect(o?.intent).toBe("help");
  });

  it("alone in its batch too", async () => {
    const { res, asked } = await run({ topic: "options", neighbours: [], monthNotStarted: true });
    expect(asked.map((a) => a.topic)).toEqual(["availability"]);
    expect(res.outcomes.get("wa-q")?.reply).toBe("HELP availability");
  });

  it("REGRESSION GUARD: with the month started, `options` is the count and the formats, as before", async () => {
    const { res, asked } = await run({ topic: "options", neighbours: [] });
    expect(asked).toEqual([]);
    expect(res.outcomes.get("wa-q")?.reply).toMatch(/^We're 2 of /);
  });
});
