/**
 * SEVERAL INSTRUCTIONS IN ONE MESSAGE (2026-11-16, Vets).
 *
 * "@Match Time switch to 7aside, take Luca to bench, @Zak is IN and then
 * make the teams" got one route, other_att, and two of its four parts were
 * dropped without a word. These pin the router's `also` list as code reads
 * it: who answers, the order the parts are done in, and that a message
 * with ONE instruction is exactly what it was.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { byRank, matchChangesFirst, orderedRoutes, settleRoutes } from "../multi-route";
import { parseRouterResponse, routeBatch } from "../router";
import { gateBatch, ROUTER_STUB_FILE_ENV } from "../gate";
import type { PipelineModel } from "../llm";
import type { Route } from "../types";
import { notDoneLine, partOf, partsNotDone } from "../../multi-instruction-reply";
import { joinHqParts } from "../../admin-group-understand";

const row = (id: string, route: string, extra: Record<string, unknown> = {}) => ({ id, route, to_bot: false, pasted_list: false, ...extra });
const answer = (...rows: Array<Record<string, unknown>>) => JSON.stringify({ routes: rows });

describe("settleRoutes: the router's route always answers; the other parts in order", () => {
  it("one instruction: the router's route, nothing else", () => {
    for (const r of ["self_att", "other_att", "question", "balancer", "admin_ops", "score", "none", "unsure"] as Route[]) {
      expect(settleRoutes(r, [])).toEqual({ route: r, alsoRoutes: [] });
    }
  });

  it("the incident: the place answers; the format, then the teams", () => {
    expect(settleRoutes("other_att", ["balancer", "admin_ops"])).toEqual({ route: "other_att", alsoRoutes: ["admin_ops", "balancer"] });
  });

  it("also NEVER changes the route (review of #613)", () => {
    expect(settleRoutes("admin_ops", ["other_att", "balancer"])).toEqual({ route: "admin_ops", alsoRoutes: ["other_att", "balancer"] });
    expect(settleRoutes("balancer", ["self_att"])).toEqual({ route: "balancer", alsoRoutes: ["self_att"] });
    expect(settleRoutes("question", ["admin_ops"])).toEqual({ route: "question", alsoRoutes: ["admin_ops"] });
  });

  it("a none message is chat: it has no other parts", () => {
    expect(settleRoutes("none", ["balancer", "admin_ops"])).toEqual({ route: "none", alsoRoutes: [] });
    expect(settleRoutes("none", ["unsure"])).toEqual({ route: "none", alsoRoutes: [] });
  });

  it("none and unsure are never parts; the owner's own kind counts once", () => {
    expect(settleRoutes("other_att", ["none", "unsure"])).toEqual({ route: "other_att", alsoRoutes: [] });
    expect(settleRoutes("balancer", ["unsure"])).toEqual({ route: "balancer", alsoRoutes: [] });
    expect(settleRoutes("other_att", ["self_att", "offer"])).toEqual({ route: "other_att", alsoRoutes: [] });
    expect(settleRoutes("question", ["help"])).toEqual({ route: "question", alsoRoutes: [] });
    expect(settleRoutes("other_att", ["balancer", "balancer"])).toEqual({ route: "other_att", alsoRoutes: ["balancer"] });
  });
});

describe("orderedRoutes: a YES first, then the format, who plays, the teams, the rest", () => {
  it("orders every part of a message", () => {
    expect(orderedRoutes({ route: "other_att", alsoRoutes: ["balancer", "question", "admin_ops"] })).toEqual([
      "admin_ops",
      "other_att",
      "balancer",
      "question",
    ]);
  });
  it("a YES to what MatchTime is waiting for runs before the teams and the squad (review of #613)", () => {
    expect(orderedRoutes({ route: "balancer", alsoRoutes: ["approve"] })).toEqual(["approve", "balancer"]);
    expect(orderedRoutes({ route: "other_att", alsoRoutes: ["balancer", "approve", "admin_ops"] })).toEqual([
      "approve",
      "admin_ops",
      "other_att",
      "balancer",
    ]);
  });
  it("a single instruction is just its route", () => {
    expect(orderedRoutes({ route: "balancer" })).toEqual(["balancer"]);
  });
  it("is stable among routes of one rank", () => {
    expect(byRank(["poster", "team_sheet"])).toEqual(["poster", "team_sheet"]);
  });
});

describe("parseRouterResponse reads `also`", () => {
  it("the incident's answer: one owner, two other parts, in order", () => {
    const out = parseRouterResponse(answer(row("m1", "other_att", { to_bot: true, also: ["balancer", "admin_ops"] })), ["m1"]);
    expect(out.routes).toEqual([
      { messageId: "m1", route: "other_att", source: "model", toBot: true, alsoRoutes: ["admin_ops", "balancer"] },
    ]);
    expect(out.degradations).toEqual([]);
  });

  it("ONE INSTRUCTION IS BYTE FOR BYTE WHAT IT WAS: `also: []` reads exactly as an answer with no `also` (a trace from before)", () => {
    const sample: Array<[string, Record<string, unknown>]> = [
      ["self_att", {}],
      ["other_att", { to_bot: true }],
      ["offer", {}],
      ["question", { to_bot: true }],
      ["balancer", { to_bot: true }],
      ["score", {}],
      ["admin_ops", { to_bot: true }],
      ["unsure", {}],
      ["none", {}],
      ["other_att", { pasted_list: true }],
      ["help", { to_bot: true }],
    ];
    for (const [route, extra] of sample) {
      const before = parseRouterResponse(answer(row("m1", route, extra)), ["m1"]);
      const after = parseRouterResponse(answer(row("m1", route, { ...extra, also: [] })), ["m1"]);
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
      expect(after.routes[0]).not.toHaveProperty("alsoRoutes");
    }
  });

  it("an also that only repeats the route adds nothing", () => {
    const out = parseRouterResponse(answer(row("m1", "balancer", { also: ["balancer"] })), ["m1"]);
    expect(out.routes[0]).not.toHaveProperty("alsoRoutes");
  });

  it("an unknown also route is dropped and said; the route stands", () => {
    const out = parseRouterResponse(answer(row("m1", "other_att", { also: ["teleport", "balancer"] })), ["m1"]);
    expect(out.routes[0]).toMatchObject({ route: "other_att", alsoRoutes: ["balancer"] });
    expect(out.degradations.map((d) => d.detail)).toEqual(['router returned an unknown also route "teleport"; dropped']);
  });

  it("an organisers' route as an also part of a players' group message is dropped; in HQ it stands", () => {
    const players = parseRouterResponse(answer(row("m1", "other_att", { also: ["ask_group"] })), ["m1"]);
    expect(players.routes[0]).not.toHaveProperty("alsoRoutes");
    expect(players.degradations).toHaveLength(1);
    const hq = parseRouterResponse(answer(row("m1", "other_att", { also: ["ask_group"] })), ["m1"], new Set(["m1"]));
    expect(hq.routes[0].alsoRoutes).toEqual(["ask_group"]);
  });

  it("help as an also part in the players' group is the question extractor's, as for a route", () => {
    const out = parseRouterResponse(answer(row("m1", "self_att", { also: ["help"] })), ["m1"]);
    expect(out.routes[0].alsoRoutes).toEqual(["question"]);
  });

  it("a missing route still falls back to unsure, with no also", () => {
    const out = parseRouterResponse(answer(), ["m1"]);
    expect(out.routes[0]).toEqual({ messageId: "m1", route: "unsure", source: "fallback" });
  });
});

function fixed(text: string): PipelineModel {
  return {
    name: "fixed",
    async complete() {
      return { text, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 };
    },
  };
}

describe("routeBatch with `also`", () => {
  it("maps the short ids back to the real ones and keeps the other parts", async () => {
    const res = await routeBatch(fixed(answer(row("m1", "other_att", { also: ["admin_ops", "balancer"] }), row("m2", "self_att"))), [
      { id: "wa-AAA", authorName: "Ava", body: "@Match Time switch to 7aside, take Luca to bench, Zak is IN and make the teams" },
      { id: "wa-BBB", authorName: "Ben", body: "in" },
    ]);
    expect(res.routes).toEqual([
      { messageId: "wa-AAA", route: "other_att", source: "model", alsoRoutes: ["admin_ops", "balancer"] },
      { messageId: "wa-BBB", route: "self_att", source: "model" },
    ]);
  });

  it("at the daily AI cap only attendance is handled: the other parts are dropped and said", async () => {
    const res = await routeBatch(fixed(answer(row("m1", "other_att", { also: ["admin_ops", "balancer"] }))), [{ id: "wa-AAA", authorName: "Ava", body: "x" }], { capped: true });
    expect(res.routes).toEqual([{ messageId: "wa-AAA", route: "other_att", source: "model" }]);
    expect(res.degradations.map((d) => d.detail)).toContain("also admin_ops, balancer at the daily AI cap; not handled");
  });
});

describe("the router stub carries `also` (a list is the route then its other parts)", () => {
  const prev = process.env[ROUTER_STUB_FILE_ENV];
  afterEach(() => {
    if (prev === undefined) delete process.env[ROUTER_STUB_FILE_ENV];
    else process.env[ROUTER_STUB_FILE_ENV] = prev;
  });

  it("by body", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mt-router-stub-"));
    const file = path.join(dir, "router.json");
    const body = "@Match Time switch to 7aside, take Luca to bench, Zak is IN and make the teams";
    writeFileSync(file, JSON.stringify({ bodies: { [body]: ["other_att", "admin_ops", "balancer"], in: "self_att" } }));
    process.env[ROUTER_STUB_FILE_ENV] = file;
    const g = await gateBatch([
      { waMessageId: "wa-1", body, authorName: "Ava" },
      { waMessageId: "wa-2", body: "in", authorName: "Ben" },
    ]);
    expect(g.routes).toEqual([
      { messageId: "wa-1", route: "other_att", source: "model", alsoRoutes: ["admin_ops", "balancer"] },
      { messageId: "wa-2", route: "self_att", source: "model" },
    ]);
  });
});

describe("the line naming a part not done", () => {
  it("names nothing when every part was done", () => {
    expect(partsNotDone(["admin_ops", "balancer"], new Set<Route>(["admin_ops", "balancer"]))).toEqual([]);
    expect(notDoneLine([], "en")).toBeNull();
  });
  it("one part, and several, in English and in Turkish", () => {
    expect(notDoneLine(["balancer"], "en")).toBe("I couldn't do this part of your message: the teams. Please ask me for it on its own.");
    expect(notDoneLine(["admin_ops", "balancer"], "en")).toBe(
      "I couldn't do these parts of your message: the setting change and the teams. Please ask me for them one at a time.",
    );
    expect(notDoneLine(["balancer"], "tr")).toBe("Mesajındaki şu kısmı yapamadım: takımlar. Lütfen bunu ayrı bir mesajla iste.");
    expect(notDoneLine(["admin_ops", "balancer"], "tr")).toBe(
      "Mesajındaki şu kısımları yapamadım: ayar değişikliği ve takımlar. Lütfen bunları ayrı ayrı iste.",
    );
  });
  it("two routes the group names alike are one part", () => {
    expect(notDoneLine(["question", "help"], "en")).toBe("I couldn't do this part of your message: the question. Please ask me for it on its own.");
  });
  it("names each route as the group would", () => {
    expect(partOf("admin_ops")).toBe("settings");
    expect(partOf("other_att")).toBe("squad");
    expect(partOf("balancer")).toBe("teams");
    expect(partOf("help")).toBe("question");
    expect(partOf("score")).toBe("result");
  });
});

describe("joinHqParts: HQ's parts, done in order, as one reply", () => {
  it("every part's line, in order, one reply", () => {
    const out = joinHqParts({
      route: "other_att",
      lang: "en",
      parts: [
        { part: "admin_ops", result: { route: "admin_ops", outcome: "hq-format-switched", replyText: "Done: Monday is 7-a-side now, 14 places." } },
        { part: "other_att", result: { route: "other_att", outcome: "hq-squad-changed", replyText: "Luca is on the bench, Zak is in." } },
        { part: "balancer", result: { route: "balancer", outcome: "hq-teams-proposed", replyText: "Teams: ..." } },
      ],
    });
    expect(out).toEqual({
      route: "other_att",
      outcome: "hq-format-switched+hq-squad-changed+hq-teams-proposed",
      replyText: "Done: Monday is 7-a-side now, 14 places.\n\nLuca is on the bench, Zak is in.\n\nTeams: ...",
    });
  });
  it("a part that did nothing is named; a line two parts both said is said once", () => {
    const teams = { route: "balancer" as Route, outcome: "hq-teams-proposed", replyText: "Teams: ..." };
    const out = joinHqParts({
      route: "other_att",
      lang: "en",
      parts: [
        { part: "admin_ops", result: null },
        { part: "other_att", result: teams },
        { part: "balancer", result: teams },
      ],
    });
    expect(out?.replyText).toBe("Teams: ...\n\nI couldn't do this part of your message: the setting change. Please ask me for it on its own.");
    expect(out?.outcome).toBe("hq-teams-proposed+hq-teams-proposed+hq-part-not-done");
  });
});

// ── SEVERAL MESSAGES IN ONE BATCH (Sutton FC, 2026-11-17) ──────────────
// 11:36 "@Match Time cancel the match due to low numbers"; 12:48 and 12:50
// two players' "In"; 12:51 "@Match Time ... can you enable today's match
// again?". All three in ONE batch: the INs were decided against the still
// cancelled match and lost, then the restore was applied.
describe("matchChangesFirst: a batch's match changes, in message order, against its attendance claims", () => {
  const claim = (id: string) => ({ id, claims: true, adminAction: null });
  const admin = (id: string, adminAction: string) => ({ id, claims: false, adminAction });

  it("the incident: two INs, then the restore. The restore is done first, so both INs count", () => {
    expect([...matchChangesFirst([claim("in1"), claim("in2"), admin("back", "restore_match")])]).toEqual(["back"]);
  });

  it("a restore before the INs is done first too", () => {
    expect([...matchChangesFirst([admin("back", "restore_match"), claim("in1")])]).toEqual(["back"]);
  });

  it("a cancel after INs waits: the INs are recorded, then the cancel applies to them", () => {
    expect([...matchChangesFirst([claim("in1"), claim("in2"), admin("off", "cancel_match")])]).toEqual([]);
  });

  it("a cancel before every IN is done first: the INs meet a cancelled match, as in a later batch", () => {
    expect([...matchChangesFirst([admin("off", "cancel_match"), claim("in1")])]).toEqual(["off"]);
  });

  it("a switch or a size is done before the INs, wherever it sits", () => {
    for (const a of ["switch_format", "player_numbers"]) {
      expect([...matchChangesFirst([admin("x", a), claim("in1")])]).toEqual(["x"]);
      expect([...matchChangesFirst([claim("in1"), admin("x", a)])]).toEqual(["x"]);
    }
  });

  it("a cancel after an IN keeps everything after it in order: IN, cancel, back on is cancelled THEN restored", () => {
    expect([...matchChangesFirst([claim("in1"), admin("off", "cancel_match"), admin("back", "restore_match")])]).toEqual([]);
    expect([...matchChangesFirst([admin("back", "restore_match"), claim("in1"), admin("off", "cancel_match")])]).toEqual(["back"]);
  });

  it("a cancel that will not be carried out (untagged, or not an organiser's) holds nothing back", () => {
    const chatter = { id: "chat", claims: false, adminAction: "cancel_match", acts: false };
    expect([...matchChangesFirst([claim("in1"), chatter, admin("back", "restore_match")])]).toEqual(["chat", "back"]);
  });

  it("what is not a change to the match stays where it always was (after the INs)", () => {
    for (const a of ["bulk_payment", "reminder", "recruit", "season_break", "set_venue", "other"]) {
      expect([...matchChangesFirst([admin("x", a), claim("in1")])]).toEqual([]);
    }
  });

  it("a game moved to another day or time is NOT done first: the INs land on the game the players were answering", () => {
    expect([...matchChangesFirst([claim("in1"), admin("mv", "move_game")])]).toEqual([]);
    expect([...matchChangesFirst([admin("mv", "move_game"), claim("in1")])]).toEqual([]);
  });

  it("no attendance claim in the batch: nothing to order against, nothing moved", () => {
    expect([...matchChangesFirst([admin("back", "restore_match"), admin("sw", "switch_format")])]).toEqual([]);
  });
});
