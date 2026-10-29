/**
 * STAGE 1 — the router, and the deterministic floor under it.
 *
 * §11.1 names router misclassification as the biggest risk in the whole
 * design AND a genuine regression: "a message routed `none` disappears
 * silently — no write, no reply, no reaction, no signal. Today the
 * mega-call at least emits SOMETHING for every message."
 *
 * Three containments are tested here. The fourth (a frozen eval set) is
 * `e2e/corpus`, which runs the real model.
 */
import { describe, it, expect } from "vitest";
import {
  ROUTER_SYSTEM_PROMPT,
  normaliseRoute,
  parseRouterResponse,
  routeFloor,
  routeBatch,
  renderRouterTurn,
  organisersHeader,
  partnerClubsLine,
} from "../router";
import { gateBatch } from "../gate";
import {
  MIN_CACHEABLE_TOKENS,
  ROUTER_MODEL,
  estimateTokens,
  type PipelineModel,
  type ModelResponse,
} from "../llm";

function fakeModel(responses: string[] | ((n: number) => string)): PipelineModel & {
  calls: Array<{ system: string; user: string; maxTokens: number }>;
} {
  const calls: Array<{ system: string; user: string; maxTokens: number }> = [];
  let i = 0;
  return {
    name: "fake",
    calls,
    async complete(req): Promise<ModelResponse> {
      calls.push({ system: req.system, user: req.user, maxTokens: req.maxTokens });
      const text = typeof responses === "function" ? responses(i) : (responses[i] ?? responses[responses.length - 1]);
      i++;
      return {
        text,
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.0001,
        ms: 5,
      };
    },
  };
}

// ── The deterministic floor (§11.1) ────────────────────────────────────

describe("the regex floor — built new, because the old one was deleted", () => {
  // ⚠️ §11.1 corrects its own first draft: the regex fast path CANNOT
  // serve as this floor, because it was deleted on 2026-04-21 and
  // handlers.ts:7-10 records that "Kemal explicitly asked for this". So
  // the floor is built new, deliberately TINY, and it force-routes
  // regardless of what the router says.
  it.each([
    ["in", "self_att"],
    ["IN", "self_att"],
    ["In 👍", "self_att"],
    ["i'm in", "self_att"],
    ["im in", "self_att"],
    ["I am in", "self_att"],
    ["out", "self_att"],
    ["OUT", "self_att"],
    ["i'm out", "self_att"],
  ])("%s → %s", (body, route) => {
    expect(routeFloor(body)).toBe(route);
  });

  it.each([
    // "+1" offers a GUEST, not the sender, so the floor must not claim
    // it: routing it self_att loses the guest and bypasses PR #29's
    // name-ask on the commonest way to offer one.
    "+1",
    "+2",
    "Zeeshan is out 😂😂 vote him out lads",
    "anyone watching the derby tonight",
    "my brother can play if needed",
    "I was in last week and nobody added me",
    "we're in trouble lads",
    "@Match Time who's on the bench?",
    "in the end we lost",
  ])("does not claim %s", (body) => {
    expect(routeFloor(body)).toBeNull();
  });
});

// ── Parsing and normalisation ──────────────────────────────────────────

describe("normaliseRoute", () => {
  it("accepts the nine routes", () => {
    expect(normaliseRoute("self_att")).toBe("self_att");
    expect(normaliseRoute("NONE")).toBe("none");
  });

  it("maps the `lineup_ops` alias onto other_att", () => {
    // §6.1's unfixed prototype failure: "move Mustafa to the bench, keep
    // Idris in" routed `team_ops` 3/3 because "bench" reads as
    // team-shaped vocabulary. We rename team_ops → balancer AND accept
    // lineup_ops as an alias, so roster surgery has somewhere natural to
    // land without creating a second attendance path in the engine.
    expect(normaliseRoute("lineup_ops")).toBe("other_att");
    expect(normaliseRoute("team_ops")).toBe("balancer");
  });

  it("returns null for a route the model invented", () => {
    expect(normaliseRoute("attendance_change")).toBeNull();
  });
});

describe("parseRouterResponse", () => {
  it("parses the documented shape", () => {
    const out = parseRouterResponse('{"routes":[{"id":"wa-1","route":"none"}]}', ["wa-1"]);
    expect(out.routes).toEqual([{ messageId: "wa-1", route: "none", source: "model" }]);
    expect(out.degradations).toHaveLength(0);
  });

  it("survives markdown fences and preamble", () => {
    const out = parseRouterResponse(
      'Here you go:\n```json\n{"routes":[{"id":"wa-1","route":"self_att"}]}\n```',
      ["wa-1"],
    );
    expect(out.routes[0].route).toBe("self_att");
  });

  it("fills a MISSING id with `unsure`, never `none`, and says so", () => {
    // The asymmetry §11.1 demands, built in rather than hoped for: a
    // false positive costs one extractor call (~$0.002) that returns no
    // claims; a false negative costs a player their slot.
    const out = parseRouterResponse('{"routes":[{"id":"wa-1","route":"none"}]}', ["wa-1", "wa-2"]);
    expect(out.routes).toHaveLength(2);
    expect(out.routes[1]).toMatchObject({ messageId: "wa-2", route: "unsure", source: "fallback" });
    expect(out.degradations[0].detail).toMatch(/no route/i);
  });

  it("drops an id the model invented", () => {
    const out = parseRouterResponse(
      '{"routes":[{"id":"wa-1","route":"none"},{"id":"ghost","route":"score"}]}',
      ["wa-1"],
    );
    expect(out.routes).toHaveLength(1);
    expect(out.degradations.some((d) => /unknown id/i.test(d.detail))).toBe(true);
  });

  it("an id returned inside the turn's square brackets, or with spaces, is still that id", () => {
    const out = parseRouterResponse('{"routes":[{"id":"[m1]","route":"none"},{"id":" m2 ","route":"self_att"}]}', ["m1", "m2"]);
    expect(out.routes).toEqual([
      { messageId: "m1", route: "none", source: "model" },
      { messageId: "m2", route: "self_att", source: "model" },
    ]);
    expect(out.degradations).toHaveLength(0);
  });

  it("falls back to `unsure` on unparseable output, and never throws", () => {
    const out = parseRouterResponse("the model said something else entirely", ["wa-1", "wa-2"]);
    expect(out.routes.map((r) => r.route)).toEqual(["unsure", "unsure"]);
    expect(out.degradations.length).toBeGreaterThan(0);
  });
});

