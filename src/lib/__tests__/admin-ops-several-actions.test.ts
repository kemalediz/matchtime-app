/**
 * SEVERAL ADMIN ACTIONS IN ONE MESSAGE, CARRIED OUT IN ORDER (Sutton FC,
 * 2026-11-23 14:44).
 *
 * "@Match Time switch to 5aside, then invite local player pool for the
 * remaining slots": the switch was done, the pool never asked, and nothing
 * was said about it. The admin extractor now reports both actions
 * (`AdminFacts.then`); the admin owner does each one in the order asked,
 * each through every gate it has alone, each seeing the state the one
 * before left (the state is read again), and the message gets ONE outcome:
 * one reply, the asks of every action for the batch-final pass. A step
 * that did nothing is named in that reply, never dropped.
 *
 * The model is stubbed ($0).
 */
import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelResponse, PipelineModel } from "../pipeline/llm";
import type { Route, SquadState } from "../pipeline/types";
import { NOW, fullName, world } from "../pipeline/__tests__/helpers";
import { t } from "../i18n/t";
import type { OrganisersOnlyKind } from "../organisers-only-kind";
import { runAdminOpsBatch, type AdminOpsBatchDeps, type AdminOpsBatchMessage } from "../admin-ops-engine-batch";

const BODY = "@Match Time switch to 5aside, then invite local player pool for the remaining slots";
const BODY_TR = "@Match Time 5'e 5 yap, sonra kalan yerler için havuzdan oyuncu çağır";

const step = (o: Record<string, unknown>) => ({
  words: "",
  payerRef: "",
  count: 0,
  coveredRefs: [],
  phrase: "",
  note: "",
  lookbackMatches: 0,
  playersFrom: [],
  clubRef: "",
  size: 0,
  aSide: false,
  ...o,
});
const SWITCH_5 = step({ action: "switch_format", words: "switch to 5aside", size: 5, aSide: true });
const POOL = step({ action: "recruit", words: "invite local player pool for the remaining slots", playersFrom: ["pool"] });

