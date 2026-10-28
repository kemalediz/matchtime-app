/**
 * FNF, Tue 20 Oct 2026, 10:36 UTC: Naim typed "@Match Time out" in the
 * players' group. Raihan had already taken him out from the organisers'
 * group thirteen minutes earlier, so his row was DROPPED. MatchTime said
 * nothing and reacted with nothing: the player could not tell whether he
 * had been heard.
 *
 * Two separate defects, both traced and reproduced (dev key):
 *
 * 1. THE SENDER'S OWN LINE WAS IN HIS RECENT CHAT. The Pi records every
 *    inbound message into its history buffer with the RAW mention token
 *    ("@158055467598020 out"), and rewrites the bot's own mention to
 *    "@Match Time" only on the message it forwards for analysis. The
 *    extractor's self-echo filter compares bodies, so "@158055467598020
 *    out" never matched "@Match Time out" and Naim was shown his own
 *    message as context. That is the 2026-09-09 echo shape: a line shown
 *    twice reads as an acknowledgement and the claim disappears.
 *    Measured on the exact production input (token count 172, equal to
 *    production's): claimless 6 of 63; the same input without the echoed
 *    line, 0 of 63. Production returned
 *    `{"claims":[],"affirmation":"no","sideRequests":[]}`.
 *    The extractor's input carries NO squad state, so Naim being DROPPED
 *    played no part in the empty claims.
 *
 * 2. A REDUNDANT CLAIM GOT NO REACTION. Even with the claim extracted,
 *    `applyClaim` returns null for an OUT from a DROPPED row (and an IN
 *    from a CONFIRMED one), and the engine set the react only after a
 *    write. So the player who repeats himself is ignored where a fresh
 *    one gets 👋 / ✅. Same acknowledgement now, no write, no extra
 *    message.
 */
import { describe, expect, it } from "vitest";
import {
  runAttendanceEngineBatch,
  type EngineBatchDeps,
  type EngineBatchMessage,
} from "../attendance-engine-batch";
import { mergeGroupChatHistory } from "../group-chat-history";
import type { SquadState } from "../pipeline/types";
import type { PipelineModel, ModelRequest } from "../pipeline/llm";

const BOT_RAW = "@158055467598020 out"; // what the Pi records into history (bodyLen=20)
const BOT_REWRITTEN = "@Match Time out"; // what it forwards as the message

function state(rows: SquadState["rows"], over: Partial<SquadState> = {}): SquadState {
  return {
    matchId: "match-1",
    maxPlayers: 18,
    kickoffLabel: "Fri 20:30",
    venue: "The Pitch",
    rows,
    roster: [
      { userId: "u-naim", name: "Naim", isAdmin: false, hasPhone: true },
      { userId: "u-kieran", name: "Kieran", isAdmin: false, hasPhone: true },
      { userId: "u-raihan", name: "Raihan", isAdmin: true, hasPhone: true },
    ],
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
  };
}

/** The extractor's raw output for Naim's message, captured on the dev key
 *  with the corrected input (`naim_selfline_removed`, run 1). */
const CAPTURED_SELF_OUT = {
  claims: [
    {
      subject: "sender",
      personRef: "",
      personNamed: false,
      polarity: "out",
      contingent: false,
      conditionOn: "none",
      tense: "present",
      reported: false,
      replaces: "",
      confidence: 0.9,
    },
  ],
  affirmation: "none",
  sideRequests: [],
};

const SELF_IN = {
  ...CAPTURED_SELF_OUT,
  claims: [{ ...CAPTURED_SELF_OUT.claims[0], polarity: "in" }],
};

function capturingModel(body: Record<string, unknown>, seen: ModelRequest[] = []): PipelineModel {
  return {
    name: "fake",
    async complete(req) {
      seen.push(req);
      return {
        text: JSON.stringify(body),
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        ms: 1,
      };
    },
  };
}