// ── The prompt itself ──────────────────────────────────────────────────

describe("the router prompt", () => {
  // ⚠️ THE SIZE CEILING MOVED ON 2026-09-11, AND IT IS NOT A TASTE
  // CHANGE. §6.1's "its size is the argument" was tested as
  // `length < 2600`, which is a character count standing in for a
  // measurement nobody had made. `MDs/router-accuracy-2026-09-11.md`
  // made it: the 2,501-character prompt reached 83.3% owner accuracy
  // over 1,748 real messages, and the rewrite reached 91%+ for
  // $0.41/month more. Small was never the goal — cheap and right was.
  //
  // What replaces it is a bound that means something. Every token of
  // this prompt is paid on every call, because it sits under Haiku
  // 4.5's 4,096-token minimum cacheable prefix and therefore never
  // caches (`__tests__/cache-threshold.test.ts` pins that, and §1.5
  // probed it). So the ceiling IS the cache minimum: cross it and the
  // per-batch cost stops being a rounding error, and the honest fix is
  // to pass ~15,500 characters so it genuinely caches rather than to
  // creep up to it.
  it("clears Haiku 5.5's minimum cacheable prefix, so it is cached rather than paid in full each call", () => {
    // On Haiku 4.5 (4,096-token minimum) this prompt was under the floor
    // and every token was paid on every call. Haiku 5.5's floor is 512
    // (probed, 2026-10-19), and the prompt is 5,202 of its tokens, so it
    // carries the 1-hour marker and later calls read it at 0.1x.
    expect(estimateTokens(ROUTER_SYSTEM_PROMPT)).toBeGreaterThanOrEqual(
      MIN_CACHEABLE_TOKENS[ROUTER_MODEL]!,
    );
  });

  it("carries the bias-toward-action rule", () => {
    expect(ROUTER_SYSTEM_PROMPT).toMatch(/in doubt/i);
  });

  it("names every route it can emit", () => {
    for (const r of ["none", "self_att", "other_att", "offer", "question", "balancer", "score", "admin_ops", "unsure"]) {
      expect(ROUTER_SYSTEM_PROMPT, r).toContain(r);
    }
  });

  // ── The prompt TEACHES routes. A route it teaches that this file
  //    cannot parse is a silent degradation on every batch that copies
  //    it, so the worked examples are checked against the parser rather
  //    than read. This is the one property of the prompt's wording that
  //    is a behaviour and not a preference.
  it("never teaches a route the parser would reject", () => {
    const taught = [...ROUTER_SYSTEM_PROMPT.matchAll(/->\s*([a-z_]+)\s*$/gm)].map((m) => m[1]!);
    expect(taught.length).toBeGreaterThan(20);
    for (const route of taught) {
      expect(normaliseRoute(route), `worked example teaches "${route}"`).not.toBeNull();
    }
  });

  it("teaches the asker's own stats request as a question, in both languages (2026-09-17)", () => {
    // `STATS_REQUEST` used to catch these before the router ran. Without
    // a worked example, "@Match Time wrapped" routed `none` 3 of 3 live.
    for (const body of ["@Match Time my stats", "@Match Time wrapped", "@Match Time istatistiklerim"]) {
      const line = ROUTER_SYSTEM_PROMPT.split("\n").find((l) => l.trim().startsWith(`"${body}"`));
      expect(line, body).toBeDefined();
      expect(line!).toMatch(/->\s*question\s*$/);
    }
  });

  // ── THE 2026-09-22 REPLACEMENT RULES ──────────────────────────────
  //
  // "Hi guys, Mojib is replacing Najib on the list. We can change" went
  // to `none`. These pin the worked examples that were added for it,
  // AND the direction of the change: rule 18 (since the 2026-09-23
  // rewrite, the unnumbered replacement ruling) and its examples only ever
  // push a message TOWARDS attendance. That is what makes them safe for
  // the veto metric (attendance-routed-`none` must stay at 0 over the
  // 373-message gold corpus) without a live run: nothing was added that
  // could teach `none`, and no existing example moved.
  it("teaches every replacement shape as attendance, in both languages", () => {
    for (const body of [
      "Hi guys, Mojib is replacing Najib on the list. We can change",
      "Amir in for Zeeshan",
      "Najib is out, Mojib is in",
      "Zair takes Abid's place tonight",
      "Mojib, Najib'in yerine geliyor",
      "Najib çıkıyor, Mojib giriyor",
    ]) {
      const line = ROUTER_SYSTEM_PROMPT.split("\n").find((l) => l.trim().startsWith(`"${body}"`));
      expect(line, body).toBeDefined();
      expect(line!, body).toMatch(/->\s*other_att\s*$/);
    }
  });

  it("states the replacement rule itself, and never as a reason to stay quiet", () => {
    // It was rule 18 until the 2026-09-23 rewrite dropped the numbering;
    // it is found by what it says now, not by where it sits.
    const rule = ROUTER_SYSTEM_PROMPT.split("\n").find((l) => l.startsWith("- A replacement"));
    expect(rule).toBeDefined();
    expect(rule!).toMatch(/replacing/i);
    expect(rule!).toMatch(/other_att/);
    // The one property that protects the veto: this rule cannot send
    // anything to `none`.
    expect(rule!).not.toMatch(/\bnone\b/);
  });

  // ── THE 2026-09-23 REWRITE: A TAGGED ASK IS NEVER BANTER ──────────
  //
  // "@Match Time Zork's chemistry", "@Match Time Mehmet's chemistry" and
  // "@Match Time who's the worst" routed `none` 0 of 3 each on the old
  // prompt (single message, floor off), so the stats owner never got the
  // chance to ask "who do you mean?". These pin the three properties the
  // rewrite rests on. Whether the model obeys them is a live question,
  // answered by the router probe in the PR, not here.
  const decisionStep = (n: number) =>
    ROUTER_SYSTEM_PROMPT.split("\n").find((l) => l.startsWith(`${n}. `)) ?? "";

  it("asks about a place in the squad BEFORE it asks about the tag", () => {
    // The order is the veto's protection: a tagged "@Match Time Najib is
    // out" must stop at the first question and never reach the second.
    expect(decisionStep(1)).toMatch(/place in THIS squad/);
    expect(decisionStep(1)).toMatch(/never none/);
    expect(decisionStep(1)).toMatch(/Nothing below overrides this/);
    expect(decisionStep(2)).toMatch(/tag/i);
    expect(ROUTER_SYSTEM_PROMPT.indexOf(decisionStep(1))).toBeLessThan(
      ROUTER_SYSTEM_PROMPT.indexOf(decisionStep(2)),
    );
  });

  it("says a tagged message is never none for being short, and names what is", () => {
    const step = decisionStep(2);
    expect(step).toMatch(/@Match Time/);
    expect(step).toMatch(/never none because it is short/);
    // Only a tagged message that asks for nothing at all is still none,
    // and talking ABOUT the bot without the @ is not a tag.
    expect(step).toMatch(/asks for nothing at all/);
    expect(step).toMatch(/without the @/);
  });

  it("teaches the short tagged stats ask as question, in both languages", () => {
    const taught = new Map(
      [...ROUTER_SYSTEM_PROMPT.matchAll(/^\s*"([^"]+)"\s+->\s*([a-z_]+)\s*$/gm)].map((m) => [m[1]!, m[2]!]),
    );
    expect(taught.get("@Match Time Burak's chemistry")).toBe("question");
    expect(taught.get("@Match Time who's top")).toBe("question");
    expect(taught.get("@Match Time Ali'nin kimyası")).toBe("question");
    // The tagged thanks is the control: tagged, asks nothing, stays none.
    expect(taught.get("@Match Time cheers 👍")).toBe("none");
  });

  it("keeps the three measured targets OUT of the prompt, so the live check is held out", () => {
    for (const body of ["Zork's chemistry", "Mehmet's chemistry", "who's the worst"]) {
      expect(ROUTER_SYSTEM_PROMPT, body).not.toContain(body);
    }
  });

  it("calls a bare \"confirmed\" unsure, never none (the 2026-09-24 veto loss)", () => {
    // The rewrite's certifying veto sweep lost a bare "Confirmed" (gold
    // attendance) in 1 of 3 runs; ten repeats of its batch read none 2/10
    // against 0/10 on the old prompt. The unsure route now names it.
    const unsure = ROUTER_SYSTEM_PROMPT.split("\n").find((l) => l.startsWith("unsure "));
    expect(unsure).toBeDefined();
    expect(unsure!).toMatch(/"confirmed"/);
    expect(unsure!).toMatch(/is unsure, never none/);
  });

  // ── THE 2026-09-24 "@Jordan IN" LOSS ───────────────────────────────
  //
  // The certifying veto read 0, 0, 1 on 415481a: "@Jordan IN", sent by
  // an admin straight after telling Jordan off for pasting the bot's
  // squad list and explaining how to say IN, routed `none`. The rule
  // that a name plus in/out is other_att used to be a ruling further
  // down; it now lives in the first decision question, stated once, with
  // the reason it failed (the surrounding telling-off read as the
  // context, the sign-in as a demonstration) answered in so many words.
  it("settles a name or @mention plus in/out in the FIRST question, whatever surrounds it", () => {
    const step = decisionStep(1);
    expect(step).toMatch(/a name or an @mention followed by in or out/);
    expect(step).toMatch(/var or yok/);
    expect(step).toMatch(/other_att, always/);
    expect(step).toMatch(/whoever sends it/);
    expect(step).toMatch(/never a demonstration/);
    expect(step).toMatch(/pasted copy of the list/);
    // Stated once: the old ruling that said the same thing is gone.
    expect(ROUTER_SYSTEM_PROMPT).not.toMatch(/^- A named person or an @mention/m);
  });

  it("teaches the bare name-plus-in/out shape in the other_att group, English and Turkish side by side", () => {
    const lines = ROUTER_SYSTEM_PROMPT.split("\n");
    const start = lines.findIndex((l) => l.startsWith("Somebody else's place"));
    const end = lines.findIndex((l, i) => i > start && l.trim() === "");
    const group = lines.slice(start + 1, end).map((l) => l.trim());
    const at = (body: string) => group.indexOf(`"${body}" -> other_att`);
    for (const body of ["@Kojo IN", "@Ali var", "Baki OUT", "Veli yok"]) {
      expect(at(body), body).toBeGreaterThanOrEqual(0);
    }
    // Side by side: each Turkish line directly follows its English twin.
    expect(at("@Ali var")).toBe(at("@Kojo IN") + 1);
    expect(at("Veli yok")).toBe(at("Baki OUT") + 1);
    // Deduplicated: each taught once in the whole prompt.
    for (const body of ["@Kojo IN", "Baki OUT"]) {
      expect(ROUTER_SYSTEM_PROMPT.split(`"${body}" ->`).length - 1, body).toBe(1);
    }
  });

  it("keeps the two lost sign-ins OUT of the prompt, so the live check is held out", () => {
    for (const body of ["@Jordan IN", "@Jesse"]) {
      expect(ROUTER_SYSTEM_PROMPT, body).not.toContain(body);
    }
  });

  it("writes no em or en dashes", () => {
    expect(ROUTER_SYSTEM_PROMPT).not.toMatch(/[\u2013\u2014]/);
  });

  it("demands an output shape this file actually parses", () => {
    // The last line of the prompt is the contract between the model and
    // `parseRouterResponse`. Pull it out, fill it in, and run it through
    // the parser: if someone renames a field in the prompt, every batch
    // degrades to `unsure` and nothing else in this suite would notice.
    const line = ROUTER_SYSTEM_PROMPT.trimEnd().split("\n").at(-1)!;
    expect(line).toMatch(/^Return JSON only:/);
    const shape = line.slice(line.indexOf("{"));
    const filled = shape.replace("<id>", "wa-1").replace("<route>", "other_att");
    const out = parseRouterResponse(filled, ["wa-1"]);
    expect(out.routes).toEqual([{ messageId: "wa-1", route: "other_att", source: "model" }]);
    expect(out.degradations).toEqual([]);
  });
});

