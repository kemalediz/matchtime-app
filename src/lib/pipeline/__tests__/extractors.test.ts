/**
 * STAGE 2 — extractors return FACTS, never decisions.
 *
 * §6.2: "Note what is ABSENT: no `intent`, no `registerAttendance`, no
 * `registerFor`, no `react`, no `reply`, no `reasoning`. There is no
 * field in which the model can express a decision, and no prose for a
 * regex to parse."
 *
 * These tests assert the parser and the schemas, not the model's
 * judgement — that is measured live, by the corpus. What can be pinned
 * deterministically is: the schema admits only facts; a malformed or
 * drifted response degrades loudly instead of half-parsing; and the
 * prompts never ask the model what SHOULD happen.
 */
import { describe, it, expect } from "vitest";
import {
  ATTENDANCE_SCHEMA,
  EXTRACTOR_PROMPTS,
  extractForRoute,
  factsSchemaFor,
  parseFacts,
} from "../extractors";
import type { ModelRequest, ModelResponse, PipelineModel } from "../llm";
import type { AttendanceFacts } from "../types";

function fakeModel(text: string | (() => never)): PipelineModel & { reqs: ModelRequest[] } {
  const reqs: ModelRequest[] = [];
  return {
    name: "fake",
    reqs,
    async complete(req): Promise<ModelResponse> {
      reqs.push(req);
      if (typeof text === "function") text();
      return {
        text: text as string,
        stopReason: "end_turn",
        usage: { inputTokens: 900, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: 0.0024,
        ms: 2100,
      };
    },
  };
}

const MSG = {
  id: "wa-1",
  body: "@Kemal Ediz my brother can play if needed",
  authorName: "Amir Ahmadi",
  tagged: false,
  history: [] as Array<{ author: string | null; body: string }>,
  lastBotPost: null as string | null,
};

// ── The schemas are facts-only ─────────────────────────────────────────

describe("the extractor schemas contain no decision", () => {
  const forbidden = [
    "intent",
    "registerAttendance",
    "registerFor",
    "react",
    "reply",
    "reasoning",
    "action",
  ];

  it.each(["self_att", "other_att", "offer", "question", "balancer", "score", "admin_ops", "unsure"])(
    "%s",
    (route) => {
      const schema = JSON.stringify(factsSchemaFor(route as never));
      for (const f of forbidden) {
        // `action` is legitimate on the TEAMS and ADMIN schemas: "show
        // vs generate", "a payment vs a reminder" are properties of what
        // the message ASKS FOR, not decisions about the squad. The
        // distinction that matters is that neither can express an
        // attendance write, and `registerFor` / `registerAttendance`
        // appear in no schema at all.
        if (f === "action" && (route === "balancer" || route === "admin_ops")) continue;
        expect(schema, `${route} schema mentions ${f}`).not.toContain(`"${f}"`);
      }
    },
  );

  it("the attendance schema requires every claim field", () => {
    const claim = ATTENDANCE_SCHEMA.properties.claims as unknown as {
      items: { required: string[] };
    };
    expect(claim.items.required).toEqual(
      expect.arrayContaining([
        "subject",
        "personRef",
        "personNamed",
        "polarity",
        "contingent",
        "conditionOn",
        "tense",
        "reported",
        "confidence",
        "basis",
      ]),
    );
  });

  it("`basis` is an enum with exactly two values, and neither is a decision", () => {
    // The field that separates "I'm in for next Tuesday" from "I will be
    // back Tuesday week". It says what the TEXT does — settles the
    // question, or reports availability — never what the engine should
    // do about it.
    const claim = ATTENDANCE_SCHEMA.properties.claims as unknown as {
      items: { properties: { basis: { enum: string[] } } };
    };
    expect(claim.items.properties.basis.enum).toEqual(["decision", "availability"]);
  });
});

describe("the extractor prompts ask for facts, not outcomes", () => {
  it("never mentions registering, benching-by-capacity, or replying", () => {
    for (const [route, prompt] of Object.entries(EXTRACTOR_PROMPTS)) {
      expect(prompt.toLowerCase(), route).not.toContain("registerattendance");
      expect(prompt.toLowerCase(), route).not.toContain("you decide");
      expect(prompt.toLowerCase(), route).not.toContain("reply");
    }
  });

  it("tells the attendance extractor that `bench` is a STATED preference", () => {
    // Capacity is the engine's job. If the extractor could infer BENCH
    // from a full squad, PR #27's invariant would be back in the model.
    expect(EXTRACTOR_PROMPTS.attendance).toMatch(/explicit/i);
  });

  it("defines `basis` as a property of the text, with both values named", () => {
    // The schema field is the fix; the prompt's job is only to say what
    // the two values mean, the same way it does for `polarity` and
    // `tense`. A rule of the form "do not register X" would be the
    // prose the redesign is moving away from.
    expect(EXTRACTOR_PROMPTS.attendance).toMatch(/\bbasis\b/);
    expect(EXTRACTOR_PROMPTS.attendance).toMatch(/"decision"/);
    expect(EXTRACTOR_PROMPTS.attendance).toMatch(/"availability"/);
  });
});

// ── Parsing ────────────────────────────────────────────────────────────

describe("parseFacts (attendance)", () => {
  const good = JSON.stringify({
    claims: [
      {
        subject: "other",
        personRef: "my brother",
        personNamed: false,
        polarity: "in",
        contingent: true,
        conditionOn: "squad",
        tense: "present",
        reported: false,
        confidence: 0.9,
      },
    ],
    affirmation: null,
    sideRequests: [],
  });

  it("parses the documented shape", () => {
    const { facts, degradations } = parseFacts("attendance", good, "wa-1");
    expect(degradations).toHaveLength(0);
    expect(facts).toMatchObject({
      kind: "attendance",
      claims: [{ subject: "other", personNamed: false, conditionOn: "squad" }],
    });
  });

  it("drops a claim with an unknown polarity and SAYS so (§11.3 schema drift)", () => {
    const drifted = JSON.stringify({
      claims: [
        { subject: "sender", personRef: "", personNamed: false, polarity: "maybe", contingent: false, conditionOn: "none", tense: "present", reported: false, confidence: 0.9 },
      ],
      affirmation: null,
      sideRequests: [],
    });
    const { facts, degradations } = parseFacts("attendance", drifted, "wa-1");
    expect((facts as AttendanceFacts).claims).toHaveLength(0);
    expect(degradations[0].detail).toMatch(/polarity/i);
  });

  it("coerces a missing boolean rather than inventing a true", () => {
    const partial = JSON.stringify({
      claims: [{ subject: "sender", personRef: "", polarity: "in", tense: "present", confidence: 0.9 }],
    });
    const { facts } = parseFacts("attendance", partial, "wa-1");
    const c = (facts as AttendanceFacts).claims[0];
    expect(c.personNamed).toBe(false);
    expect(c.contingent).toBe(false);
    expect(c.reported).toBe(false);
    expect(c.conditionOn).toBe("none");
  });

  it("clamps a confidence outside 0..1", () => {
    const odd = JSON.stringify({
      claims: [{ subject: "sender", personRef: "", polarity: "in", tense: "present", confidence: 42 }],
    });
    const { facts } = parseFacts("attendance", odd, "wa-1");
    expect((facts as AttendanceFacts).claims[0].confidence).toBe(1);
  });

  it("returns no facts and a degradation on unparseable output", () => {
    const { facts, degradations } = parseFacts("attendance", "sorry, I can't help", "wa-1");
    expect(facts.kind).toBe("none");
    expect(degradations).toHaveLength(1);
  });

  it("parses `basis` and keeps it verbatim", () => {
    const avail = JSON.stringify({
      claims: [
        {
          subject: "sender",
          personRef: "",
          personNamed: false,
          polarity: "in",
          contingent: false,
          conditionOn: "none",
          tense: "future",
          basis: "availability",
          reported: false,
          confidence: 0.7,
        },
      ],
      affirmation: "none",
      sideRequests: [],
    });
    const { facts, degradations } = parseFacts("attendance", avail, "wa-1");
    expect(degradations).toHaveLength(0);
    expect((facts as AttendanceFacts).claims[0].basis).toBe("availability");
  });

  it("falls back to `decision` on drift, and SAYS so", () => {
    // The permissive direction on purpose, and it is the same choice
    // `tense` and `conditionOn` already make: an unreadable value must
    // not silently start suppressing writes the pipeline makes today.
    // Structured output constrains the enum, so this is belt-and-braces
    // — but a silent behaviour change on a model upgrade is exactly the
    // §11.3 failure, so it is loud.
    const drifted = JSON.stringify({
      claims: [
        {
          subject: "sender",
          personRef: "",
          personNamed: false,
          polarity: "in",
          contingent: false,
          conditionOn: "none",
          tense: "present",
          basis: "maybe",
          reported: false,
          confidence: 0.9,
        },
      ],
      affirmation: "none",
      sideRequests: [],
    });
    const { facts, degradations } = parseFacts("attendance", drifted, "wa-1");
    expect((facts as AttendanceFacts).claims[0].basis).toBe("decision");
    expect(degradations.map((d) => d.detail).join(" ")).toMatch(/basis/i);
  });

  it("treats an ABSENT `basis` as a decision, silently — that is today's behaviour", () => {
    const partial = JSON.stringify({
      claims: [{ subject: "sender", personRef: "", polarity: "in", tense: "present", confidence: 0.9 }],
    });
    const { facts, degradations } = parseFacts("attendance", partial, "wa-1");
    expect((facts as AttendanceFacts).claims[0].basis).toBe("decision");
    expect(degradations).toHaveLength(0);
  });

  it("ignores any decision field the model smuggles in", () => {
    const smuggled = JSON.stringify({
      claims: [],
      affirmation: null,
      sideRequests: [],
      registerAttendance: "OUT",
      reply: "Dropping you now 👋",
    });
    const { facts } = parseFacts("attendance", smuggled, "wa-1");
    expect(JSON.stringify(facts)).not.toContain("registerAttendance");
    expect(JSON.stringify(facts)).not.toContain("Dropping you now");
  });
});

describe("parseFacts (other routes)", () => {
  it("question", () => {
    const { facts } = parseFacts(
      "question",
      '{"topic":"count","personRef":null,"statedCount":9}',
      "wa-1",
    );
    expect(facts).toEqual({ kind: "question", topic: "count", personRef: null, statedCount: 9 });
  });

  it("question with an unknown topic falls back to `other`, loudly", () => {
    const { facts, degradations } = parseFacts(
      "question",
      '{"topic":"vibes","personRef":null,"statedCount":null}',
      "wa-1",
    );
    expect(facts).toMatchObject({ topic: "other" });
    expect(degradations).toHaveLength(1);
  });

  it("score clamps and rejects nonsense", () => {
    const { facts } = parseFacts("score", '{"first":5,"second":3}', "wa-1");
    expect(facts).toMatchObject({ kind: "score", first: 5, second: 3 });
    const bad = parseFacts("score", '{"first":"lots","second":3}', "wa-1");
    expect(bad.facts.kind).toBe("none");
    expect(bad.degradations).toHaveLength(1);
  });

  it("teams", () => {
    const { facts } = parseFacts(
      "teams",
      '{"action":"show","includeRefs":[],"teamNames":null,"swaps":[]}',
      "wa-1",
    );
    expect(facts).toMatchObject({ kind: "teams", action: "show" });
    // A response predating `pairings` parses to an EMPTY list, not to
    // `undefined`: the engine iterates it unconditionally.
    expect(facts).toMatchObject({ pairings: [] });
  });

  // ── §10 step 8's additions to the teams extractor ───────────────────

  it("teams carries a PAIRING as a group of names, with no colour in it", () => {
    // "put me and David on the same team" is RELATIVE. Before this field
    // existed the only way to carry it was to make the model invent a
    // colour — exactly the class of model-authored fact §6.4 removes.
    const { facts } = parseFacts(
      "teams",
      '{"action":"generate","includeRefs":[],"teamNames":[],"swaps":[],' +
        '"pairings":[["me","David"],["Sait","Abid"]]}',
      "wa-1",
    );
    expect(facts).toMatchObject({
      kind: "teams",
      action: "generate",
      pairings: [
        ["me", "David"],
        ["Sait", "Abid"],
      ],
    });
  });

  it("teams drops a pairing of fewer than two people", () => {
    // A group of one constrains nothing; honouring it would pin somebody
    // to an arbitrary colour on the strength of a stray array.
    const { facts } = parseFacts(
      "teams",
      '{"action":"generate","includeRefs":[],"teamNames":[],"swaps":[],' +
        '"pairings":[["me"],[],["Sait","Abid"]]}',
      "wa-1",
    );
    expect(facts).toMatchObject({ pairings: [["Sait", "Abid"]] });
  });

  it("the teams schema requires pairings, so the model cannot omit it", () => {
    const schema = factsSchemaFor("balancer") as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toContain("pairings");
    expect(schema.properties.pairings).toEqual({
      type: "array",
      items: { type: "array", items: { type: "string" } },
    });
  });

  it("the teams prompt tells the model that generate wins over rename", () => {
    // The measured shape: "@Match Time generate the teams now, come up
    // with fun team names" must extract as `generate`, not `rename` —
    // `rename` is handed back, and handing that message back would lose
    // the club's most-used command to a wording detail.
    const p = EXTRACTOR_PROMPTS.teams;
    expect(p).toMatch(/If the line-ups have to be worked out again, it is "generate"/);
    expect(p).toMatch(/"rename" is ONLY for a message that wants the SAME two line-ups/);
    // …and it still never picks anything itself.
    expect(p).toMatch(/You never pick the teams/);
    expect(p).toMatch(/keep that word verbatim; do not guess their name/);
  });

  it("admin", () => {
    const { facts } = parseFacts(
      "admin",
      '{"action":"bulk_payment","payerRef":"Amir","count":4,"coveredRefs":[]}',
      "wa-1",
    );
    expect(facts).toMatchObject({ kind: "admin", action: "bulk_payment", count: 4 });
  });

  // ── §10 step 7 part 2's additions to the admin extractor ────────────
  //
  // `recruit` is the one admin action the mega-prompt could do that
  // nothing else could: "@Match Time message all players who played in
  // the last 5 matches and invite them" routes `admin_ops`, and before
  // this it came back as `other`. A route cannot leave the mega-prompt
  // while one of its real phrasings only works there.

  it("admin · recruit, with a lookback the message stated", () => {
    const { facts } = parseFacts(
      "admin",
      '{"action":"recruit","payerRef":"","count":0,"coveredRefs":[],"phrase":"","note":"","lookbackMatches":5}',
      "wa-1",
    );
    expect(facts).toMatchObject({ kind: "admin", action: "recruit", lookbackMatches: 5 });
  });

  it("admin · a lookback of 0 is DROPPED, not carried as a number", () => {
    // 0 is the schema's stand-in for "the message named no number", the
    // same convention `statedCount` uses. Carrying it through would make
    // the engine clamp 0 to 1 and blast a one-match window.
    const { facts } = parseFacts(
      "admin",
      '{"action":"recruit","payerRef":"","count":0,"coveredRefs":[],"phrase":"","note":"","lookbackMatches":0}',
      "wa-1",
    );
    expect(facts).toMatchObject({ kind: "admin", action: "recruit" });
    expect("lookbackMatches" in facts).toBe(false);
  });

  it("admin · a reminder keeps the phrase AS WRITTEN and the note beside it", () => {
    // §3.2 S22: the extractor hands back the words. `date-fns-tz`
    // resolves them, in `reminder-time.ts`, from an injected `now`.
    const { facts } = parseFacts(
      "admin",
      '{"action":"reminder","payerRef":"","count":0,"coveredRefs":[],"phrase":"tomorrow at 6","note":"bring the bibs","lookbackMatches":0}',
      "wa-1",
    );
    expect(facts).toMatchObject({
      kind: "admin",
      action: "reminder",
      phrase: "tomorrow at 6",
      note: "bring the bibs",
    });
  });

  it("admin · an unknown action still drops the whole shape rather than guessing", () => {
    const { facts, degradations } = parseFacts(
      "admin",
      '{"action":"refund","payerRef":"","count":0,"coveredRefs":[],"phrase":"","note":"","lookbackMatches":0}',
      "wa-1",
    );
    expect(facts.kind).toBe("none");
    expect(degradations).toHaveLength(1);
  });
});

// ── The call ───────────────────────────────────────────────────────────

describe("extractForRoute", () => {
  it("never calls the model for a `none` route — that is the whole saving", async () => {
    const model = fakeModel("{}");
    const out = await extractForRoute(model, "none", MSG);
    expect(model.reqs).toHaveLength(0);
    expect(out.facts.kind).toBe("none");
  });

  it("routes self_att, other_att, offer and unsure to the SAME attendance extractor", async () => {
    const model = fakeModel('{"claims":[],"affirmation":null,"sideRequests":[]}');
    for (const route of ["self_att", "other_att", "offer", "unsure"] as const) {
      await extractForRoute(model, route, MSG);
    }
    expect(model.reqs).toHaveLength(4);
    expect(new Set(model.reqs.map((r) => r.system)).size).toBe(1);
  });

  it("degrades loudly when the model call throws", async () => {
    const model = fakeModel(() => {
      throw new Error("overloaded");
    });
    const out = await extractForRoute(model, "self_att", MSG);
    expect(out.facts.kind).toBe("none");
    expect(out.degradations.at(-1)!.detail).toMatch(/overloaded/);
    expect(out.degradations.at(-1)!.stage).toBe("extractor");
  });

  // ── §10 STEP 8 — ONE RETRY, AND ONLY ON THE ATTENDANCE ROUTES ──────
  //
  // `llm.ts` already raises the SDK's retries to 4, and its comment says
  // why: "the failure mode of a call that gives up is a player who said
  // IN not being in the squad… It is the FIRST of two defences:
  // `attendance-engine-batch.ts` hands a message whose extraction still
  // failed BACK TO THE ANALYZER rather than letting it go silent."
  //
  // Step 8 deletes the second defence. There is no analyzer, so an
  // extraction that fails now means silence plus an operator note — for
  // a message the router already decided was attendance-shaped.
  //
  // The SDK's retries cover 408/409/429/5xx. They do NOT cover the other
  // half: a response the strict schema rejects, or one `parseFacts`
  // cannot read. That failure is non-deterministic in exactly the way a
  // fresh call fixes, and §11.1's asymmetry prices it — "a false
  // positive costs one extractor call (~$0.002); a false negative costs
  // a player their slot."
  //
  // ONE retry, not two: past the second attempt the cause is almost
  // certainly the message itself, and the honest answer is the operator
  // note rather than a third bill and another two seconds.
  describe("the attendance extractor retries once, and nothing else does", () => {
    function flakyModel(failures: number, then: string): PipelineModel & { calls: number } {
      let calls = 0;
      const m = {
        name: "flaky",
        get calls() {
          return calls;
        },
        async complete(): Promise<ModelResponse> {
          calls++;
          if (calls <= failures) throw new Error("529 Overloaded");
          return {
            text: then,
            stopReason: "end_turn",
            usage: { inputTokens: 900, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 },
            costUsd: 0.0024,
            ms: 2100,
          };
        },
      };
      return m as PipelineModel & { calls: number };
    }

    const GOOD = '{"claims":[],"affirmation":null,"sideRequests":[]}';

    it.each(["self_att", "other_att", "offer", "unsure"] as const)(
      "recovers a %s extraction that failed once",
      async (route) => {
        const model = flakyModel(1, GOOD);
        const out = await extractForRoute(model, route, MSG);
        expect(model.calls).toBe(2);
        expect(out.facts.kind).toBe("attendance");
      },
    );

    it("gives up after the second attempt and reports BOTH failures", async () => {
      const model = flakyModel(2, GOOD);
      const out = await extractForRoute(model, "self_att", MSG);
      expect(model.calls).toBe(2);
      expect(out.facts.kind).toBe("none");
      // The operator sees that it was tried twice; "it failed" and "it
      // failed twice in a row" are different signals about the same
      // minute, and only the second one says the model is having a bad
      // time rather than the message being odd.
      expect(out.degradations.at(-1)!.detail).toMatch(/twice/i);
    });

    it.each(["question", "balancer", "score", "admin_ops"] as const)(
      "does NOT retry %s — a missed answer is recoverable in one message",
      async (route) => {
        const model = flakyModel(1, GOOD);
        const out = await extractForRoute(model, route, MSG);
        expect(model.calls, `${route} retried; only the write path should`).toBe(1);
        expect(out.facts.kind).toBe("none");
      },
    );

    it("never retries a call that SUCCEEDED", async () => {
      const model = flakyModel(0, GOOD);
      await extractForRoute(model, "self_att", MSG);
      expect(model.calls).toBe(1);
    });
  });

  it("sends a strict JSON schema and a capped max_tokens", async () => {
    const model = fakeModel('{"claims":[],"affirmation":null,"sideRequests":[]}');
    await extractForRoute(model, "self_att", MSG);
    expect(model.reqs[0].schema).toBeDefined();
    expect(model.reqs[0].maxTokens).toBeLessThanOrEqual(16_384);
  });

  it("gives the extractor the message and its context, but NEVER the squad state", async () => {
    // If the extractor could see the squad it could infer BENCH from
    // capacity, and PR #27's invariant would be back inside the model.
    const model = fakeModel('{"claims":[],"affirmation":null,"sideRequests":[]}');
    await extractForRoute(model, "self_att", {
      ...MSG,
      history: [{ author: "Shaz Iqbal", body: "IN" }],
      lastBotPost: "Pending — waiting for confirmation: Faris Nasser",
    });
    const user = model.reqs[0].user;
    expect(user).toContain("my brother can play if needed");
    expect(user).toContain("Shaz Iqbal");
    expect(user).toContain("Pending");
    expect(user).not.toMatch(/\d+\/14/);
    expect(user.toLowerCase()).not.toContain("confirmed (");
  });
});

// ── The message is not its own context (2026-09-09) ────────────────────
//
// The Pi records every inbound message into its history buffer BEFORE
// buffering it for the flush, and sends the whole buffer with the batch.
// So `history` arrives here already containing the messages being
// extracted, and each one was shown its own text twice: once under
// "RECENT CHAT", once under "THE MESSAGE".
//
// That duplication is what made a bare "In" non-deterministic — the
// model reads the second copy as an echo of the first and returns
// `claims: []` with `affirmation: "yes"`. Measured on the live model,
// 20 runs each: 14/20 claimless with the echo, 0/20 without it. Two
// players lost their place to it on 2026-09-09.
describe("the recent chat never contains the message being extracted", () => {
  const echoModel = () => fakeModel('{"claims":[],"affirmation":"none","sideRequests":[]}');

  it("drops the sender's own duplicate line from RECENT CHAT", async () => {
    const model = echoModel();
    await extractForRoute(model, "self_att", {
      ...MSG,
      body: "In",
      authorName: "Mojib Jalali",
      history: [
        { author: "Wasimp", body: "In" },
        { author: "Mojib Jalali", body: "In" },
      ],
    });
    const user = model.reqs[0].user;
    // Wasim's identical word is real context and survives; the sender's
    // own copy of the message under extraction does not.
    expect(user).toContain("Wasimp: In");
    expect(user).not.toContain("Mojib Jalali: In");
    expect(user).toContain("THE MESSAGE (from Mojib Jalali)");
  });

  it("keeps an identical line from a DIFFERENT person", async () => {
    const model = echoModel();
    await extractForRoute(model, "self_att", {
      ...MSG,
      body: "In",
      authorName: "Mojib Jalali",
      history: [{ author: "Abid Kazmi", body: "In" }],
    });
    expect(model.reqs[0].user).toContain("Abid Kazmi: In");
  });

  it("keeps a DIFFERENT line from the same person", async () => {
    const model = echoModel();
    await extractForRoute(model, "self_att", {
      ...MSG,
      body: "In",
      authorName: "Mojib Jalali",
      history: [{ author: "Mojib Jalali", body: "what time is kickoff?" }],
    });
    expect(model.reqs[0].user).toContain("Mojib Jalali: what time is kickoff?");
  });

  it("omits the RECENT CHAT block entirely when the echo was all there was", async () => {
    const model = echoModel();
    await extractForRoute(model, "self_att", {
      ...MSG,
      body: "In",
      authorName: "Mojib Jalali",
      history: [{ author: "Mojib Jalali", body: "In" }],
    });
    expect(model.reqs[0].user).not.toContain("RECENT CHAT");
  });
});

// ── Turkish (2026-09-16) ───────────────────────────────────────────────
describe("the attendance extractor reads Turkish", () => {
  it("says the message may be Turkish and names the claim shapes in it", () => {
    const p = EXTRACTOR_PROMPTS.attendance;
    expect(p).toMatch(/Turkish/);
    for (const w of ["varım", "yokum", "belki", "bakarız", "kesin değil", "ben de", "kaleye geçerim"]) {
      expect(p, w).toContain(w);
    }
  });

  it("defines a bare hedge — English or Turkish — as a contingent claim on the sender's own state", () => {
    // `tentativeUserId` in attendance-engine-batch.ts records a maybe from
    // exactly this shape: subject sender, contingent true, conditionOn
    // "self", polarity not out. A hedge the extractor returns as an empty
    // claims array is a maybe the 24h follow-up DM never chases.
    const p = EXTRACTOR_PROMPTS.attendance;
    expect(p).toMatch(/"maybe"/);
    expect(p).toMatch(/maybe[^\n]*belki[^\n]*contingent/i);
  });
});
