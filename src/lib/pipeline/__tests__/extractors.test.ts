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
      ]),
    );
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
  });

  it("admin", () => {
    const { facts } = parseFacts(
      "admin",
      '{"action":"bulk_payment","payerRef":"Amir","count":4,"coveredRefs":[]}',
      "wa-1",
    );
    expect(facts).toMatchObject({ kind: "admin", action: "bulk_payment", count: 4 });
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
    expect(out.degradations[0].detail).toMatch(/overloaded/);
    expect(out.degradations[0].stage).toBe("extractor");
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