// ── The batch call ─────────────────────────────────────────────────────

describe("routeBatch", () => {
  const msgs = [
    { id: "wa-1", authorName: "Ayoub", body: "😂😂😂" },
    { id: "wa-2", authorName: "Najib", body: "In" },
  ];

  it("routes a batch in ONE call and lets the floor override the model", async () => {
    const model = fakeModel(['{"routes":[{"id":"m1","route":"none"},{"id":"m2","route":"none"}]}']);
    const out = await routeBatch(model, msgs);
    expect(model.calls).toHaveLength(1);
    expect(out.routes[0]).toMatchObject({ route: "none", source: "model" });
    // "In" is bare self-attendance. The router said banter; the floor
    // wins, because losing that is losing a player's slot.
    expect(out.routes[1]).toMatchObject({ route: "self_att", source: "floor" });
    expect(out.degradations.some((d) => /floor overrode/i.test(d.detail))).toBe(true);
  });

  // FNF HQ, 2026-10-17/18 (Vercel request logs): three times in two days
  // the model copied a ~80-character WhatsApp id back wrong ("B03" twice;
  // the turn's brackets kept and one character changed; the brackets
  // kept), the route was dropped as an unknown id, and the message fell
  // back to `unsure`. The model now never sees a WhatsApp id.
  describe("the model is shown short positional ids, never the WhatsApp ids", () => {
    const INCIDENT = "false_120363046757382958@g.us_AC5922E2E21D4093AAD157B03EDDADA1_89485761081551@lid";
    const REPLY = "false_120363046757382958@g.us_3A84686B35E9610A2A4B_156345466617992@lid";
    const LONG = "false_120363046757382958@g.us_AC4A09768AC82AC94A71E11BC84022E4_89485761081551@lid";
    const batch = [
      { id: INCIDENT, authorName: "Kemal", body: "@Match Time what is squad now including bench?" },
      { id: REPLY, authorName: "Hamzah", body: "Is it okay if we put Shehryar in first cos he's a goalkeeper" },
      { id: LONG, authorName: "Kemal", body: "also I put limits for Matchtime" },
    ];

    it("the turn carries m1, m2, m3; no WhatsApp id reaches the model", async () => {
      const m = fakeModel(['{"routes":[]}']);
      await routeBatch(m, batch, { floor: false, now: new Date("2026-10-20T18:00:00Z") });
      expect(m.calls[0].user).toBe(
        "NOW: Tuesday 20 October 2026, 19:00 (club time, London)\n" +
          "[m1] Kemal: @Match Time what is squad now including bench?\n" +
          "[m2] Hamzah: Is it okay if we put Shehryar in first cos he's a goalkeeper\n" +
          "[m3] Kemal: also I put limits for Matchtime",
      );
      for (const id of [INCIDENT, REPLY, LONG]) {
        expect(m.calls[0].user).not.toContain(id);
        expect(m.calls[0].system).not.toContain(id);
      }
    });

    it("each short id maps back to its own message, in any order", async () => {
      const m = fakeModel(['{"routes":[{"id":"m3","route":"none"},{"id":"[m1]","route":"question"},{"id":"m2","route":"other_att"}]}']);
      const out = await routeBatch(m, batch, { floor: false });
      expect(out.routes).toEqual([
        { messageId: INCIDENT, route: "question", source: "model" },
        { messageId: REPLY, route: "other_att", source: "model" },
        { messageId: LONG, route: "none", source: "model" },
      ]);
      expect(out.degradations).toHaveLength(0);
    });

    it("an unknown short id is dropped, and only the message it left unrouted falls back, by its real id", async () => {
      const m = fakeModel(['{"routes":[{"id":"m1","route":"question"},{"id":"m9","route":"self_att"},{"id":"m3","route":"none"}]}']);
      const out = await routeBatch(m, batch, { floor: false });
      expect(out.routes.map((r) => [r.messageId, r.route, r.source])).toEqual([
        [INCIDENT, "question", "model"],
        [REPLY, "unsure", "fallback"],
        [LONG, "none", "model"],
      ]);
      expect(out.degradations.map((d) => d.detail)).toEqual(['router returned an unknown id "m9"; dropped', "router returned no route; defaulting to unsure"]);
      expect(out.degradations[1].messageId).toBe(REPLY);
    });

    it("a WhatsApp id echoed back, right or wrong, is not a short id: dropped", async () => {
      const m = fakeModel([JSON.stringify({ routes: [{ id: INCIDENT, route: "question" }] })]);
      const out = await routeBatch(m, [batch[0]], { floor: false });
      expect(out.routes[0]).toMatchObject({ messageId: INCIDENT, source: "fallback" });
    });

    it("an organisers' route is still allowed only on the organisers' group message", async () => {
      const m = fakeModel(['{"routes":[{"id":"m1","route":"approve"},{"id":"m2","route":"approve"}]}']);
      const out = await routeBatch(m, [{ ...batch[0], organisers: { context: [] } }, batch[1]], { floor: false });
      expect(out.routes.map((r) => r.route)).toEqual(["approve", "unsure"]);
    });
  });

  it("routes EVERYTHING to the attendance extractor when the model throws (§11.4)", async () => {
    const model: PipelineModel = {
      name: "broken",
      async complete() {
        throw new Error("router timeout");
      },
    };
    const out = await routeBatch(model, msgs);
    expect(out.routes.map((r) => r.route)).toEqual(["unsure", "self_att"]);
    expect(out.degradations[0].detail).toMatch(/router timeout/);
  });

  it("caps max_tokens well below the SDK's non-streaming limit", async () => {
    const model = fakeModel(['{"routes":[]}']);
    await routeBatch(model, msgs);
    expect(model.calls[0].maxTokens).toBeLessThanOrEqual(16_384);
  });

  it("never calls the model at all when every message hits the floor", async () => {
    const model = fakeModel(['{"routes":[]}']);
    const out = await routeBatch(model, [
      { id: "wa-1", authorName: "Najib", body: "in" },
      { id: "wa-2", authorName: "Zair", body: "out" },
    ]);
    expect(model.calls).toHaveLength(0);
    expect(out.routes.every((r) => r.source === "floor")).toBe(true);
  });
});

