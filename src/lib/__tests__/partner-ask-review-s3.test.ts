/**
 * The review of the cross-club stack, findings that belong to slice S3.
 *
 *   M1  a reply to a partner club's ask is handled whatever the partner
 *       club's own match state: no active match, attendance off, a match
 *       id mismatch or an open bench prompt never swallow it;
 *   M2  in one batch, a plain own-club IN and a quoted ask IN from the
 *       same person do not supersede each other;
 *   M4  a partner ask is no "awaiting answer" for the whole group;
 *   H2  OUT acts only while the asking club's match is still to play;
 *   M3  the post goes out only to a Pi that forwards quoted ids.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runAttendanceEngineBatch, type EngineBatchDeps, type EngineBatchMessage } from "../attendance-engine-batch";
import { decideVolunteer } from "../partner-volunteer-rules";
import type { PipelineModel } from "../pipeline/llm";
import type { SquadState } from "../pipeline/types";
import { decide } from "../pipeline/engine";
import { NOW, attendanceFacts, claim, msg as emsg, world } from "../pipeline/__tests__/helpers";

const ASK = { askId: "ask-1", postWaMessageId: "true_g@g.us_3EB0ASK1", askerName: "FNF", open: true };

function model(polarity: "in" | "out" = "in"): PipelineModel {
  return {
    name: "fake",
    async complete() {
      return {
        text: JSON.stringify({
          claims: [{ subject: "sender", personRef: "", personNamed: false, polarity, contingent: false, conditionOn: "none", tense: "present", reported: false, confidence: 0.95 }],
          affirmation: "none",
          sideRequests: [],
        }),
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0,
        ms: 1,
      };
    },
  };
}

function state(over: Partial<SquadState> = {}): SquadState {
  return {
    matchId: "match-1",
    maxPlayers: 4,
    kickoffLabel: "Tue 20:00",
    venue: "The Pitch",
    rows: [],
    roster: [{ userId: "u-pete", name: "Pete Power", isAdmin: false, hasPhone: true }],
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
    partnerAsks: [ASK],
    ...over,
  };
}

const quoted: EngineBatchMessage = {
  waMessageId: "wa-q",
  body: "in",
  authorName: "Pete Power",
  senderUserId: "u-pete",
  senderName: "Pete Power",
  senderIsAdmin: false,
  tagged: true,
  route: "self_att",
  gated: false,
  quoted: { id: "3EB0ASK1", fromMatchTime: true },
};

function deps(s: SquadState, over: Partial<EngineBatchDeps> = {}) {
  const volunteers: string[] = [];
  const registered: string[] = [];
  const d = {
    model: model(),
    loadState: async () => s,
    openBenchPromptUserIds: async () => [] as string[],
    claimGuestNameAsk: async () => true,
    registerAttendance: async (userId: string) => {
      registered.push(userId);
      return { status: "CONFIRMED" as const, position: 1, slot: 1, confirmedCount: 1, maxPlayers: 4 };
    },
    cancelAttendance: async () => ({ status: "DROPPED" as const }),
    resolveOrProvision: async (name: string) => ({ userId: `new:${name}` }),
    partnerVolunteer: async (w: { askId: string }) => {
      volunteers.push(w.askId);
      return { ok: true, outcome: "registered-bench", dmText: "Thanks, you're on FNF's bench.", dmQueued: true };
    },
    ...over,
  } as unknown as EngineBatchDeps;
  return { d, volunteers, registered };
}

const run = (s: SquadState, messages: EngineBatchMessage[], d: EngineBatchDeps, expected: string | null = "match-1") =>
  runAttendanceEngineBatch({ orgId: "org-1", now: new Date("2026-09-03T12:00:00Z"), messages, history: [], expectedMatchId: expected, enabled: true, deps: d });

describe("M1: a reply to an ask is never lost to the partner club's own match state", () => {
  for (const [label, s, expected, prompted] of [
    ["no active registration match", state({ matchId: null }), null, false],
    ["attendance switched off", state({ features: { attendance: false, paymentTracking: false, statsQa: false, reminders: false, language: "en" } }), "match-1", false],
    ["the route's match and the engine's disagree", state(), "other-match", false],
    ["an open bench prompt for the sender", state(), "match-1", true],
  ] as const) {
    it(label, async () => {
      const { d, volunteers, registered } = deps(s, prompted ? { openBenchPromptUserIds: async () => ["u-pete"] } : {});
      const r = await run(s, [quoted], d, expected);
      expect(volunteers).toEqual(["ask-1"]);
      expect(registered).toEqual([]);
      // 2026-10-21 (Kemal): he is answered by DM; the group hears nothing.
      expect(r.outcomes.get("wa-q")?.reply).toBeNull();
      expect(r.outcomes.get("wa-q")?.intent).toBe("partner_volunteer");
    });
  }
});

describe("2026-10-21 (Kemal): a swipe-reply to the ask adds no noise to the partner group", () => {
  it("answered by DM: no reply and no reaction in the group", async () => {
    const s = state();
    const { d } = deps(s);
    const r = await run(s, [quoted], d);
    expect(r.outcomes.get("wa-q")?.reply).toBeNull();
    expect(r.outcomes.get("wa-q")?.react).toBeNull();
    expect(r.outcomes.get("wa-q")?.action).toBe("partner-volunteer:registered-bench");
  });

  it("registered but no number to DM him: a 👍 reaction on his message, still no message", async () => {
    const s = state();
    const { d } = deps(s, { partnerVolunteer: async () => ({ ok: true, outcome: "registered-bench", dmText: "x", dmQueued: false }) } as Partial<EngineBatchDeps>);
    const r = await run(s, [quoted], d);
    expect(r.outcomes.get("wa-q")?.reply).toBeNull();
    expect(r.outcomes.get("wa-q")?.react).toBe("👍");
  });

  it("a refusal with no number to DM him: silent in the group", async () => {
    const s = state();
    const { d } = deps(s, { partnerVolunteer: async () => ({ ok: true, outcome: "closed", dmText: "x", dmQueued: false }) } as Partial<EngineBatchDeps>);
    const r = await run(s, [quoted], d);
    expect(r.outcomes.get("wa-q")?.reply).toBeNull();
    expect(r.outcomes.get("wa-q")?.react).toBeNull();
  });

  // D5b, revised 2026-10-22 (Kemal): the own game is the default.
  const withFreshAsk = () => state({ partnerAsks: [{ ...ASK, postedAt: new Date("2026-09-03T11:40:00Z").toISOString() }] });
  const plain: EngineBatchMessage = { ...quoted, waMessageId: "wa-plain", quoted: undefined, tagged: false };

  it("D5b: a plain IN counts for his own game, THEN he is asked by DM about FNF's", async () => {
    const s = withFreshAsk();
    const order: string[] = [];
    const asked: Array<{ askId: string; userId: string; matchId: string }> = [];
    const { d, registered } = deps(s, {
      registerAttendance: async (userId: string) => {
        order.push(`register:${userId}`);
        registered.push(userId);
        return { status: "CONFIRMED" as const, position: 1, slot: 1, confirmedCount: 1, maxPlayers: 4 };
      },
      askPartnerAfterOwnIn: async (a: { askId: string; userId: string; matchId: string }) => {
        order.push(`ask:${a.userId}`);
        asked.push(a);
        return true;
      },
      claimPartnerAskWhich: async () => {
        throw new Error("the old question must not be asked");
      },
    } as Partial<EngineBatchDeps>);
    const r = await run(s, [plain], d);
    expect(registered).toEqual(["u-pete"]);
    expect(asked).toEqual([{ askId: "ask-1", userId: "u-pete", matchId: "match-1" }]);
    expect(order).toEqual(["register:u-pete", "ask:u-pete"]);
    // The group hears what any IN gets: nothing about FNF.
    expect(r.outcomes.get("wa-plain")?.reply ?? "").not.toContain("FNF");
    expect(r.outcomes.get("wa-plain")?.intent).toBe("in");
  });

  it("D5b: his own IN did not land, so he is not told he was put IN", async () => {
    const s = withFreshAsk();
    const asked: string[] = [];
    const { d } = deps(s, {
      registerAttendance: async () => {
        throw new Error("pg is down");
      },
      askPartnerAfterOwnIn: async (a: { userId: string }) => {
        asked.push(a.userId);
        return true;
      },
    } as Partial<EngineBatchDeps>);
    await run(s, [plain], d);
    expect(asked).toEqual([]);
  });

  it("D5b: the DM failing never undoes or hides his own IN", async () => {
    const s = withFreshAsk();
    const { d, registered } = deps(s, {
      askPartnerAfterOwnIn: async () => {
        throw new Error("queue down");
      },
    } as Partial<EngineBatchDeps>);
    const r = await run(s, [plain], d);
    expect(registered).toEqual(["u-pete"]);
    expect(r.outcomes.get("wa-plain")?.action).toBe("IN");
    expect(r.degradations.join(" ")).toMatch(/D5b/);
  });
});

describe("M2: own-club IN and a quoted ask IN from the same person, one batch", () => {
  it("both act: the own IN is not superseded, and the ask IN is not either", () => {
    const own = emsg({ id: "wa-own", from: "sait", body: "IN", route: "self_att", facts: attendanceFacts([claim()]) });
    const ask = { ...emsg({ id: "wa-ask", from: "sait", body: "IN", route: "self_att", facts: attendanceFacts([claim()]) }), quoted: { id: "3EB0ASK1", fromMatchTime: true } };
    const s = { ...world({ confirmed: ["kemal"] }), partnerAsks: [ASK] };
    for (const order of [[own, ask], [ask, own]]) {
      const r = decide({ now: NOW, state: s, messages: order });
      expect(r.writes.find((w) => w.kind === "attendance")).toMatchObject({ userId: "u-sait", status: "CONFIRMED" });
      expect(r.writes.find((w) => w.kind === "partner_volunteer")).toMatchObject({ userId: "u-sait", polarity: "in" });
    }
  });
});

describe("H2: OUT only while the asking club's game is still to play", () => {
  const base = { polarity: "out" as const, askOpen: false, senderIsPartnerMember: true, inOverlappingOwnGame: false, ordinaryAskerMember: false, onAskerMatch: true };
  it("a played or finished game: never dropped", () => {
    expect(decideVolunteer({ ...base, askerMatchLive: false, pastGuest: false })).toEqual({ kind: "refuse", why: "game-over" });
    expect(decideVolunteer({ ...base, askerMatchLive: true, pastGuest: true })).toEqual({ kind: "refuse", why: "game-over" });
  });
  it("a game still to play: dropped", () => {
    expect(decideVolunteer({ ...base, askerMatchLive: true, pastGuest: false })).toEqual({ kind: "withdraw" });
  });
});

describe("M4: no awaiting-answer rescue for a partner ask", () => {
  it("the loader no longer lists partner asks as questions to the whole group", () => {
    const src = readFileSync(join(__dirname, "..", "pipeline", "load-awaiting-answer.ts"), "utf8");
    expect(src).not.toMatch(/partnerAsk/);
    const kinds = readFileSync(join(__dirname, "..", "pipeline", "awaiting-answer.ts"), "utf8");
    expect(kinds).not.toMatch(/"partner-ask"/);
  });
});

describe("M3: the post waits for a Pi that forwards quoted ids", () => {
  it("the scheduler holds a partner ask's post unless the Pi says quoted-id", () => {
    const src = readFileSync(join(__dirname, "..", "bot-scheduler.ts"), "utf8");
    expect(src).toMatch(/partnerAskPostJobIds/);
    expect(src).toMatch(/piSendsQuotedIds|quotedIds/);
  });
});