function stubModel(table: Record<string, unknown>) {
  const calls: string[] = [];
  const model: PipelineModel = {
    name: "test-stub",
    async complete(req: ModelRequest): Promise<ModelResponse> {
      const body = req.user.split("\n").slice(-1)[0];
      calls.push(`${req.label}|${body}`);
      const payload = table[body];
      if (payload === undefined) throw new Error(`no stub for "${body}"`);
      return {
        text: JSON.stringify(payload),
        stopReason: "end_turn",
        usage: { inputTokens: 900, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.0013,
        ms: 600,
      };
    },
  };
  return { model, calls };
}

const onlyKemal = async (_o: string, lang: string | null, kind?: OrganisersOnlyKind) => t(lang).hq_only_organisers({ names: "Kemal", kind });

/** Seven confirmed for a 14-place game, Kemal the admin. */
const SEVEN = ["kemal", "elvin", "sait", "amir", "zair", "faris", "adam"];

function deps(model: PipelineModel, log: string[], over: Partial<AdminOpsBatchDeps> = {}, lang: "en" | "tr" = "en"): AdminOpsBatchDeps {
  let size = 14;
  return {
    model,
    loadState: async (): Promise<SquadState> => {
      log.push(`loadState@${size}`);
      const s = world({ confirmed: SEVEN, maxPlayers: size });
      return { ...s, features: { ...s.features, language: lang } };
    },
    reminderMutedUserIds: async () => [],
    gamesToCome: async () => [],
    loadPaidState: async () => ({ matchName: "Tuesday", confirmed: [], creditTotal: 0 }),
    markPaid: async () => undefined,
    createPaymentCredit: async () => undefined,
    loadPhone: async () => "+447700900000",
    queueReminderDm: async () => undefined,
    onlyOrganisersLine: onlyKemal,
    applySwitchFormatWords: async (a) => {
      size = a.perSide * 2;
      log.push(`switch ${a.perSide}`);
      return { outcome: "format-switched-activity", replyText: "✅ Done: Tuesday is 5-a-side now, 10 places. I've posted the new list.", matchId: "m-1" };
    },
    ...over,
  };
}

function msg(body: string, o: Partial<AdminOpsBatchMessage> = {}): AdminOpsBatchMessage {
  return {
    waMessageId: "wa-1",
    body,
    authorName: fullName("kemal"),
    senderUserId: "u-kemal",
    senderName: fullName("kemal"),
    tagged: true,
    taggedExplicitly: true,
    route: "admin_ops",
    gated: false,
    ...o,
  };
}

async function run(body: string, facts: unknown, o: { m?: Partial<AdminOpsBatchMessage>; over?: Partial<AdminOpsBatchDeps>; lang?: "en" | "tr"; partOfSeveral?: boolean } = {}) {
  const { model, calls } = stubModel({ [body]: facts });
  const log: string[] = [];
  const res = await runAdminOpsBatch({
    orgId: "org-1",
    now: NOW,
    messages: [msg(body, o.m)],
    history: [],
    enabled: new Set<Route>(["admin_ops"]),
    deps: deps(model, log, o.over, o.lang),
    ...(o.partOfSeveral ? { partOfSeveral: true } : {}),
  });
  return { res, out: res.outcomes.get("wa-1"), log, calls };
}

describe("several admin actions in one message", () => {
  it("the Sutton message: switched first, then the pool asked against the new size; ONE outcome, ONE extractor call", async () => {
    const { res, out, log, calls } = await run(BODY, { toMatchTime: true, actions: [SWITCH_5, POOL] });
    // In order, and the pool step reads the state the switch left.
    expect(log).toEqual(["loadState@14", "switch 5", "loadState@10"]);
    expect(calls).toHaveLength(1);
    expect(res.ownedIds.has("wa-1")).toBe(true);
    expect(out?.reply).toBe("✅ Done: Tuesday is 5-a-side now, 10 places. I've posted the new list.");
    // The pool is asked by the batch-final pass, after every write.
    expect(out?.poolAskRequest).toEqual({ matchId: expect.any(String) });
    expect(out?.switchedMatchId).toBe("m-1");
    expect(out?.intent).toBe("format-switched-activity+pool_ask");
    expect(out?.writeFailed).toBe(false);
    expect(res.cost.calls).toBe(1);
  });

  it("Turkish: the same two steps", async () => {
    const { out, log } = await run(BODY_TR, { toMatchTime: true, actions: [SWITCH_5, POOL] }, { lang: "tr" });
    expect(log).toEqual(["loadState@14", "switch 5", "loadState@10"]);
    expect(out?.poolAskRequest).not.toBeNull();
  });

  it("each step keeps its own gate: a player who is not an organiser hears who can, once, and nothing is done", async () => {
    const { out, log } = await run(BODY, { toMatchTime: true, actions: [SWITCH_5, POOL] }, { m: { senderUserId: "u-zair", senderName: fullName("zair"), authorName: fullName("zair") } });
    expect(log.filter((l) => l.startsWith("switch"))).toEqual([]);
    expect(out?.poolAskRequest).toBeNull();
    // Each step's own refusal, in order, and no not-done line beside them.
    expect(out?.reply).toBe("Only Kemal can change that.\n\nOnly Kemal can ask for players.");
  });

  it("a step MatchTime has no action for is named in the one reply, in the sender's words, never dropped", async () => {
    const CANCEL = step({ action: "cancel_match", words: "cancel Friday", matchDay: "Friday" });
    const OTHER = step({ action: "other", words: "tell the bench" });
    const body = "@Match Time cancel Friday and tell the bench";
    const { out } = await run(body, { toMatchTime: true, actions: [CANCEL, OTHER] }, {
      over: { cancelOrRestore: async () => ({ outcome: "match-cancelled", replyText: "❌ Friday's game is cancelled.", react: null }) },
    });
    expect(out?.reply).toBe(`❌ Friday's game is cancelled.\n\n${"I couldn't do this part of your message: \"tell the bench\". Please ask me for it on its own."}`);
    // Not a dead end: the cancel was done, so no unified answer replaces the reply.
    expect(out?.intent).not.toBe("request_not_handled");
    expect(out?.deadEndWhy).toBeUndefined();
  });

  it("a later step that is not done because it threw is named too, and the first step's reply stands", async () => {
    const QUIET = step({ action: "quiet_hours", words: "turn off quiet hours", quietOff: true });
    const { out } = await run(BODY, { toMatchTime: true, actions: [SWITCH_5, QUIET] }, {
      over: { applyQuietHoursWords: async () => { throw new Error("db down"); } },
    });
    expect(out?.reply).toMatch(/^✅ Done: Tuesday is 5-a-side now/);
    expect(out?.reply).toContain("\"turn off quiet hours\"");
  });

  // The live run of 2026-11-23: the size came back with no "a side", the
  // switch asked "How many a side?", and the pool was then asked for 7
  // places at the OLD size. A later action never runs on a change that did
  // not happen.
  it("an earlier action that did not go through (the switch asked how many a side): the pool is NOT asked, and is named", async () => {
    const { out, log } = await run(BODY, { toMatchTime: true, actions: [SWITCH_5, POOL] }, {
      over: { applySwitchFormatWords: async () => ({ outcome: "format-no-size", replyText: "How many a side? For example *@Match Time make it 8 a side*." }) },
    });
    expect(log).toEqual(["loadState@14"]);
    expect(out?.poolAskRequest).toBeNull();
    expect(out?.reply).toBe(
      "How many a side? For example *@Match Time make it 8 a side*.\n\n" +
        "I couldn't do this part of your message: \"invite local player pool for the remaining slots\". Please ask me for it on its own.",
    );
  });

  it("an 'other' first neither runs nor blocks: the switch after it is done", async () => {
    const OTHER = step({ action: "other", words: "order new bibs" });
    const { out, log } = await run("@Match Time order new bibs and make it 5 aside", { toMatchTime: true, actions: [OTHER, SWITCH_5] });
    expect(log).toContain("switch 5");
    expect(out?.reply).toMatch(/^✅ Done: Tuesday is 5-a-side now/);
    expect(out?.reply).toContain('"order new bibs"');
  });

  it("Turkish not-done line", async () => {
    const CANCEL = step({ action: "cancel_match", words: "cumayı iptal et", matchDay: "cuma" });
    const OTHER = step({ action: "other", words: "yedeklere haber ver" });
    const body = "@Match Time cumayı iptal et ve yedeklere haber ver";
    const { out } = await run(body, { toMatchTime: true, actions: [CANCEL, OTHER] }, {
      lang: "tr",
      over: { cancelOrRestore: async () => ({ outcome: "match-cancelled", replyText: "❌ İptal.", react: null }) },
    });
    expect(out?.reply).toBe("❌ İptal.\n\nMesajındaki şu kısmı yapamadım: \"yedeklere haber ver\". Lütfen bunu ayrı bir mesajla iste.");
  });

  it("untagged: nothing done and nothing said for any step (the interaction contract)", async () => {
    const { out, log } = await run(BODY.replace("@Match Time ", ""), { toMatchTime: false, actions: [SWITCH_5, POOL] }, { m: { tagged: false, taggedExplicitly: false } });
    expect(log.filter((l) => l.startsWith("switch"))).toEqual([]);
    expect(out?.reply ?? null).toBeNull();
    expect(out?.poolAskRequest ?? null).toBeNull();
  });

  it("one part of several (partOfSeveral): every step runs with it", async () => {
    const seen: Array<boolean | undefined> = [];
    const { out } = await run(BODY, { toMatchTime: true, actions: [SWITCH_5, POOL] }, {
      partOfSeveral: true,
      over: { applySwitchFormatWords: async (a) => (seen.push(a.groupList), { outcome: "format-switched", replyText: "✅ Done.", matchId: "m-1" }) },
    });
    expect(seen).toEqual([false]);
    expect(out?.poolAskRequest).not.toBeNull();
  });

  // Review of #629, item 6: "make Thursday 5 a side, then ask the pool" when
  // the next game is Monday: the pool is asked for the game the switch changed.
  it("the pool after a switch of another game: the ask is for the game the switch changed", async () => {
    const { out } = await run(BODY, { toMatchTime: true, actions: [{ ...SWITCH_5, matchDay: "Thursday" }, POOL] }, {
      over: { applySwitchFormatWords: async () => ({ outcome: "format-switched", replyText: "✅ Done: Thursday is 5-a-side now, 10 places.", matchId: "m-thu" }) },
    });
    expect(out?.poolAskRequest).toEqual({ matchId: "m-thu" });
  });

  // Review of #629, item 7: an "other" action is named, never run, and
  // leaves no "no deterministic handler" line on the operator note.
  it("an 'other' action leaves no operator-note noise, first or later", async () => {
    const OTHER = step({ action: "other", words: "order new bibs" });
    for (const actions of [[SWITCH_5, OTHER], [OTHER, SWITCH_5]]) {
      const { res, out } = await run(BODY, { toMatchTime: true, actions });
      expect(res.degradations.join(" ")).not.toMatch(/no deterministic handler/);
      expect(out?.reply).toContain('"order new bibs"');
    }
  });

  // Review of #629, item 5: a message whose match change is not its first
  // action still counts as a match change for the batch's order.
  it("applyNow is told a match change when ANY action of the message is one", async () => {
    const QUIET = step({ action: "quiet_hours", words: "turn off quiet hours", quietOff: true });
    const { model } = stubModel({ [BODY]: { toMatchTime: true, actions: [QUIET, SWITCH_5] } });
    const seen: Array<[string, string]> = [];
    await runAdminOpsBatch({
      orgId: "org-1",
      now: NOW,
      messages: [msg(BODY)],
      history: [],
      enabled: new Set<Route>(["admin_ops"]),
      deps: deps(model, []),
      applyNow: (actions) => {
        seen.push(...actions);
        return new Set();
      },
    });
    expect(seen).toEqual([["wa-1", "switch_format"]]);
  });

  it("one action is exactly as before: one state read, one outcome", async () => {
    const { out, log } = await run("@Match Time make it 5 aside", { toMatchTime: true, actions: [SWITCH_5] });
    expect(log).toEqual(["loadState@14", "switch 5"]);
    expect(out?.intent).toBe("format-switched-activity");
  });
});