// ── Found by the first live corpus sweep (2026-09-01) ──────────────────

describe("the mention floor — a tagged person plus a bare IN/OUT", () => {
  // §11.1 in its purest form: `@Ehtisham Ul Haq In` routed `none` on the
  // live corpus, so a real third-party registration disappeared with no
  // write, no reply and no signal. It is the same shape as the bare
  // self-attendance floor — a mention and a token, nothing else — so it
  // gets the same treatment, one route along.
  it.each([
    ["@Ehtisham Ul Haq In", "other_att"],
    ["@Najib in", "other_att"],
    ["@Zair Malik out", "other_att"],
    ["@Faris Nasser IN 👍", "other_att"],
  ])("%s → %s", (body, route) => {
    expect(routeFloor(body)).toBe(route);
  });

  it.each([
    // A tagged bot is never a player. Without this, "@Match Time in"
    // would try to register a member called "Match Time" — the ghost
    // user class of bug, one layer up.
    "@Match Time in",
    "@MatchTime out",
    // Not a bare declaration: anything past the token is a sentence.
    "@Zair Malik is in if we're short",
    "@all we need more players pls",
    "@Kemal Ediz my brother can play if needed",
    "@Match Time who's on the bench?",
    "@Ehtisham Ul Haq is replacing @Elnur Mammadov",
  ])("does not claim %s", (body) => {
    expect(routeFloor(body)).toBeNull();
  });
});