function deps(model: PipelineModel, s: SquadState) {
  const registered: string[] = [];
  const cancelled: string[] = [];
  const d = {
    model,
    loadState: async () => s,
    openBenchPromptUserIds: async () => [],
    async claimGuestNameAsk() {
      return true;
    },
    async registerAttendance(userId: string) {
      registered.push(userId);
      return { status: "CONFIRMED" as const, position: 1, slot: 1, confirmedCount: 1, maxPlayers: 18 };
    },
    async cancelAttendance(userId: string) {
      cancelled.push(userId);
      return { status: "DROPPED" as const };
    },
    async resolveOrProvision(name: string) {
      return { userId: `new-real:${name}` };
    },
  } as unknown as EngineBatchDeps;
  return { d, registered, cancelled };
}

function naimMsg(over: Partial<EngineBatchMessage> = {}): EngineBatchMessage {
  return {
    waMessageId: "wa-naim",
    body: BOT_REWRITTEN,
    authorName: "Naim",
    senderUserId: "u-naim",
    senderName: "Naim",
    senderIsAdmin: false,
    tagged: true,
    route: "self_att",
    gated: false,
    ...over,
  };
}

async function run(messages: EngineBatchMessage[], d: EngineBatchDeps, history: Array<{ author: string | null; body: string }> = []) {
  return runAttendanceEngineBatch({
    orgId: "org-1",
    now: new Date("2026-10-20T10:36:39Z"),
    messages,
    history,
    expectedMatchId: "match-1",
    enabled: true,
    deps: d,
  });
}

describe("defect 1: the sender's own message is never shown back to him as recent chat", () => {
  // Since 2026-10-20 the route builds the recent chat itself
  // (`group-chat-history.ts`): the Pi's line for a message in the batch is
  // replaced by the batch's own line, shown under the sender's ROSTER name,
  // and the route hands the extractor that same name as the sender. So the
  // extractor's own-line filter (author AND body) matches, whatever the
  // Pi recorded and whatever pushname Naim uses.
  const T_KIERAN = "2026-10-20T10:30:41.000Z";
  const T_NAIM = "2026-10-20T10:36:37.000Z";
  const piHistory = [
    { authorName: "Kiz", body: BOT_RAW, timestamp: T_KIERAN },
    { authorName: "Naimy", body: BOT_RAW, timestamp: T_NAIM },
  ];
  const batch = [{ authorName: "Naimy", timestamp: T_NAIM, author: "Naim", body: BOT_REWRITTEN, stored: false }];

  it("the Naim input: the extractor sees Kieran's line and not Naim's own", async () => {
    const seen: ModelRequest[] = [];
    const s = state([{ userId: "u-naim", status: "DROPPED", position: 7 }]);
    const { d } = deps(capturingModel(CAPTURED_SELF_OUT, seen), s);
    const history = mergeGroupChatHistory({
      pi: piHistory,
      stored: [{ authorName: "Kiz", author: "Kieran", body: BOT_REWRITTEN, at: new Date("2026-10-20T10:30:45.000Z") }],
      batch,
    });
    await run([naimMsg()], d, history);
    expect(seen).toHaveLength(1);
    expect(seen[0].user).toContain(`Kieran: ${BOT_REWRITTEN}`);
    expect(seen[0].user).not.toContain(`Naim: ${BOT_REWRITTEN}`);
    expect(seen[0].user).not.toContain(`Naimy`);
    expect(seen[0].user).not.toContain(BOT_RAW);
  });

  it("after a Pi restart (no Pi history at all) the stored line is still there, and still not his own", async () => {
    const seen: ModelRequest[] = [];
    const s = state([{ userId: "u-naim", status: "DROPPED", position: 7 }]);
    const { d } = deps(capturingModel(CAPTURED_SELF_OUT, seen), s);
    const history = mergeGroupChatHistory({
      pi: [],
      stored: [{ authorName: "Kiz", author: "Kieran", body: "who's out tonight?", at: new Date(T_KIERAN) }],
      batch,
    });
    await run([naimMsg()], d, history);
    expect(seen[0].user).toContain("RECENT CHAT");
    expect(seen[0].user).toContain("Kieran: who's out tonight?");
    expect(seen[0].user).not.toContain(`Naim: ${BOT_REWRITTEN}`);
  });
});

