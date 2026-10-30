/**
 * §10 STEP 7 PART 2 — the `admin_ops` route, owned end to end.
 *
 * The route that moves real money on a live club, so ownership is
 * tested before behaviour throughout. The properties, in order of how
 * much they can hurt somebody:
 *
 *   1. THE MONEY. Only an admin credits; a named credit and an aggregate
 *      credit are different writes and are never both; a credit that
 *      threw says nothing; and there is no target match unless a
 *      genuinely COMPLETED, non-historical one exists.
 *   2. THE OPT-OUT. A player who muted reminder DMs is never DM'd by
 *      this path, and a lookup that FAILED is not permission either.
 *   3. THE BLAST RUNS LATER. `recruit_blast` is reported, never applied;
 *      2026-09-01 was a blast that ran before the batch's writes.
 *   4. NOTHING IS OWNED BY DEFAULT, and every failure lands on "the
 *      analyzer decides this message".
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { newSilenceFacts, type SilenceFacts } from "../tagged-silence";
import type { ModelRequest, ModelResponse, PipelineModel } from "../pipeline/llm";
import type { EngineResult, Route, SquadState } from "../pipeline/types";
import { NOW, fullName, world, type WorldOpts } from "../pipeline/__tests__/helpers";
import type { PaidState } from "../admin-ops-engine";
import type { StoredAsk } from "../refused-ask-retry";
import {
  runAdminOpsBatch,
  describeAdminOpsBatch,
  ADMIN_OPS_ROUTES,
  type AdminOpsBatchDeps,
  type AdminOpsBatchMessage,
} from "../admin-ops-engine-batch";

// ── Fixtures ───────────────────────────────────────────────────────────

const SQUAD = ["kemal", "elvin", "sait", "amir"];

function paidWorld(over: WorldOpts = {}): SquadState {
  return world({
    confirmed: SQUAD,
    features: { paymentTracking: true, reminders: true },
    completedMatch: { id: "done-1", participantUserIds: SQUAD.map((k) => `u-${k}`) },
    ...over,
  });
}

function stubModel(table: Record<string, unknown>, opts: { throwOn?: string } = {}) {
  const calls: string[] = [];
  const model: PipelineModel = {
    name: "test-stub",
    async complete(req: ModelRequest): Promise<ModelResponse> {
      const body = req.user.split("\n").slice(-1)[0];
      calls.push(`${req.label}|${body}`);
      if (opts.throwOn && body.includes(opts.throwOn)) throw new Error("529 Overloaded");
      const payload = table[body];
      if (payload === undefined) throw new Error(`no stub for "${body}"`);
      return {
        text: JSON.stringify(payload),
        stopReason: "end_turn",
        usage: { inputTokens: 900, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.0013,
        ms: 600,
      };
    },
  };
  return { model, calls };
}

interface Recorder {
  marked: Array<{ matchId: string; userId: string; payerUserId: string }>;
  credits: Array<{ matchId: string; payerUserId: string; recordedByUserId: string; count: number }>;
  dms: Array<{ phone: string; text: string; sendAt: Date }>;
  deps: AdminOpsBatchDeps;
}

const DEFAULT_PAID_STATE: PaidState = {
  matchName: "Tuesday 7-a-side",
  confirmed: SQUAD.map((k) => ({ userId: `u-${k}`, name: fullName(k), paid: false })),
  creditTotal: 0,
};

function recorder(
  model: PipelineModel,
  state: SquadState,
  over: Partial<AdminOpsBatchDeps> = {},
  paidState: PaidState = DEFAULT_PAID_STATE,
): Recorder {
  const marked: Recorder["marked"] = [];
  const credits: Recorder["credits"] = [];
  const dms: Recorder["dms"] = [];
  return {
    marked,
    credits,
    dms,
    deps: {
      model,
      loadState: async () => state,
      reminderMutedUserIds: async () => [],
      loadPaidState: async () => paidState,
      markPaid: async (a) => {
        marked.push(a);
      },
      createPaymentCredit: async (a) => {
        credits.push(a);
      },
      loadPhone: async () => "+447700900000",
      queueReminderDm: async (a) => {
        dms.push(a);
      },
      ...over,
    },
  };
}

function msg(o: Partial<AdminOpsBatchMessage> & { body: string }): AdminOpsBatchMessage {
  return {
    waMessageId: o.waMessageId ?? `wa-${o.body.slice(0, 14)}`,
    body: o.body,
    authorName: o.authorName ?? fullName("elvin"),
    senderUserId: o.senderUserId === undefined ? "u-elvin" : o.senderUserId,
    senderName: o.senderName ?? fullName("elvin"),
    tagged: o.tagged ?? true,
    // The Pi's mention flag, as the real Pi sets it with its "@Match Time"
    // body rewrite (review of #476), unless the case says otherwise.
    taggedExplicitly: o.taggedExplicitly ?? o.body.includes("@Match Time"),
    // `"route" in o` and not `?? "admin_ops"`: an EXPLICIT `undefined` is
    // the shape of a message the router never mentioned, and it has to
    // survive the builder or the "never owned" test tests nothing.
    route: "route" in o ? o.route : "admin_ops",
    gated: o.gated ?? false,
  };
}

async function run(args: {
  messages: AdminOpsBatchMessage[];
  deps: AdminOpsBatchDeps;
  enabled?: Route[];
  silence?: SilenceFacts;
}) {
  return runAdminOpsBatch({
    ...(args.silence ? { silence: args.silence } : {}),
    orgId: "org-1",
    now: NOW,
    messages: args.messages,
    history: [],
    enabled: new Set<Route>(args.enabled ?? ["admin_ops"]),
    deps: args.deps,
  });
}

const PAY = "@Match Time Amir paid for 4 players";
const PAY_FACTS = {
  action: "bulk_payment",
  payerRef: "Amir",
  count: 4,
  coveredRefs: [],
  phrase: "",
  note: "",
  lookbackMatches: 0,
};
const REMIND = "@Match Time remind me tomorrow at 6 to bring the bibs";
const REMIND_FACTS = {
  action: "reminder",
  payerRef: "",
  count: 0,
  coveredRefs: [],
  phrase: "tomorrow at 6",
  // 2026-10-30: the extractor states the London time from NOW.
  remindAt: "2026-09-02 18:00",
  note: "bring the bibs",
  lookbackMatches: 0,
};
const BLAST = "@Match Time message all players who played in the last 5 matches and invite them";
const BLAST_FACTS = {
  action: "recruit",
  payerRef: "",
  count: 0,
  coveredRefs: [],
  phrase: "",
  note: "",
  lookbackMatches: 5,
};

// ── 1. Nothing by default ──────────────────────────────────────────────

describe("the admin_ops route owns nothing unless its flag says so", () => {
  it("makes no model call at all with the flag off", async () => {
    const { model, calls } = stubModel({});
    const r = recorder(model, paidWorld());
    const res = await run({ messages: [msg({ body: PAY })], deps: r.deps, enabled: [] });
    expect(res.ownedIds.size).toBe(0);
    expect(calls).toEqual([]);
    expect(r.credits).toEqual([]);
  });

  it("owns nothing for another route, or a message the router never mentioned", async () => {
    const { model, calls } = stubModel({});
    const r = recorder(model, paidWorld());
    const res = await run({
      messages: [msg({ body: PAY, route: "self_att" }), msg({ body: PAY, route: undefined })],
      deps: r.deps,
    });
    expect(res.ownedIds.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it("owns nothing for a message step 5's gate already skipped", async () => {
    const { model, calls } = stubModel({});
    const r = recorder(model, paidWorld());
    const res = await run({ messages: [msg({ body: PAY, gated: true })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it("names exactly the route it owns", () => {
    expect([...ADMIN_OPS_ROUTES]).toEqual(["admin_ops"]);
  });
});

// ── 2. The money ───────────────────────────────────────────────────────

describe("S21 · a bulk payment credit", () => {
  it("an admin's aggregate credit creates ONE PaymentCredit and stamps nobody", async () => {
    const { model } = stubModel({ [PAY]: PAY_FACTS });
    const r = recorder(model, paidWorld());
    const res = await run({ messages: [msg({ body: PAY })], deps: r.deps });

    expect(r.credits).toEqual([
      {
        matchId: "done-1",
        payerUserId: "u-amir",
        // The ADMIN who typed it, never the payer.
        recordedByUserId: "u-elvin",
        count: 4,
      },
    ]);
    expect(r.marked).toEqual([]);

    const out = [...res.outcomes.values()][0];
    expect(out.intent).toBe("bulk_payment_credit");
    expect(out.react).toBe("👍");
    // Every number in the ack is read from what landed: 4 confirmed,
    // nobody paid, one credit of 4 → nothing outstanding.
    expect(out.reply).toBe(
      "💳 Got it, credited *Amir Ahmadi* with 4 payments for *Tuesday 7-a-side*. Unpaid: 0/4.",
    );
  });

  it("a NAMED credit stamps those rows and creates no credit row", async () => {
    // Doing both would double-count the same money — `route.ts:3841-3873`
    // branches for exactly this reason.
    const { model } = stubModel({
      [PAY]: { ...PAY_FACTS, count: 2, coveredRefs: ["Sait", "Kemal"] },
    });
    const r = recorder(model, paidWorld());
    const res = await run({ messages: [msg({ body: PAY })], deps: r.deps });

    expect(r.credits).toEqual([]);
    expect(r.marked.map((m) => m.userId).sort()).toEqual(["u-kemal", "u-sait"]);
    expect(r.marked.every((m) => m.payerUserId === "u-amir")).toBe(true);
    expect([...res.outcomes.values()][0].reply).toBe(
      "💳 Got it, credited *Amir Ahmadi* with Sait Demir, Kemal Ediz for *Tuesday 7-a-side*. " +
        "Unpaid: 2/4.",
    );
  });

  it("never re-stamps a row that is already paid", async () => {
    const { model } = stubModel({
      [PAY]: { ...PAY_FACTS, count: 2, coveredRefs: ["Sait", "Kemal"] },
    });
    const r = recorder(model, paidWorld(), {}, {
      ...DEFAULT_PAID_STATE,
      confirmed: DEFAULT_PAID_STATE.confirmed.map((c) =>
        c.userId === "u-sait" ? { ...c, paid: true } : c,
      ),
    });
    await run({ messages: [msg({ body: PAY })], deps: r.deps });
    expect(r.marked.map((m) => m.userId)).toEqual(["u-kemal"]);
  });

  it("reports names it could not place on the squad rather than dropping them", async () => {
    const { model } = stubModel({
      [PAY]: { ...PAY_FACTS, count: 2, coveredRefs: ["Sait", "Idris"] },
    });
    // Idris is on the roster but was not CONFIRMED for the played match.
    const r = recorder(model, paidWorld({ players: [...SQUAD, "idris"] }));
    const res = await run({ messages: [msg({ body: PAY })], deps: r.deps });
    expect(r.marked.map((m) => m.userId)).toEqual(["u-sait"]);
    expect([...res.outcomes.values()][0].reply).toMatch(/couldn't find 1 of those names/);
  });

  it("a random member cannot credit a payment", async () => {
    // The chase math must not be corruptible by any member who can type.
    const { model } = stubModel({ [PAY]: PAY_FACTS });
    const r = recorder(model, paidWorld());
    const res = await run({
      messages: [msg({ body: PAY, senderUserId: "u-zair", senderName: fullName("zair") })],
      deps: r.deps,
    });
    expect(r.credits).toEqual([]);
    expect(r.marked).toEqual([]);
    expect([...res.outcomes.values()][0].reply).toBeNull();
  });

  it("hands the message back when payment tracking is off for the org", async () => {
    const { model } = stubModel({ [PAY]: PAY_FACTS });
    const r = recorder(model, paidWorld({ features: { paymentTracking: false } }));
    const res = await run({ messages: [msg({ body: PAY })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(res.degradations.join(" ")).toMatch(/payment tracking is off/);
  });

  it("hands the message back when the last match played was never COMPLETED", async () => {
    // `SquadState.completedMatch` is deliberately wider than the money
    // needs it to be, so the score route can record a first result. A
    // payment credit narrows it back to the shipped selector.
    const { model } = stubModel({ [PAY]: PAY_FACTS });
    const r = recorder(
      model,
      paidWorld({
        completedMatch: {
          id: "done-1",
          status: "TEAMS_PUBLISHED",
          participantUserIds: SQUAD.map((k) => `u-${k}`),
        },
      }),
    );
    const res = await run({ messages: [msg({ body: PAY })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(r.credits).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/no genuinely COMPLETED, non-historical match/);
  });

  it("never credits against a seeded historical match", async () => {
    const { model } = stubModel({ [PAY]: PAY_FACTS });
    const r = recorder(
      model,
      paidWorld({
        completedMatch: {
          id: "old-1",
          isHistorical: true,
          participantUserIds: SQUAD.map((k) => `u-${k}`),
        },
      }),
    );
    const res = await run({ messages: [msg({ body: PAY })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(r.credits).toEqual([]);
  });

  it("refuses a count the format cannot hold, rather than clamping it quietly", async () => {
    const { model } = stubModel({ [PAY]: { ...PAY_FACTS, count: 40 } });
    const r = recorder(model, paidWorld());
    const res = await run({ messages: [msg({ body: PAY })], deps: r.deps });
    expect(r.credits).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/exceeds the format/);
  });

  it("says NOTHING when the credit write threw", async () => {
    const { model } = stubModel({ [PAY]: PAY_FACTS });
    const r = recorder(model, paidWorld(), {
      createPaymentCredit: async () => {
        throw new Error("unique violation");
      },
    });
    const res = await run({ messages: [msg({ body: PAY })], deps: r.deps });
    const out = [...res.outcomes.values()][0];
    expect(out.reply).toBeNull();
    expect(out.react).toBeNull();
    expect(out.writeFailed).toBe(true);
    expect(res.degradations.join(" ")).toMatch(/unique violation/);
  });
});

// ── 3. The reminder ────────────────────────────────────────────────────

describe("S22 · a personal reminder", () => {
  it("queues a future-dated DM and acks with the RESOLVED time", async () => {
    const { model } = stubModel({ [REMIND]: REMIND_FACTS });
    const r = recorder(model, paidWorld());
    const res = await run({ messages: [msg({ body: REMIND })], deps: r.deps });

    expect(r.dms).toHaveLength(1);
    // BotJob.phone carries no leading "+" (`route.ts:3954`).
    expect(r.dms[0].phone).toBe("447700900000");
    expect(r.dms[0].sendAt.toISOString()).toBe("2026-09-02T17:00:00.000Z");
    expect(r.dms[0].text).toContain("bring the bibs");
    expect(r.dms[0].text).toContain("Reminder, Elvin");

    const out = [...res.outcomes.values()][0];
    expect(out.intent).toBe("reminder_request");
    expect(out.react).toBe("⏰");
    expect(out.reply).toBe("👍 Got it, I'll DM you Wed 2 Sep at 18:00.");
  });

  it("hands the message back when the sender muted reminder DMs", async () => {
    // The player asked MatchTime to stop DMing them. The shipped path
    // answers that out loud with a 🔕; that sentence lives in the
    // analyzer, so the message goes back to it rather than being
    // answered in a second wording.
    const { model } = stubModel({ [REMIND]: REMIND_FACTS });
    const r = recorder(model, paidWorld(), { reminderMutedUserIds: async () => ["u-elvin"] });
    const res = await run({ messages: [msg({ body: REMIND })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(r.dms).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/muted reminder DMs/);
  });

  it("owns NOTHING when the opt-out lookup itself failed", async () => {
    // A failed lookup is not permission to DM somebody who may have
    // asked to be left alone.
    const { model } = stubModel({ [REMIND]: REMIND_FACTS });
    const r = recorder(model, paidWorld(), {
      reminderMutedUserIds: async () => {
        throw new Error("pg is down");
      },
    });
    const res = await run({ messages: [msg({ body: REMIND })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(r.dms).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/opt-out lookup failed/);
  });

  it("stays silent for an org with reminders switched off", async () => {
    const { model } = stubModel({ [REMIND]: REMIND_FACTS });
    const r = recorder(model, paidWorld({ features: { reminders: false } }));
    const res = await run({ messages: [msg({ body: REMIND })], deps: r.deps });
    expect(r.dms).toEqual([]);
    expect([...res.outcomes.values()][0].reply).toBeNull();
  });

  it("hands back a member with no phone number on file", async () => {
    const { model } = stubModel({ [REMIND]: REMIND_FACTS });
    const r = recorder(model, paidWorld({ noPhone: ["elvin"] }));
    const res = await run({ messages: [msg({ body: REMIND })], deps: r.deps });
    expect(r.dms).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/no phone number on file/);
  });

  it("says nothing when the phone disappeared between the read and the write", async () => {
    const { model } = stubModel({ [REMIND]: REMIND_FACTS });
    const r = recorder(model, paidWorld(), { loadPhone: async () => null });
    const res = await run({ messages: [msg({ body: REMIND })], deps: r.deps });
    const out = [...res.outcomes.values()][0];
    expect(r.dms).toEqual([]);
    expect(out.reply).toBeNull();
    expect(out.writeFailed).toBe(true);
  });

  it("refuses when the extractor could state no time, rather than guessing a day", async () => {
    const { model } = stubModel({
      [REMIND]: { ...REMIND_FACTS, phrase: "before the match", remindAt: "" },
    });
    const r = recorder(model, paidWorld());
    const res = await run({ messages: [msg({ body: REMIND })], deps: r.deps });
    expect(r.dms).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/no time/);
  });

  it("falls back to the message itself when the extractor named no note", async () => {
    const { model } = stubModel({ [REMIND]: { ...REMIND_FACTS, note: "" } });
    const r = recorder(model, paidWorld());
    await run({ messages: [msg({ body: REMIND })], deps: r.deps });
    expect(r.dms[0].text).toContain(REMIND);
  });
});

// ── 4. The recruit blast ───────────────────────────────────────────────

// ── 4b. Partner clubs asked in the organiser's words (slice S6) ─────────

describe("a partner ask is reported, never performed here", () => {
  const ASK = "@Match Time ask Sutton if anyone can play";
  const ASK_FACTS = { ...BLAST_FACTS, lookbackMatches: 0, playersFrom: "partners", clubRef: "Sutton" };

  it("an admin's ask is owned, carries the club as written, and is not a blast", async () => {
    const { model } = stubModel({ [ASK]: ASK_FACTS });
    const r = recorder(model, paidWorld());
    const res = await run({ messages: [msg({ body: ASK, senderUserId: "u-kemal" })], deps: r.deps });
    expect(res.ownedIds.size).toBe(1);
    expect(res.degradations.join(" ")).not.toMatch(/cannot apply/);
    const out = [...res.outcomes.values()][0];
    expect(out.partnerAskRequest).toEqual({ clubRef: "Sutton", matchId: expect.any(String) });
    expect(out.recruitRequest).toBe(false);
    expect(out.intent).toBe("partner_ask");
    expect(r.dms).toEqual([]);
    expect(out.reply).toBeNull();
  });

  it("no club named: clubRef null", async () => {
    const { model } = stubModel({ [ASK]: { ...ASK_FACTS, clubRef: "" } });
    const r = recorder(model, paidWorld());
    const res = await run({ messages: [msg({ body: ASK, senderUserId: "u-kemal" })], deps: r.deps });
    expect([...res.outcomes.values()][0].partnerAskRequest).toMatchObject({ clubRef: null });
  });

  it("a non-admin's ask is not reported", async () => {
    const { model } = stubModel({ [ASK]: ASK_FACTS });
    const r = recorder(model, paidWorld());
    const res = await run({ messages: [msg({ body: ASK, senderUserId: "u-zair", senderName: fullName("zair") })], deps: r.deps });
    expect([...res.outcomes.values()][0].partnerAskRequest).toBeNull();
  });
});

// ── 4c. The MatchTime player pool asked in the players' group (L10) ─────

describe("a pool ask is reported, never performed here", () => {
  const ASK = "@Match Time ask the pool for a player";
  const POOL_FACTS = { ...BLAST_FACTS, lookbackMatches: 0, playersFrom: "pool", clubRef: "" };

  it("an admin's ask is owned and reported for the batch-final pass; no blast, no partner ask, no DM", async () => {
    const { model } = stubModel({ [ASK]: POOL_FACTS });
    const r = recorder(model, paidWorld());
    const res = await run({ messages: [msg({ body: ASK, senderUserId: "u-kemal" })], deps: r.deps });
    const out = [...res.outcomes.values()][0];
    expect(res.degradations.join(" ")).not.toMatch(/cannot apply/);
    expect(out.poolAskRequest).toEqual({ matchId: expect.any(String) });
    expect(out.partnerAskRequest).toBeNull();
    expect(out.recruitRequest).toBe(false);
    expect(out.intent).toBe("pool_ask");
    expect(r.dms).toEqual([]);
  });

  it("a non-admin's ask is not reported (today's behaviour for that route)", async () => {
    const { model } = stubModel({ [ASK]: POOL_FACTS });
    const r = recorder(model, paidWorld());
    const res = await run({ messages: [msg({ body: ASK, senderUserId: "u-zair", senderName: fullName("zair") })], deps: r.deps });
    const out = [...res.outcomes.values()][0];
    expect(out.poolAskRequest).toBeNull();
    expect(out.recruitRequest).toBe(false);
    expect(r.dms).toEqual([]);
  });
});

// ── 4d. Several places, or none (2026-10-28, Friday MT Community) ───────

describe("several places in one ask, or none named", () => {
  const ASK = "@Match Time find me players feom partner clubs and player pool";
  const base = { ...BLAST_FACTS, lookbackMatches: 0, clubRef: "" };
  const outcomeOf = async (facts: Record<string, unknown>, senderUserId = "u-kemal") => {
    const { model } = stubModel({ [ASK]: facts });
    const r = recorder(model, paidWorld());
    const res = await run({ messages: [msg({ body: ASK, senderUserId })], deps: r.deps });
    return { out: [...res.outcomes.values()][0], dms: r.dms, degradations: res.degradations };
  };

  it("partner clubs and the pool: both reported for the batch-final pass, no blast, no DM", async () => {
    const { out, dms, degradations } = await outcomeOf({ ...base, playersFrom: ["partners", "pool"] });
    expect(degradations.join(" ")).not.toMatch(/cannot apply/);
    expect(out.partnerAskRequest).toEqual({ clubRef: null, matchId: expect.any(String) });
    expect(out.poolAskRequest).toEqual({ matchId: expect.any(String) });
    expect(out.recruitRequest).toBe(false);
    expect(dms).toEqual([]);
  });

  it("everywhere: the club's own players too, so the blast is reported beside both asks", async () => {
    const { out } = await outcomeOf({ ...base, playersFrom: ["club", "partners", "pool"] });
    expect(out.partnerAskRequest).not.toBeNull();
    expect(out.poolAskRequest).not.toBeNull();
    expect(out.recruitRequest).toBe(true);
    expect(out.recruitSourceUnsaid).toBe(false);
  });

  it("no place named: the blast is reported marked unsaid, for the route to ask which", async () => {
    const { out } = await outcomeOf({ ...base, playersFrom: [] });
    expect(out.recruitRequest).toBe(true);
    expect(out.recruitSourceUnsaid).toBe(true);
    expect(out.partnerAskRequest).toBeNull();
    expect(out.poolAskRequest).toBeNull();
  });

  it("the club's own players named: the blast, not unsaid (today's behaviour)", async () => {
    const { out } = await outcomeOf({ ...base, playersFrom: ["club"] });
    expect(out.recruitRequest).toBe(true);
    expect(out.recruitSourceUnsaid).toBe(false);
  });

  it("a player who is not an admin, tagging MatchTime: nothing asked, the one line naming who can", async () => {
    const { model } = stubModel({ [ASK]: { ...base, playersFrom: ["partners", "pool"] } });
    const r = recorder(model, paidWorld());
    const res = await run({
      messages: [msg({ body: ASK, senderUserId: "u-zair", senderName: fullName("zair"), taggedExplicitly: true })],
      deps: { ...r.deps, onlyOrganisersLine: async () => "Only Kemal can change that." },
    });
    const out = [...res.outcomes.values()][0];
    expect(out.partnerAskRequest).toBeNull();
    expect(out.poolAskRequest).toBeNull();
    expect(out.recruitRequest).toBe(false);
    expect(out.reply).toBe("Only Kemal can change that.");
    expect(out.intent).toBe("organisers_only");
    expect(r.dms).toEqual([]);
  });

  it("a player who is not an admin, untagged: silent, nothing asked", async () => {
    const { model } = stubModel({ [ASK]: { ...base, playersFrom: [] } });
    const r = recorder(model, paidWorld());
    const res = await run({
      messages: [msg({ body: ASK, senderUserId: "u-zair", senderName: fullName("zair"), tagged: false, taggedExplicitly: false })],
      deps: { ...r.deps, onlyOrganisersLine: async () => "Only Kemal can change that." },
    });
    const out = res.outcomes.get(`wa-${ASK.slice(0, 14)}`);
    expect(out?.reply ?? null).toBeNull();
    expect(out?.recruitRequest ?? false).toBe(false);
  });
});

describe("the recruit blast is reported, never fired here", () => {
  it("an admin's ask is owned and carries the clamped lookback", async () => {
    const { model } = stubModel({ [BLAST]: BLAST_FACTS });
    const r = recorder(model, paidWorld());
    const res = await run({ messages: [msg({ body: BLAST, senderUserId: "u-kemal" })], deps: r.deps });

    const out = [...res.outcomes.values()][0];
    expect(out.recruitRequest).toBe(true);
    expect(out.recruitLookbackMatches).toBe(5);
    expect(out.intent).toBe("recruit_recent");
    // Nothing was sent from here. 2026-09-01: a blast that ran before
    // the batch's writes told the owner his squad was full one line
    // after he said Najib was out.
    expect(r.dms).toEqual([]);
    expect(r.credits).toEqual([]);
    expect(out.reply).toBeNull();
  });

  it("clamps a number the model read out of a sentence", async () => {
    const { model } = stubModel({ [BLAST]: { ...BLAST_FACTS, lookbackMatches: 50 } });
    const r = recorder(model, paidWorld());
    const res = await run({ messages: [msg({ body: BLAST, senderUserId: "u-kemal" })], deps: r.deps });
    expect([...res.outcomes.values()][0].recruitLookbackMatches).toBe(12);
  });

  it("reports null when the message named no number, so the default of 5 applies", async () => {
    const { model } = stubModel({ [BLAST]: { ...BLAST_FACTS, lookbackMatches: 0 } });
    const r = recorder(model, paidWorld());
    const res = await run({ messages: [msg({ body: BLAST, senderUserId: "u-kemal" })], deps: r.deps });
    expect([...res.outcomes.values()][0].recruitLookbackMatches).toBeNull();
  });

  // 2026-10-22, Sutton FC: a swipe-reply to MatchTime's post counts as a
  // tag, so the owner's reply to FNF's ask passed the admin and tag gates.
  // The quoted post's id must reach the engine, which refuses it.
  it("an admin's swipe-reply to a partner club's ask is never a recruit for this club", async () => {
    const { model } = stubModel({ [BLAST]: BLAST_FACTS });
    const r = recorder(model, {
      ...paidWorld(),
      partnerAsks: [{ askId: "ask-fnf", postWaMessageId: "true_g@g.us_3EB0FNFASK", askerName: "FNF", open: true }],
    });
    const replying = { ...msg({ body: BLAST, senderUserId: "u-kemal" }), quoted: { id: "3EB0FNFASK", fromMatchTime: true } };
    const res = await run({ messages: [replying], deps: r.deps });
    const out = [...res.outcomes.values()][0];
    expect(out.recruitRequest).toBe(false);
    expect(out.partnerAskRequest ?? null).toBeNull();
    expect(out.reasoning).toMatch(/partner club's ask/);
  });

  // 2026-10-22 (Kemal): a mass DM needs an EXPLICIT @ tag. A swipe-reply
  // to a MatchTime post counts as a tag for an answer (`messageTagsBot`),
  // never for a recruit blast.
  const UNTAGGED_BLAST = "message all players who played in the last 5 matches and invite them";
  it("a swipe-reply to a MatchTime post is not the tag a recruit blast needs", async () => {
    const { model } = stubModel({ [UNTAGGED_BLAST]: BLAST_FACTS });
    const r = recorder(model, paidWorld());
    const replying = {
      ...msg({ body: UNTAGGED_BLAST, senderUserId: "u-kemal", tagged: true, taggedExplicitly: false }),
      quoted: { id: "3EB0SQUAD", fromMatchTime: true },
    };
    const res = await run({ messages: [replying], deps: r.deps });
    const out = [...res.outcomes.values()][0];
    expect(out.recruitRequest).toBe(false);
    expect(out.reply).toBeNull();
    expect(r.dms).toEqual([]);
    expect(out.reasoning).toMatch(/@Match Time tag/i);
  });

  it("the Pi's mention signal is the explicit tag: the blast is reported", async () => {
    const { model } = stubModel({ [UNTAGGED_BLAST]: BLAST_FACTS });
    const r = recorder(model, paidWorld());
    const res = await run({
      messages: [msg({ body: UNTAGGED_BLAST, senderUserId: "u-kemal", tagged: true, taggedExplicitly: true })],
      deps: r.deps,
    });
    expect([...res.outcomes.values()][0].recruitRequest).toBe(true);
  });

  it("a non-admin's ask fires nothing and is not reported as a request", async () => {
    const { model } = stubModel({ [BLAST]: BLAST_FACTS });
    const r = recorder(model, paidWorld());
    const res = await run({
      messages: [msg({ body: BLAST, senderUserId: "u-zair", senderName: fullName("zair") })],
      deps: r.deps,
    });
    expect([...res.outcomes.values()][0].recruitRequest).toBe(false);
  });

  // ⚠️ THIS TEST USED TO READ "an admin needs no tag for it (PR #33)"
  // AND EXPECT `true`. It was inverted on 2026-09-06, deliberately.
  //
  // What changed and why: on the live router, "message everyone from the
  // last 50 games" comes back `admin_ops` 13/20, `question` 4/20, `none`
  // 3/20 over 20 calls. The route was the only gate this action had, so
  // the same untagged message DM'd 20 people on 13 runs and did nothing
  // on the other 7. `recruit-lookback.ts` names the stake: a mass DM
  // from an unofficial WhatsApp client is how the account gets banned,
  // and that takes the whole product down.
  //
  // It is NOT a revert of PR #33. That fix is the recruit SIDE REQUEST
  // on the attendance path (`attendance-engine-batch.ts` still reports
  // `recruitRequest` for an untagged admin whose message carries
  // `sideRequests: ["recruit"]`), which is what the 2026-09-01 incident
  // actually was — "Najib is out. We need one more player." still drops
  // Najib untagged and still blasts, at the bounded default of 5. What
  // is refused here is the EXPLICIT bulk command carrying a model-read
  // lookback: the untagged path may no longer widen a blast.
  //
  // Full argument on `RECRUIT_BLAST_REQUIRES_TAG` in `recruit-request.ts`.
  it("an admin STILL needs a tag for it — the route is not a gate (2026-09-06)", async () => {
    // No "@Match Time" in the body: with it, the message IS explicitly
    // tagged (the Pi writes that text for a real mention), whatever
    // `tagged` says.
    const { model } = stubModel({ [UNTAGGED_BLAST]: BLAST_FACTS });
    const r = recorder(model, paidWorld());
    const res = await run({
      messages: [msg({ body: UNTAGGED_BLAST, senderUserId: "u-kemal", tagged: false })],
      deps: r.deps,
    });
    const out = [...res.outcomes.values()][0];
    expect(out.recruitRequest).toBe(false);
    // Nothing is fired and nothing is said. The refusal is a DECISION,
    // recorded on the row the admin log reads, not a new sentence in the
    // group: untagged silence is what the interaction contract already
    // promises, and a bot that answers "tag me" to every ambiguous line
    // is the nagging §13 exists to prevent.
    expect(r.dms).toEqual([]);
    expect(out.reply).toBeNull();
    expect(out.reasoning).toMatch(/@Match Time tag/i);
  });
});

// ── 5. Fail open, every way it can ─────────────────────────────────────

describe("every failure hands the message back to the analyzer", () => {
  it("a state load that throws owns nothing and says why", async () => {
    const { model } = stubModel({ [PAY]: PAY_FACTS });
    const r = recorder(model, paidWorld(), {
      loadState: async () => {
        throw new Error("pg is down");
      },
    });
    const res = await run({ messages: [msg({ body: PAY })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(res.degradations.join(" ")).toMatch(/state load failed.*pg is down/);
  });

  it("an extractor that throws disowns THAT message", async () => {
    // This asserted /handing this message back to the analyzer/ until
    // §10 step 8 deleted the analyzer. Nothing credits the payment now;
    // the degradation is what `lib/operator-note.ts` prints on the admin
    // DM, so asserting the sentence asserts the operator is told the
    // truth rather than that a message is safe.
    const { model } = stubModel({ [PAY]: PAY_FACTS }, { throwOn: "Amir paid" });
    const r = recorder(model, paidWorld());
    const res = await run({ messages: [msg({ body: PAY })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(r.credits).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/nobody handles this message/);
    expect(res.degradations.join(" ")).not.toMatch(/analyzer/i);
  });

  // CHANGED 2026-09-29. "@Match Time delete these teams, early to form
  // them, there is still 5 days" (Sutton FC, 24 Sep 22:52 BST) came back
  // `other`, and the admin got SILENCE while the early teams stood.
  // Kemal: a tagged request that cannot be handled is answered in one
  // line, never swallowed. (The clear itself is now a deterministic
  // pre-peel in route.ts, `lib/team-clear.ts`; this is the backstop for
  // every other `other`.)
  it('a TAGGED admin action "other" from a player is answered in one line, and nothing is written', async () => {
    const { model } = stubModel({ [PAY]: { ...PAY_FACTS, action: "other" } });
    const r = recorder(model, paidWorld());
    const res = await run({
      messages: [msg({ body: PAY, senderUserId: "u-zair", senderName: fullName("zair") })],
      deps: r.deps,
    });
    expect(res.ownedIds.size).toBe(1);
    const out = [...res.outcomes.values()][0];
    expect(out.reply).toBe("Sorry, I can't do that one yet.");
    expect(out.react).toBeNull();
    expect(out.recruitRequest).toBe(false);
    expect(out.statsBlastRequest).toBe(false);
    expect(r.credits).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/has no deterministic handler/);
  });

  it('the Turkish group hears the "can\'t do that" line in Turkish', async () => {
    const tr = paidWorld();
    const trState = { ...tr, features: { ...tr.features, language: "tr" as const } };
    const { model } = stubModel({ [PAY]: { ...PAY_FACTS, action: "other" } });
    const r = recorder(model, trState);
    const res = await run({
      messages: [msg({ body: PAY, senderUserId: "u-zair", senderName: fullName("zair") })],
      deps: r.deps,
    });
    expect([...res.outcomes.values()][0].reply).toBe("Kusura bakmayın, bunu henüz yapamıyorum.");
  });

  // 2026-09-30, Kemal: schedule changes (block bookings, cancelling a
  // week, kick-off, format, the weekly game) are made in the admin
  // screens, not by WhatsApp command. An ADMIN whose request lands here
  // is pointed at the admin screens instead of a dead end. No model call
  // is added and no prompt changes: this is the same `other` verdict,
  // answered differently for an admin. The link is the public URL: the
  // reply is posted in the group.
  // 2026-10-28, Kemal: this reply now answers ANY admin request MatchTime
  // cannot do (e.g. "switch on the player pool"), so it points at the
  // club's settings page and the general help, not at "help schedule".
  it('a TAGGED "other" from an ADMIN points at the club settings page and "help"', async () => {
    const { model } = stubModel({ [PAY]: { ...PAY_FACTS, action: "other" } });
    const r = recorder(model, paidWorld());
    const res = await run({ messages: [msg({ body: PAY, senderUserId: "u-elvin" })], deps: r.deps });
    const out = [...res.outcomes.values()][0];
    expect(out.reply).toBe(
      "I can't change that by message, but you can do it on your club's settings page in a few taps: https://matchtime.ai/admin/settings\n" +
        "Or ask me: *@Match Time help*",
    );
    expect(r.credits).toEqual([]);
  });

  it("the same for an admin in Turkish", async () => {
    const tr = paidWorld();
    const trState = { ...tr, features: { ...tr.features, language: "tr" as const } };
    const { model } = stubModel({ [PAY]: { ...PAY_FACTS, action: "other" } });
    const r = recorder(model, trState);
    const res = await run({ messages: [msg({ body: PAY, senderUserId: "u-elvin" })], deps: r.deps });
    const reply = [...res.outcomes.values()][0].reply!;
    expect(reply).toBe(
      "Bunu mesajla değiştiremiyorum, ama kulübünüzün ayarlar sayfasından birkaç dokunuşla yapabilirsiniz: https://matchtime.ai/admin/settings\n" +
        "Ya da bana sorun: *@Match Time yardım*",
    );
    expect(reply).not.toContain("program");
    expect(reply).not.toMatch(/[—–]/);
  });

  it('a message that only NAMES MatchTime, without an @-tag, is not answered (2026-09-10 sentence)', async () => {
    const body =
      "please do not forget to rate the players via the link from Matchtime DM'ed to you. " +
      "the more accurate ratings, the more balanced teams next time";
    const { model } = stubModel({ [body]: { ...PAY_FACTS, action: "other" } });
    const r = recorder(model, paidWorld());
    const res = await run({
      messages: [msg({ body, tagged: true, taggedExplicitly: false })],
      deps: r.deps,
    });
    expect(res.ownedIds.size).toBe(0);
  });

  it('an UNTAGGED admin action "other" is still owned by nobody (no reply to banter)', async () => {
    const { model } = stubModel({ [PAY]: { ...PAY_FACTS, action: "other" } });
    const r = recorder(model, paidWorld());
    const res = await run({ messages: [msg({ body: PAY, tagged: false })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(res.degradations.join(" ")).toMatch(/has no deterministic handler/);
  });

  it('an "other" answered in one line does not stop a neighbour\'s payment being credited', async () => {
    const OTHER = "@Match Time do the thing";
    const { model } = stubModel({ [PAY]: PAY_FACTS, [OTHER]: { ...PAY_FACTS, action: "other" } });
    const r = recorder(model, paidWorld());
    const res = await run({
      messages: [msg({ waMessageId: "wa-o", body: OTHER }), msg({ waMessageId: "wa-p", body: PAY })],
      deps: r.deps,
    });
    expect(res.outcomes.get("wa-o")!.reply).toMatch(/^I can't change that by message/);
    expect(r.credits.length).toBeGreaterThan(0);
  });

  it("an engine that throws owns nothing rather than 500ing the request", async () => {
    const { model } = stubModel({ [PAY]: PAY_FACTS });
    const r = recorder(model, paidWorld(), {
      decide: () => {
        throw new Error("coverage violation");
      },
    });
    const res = await run({ messages: [msg({ body: PAY })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(r.credits).toEqual([]);
  });

  it("refuses the WHOLE batch if the engine proposes a write this path cannot apply", async () => {
    const { model } = stubModel({ [PAY]: PAY_FACTS });
    const r = recorder(model, paidWorld(), {
      decide: (input): EngineResult => ({
        outcomes: input.messages.map((m) => ({
          messageId: m.id,
          route: m.route,
          disposition: "acted",
          reasons: [],
          writes: [],
          react: null,
        })),
        writes: [
          {
            kind: "attendance",
            userId: "u-zair",
            name: "Zair Malik",
            status: "CONFIRMED",
            explicitBench: false,
            promote: false,
            sourceMessageId: input.messages[0].id,
            reason: "smuggled",
          },
        ],
        nextState: input.state,
        speech: [],
        degradations: [],
      }),
    });
    const res = await run({ messages: [msg({ body: PAY })], deps: r.deps });
    expect(res.ownedIds.size).toBe(0);
    expect(r.credits).toEqual([]);
    expect(res.degradations.join(" ")).toMatch(/cannot apply \(attendance\)/);
  });
});

// ── 6. The operator's lines ────────────────────────────────────────────

describe("describeAdminOpsBatch", () => {
  it("says nothing when the flag is off and nothing was lost", () => {
    const { info, warns } = describeAdminOpsBatch(
      { ownedIds: new Set(), outcomes: new Map(), degradations: [], cost: { usd: 0, calls: 0, ms: 0 } },
      2,
    );
    expect(info).toBeNull();
    expect(warns).toEqual([]);
  });

  it("speaks up for a batch that owned nothing but LOST something", () => {
    const { info, warns } = describeAdminOpsBatch(
      {
        ownedIds: new Set(),
        outcomes: new Map(),
        degradations: ["extractor died"],
        cost: { usd: 0, calls: 0, ms: 0 },
      },
      2,
    );
    expect(info).toMatch(/decided 0\/2/);
    expect(warns).toEqual(["[analyze] admin-ops-engine degraded: extractor died"]);
  });
});

// ── 7. The apply layer touches no database of its own ──────────────────

describe("the apply layer's dependencies are injected, asserted by scanning it", () => {
  const SRC = fs.readFileSync(path.resolve(__dirname, "..", "admin-ops-engine.ts"), "utf8");

  it("imports neither db nor Prisma", () => {
    expect(SRC).not.toMatch(/from ["']\.\/db["']/);
    expect(SRC).not.toMatch(/@prisma\/client/);
    expect(SRC).not.toMatch(/\bdb\s*\./);
  });

  it("never fires the recruit blast — that is the route's, after the batch", () => {
    expect(SRC).not.toMatch(/inviteRecentPlayers/);
  });
});

// ── 5. The stats blast (2026-09-10) ────────────────────────────────────
//
// The other mass DM, modelled exactly like the recruit blast one block
// up: reported here, fired by the route after the batch. It arrived on
// this path because a regex in `analyze/route.ts` classified it until
// 18:38 on 2026-09-10, when an owner's reminder to his players ("…rate
// the players via the link from Matchtime DM'ed to you. the more
// accurate ratings…") satisfied its three keyword tests from three
// unrelated fragments and queued 69 DMs.

const STATS = "@Match Time send everyone their stats";
const STATS_FACTS = {
  action: "stats_blast",
  payerRef: "",
  count: 0,
  coveredRefs: [],
  phrase: "",
  note: "",
  lookbackMatches: 0,
};

describe("the stats blast is reported, never fired here", () => {
  it("a tagged admin's ask is owned and reported", async () => {
    const { model } = stubModel({ [STATS]: STATS_FACTS });
    const r = recorder(model, paidWorld());
    const res = await run({
      messages: [msg({ body: STATS, senderUserId: "u-kemal", taggedExplicitly: true })],
      deps: r.deps,
    });
    const out = [...res.outcomes.values()][0];
    expect(out.statsBlastRequest).toBe(true);
    expect(out.intent).toBe("stats_blast");
    // Nothing left this path. The route performs the blast, after every
    // write in the batch, and composes the reply from what landed.
    expect(r.dms).toEqual([]);
    expect(out.reply).toBeNull();
  });

  it("a non-admin's ask fires nothing and is not reported as a request", async () => {
    const { model } = stubModel({ [STATS]: STATS_FACTS });
    const r = recorder(model, paidWorld());
    const res = await run({
      messages: [
        msg({
          body: STATS,
          senderUserId: "u-zair",
          senderName: fullName("zair"),
          taggedExplicitly: true,
        }),
      ],
      deps: r.deps,
    });
    expect([...res.outcomes.values()][0].statsBlastRequest).toBe(false);
    expect(r.dms).toEqual([]);
  });

  // e2e/sim/stats-blast.spec.ts:165 (2026-10-30): the refusal is silent by
  // design, and the route can only keep it silent if it is told.
  it("a non-admin's refused ask is recorded as refused; an admin's is not", async () => {
    const { model } = stubModel({ [STATS]: STATS_FACTS });
    const silence = newSilenceFacts();
    await run({
      messages: [
        msg({ waMessageId: "wa-zair", body: STATS, senderUserId: "u-zair", senderName: fullName("zair"), taggedExplicitly: true }),
        msg({ waMessageId: "wa-kemal", body: STATS, senderUserId: "u-kemal", taggedExplicitly: true }),
      ],
      deps: recorder(model, paidWorld()).deps,
      silence,
    });
    expect([...silence.refused]).toEqual(["wa-zair"]);
  });

  it("an ask whose read failed is recorded as a failed read", async () => {
    const { model } = stubModel({ [STATS]: STATS_FACTS }, { throwOn: STATS });
    const silence = newSilenceFacts();
    await run({
      messages: [msg({ waMessageId: "wa-kemal", body: STATS, senderUserId: "u-kemal", taggedExplicitly: true })],
      deps: recorder(model, paidWorld()).deps,
      silence,
    });
    expect([...silence.readFailed]).toEqual(["wa-kemal"]);
  });

  // ⚠️ THE INCIDENT, AT THIS LAYER. `tagged` is TRUE here on purpose:
  // `messageTagsBot` counts the bare word "Matchtime" anywhere in a
  // body, and the sentence that queued 69 DMs contains it. The gate that
  // refuses it is the stricter one — nobody @-mentioned the bot.
  it("refuses a message that only MENTIONS MatchTime, however the model read it", async () => {
    const incident =
      "please do not forget to rate the players via the link from Matchtime DM'ed to you. " +
      "the more accurate ratings, the more balanced teams next time";
    const { model } = stubModel({ [incident]: STATS_FACTS });
    const r = recorder(model, paidWorld());
    const res = await run({
      messages: [
        msg({ body: incident, senderUserId: "u-kemal", tagged: true, taggedExplicitly: false }),
      ],
      deps: r.deps,
    });
    const out = [...res.outcomes.values()][0];
    expect(out.statsBlastRequest).toBe(false);
    expect(r.dms).toEqual([]);
    expect(out.reply).toBeNull();
    expect(out.reasoning).toMatch(/@Match Time tag/i);
  });
});

// CHANGED 2026-10-23 (Kemal). Friday MT Community, 23 Oct: "@Match Time
// cancel the match" from Kemal, an owner, routed admin_ops, extracted
// `cancel_match`, and was answered as `other` ("I can't change that by
// message..."). A club with no admin group now cancels here through the one
// core (`match-cancel.ts`); a club with one is pointed there (that decision
// is `playersGroupCancelOrRestore`'s, tested in match-cancel.test.ts).
describe("cancelling a match from the players' group (2026-10-23)", () => {
  const CANCEL = "@Match Time cancel the match";
  const CANCEL_FACTS = { ...BLAST_FACTS, action: "cancel_match", lookbackMatches: 0, matchDay: "" };
  type CancelCall = { orgId: string; lang: string | null; mode: string; dayPhrase: string | null; pastGame?: boolean; organiser: boolean; now: Date };

  function cancelRecorder(answer = { outcome: "match_cancelled", replyText: null as string | null, react: "✅" as string | null }) {
    const calls: CancelCall[] = [];
    return {
      calls,
      dep: async (a: CancelCall) => {
        calls.push(a);
        return answer;
      },
    };
  }

  it("the incident: an owner's tagged cancel reaches the one cancel core, not the admin-page dead end", async () => {
    const { model } = stubModel({ [CANCEL]: CANCEL_FACTS });
    const c = cancelRecorder();
    const r = recorder(model, paidWorld(), { cancelOrRestore: c.dep });
    const res = await run({ messages: [msg({ body: CANCEL, senderUserId: "u-kemal" })], deps: r.deps });
    expect(c.calls).toEqual([{ orgId: "org-1", lang: "en", mode: "cancel", dayPhrase: null, pastGame: false, organiser: true, now: NOW }]);
    const out = res.outcomes.get(`wa-${CANCEL.slice(0, 14)}`)!;
    expect(res.ownedIds.has(out.waMessageId)).toBe(true);
    expect(out.reply).toBeNull();
    expect(out.react).toBe("✅");
    expect(out.intent).toBe("match_cancelled");
    expect(out.action).toBe("cancel_match");
    expect(r.marked).toEqual([]);
    expect(r.credits).toEqual([]);
    expect(r.dms).toEqual([]);
  });

  it("a game that did not happen (2026-10-28): pastGame reaches the one core, and its reply and tick go out", async () => {
    const GONE = "@Match Time Tuesday's game didn't happen";
    const { model } = stubModel({ [GONE]: { ...CANCEL_FACTS, action: "cancel_match", matchDay: "Tuesday", pastGame: true } });
    const c = cancelRecorder({ outcome: "match_not_played", replyText: "Done. Tuesday 5-a-side on 27 Oct is marked as not played: no score, ratings or Man of the Match for it.", react: "✅" });
    const r = recorder(model, paidWorld(), { cancelOrRestore: c.dep });
    const res = await run({ messages: [msg({ body: GONE, senderUserId: "u-kemal" })], deps: r.deps });
    expect(c.calls[0]).toMatchObject({ mode: "cancel", dayPhrase: "Tuesday", pastGame: true, organiser: true });
    const out = [...res.outcomes.values()][0];
    expect(out.react).toBe("✅");
    expect(out.reply).toContain("marked as not played");
  });

  it("an owner's undo is a restore, with the day as the extractor wrote it", async () => {
    const BACK = "@Match Time Friday is back on";
    const { model } = stubModel({ [BACK]: { ...CANCEL_FACTS, action: "restore_match", matchDay: "Friday" } });
    const c = cancelRecorder({ outcome: "match_restored", replyText: null, react: "✅" });
    const r = recorder(model, paidWorld(), { cancelOrRestore: c.dep });
    const res = await run({ messages: [msg({ body: BACK, senderUserId: "u-kemal" })], deps: r.deps });
    expect(c.calls[0]).toMatchObject({ mode: "restore", dayPhrase: "Friday", organiser: true });
    expect([...res.outcomes.values()][0].react).toBe("✅");
  });

  it("a player who is not an owner or admin: the core is told so, and its line is the reply", async () => {
    const { model } = stubModel({ [CANCEL]: CANCEL_FACTS });
    const c = cancelRecorder({ outcome: "match_cancel_organisers_only", replyText: "Only Kemal can change that.", react: null });
    const r = recorder(model, paidWorld(), { cancelOrRestore: c.dep });
    const res = await run({ messages: [msg({ body: CANCEL, senderUserId: "u-sait", senderName: fullName("sait") })], deps: r.deps });
    expect(c.calls[0].organiser).toBe(false);
    const out = [...res.outcomes.values()][0];
    expect(out.reply).toBe("Only Kemal can change that.");
    expect(out.react).toBeNull();
  });

  it("untagged, or only NAMING MatchTime: nothing new, the core is never reached", async () => {
    for (const m of [
      msg({ body: CANCEL, senderUserId: "u-kemal", tagged: false }),
      msg({ body: CANCEL, senderUserId: "u-kemal", tagged: true, taggedExplicitly: false }),
    ]) {
      const { model } = stubModel({ [CANCEL]: CANCEL_FACTS });
      const c = cancelRecorder();
      const r = recorder(model, paidWorld(), { cancelOrRestore: c.dep });
      const res = await run({ messages: [m], deps: r.deps });
      expect(c.calls).toEqual([]);
      expect(res.outcomes.size).toBe(0);
    }
  });

  it("the core threw: owned, silent, reported", async () => {
    const { model } = stubModel({ [CANCEL]: CANCEL_FACTS });
    const r = recorder(model, paidWorld(), {
      cancelOrRestore: async () => {
        throw new Error("db down");
      },
    });
    const res = await run({ messages: [msg({ body: CANCEL, senderUserId: "u-kemal" })], deps: r.deps });
    const out = [...res.outcomes.values()][0];
    expect(out.reply).toBeNull();
    expect(out.react).toBeNull();
    expect(out.writeFailed).toBe(true);
    expect(res.degradations.join(" ")).toMatch(/db down/);
  });

  it("the engine and the analyze route never reach the cancel code; this batch only through the one door", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["src/lib/pipeline/engine.ts", "src/app/api/whatsapp/analyze/route.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/match-cancel["']/);
    }
    const batch = readFileSync("src/lib/admin-ops-engine-batch.ts", "utf8");
    expect(batch).not.toMatch(/cancelMatchById|restoreMatchById/);
  });
});

// ── 2026-10-28 (Kemal): "try again" after a refusal, and "set the pitch",
// by an owner or admin tagging MatchTime in the players' group of a club
// with no admin group. MT Test 15:40 UTC: "@Match Time added the venue
// location" was read `other` and got "I can't change that by message".

describe("try again after a refusal", () => {
  const RETRY = "@Match Time added the venue location";
  const RETRY_FACTS = { ...BLAST_FACTS, action: "retry_ask", lookbackMatches: 0, playersFrom: [], clubRef: "", toMatchTime: true };
  const ASKED: StoredAsk = { facts: { kind: "admin", action: "recruit", partnerClubs: true, pool: true, toMatchTime: true }, at: new Date(NOW.getTime() - 2 * 60_000) };

  const outcomeOf = async (over: Partial<AdminOpsBatchDeps>, m: Partial<AdminOpsBatchMessage> = {}) => {
    const { model } = stubModel({ [RETRY]: RETRY_FACTS });
    const r = recorder(model, paidWorld());
    const seen: string[] = [];
    const res = await run({
      messages: [msg({ body: RETRY, senderUserId: "u-kemal", senderName: fullName("kemal"), taggedExplicitly: true, ...m })],
      deps: { ...r.deps, onlyOrganisersLine: async () => "Only Kemal can change that.", ...over, latestAskForRetry: async (a) => (seen.push(a.where), over.latestAskForRetry ? over.latestAskForRetry(a) : null) },
    });
    return { out: res.outcomes.get(`wa-${RETRY.slice(0, 14)}`), dms: r.dms, seen, res };
  };

  it("repeats the organisers' stored ask: the partner clubs and the pool, for the batch-final pass", async () => {
    const { out, dms, seen } = await outcomeOf({ latestAskForRetry: async () => ASKED });
    expect(seen).toEqual(["group"]);
    expect(out?.partnerAskRequest).toEqual({ clubRef: null, matchId: expect.any(String) });
    expect(out?.poolAskRequest).toEqual({ matchId: expect.any(String) });
    expect(out?.recruitRequest).toBe(false);
    expect(out?.reasoning).toMatch(/retry_ask/);
    expect(dms).toEqual([]);
  });

  it("nothing stored to repeat: one short line, never the generic \"can't change that\"", async () => {
    const { out } = await outcomeOf({ latestAskForRetry: async () => null });
    expect(out?.reply).toBe("👍 Thanks. There's nothing of mine waiting to try again.");
    expect(out?.partnerAskRequest).toBeNull();
    expect(out?.poolAskRequest).toBeNull();
    expect(out?.reply).not.toMatch(/can't change that/);
  });

  it("a player who is not an organiser: the one line naming who can, nothing repeated", async () => {
    const { out, seen } = await outcomeOf({ latestAskForRetry: async () => ASKED }, { senderUserId: "u-zair", senderName: fullName("zair") });
    expect(out?.reply).toBe("Only Kemal can change that.");
    expect(out?.intent).toBe("organisers_only");
    expect(out?.poolAskRequest).toBeNull();
    expect(seen).toEqual([]);
  });

  it("untagged: the players' chat, nothing said and nothing repeated", async () => {
    const { out, seen } = await outcomeOf({ latestAskForRetry: async () => ASKED }, { tagged: false, taggedExplicitly: false });
    expect(out?.reply ?? null).toBeNull();
    expect(out?.poolAskRequest ?? null).toBeNull();
    expect(seen).toEqual([]);
  });
});

describe("set the pitch by WhatsApp", () => {
  const PITCH = "@Match Time our pitch is Goals Sutton";
  const PITCH_FACTS = { ...BLAST_FACTS, action: "set_venue", lookbackMatches: 0, playersFrom: [], clubRef: "", venueName: "Goals Sutton", venueChoice: 0, toMatchTime: true };

  const outcomeOf = async (m: Partial<AdminOpsBatchMessage> = {}, facts: Record<string, unknown> = PITCH_FACTS) => {
    const { model } = stubModel({ [PITCH]: facts });
    const r = recorder(model, paidWorld());
    const calls: Array<{ words: string | null; choice: number | null; userId: string }> = [];
    const res = await run({
      messages: [msg({ body: PITCH, senderUserId: "u-kemal", senderName: fullName("kemal"), taggedExplicitly: true, ...m })],
      deps: {
        ...r.deps,
        onlyOrganisersLine: async () => "Only Kemal can change that.",
        setVenueFromWords: async (a) => (calls.push({ words: a.words, choice: a.choice, userId: a.userId }), { outcome: "venue-set", replyText: "📍 Done, your pitch is *Goals Sutton*, Oxford Rd.", set: true }),
      },
    });
    return { out: res.outcomes.get(`wa-${PITCH.slice(0, 14)}`), calls };
  };

  it("an organiser: looked up and set, and the reply names it", async () => {
    const { out, calls } = await outcomeOf();
    expect(calls).toEqual([{ words: "Goals Sutton", choice: null, userId: "u-kemal" }]);
    expect(out?.reply).toContain("*Goals Sutton*");
    expect(out?.intent).toBe("venue-set");
  });

  it("a number picked from MatchTime's list is passed on", async () => {
    const { calls } = await outcomeOf({}, { ...PITCH_FACTS, venueChoice: 2 });
    expect(calls[0].choice).toBe(2);
  });

  it("a player who is not an organiser: the one line naming who can, nothing looked up", async () => {
    const { out, calls } = await outcomeOf({ senderUserId: "u-zair", senderName: fullName("zair") });
    expect(out?.reply).toBe("Only Kemal can change that.");
    expect(calls).toEqual([]);
  });

  it("untagged: nothing looked up, nothing said", async () => {
    const { out, calls } = await outcomeOf({ tagged: false, taggedExplicitly: false });
    expect(out?.reply ?? null).toBeNull();
    expect(calls).toEqual([]);
  });
});