describe("router prompt rules added after the live sweep", () => {
  it("tells the router that a reposted roster is not a team sheet", () => {
    // Live corpus: a 14-name numbered list (S26's reposted roster) routed
    // `balancer`, so the tag gate refused it as a team op and two real
    // registrations were lost.
    expect(ROUTER_SYSTEM_PROMPT).toMatch(/list of players|roster/i);
  });

  it("tells the router that an @mention with in/out is other_att", () => {
    expect(ROUTER_SYSTEM_PROMPT).toMatch(/@-?mention|mention/i);
  });
});

// ── Turkish (2026-09-16): Erdal's group reads and writes in Turkish ────
//
// `MDs/second-group-readiness-erdal-2026-09-16.md` §2 measured the live
// router on the bare Turkish forms: "yokum" routed `none` 10 of 10,
// "yok" 10 of 10, "var" registered 0 of 10. Those are the Turkish "in"
// and "out" — the single most common attendance messages a group sends —
// and they were lost silently, exactly the failure the floor exists for.
// The floor's vocabulary grows; its flag, its shape and its one-way
// property do not.
describe("the floor reads the bare Turkish forms, same shape as the English ones", () => {
  it.each([
    ["var", "self_att"],
    ["Var", "self_att"],
    ["VAR", "self_att"],
    ["var.", "self_att"],
    ["varım", "self_att"],
    ["Varım", "self_att"],
    ["VARIM", "self_att"],
    ["varim", "self_att"],
    ["ben varım", "self_att"],
    ["Ben varım 👍", "self_att"],
    ["yok", "self_att"],
    ["Yok.", "self_att"],
    ["yokum", "self_att"],
    ["ben yokum", "self_att"],
    ["gelemiyorum", "self_att"],
    ["Gelemiyorum 😔", "self_att"],
    // The mention half: a tagged person plus a bare Turkish token.
    ["@Ali var", "other_att"],
    ["@Ali Yok", "other_att"],
    ["@Ali Veli yok", "other_att"],
  ])("%s → %s", (body, route) => {
    expect(routeFloor(body)).toBe(route);
  });

  it.each([
    // Anything beyond the bare token is a sentence and goes to the model.
    "var mı?",
    "varım ama geç kalırım",
    "yok artık",
    "bir şey yok",
    "top var mı bugün",
    "varsa gelirim",
    "bu hafta yokum",
    "belki",
    "bakarız",
    "kesin değil",
    // A mention of the bot is never a player.
    "@Match Time var",
  ])("does not claim %s", (body) => {
    expect(routeFloor(body)).toBeNull();
  });
});

// ── Emoji (2026-09-24): in a display name, and after the declaration ──
//
// The floor goes ON in production with the router rewrite, and a group
// types emoji everywhere: in display names ("Jesse👑") and after the
// token ("IN ✌️"). An emoji is never a word, so it can neither make a
// bare declaration a sentence nor end a mentioned name. It is matched as
// an emoji SEQUENCE, not a hand list: "✌️" carries U+FE0F (a nonspacing
// mark, not a symbol), "🤷‍♂️" joins with U+200D (a format character).
describe("the floor reads emoji in a name and after the declaration", () => {
  it.each([
    // In the mentioned display name: attached, leading, or its own word.
    ["@Jesse👑 IN", "other_att"],
    ["@👑Jesse in", "other_att"],
    ["@Jesse 👑 IN", "other_att"],
    ["@Ehtisham Ul Haq 🔥 In", "other_att"],
    // After the declaration, self and mention alike.
    ["In 👍", "self_att"],
    ["IN ✌️", "self_att"],
    ["In 💪🏽", "self_att"],
    ["Out 🤷‍♂️", "self_att"],
    ["In 🇬🇧", "self_att"],
    ["In 🏴󠁧󠁢󠁥󠁮󠁧󠁿", "self_att"],
    ["var ✅", "self_att"],
    ["IN 🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥", "self_att"],
    ["@Jordan IN 🙏", "other_att"],
    ["@Ali var 👍", "other_att"],
    ["@Jesse👑 out 🤷‍♂️", "other_att"],
  ])("%s → %s", (body, route) => {
    expect(routeFloor(body)).toBe(route);
  });

  it.each([
    // Emoji widen the floor; they never widen it into sentences.
    "Hi @Jordan going forward we need to say IN",
    "@Jordan in the car",
    "@Jordan 👑 in the car",
    "in 20 mins",
    "in 20",
    "Confirmed",
    "Confirmed 👍",
    // The bot is never a player, however it is decorated.
    "@Match Time in",
    "@Match Time 👍 in",
    // Only emoji: no token, so nothing to claim.
    "👍",
    "🔥🔥🔥",
    "@👑",
    "@Jesse👑",
    // Still deliberately unmatched: "+1" offers a guest.
    "+1",
    "+1 👍",
  ])("does not claim %s", (body) => {
    expect(routeFloor(body)).toBeNull();
  });
});