describe("defect 2: a redundant self claim is acknowledged like a fresh one, with no write and no message", () => {
  it("OUT when already DROPPED: 👋, nothing cancelled, no reply", async () => {
    const s = state([{ userId: "u-naim", status: "DROPPED", position: 7 }]);
    const { d, cancelled, registered } = deps(capturingModel(CAPTURED_SELF_OUT), s);
    const r = await run([naimMsg()], d);
    const o = r.outcomes.get("wa-naim");
    expect(o?.react).toBe("👋");
    expect(o?.reply).toBeNull();
    expect(cancelled).toEqual([]);
    expect(registered).toEqual([]);
  });

  it("OUT when already DROPPED, in Turkish: the same 👋", async () => {
    const s = state([{ userId: "u-naim", status: "DROPPED", position: 7 }], {
      features: { attendance: true, paymentTracking: false, statsQa: false, reminders: false, language: "tr" },
    });
    const { d, cancelled } = deps(capturingModel(CAPTURED_SELF_OUT), s);
    const r = await run([naimMsg({ body: "@Match Time yokum" })], d);
    expect(r.outcomes.get("wa-naim")?.react).toBe("👋");
    expect(r.outcomes.get("wa-naim")?.reply).toBeNull();
    expect(cancelled).toEqual([]);
  });

  it("OUT with no row at all (never down for this match) stays the silent no-op it was", async () => {
    const s = state([]);
    const { d, cancelled } = deps(capturingModel(CAPTURED_SELF_OUT), s);
    const r = await run([naimMsg()], d);
    expect(r.outcomes.get("wa-naim")?.react).toBeNull();
    expect(cancelled).toEqual([]);
  });

  it("the fresh OUT is unchanged: CONFIRMED -> cancelled, 👋", async () => {
    const s = state([{ userId: "u-naim", status: "CONFIRMED", position: 7 }]);
    const { d, cancelled } = deps(capturingModel(CAPTURED_SELF_OUT), s);
    const r = await run([naimMsg()], d);
    expect(cancelled).toEqual(["u-naim"]);
    expect(r.outcomes.get("wa-naim")?.react).toBe("👋");
  });

  it("IN when already CONFIRMED: ✅, nothing registered, no reply", async () => {
    const s = state([{ userId: "u-naim", status: "CONFIRMED", position: 7 }]);
    const { d, registered } = deps(capturingModel(SELF_IN), s);
    const r = await run([naimMsg({ body: "@Match Time in" })], d);
    expect(r.outcomes.get("wa-naim")?.react).toBe("✅");
    expect(r.outcomes.get("wa-naim")?.reply).toBeNull();
    expect(registered).toEqual([]);
  });

  it("IN when already CONFIRMED, in Turkish (varım): the same ✅", async () => {
    const s = state([{ userId: "u-naim", status: "CONFIRMED", position: 7 }], {
      features: { attendance: true, paymentTracking: false, statsQa: false, reminders: false, language: "tr" },
    });
    const { d, registered } = deps(capturingModel(SELF_IN), s);
    const r = await run([naimMsg({ body: "@Match Time varım" })], d);
    expect(r.outcomes.get("wa-naim")?.react).toBe("✅");
    expect(registered).toEqual([]);
  });

  it("IN when already on the BENCH with no room: 🪑, nothing written", async () => {
    const full = Array.from({ length: 18 }, (_, i) => ({ userId: `u-p${i}`, status: "CONFIRMED" as const, position: i + 1 }));
    const s = state([...full, { userId: "u-naim", status: "BENCH", position: 19 }]);
    const { d, registered } = deps(capturingModel(SELF_IN), s);
    const r = await run([naimMsg({ body: "@Match Time in" })], d);
    expect(r.outcomes.get("wa-naim")?.react).toBe("🪑");
    expect(registered).toEqual([]);
  });
});