describe("the router prompt reads Turkish", () => {
  it("says a message may be Turkish, and that a bare var/yok is attendance like a bare in/out", () => {
    expect(ROUTER_SYSTEM_PROMPT).toMatch(/Turkish/);
    for (const w of ["var", "yok", "varım", "yokum"]) {
      expect(ROUTER_SYSTEM_PROMPT, w).toContain(`"${w}"`);
    }
  });

  it("teaches the seven Turkish shapes as worked examples, in the block the router copies from", () => {
    const taught = new Map(
      [...ROUTER_SYSTEM_PROMPT.matchAll(/^\s*"([^"]+)"\s+->\s*([a-z_]+)\s*$/gm)].map((m) => [m[1]!, m[2]!]),
    );
    // bare IN and OUT forms
    expect(taught.get("var")).toBe("self_att");
    expect(taught.get("yokum")).toBe("self_att");
    // a hedge
    expect(taught.get("belki")).toBe("offer");
    // a relayed third-party IN and a third-party OUT
    expect(taught.get("Ali de geliyor")).toBe("other_att");
    expect(taught.get("Mehmet gelemiyor")).toBe("other_att");
    // a question
    expect(taught.get("kaç kişiyiz?")).toBe("question");
    // banter
    expect(
      [...taught.entries()].some(([body, route]) => /hadi|maç|😂/.test(body) && route === "none"),
    ).toBe(true);
  });
});

// ── ONE ROUTER FOR EVERY GROUP (2026-10-16) ─────────────────────────
//
// A club's organisers' (admin) group goes through this same router, with
// its context under a header. The players' group must not see any of it:
// its user turn is byte-for-byte what it was, and the organisers' routes
// can never land on a players' message.
describe("the organisers' group", () => {
  // Tue 20 Oct 2026, 19:00 London.
  const NOW = new Date("2026-10-20T18:00:00Z");
  const NOW_LINE = "NOW: Tuesday 20 October 2026, 19:00 (club time, London)";

  it("a players' group turn: the time now, then one line per message", () => {
    expect(renderRouterTurn([{ id: "a", authorName: "Ali", body: "in" }, { id: "b", authorName: null, body: "out" }], NOW)).toBe(
      `${NOW_LINE}\n[a] Ali: in\n[b] (unknown): out`,
    );
  });

  it("an organisers' message comes under its header and context lines", () => {
    expect(renderRouterTurn([{ id: "h", authorName: "Raihan", body: "yes", organisers: { context: ["WAITING: nothing."] } }], NOW)).toBe(
      `${NOW_LINE}\n${organisersHeader()}\nWAITING: nothing.\n[h] Raihan: yes`,
    );
  });

  // Slice S6 (2026-10-21): partner clubs. The organisers' header says that
  // asking another club is admin_ops; a players' group organiser in a club
  // with partners is shown the partners above the message.
  // 2026-10-21: players can be in the organisers' group too (2026-10-20), so
  // the header says whether THIS sender is an organiser, from what code
  // knows, and the prompt never assumes it.
  it("the header states whether the sender is an organiser, as code knows it, and assumes nothing without it", () => {
    expect(organisersHeader(true)).toMatch(/^ORGANISERS' GROUP\. The sender is an organiser of the club\. /);
    expect(organisersHeader(false)).toMatch(/^ORGANISERS' GROUP\. The sender is a member of the club, not an organiser\. /);
    expect(organisersHeader()).toMatch(/^ORGANISERS' GROUP\. Here, /);
    const turn = (senderIsOrganiser?: boolean) =>
      renderRouterTurn([{ id: "h", authorName: "Pat", body: "Naim is out", organisers: { context: ["WAITING: nothing."], senderIsOrganiser } }], NOW);
    expect(turn(false)).toBe(`${NOW_LINE}\n${organisersHeader(false)}\nWAITING: nothing.\n[h] Pat: Naim is out`);
    expect(turn(true)).toContain("The sender is an organiser of the club.");
    expect(turn()).not.toMatch(/The sender is/);
  });

  it("the prompt never says every sender in the organisers' group is an organiser", () => {
    expect(ROUTER_SYSTEM_PROMPT).not.toMatch(/every sender is an organiser/i);
    const hq = ROUTER_SYSTEM_PROMPT.slice(ROUTER_SYSTEM_PROMPT.indexOf("IN THE ORGANISERS' GROUP."));
    expect(hq.split("\n")[0]).toMatch(/the header says whether this sender is one of them/);
    expect(hq.split("\n")[0]).toMatch(/code decides what each sender may do/);
  });

  it("a players' group organiser, in a club with partners: the partner line above the message", () => {
    const turn = renderRouterTurn([{ id: "a", authorName: "Raihan", body: "@Match Time ask Sutton", partnerClubs: ["Sutton FC", "MT Vets"] }], NOW);
    expect(turn).toBe(`${NOW_LINE}\n${partnerClubsLine(["Sutton FC", "MT Vets"])}\n[a] Raihan: @Match Time ask Sutton`);
    // Only the fact (2026-10-29): what finding players routes to is the
    // system prompt's, defined once there.
    expect(partnerClubsLine(["Sutton FC", "MT Vets"])).toBe("PARTNER CLUBS of this club: Sutton FC, MT Vets.");
  });

  // 2026-10-29: "@Match Time invite players from pool" routed offer half
  // the time; finding players is defined once, under admin_ops, and the
  // boundary with asking the group is one ruling.
  it("defines finding players (the pool, partner clubs, no place named) under admin_ops", () => {
    const admin = ROUTER_SYSTEM_PROMPT.split("\n").find((l) => l.startsWith("admin_ops "));
    expect(admin).toMatch(/find new players/);
    expect(admin).toMatch(/player pool/);
    expect(admin).toMatch(/partner club/);
    expect(admin).toMatch(/no place named/);
    const ruling = ROUTER_SYSTEM_PROMPT.split("\n").find((l) => l.startsWith("- Asking for a player"));
    expect(ruling).toMatch(/WHO is asked decides/);
    expect(ruling).toMatch(/offer/);
    expect(ruling).toMatch(/admin_ops/);
    // Question 1 only ever pushes towards attendance.
    expect(ROUTER_SYSTEM_PROMPT.split("\n").find((l) => l.startsWith("1. "))).not.toMatch(/admin_ops/);
    const hq = ROUTER_SYSTEM_PROMPT.split("\n").find((l) => l.startsWith("ask_group "));
    expect(hq).toMatch(/not admin_ops/);
  });

  it("keeps the live check's find-players wordings OUT of the prompt", () => {
    // ("can you find us a player" is HQ's ask_group example, since 2026-10-16.)
    for (const body of ["invite players from pool", "havuzdan oyuncu davet et", "@Match Time find us a player", "we need one more, anyone?"]) {
      expect(ROUTER_SYSTEM_PROMPT, body).not.toContain(body);
    }
  });

  it("the organisers' group turn is unchanged by partner clubs (slice S6)", () => {
    const withPartners = renderRouterTurn([{ id: "h", authorName: "Raihan", body: "x", organisers: { context: ["WAITING: nothing."] }, partnerClubs: ["Sutton FC"] }], NOW);
    const without = renderRouterTurn([{ id: "h", authorName: "Raihan", body: "x", organisers: { context: ["WAITING: nothing."] } }], NOW);
    expect(withPartners).toBe(without);
    expect(organisersHeader()).not.toMatch(/another club/);
  });

  it("no partner line without partners, and never in the organisers' group", () => {
    expect(renderRouterTurn([{ id: "a", authorName: "Ali", body: "in" }], NOW)).not.toContain("PARTNER CLUBS");
    expect(renderRouterTurn([{ id: "a", authorName: "Ali", body: "in", partnerClubs: [] }], NOW)).toBe(`${NOW_LINE}\n[a] Ali: in`);
    expect(renderRouterTurn([{ id: "h", authorName: "Raihan", body: "x", organisers: { context: [] }, partnerClubs: ["Sutton FC"] }], NOW)).not.toContain("PARTNER CLUBS of this club");
  });

  it("the partner line never carries a dash", () => {
    expect(partnerClubsLine(["A"])).not.toMatch(/[–—]/);
  });

  it("an organisers' route on a players' group message reads as unsure, never none; help reads as the question it is there (2026-10-28)", () => {
    for (const route of ["approve", "poster", "team_sheet", "help", "ask_group"]) {
      const r = parseRouterResponse(JSON.stringify({ routes: [{ id: "p", route }] }), ["p"]);
      expect(r.routes[0]).toMatchObject({ messageId: "p", route: route === "help" ? "question" : "unsure" });
      const hq = parseRouterResponse(JSON.stringify({ routes: [{ id: "h", route }] }), ["h"], new Set(["h"]));
      expect(hq.routes[0]).toMatchObject({ messageId: "h", route });
    }
  });

  it("the prompt defines the organisers' routes once, in their own section, after every players' rule", () => {
    const section = ROUTER_SYSTEM_PROMPT.indexOf("IN THE ORGANISERS' GROUP.");
    expect(section).toBeGreaterThan(ROUTER_SYSTEM_PROMPT.indexOf("RULINGS."));
    expect(ROUTER_SYSTEM_PROMPT.indexOf("RULINGS.")).toBeGreaterThan(0);
    for (const r of ["approve", "poster", "team_sheet", "help", "ask_group"]) {
      expect(ROUTER_SYSTEM_PROMPT.indexOf(`\n${r} `)).toBeGreaterThan(section);
    }
    // Code, not the model, decides who a YES was for.
    expect(ROUTER_SYSTEM_PROMPT).toMatch(/code checks who it was for/);
  });

  // QUOTED-REPLY CONTEXT, SLICE S4 (2026-10-20): a reply to ANYONE comes
  // under the DM block's "THEY ARE REPLYING TO" lines (`quotedLines`), in
  // both groups; it replaced the MatchTime-only "REPLYING TO" line.
  const BENCH = { author: null, at: null, text: "Football 9-a-side is full at 18 of 18, but the bench is open.", topic: null, match: null };

  it("a players' group reply to MatchTime comes under the shared reply lines", () => {
    expect(
      renderRouterTurn(
        [
          { id: "r", authorName: "Can", body: "Bench? We do bench now?", reply: BENCH },
          { id: "s", authorName: "Ali", body: "in" },
        ],
        NOW,
      ),
    ).toBe(
      `${NOW_LINE}\n` +
        "THEY ARE REPLYING TO a MatchTime message (when it was sent is not known):\n" +
        '"Football 9-a-side is full at 18 of 18, but the bench is open."\n' +
        "[r] Can: Bench? We do bench now?\n[s] Ali: in",
    );
  });

  it("a reply to a member's message names them, and its time", () => {
    const turn = renderRouterTurn(
      [{ id: "r", authorName: "Bo", body: "same", reply: { author: { name: "Ali Khan" }, at: new Date("2026-10-20T17:58:00Z"), text: "IN", topic: null, match: null } }],
      NOW,
    );
    expect(turn).toBe(`${NOW_LINE}\nTHEY ARE REPLYING TO Ali Khan's message of Tue 20 Oct, 18:58:\n"IN"\n[r] Bo: same`);
  });

  it("an organisers' reply: header, context, then the reply lines right above the message", () => {
    const turn = renderRouterTurn(
      [{ id: "h", authorName: "Raihan", body: "yes", organisers: { context: ["WAITING: nothing."] }, reply: { ...BENCH, text: "Teams ready" } }],
      NOW,
    );
    expect(turn).toBe(
      `${NOW_LINE}\n${organisersHeader()}\nWAITING: nothing.\nTHEY ARE REPLYING TO a MatchTime message (when it was sent is not known):\n"Teams ready"\n[h] Raihan: yes`,
    );
  });

  it("the router is shown at most 300 characters of the quoted words", () => {
    const turn = renderRouterTurn([{ id: "r", authorName: "Can", body: "?", reply: { ...BENCH, text: "y".repeat(400) } }], NOW);
    expect(turn).toContain(`"${"y".repeat(300)}"`);
    expect(turn).not.toContain("y".repeat(301));
  });

  it("the gate hands the quoted message to the router, and the time now", async () => {
    const m = fakeModel([JSON.stringify({ routes: [{ id: "m1", route: "question" }] })]);
    await gateBatch([{ waMessageId: "r", authorName: "Can", body: "Bench? We do bench now?", reply: { ...BENCH, text: "the bench is open" } }], {
      model: m,
      floor: false,
      now: NOW,
    });
    expect(m.calls[0].user).toBe(
      `${NOW_LINE}\nTHEY ARE REPLYING TO a MatchTime message (when it was sent is not known):\n"the bench is open"\n[m1] Can: Bench? We do bench now?`,
    );
  });

  it("the prompt defines replies once, and says a reply to MatchTime's own message is a tag where it defines a tag", () => {
    const replies = ROUTER_SYSTEM_PROMPT.slice(ROUTER_SYSTEM_PROMPT.indexOf("REPLIES."), ROUTER_SYSTEM_PROMPT.indexOf("WHAT IS AT STAKE."));
    expect(replies).toContain('"THEY ARE REPLYING TO"');
    expect(replies).toContain("NOW");
    expect(ROUTER_SYSTEM_PROMPT.split("THEY ARE REPLYING TO").length).toBe(2);
    expect(ROUTER_SYSTEM_PROMPT).not.toContain("REPLYING TO MatchTime");
    const q2 = ROUTER_SYSTEM_PROMPT.slice(ROUTER_SYSTEM_PROMPT.indexOf("2. Does it tag the bot?"), ROUTER_SYSTEM_PROMPT.indexOf("3. Is it for the bot"));
    // Players' group only: in HQ a quoted reply to MatchTime's teams is
    // what the safe-YES rule approves, and a first wording here made a
    // quoted "thanks 👍" route approve (live check, 2026-10-16).
    expect(q2).toMatch(/In the players' group, so is a reply to MatchTime's own message; a reply to a member's message is not/);
  });

  it("the model is sent the organisers' context and the routes enum includes theirs", async () => {
    const m = fakeModel([JSON.stringify({ routes: [{ id: "m1", route: "approve" }] })]);
    const r = await routeBatch(m, [{ id: "h", authorName: "R", body: "looks good", organisers: { context: ["WAITING: approval of the proposed teams for Fri 16 Oct, asked at 10:00."] } }], { floor: false });
    expect(r.routes[0].route).toBe("approve");
    expect(m.calls[0].user).toContain("WAITING: approval of the proposed teams");
  });
});

// ── 2026-10-20: ASKING WHEN THE TEAMS COME OUT IS A QUESTION ────────────
//
// Measured on main (dev key, Haiku 5.5): "@Match Time when will the teams be
// out?" routed balancer 4 of 10, "@Match Time takımlar ne zaman?" 2 of 3. A
// teams question routed balancer reaches the extractor that can GENERATE.
// The boundary, stated once: SEE or MAKE the teams is balancer; WHEN they
// come out or HOW they are picked is question.
describe("the two teams: seeing or making them is balancer, asking when is question", () => {
  const lines = ROUTER_SYSTEM_PROMPT.split("\n");
  const taught = new Map(
    [...ROUTER_SYSTEM_PROMPT.matchAll(/^\s*"([^"]+)"\s+->\s*([a-z_]+)\s*$/gm)].map((m) => [m[1]!, m[2]!]),
  );

  it("defines balancer as seeing or making the line-ups, and question as holding when the teams come out", () => {
    const balancer = lines.find((l) => l.startsWith("balancer "))!;
    expect(balancer).toMatch(/SEE or MAKE/);
    const question = lines.find((l) => l.startsWith("question "))!;
    expect(question).toMatch(/when the teams come out/);
    expect(question).toMatch(/how the teams are picked/);
  });

  it("states the boundary in one ruling, not on every route", () => {
    const rulings = lines.filter((l) => l.startsWith("- ") && /WHEN they come out/.test(l));
    expect(rulings).toHaveLength(1);
    expect(rulings[0]).toMatch(/balancer/);
    expect(rulings[0]).toMatch(/question/);
  });

  it("teaches both sides in one teams group, English and Turkish", () => {
    const start = lines.findIndex((l) => l.startsWith("The two teams"));
    const end = lines.findIndex((l, i) => i > start && l.trim() === "");
    const group = lines.slice(start + 1, end).map((l) => l.trim());
    expect(group).toContain('"Teams?" -> balancer');
    expect(group).toContain('"@Match Time takımları göster" -> balancer');
    expect(group).toContain('"@Match Time what time do the teams come out?" -> question');
    expect(group).toContain('"@Match Time takımlar saat kaçta açıklanıyor?" -> question');
  });

  it("keeps the measured incidents OUT of the prompt, so the live check is held out", () => {
    for (const body of ["when will the teams be out", "takımlar ne zaman?", "yöneticiler kim"]) {
      expect(ROUTER_SYSTEM_PROMPT, body).not.toContain(body);
    }
  });

  it("counts the bot's name used to speak to it as a tag, and talk ABOUT it as none", () => {
    const step = lines.find((l) => l.startsWith("2. "))!;
    expect(step).toMatch(/the bot's name used to speak to it/);
    expect(step).toMatch(/without the @ while talking ABOUT the bot/);
    expect(taught.get("MatchTime who runs this club?")).toBe("question");
  });

  it("in the organisers' group, asking the bot something is for the bot", () => {
    const hq = ROUTER_SYSTEM_PROMPT.slice(ROUTER_SYSTEM_PROMPT.indexOf("IN THE ORGANISERS' GROUP."));
    expect(hq.split("\n")[0]).toMatch(/only when it asks the bot for something it holds, tells the bot to do something, or answers/);
  });
});
