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
        "personKind",
        "benchAsked",
        "polarity",
        "contingent",
        "conditionOn",
        "tense",
        "reported",
        "confidence",
      ]),
    );
  });

  it("has no `basis` field any more (2026-10-28)", () => {
    // Being free to play is the sender's offer (bench, contingent,
    // conditionOn squad), so the field that held such claims was retired.
    const claim = ATTENDANCE_SCHEMA.properties.claims as unknown as {
      items: { properties: Record<string, unknown>; required: string[] };
    };
    expect(claim.items.properties).not.toHaveProperty("basis");
    expect(claim.items.required).not.toContain("basis");
  });
});

describe("the extractor prompts ask for facts, not outcomes", () => {
  it("never mentions registering, benching-by-capacity, or replying", () => {
    for (const [route, prompt] of Object.entries(EXTRACTOR_PROMPTS)) {
      expect(prompt.toLowerCase(), route).not.toContain("registerattendance");
      expect(prompt.toLowerCase(), route).not.toContain("you decide");
      // A WhatsApp reply the MESSAGE is (quoted-reply context, slice S4) is
      // context; what is guarded here is MatchTime's own reply, which code
      // writes. So the reply-context vocabulary is set aside first.
      const ownReply = prompt
        .toLowerCase()
        .replace(/whatsapp reply|they are replying to|replying to|replied to|replies to|reply line|a reply (?:that|about)/g, "");
      expect(ownReply, route).not.toContain("reply");
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

  // FNF HQ 2026-10-24: a claim plus a question to MatchTime in one message.
  it("keeps a question and a team change (2026-10-30) as side requests, beside recruit and chase, and drops anything else", () => {
    const raw = JSON.stringify({ claims: [], affirmation: "none", sideRequests: ["question", "recruit", "teams", "chase", "bogus"] });
    expect((parseFacts("attendance", raw, "wa-1").facts as AttendanceFacts).sideRequests).toEqual(["question", "recruit", "teams", "chase"]);
    expect(ATTENDANCE_SCHEMA.properties.sideRequests.items.enum).toEqual(["recruit", "chase", "question", "teams"]);
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

  it("drops a `basis` the model still sends, without a degradation", () => {
    // A stub or an older model sending the retired field changes nothing:
    // the parser builds a new claim, so the key never travels on.
    const old = JSON.stringify({
      claims: [
        {
          subject: "sender",
          personRef: "",
          personNamed: false,
          polarity: "bench",
          contingent: true,
          conditionOn: "squad",
          tense: "future",
          basis: "availability",
          reported: false,
          confidence: 0.7,
        },
      ],
      affirmation: "none",
      sideRequests: [],
    });
    const { facts, degradations } = parseFacts("attendance", old, "wa-1");
    expect(degradations).toHaveLength(0);
    expect((facts as AttendanceFacts).claims[0]).not.toHaveProperty("basis");
    expect((facts as AttendanceFacts).claims[0]).toMatchObject({ polarity: "bench", contingent: true, conditionOn: "squad" });
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
    // Likewise `moves` (2026-10-16), an empty list for an older response.
    expect(facts).toMatchObject({ moves: [] });
  });

  it("teams carries MOVES: people to the other team, no side named (2026-10-16)", () => {
    // "swap Ali and Can" and "move Tom" name no colour, so they cannot be
    // `swaps` (absolute). The organisers' group turns them into a swap or
    // a move (`teamCommandFromFacts`).
    const { facts } = parseFacts(
      "teams",
      '{"action":"swap","includeRefs":[],"teamNames":[],"swaps":[],"moves":["Ali"," Can ",""],"pairings":[]}',
      "wa-1",
    );
    expect(facts).toMatchObject({ kind: "teams", action: "swap", swaps: [], moves: ["Ali", "Can"] });
  });

  it("teams carries SWAPSIDES and the SUGGEST action (2026-10-29, FNF HQ)", () => {
    // "swap everyone on bibs with non bibs" names nobody; "recommend swaps"
    // asks for a recommendation. Both came back as "Which players?" or nothing.
    const sides = parseFacts(
      "teams",
      '{"action":"swap","includeRefs":[],"teamNames":[],"swaps":[],"moves":[],"pairings":[],"swapSides":true}',
      "wa-1",
    );
    expect(sides.facts).toMatchObject({ kind: "teams", action: "swap", swapSides: true, moves: [] });
    const older = parseFacts("teams", '{"action":"swap","includeRefs":[],"teamNames":[],"swaps":[],"moves":["Ali"]}', "wa-1");
    expect(older.facts).toMatchObject({ swapSides: false });
    const suggest = parseFacts(
      "teams",
      '{"action":"suggest","includeRefs":[],"teamNames":[],"swaps":[],"moves":[],"pairings":[],"swapSides":false}',
      "wa-1",
    );
    expect(suggest.facts).toMatchObject({ kind: "teams", action: "suggest" });
    const schema = factsSchemaFor("balancer") as { required: string[]; properties: Record<string, { enum?: string[] }> };
    expect(schema.required).toContain("swapSides");
    expect(schema.properties.action.enum).toContain("suggest");
  });

  it("the teams prompt (2026-10-29 rewrite): a change to the teams as they stand is swap, never generate", () => {
    const p = EXTRACTOR_PROMPTS.teams;
    // Each field defined once, at the start of its own line.
    for (const field of ["includeRefs", "teamNames", "moves", "swaps", "pairings", "swapSides"]) {
      expect(p.split(`\n${field}\n`).length, field).toBe(2);
    }
    expect(p).toMatch(/"Ali and Habib on one team"[^\n]*-> swap, pairings \[\["Ali","Habib"\]\]/);
    expect(p).toMatch(/"swap everyone on bibs with non bibs"[^\n]*-> swap, swapSides true/);
    expect(p).toMatch(/"swap Rafi and Yorel, Mo and Akram"[^\n]*moves \["Rafi","Yorel","Mo","Akram"\]/);
    expect(p).toMatch(/"recommend swaps"[^\n]*-> suggest/);
    expect(p).toMatch(/"make the teams and put me and David on the same team" -> generate, pairings/);
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
    // the club's most-used command to a wording detail. Since the
    // 2026-10-20 rewrite each action is defined once, under `action`.
    const p = EXTRACTOR_PROMPTS.teams;
    expect(p).toMatch(/"generate"\s+work the line-ups out again[^\n]*even when the same message also asks for new names/);
    expect(p).toMatch(/"rename"\s+keep the same two line-ups/);
    // …and it still never picks the players itself, or guesses the sender.
    expect(p).toMatch(/You never pick the players/);
    expect(p).toMatch(/When the sender means themselves[^\n]*write "me"/);
    // Each action is defined in one place only.
    for (const action of ['"show"', '"generate"', '"rename"', '"swap"', '"suggest"']) {
      expect(p.split(`\n  ${action} `).length, action).toBe(2);
    }
  });

  it("the teams prompt makes up two names when the message asks MatchTime to pick them (teams-live Scenario 1)", () => {
    // "@Match Time generate the teams, you pick some fun team names" came
    // back with teamNames [] since the mega-prompt was deleted, so the
    // group got Red and Yellow. Team names are words for the group, not
    // a decision about the club's records: `sanitiseTeamNames` cleans and
    // caps whatever arrives.
    const p = EXTRACTOR_PROMPTS.teams;
    expect(p).toMatch(/teamNames[\s\S]*asks you to pick the names[^\n]*make up two short names/);
    expect(p).not.toMatch(/leaves teamNames empty/);
  });

  it("the teams prompt reads the Turkish commands the Turkish copy tells a group to type", () => {
    // `strings.tr.ts` quotes these forms; the teams extractor is the one
    // that has to read them. The Turkish forms sit beside the English
    // ones in the examples, grouped by the action they teach.
    const p = EXTRACTOR_PROMPTS.teams;
    expect(p).toMatch(/"takımları kur"[^\n]*"yeniden kur"[^\n]*-> generate/);
    expect(p).toMatch(/"takımları göster"[^\n]*-> show/);
    expect(p).toMatch(/"Ali ile Can'ı değiştir"[^\n]*moves \["Ali","Can"\]/);
    // The Turkish first person is written "me" so the engine's closed
    // list rebinds it; "ben" is also an English name, so it is not on it.
    expect(p).toMatch(/"beni"[^\n]*"me"/);
  });

  it("the admin prompt defines each action and each field once (2026-10-20 rewrite)", () => {
    // Before the rewrite the `stats_blast` rule ("YOU send it, not the
    // players") was stated in its definition, in a WHO DOES THE WORK
    // paragraph and again in four examples.
    const p = EXTRACTOR_PROMPTS.admin;
    for (const action of ["bulk_payment", "fee_waiver", "reminder", "recruit", "stats_blast", "other"]) {
      expect(p.split(`\n  "${action}" `).length, action).toBe(2);
    }
    for (const field of ["payerRef", "count", "coveredRefs", "undo", "matchDay", "pastGame", "phrase", "note", "lookbackMatches", "playersFrom", "clubRef"]) {
      expect(p.split(`\n  ${field} `).length, field).toBe(2);
    }
    expect(p).not.toMatch(/WHO DOES THE WORK/);
    expect(p).not.toMatch(/[–—]/);
    // English and Turkish side by side in the examples.
    expect(p).toMatch(/"Ali ve Can cuma günü ödemesin"/);
    expect(p).toMatch(/"Ali ücretsiz değil, ödesin"[^\n]*undo true/);
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

  // ── Slice S6 (2026-10-21): partner clubs asked in the organiser's words.
  // Two facts about the TEXT: the sender wants players from ANOTHER club,
  // and that club's name as written. Code looks the name up against the
  // club's active partners (`partner-ask-words-rules.ts`).

  it("admin · the S6 rewrite: partner clubs defined once, EN and TR examples, near misses", () => {
    const p = EXTRACTOR_PROMPTS.admin;
    expect(p).toMatch(/"Sutton'a sor bakalım oynayan var mı"[^\n]*clubRef "Sutton"/);
    expect(p).toMatch(/"search for players from our partner groups"[^\n]*playersFrom \["partners"\], clubRef ""/);
    expect(p).toMatch(/"Sutton were great last week"[^\n]*other/);
    expect(p).not.toMatch(/[–—]/);
  });

  // ── HQ outward actions (2026-10-22): FNF HQ, "@Kemal can we ask Sutton
  // group?" was a question to a person, read as an ask and posted in the
  // players' group. The extractor says who the message is spoken to; code
  // lets nothing leave HQ untagged unless it is spoken to MatchTime.

  it("admin · toMatchTime is defined once, with the incident and EN/TR near misses", () => {
    const p = EXTRACTOR_PROMPTS.admin;
    expect(p.split("\n  toMatchTime ").length).toBe(2);
    expect(p).toMatch(/"@Kemal can we ask Sutton group\?"[^\n]*toMatchTime false/);
    expect(p).toMatch(/"gruba soralım mı\?"[^\n]*toMatchTime false/);
    expect(p).toMatch(/"ask the group if anyone can play"[^\n]*toMatchTime true/);
  });

  it("admin · the schema requires toMatchTime", () => {
    const schema = factsSchemaFor("admin_ops") as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required).toContain("toMatchTime");
    expect(schema.properties.toMatchTime).toEqual({ type: "boolean" });
  });

  it("admin · toMatchTime true is carried; false or missing is not (fails closed)", () => {
    const base = '"payerRef":"","count":0,"coveredRefs":[],"undo":false,"matchDay":"","phrase":"","note":"","lookbackMatches":0,"playersFrom":"club","clubRef":""';
    expect(parseFacts("admin", `{"action":"recruit",${base},"toMatchTime":true}`, "wa-1").facts).toMatchObject({ toMatchTime: true });
    expect("toMatchTime" in parseFacts("admin", `{"action":"recruit",${base},"toMatchTime":false}`, "wa-1").facts).toBe(false);
    expect("toMatchTime" in parseFacts("admin", `{"action":"recruit",${base}}`, "wa-1").facts).toBe(false);
  });

  it("admin · a game whose time has gone (2026-10-28): pastGame required, carried only on a cancel or restore, and only when true", () => {
    const schema = factsSchemaFor("admin_ops") as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required).toContain("pastGame");
    expect(schema.properties.pastGame).toEqual({ type: "boolean" });
    const base = '"payerRef":"","count":0,"coveredRefs":[],"undo":false,"phrase":"","note":"","lookbackMatches":0,"playersFrom":"","clubRef":"","toMatchTime":true';
    expect(parseFacts("admin", `{"action":"cancel_match",${base},"matchDay":"Tuesday","pastGame":true}`, "wa-1").facts).toMatchObject({ action: "cancel_match", matchDay: "Tuesday", pastGame: true });
    expect(parseFacts("admin", `{"action":"restore_match",${base},"matchDay":"","pastGame":true}`, "wa-1").facts).toMatchObject({ pastGame: true });
    expect("pastGame" in parseFacts("admin", `{"action":"cancel_match",${base},"matchDay":"","pastGame":false}`, "wa-1").facts).toBe(false);
    expect("pastGame" in parseFacts("admin", `{"action":"recruit",${base},"matchDay":"","pastGame":true}`, "wa-1").facts).toBe(false);
    // The cancel examples, English and Turkish side by side, say which are past.
    expect(EXTRACTOR_PROMPTS.admin).toMatch(/"salı maçı yapılmadı"[^\n]*pastGame true/);
  });

  it("admin · the schema requires where the players come from, and the club named", () => {
    const schema = factsSchemaFor("admin_ops") as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required).toEqual(expect.arrayContaining(["playersFrom", "clubRef"]));
    // Every place named, as a list (2026-10-28: "partner clubs and the pool").
    expect(schema.properties.playersFrom).toEqual({ type: "array", items: { type: "string", enum: ["club", "partners", "pool"] } });
    expect(schema.properties.clubRef).toEqual({ type: "string" });
    // One source, one field: S6's boolean is gone from what the model fills.
    expect(schema.properties.partnerClubs).toBeUndefined();
  });

  it("admin · recruit from partner clubs: partnerClubs and the name as written", () => {
    const { facts } = parseFacts(
      "admin",
      '{"action":"recruit","payerRef":"","count":0,"coveredRefs":[],"undo":false,"matchDay":"","phrase":"","note":"","lookbackMatches":0,"playersFrom":"partners","clubRef":" Sutton "}',
      "wa-1",
    );
    expect(facts).toMatchObject({ kind: "admin", action: "recruit", partnerClubs: true, clubRef: "Sutton" });
  });

  it("admin · a club name implies another club whatever source came back", () => {
    const { facts } = parseFacts(
      "admin",
      '{"action":"recruit","payerRef":"","count":0,"coveredRefs":[],"undo":false,"matchDay":"","phrase":"","note":"","lookbackMatches":0,"playersFrom":"club","clubRef":"Friday MT Community"}',
      "wa-1",
    );
    expect(facts).toMatchObject({ partnerClubs: true, clubRef: "Friday MT Community" });
  });

  it("admin · the S6 facts are dropped on any action but recruit, and when empty", () => {
    const other = parseFacts(
      "admin",
      '{"action":"other","payerRef":"","count":0,"coveredRefs":[],"undo":false,"matchDay":"","phrase":"","note":"","lookbackMatches":0,"playersFrom":"partners","clubRef":"Sutton"}',
      "wa-1",
    ).facts;
    expect("partnerClubs" in other).toBe(false);
    expect("clubRef" in other).toBe(false);
    const own = parseFacts(
      "admin",
      '{"action":"recruit","payerRef":"","count":0,"coveredRefs":[],"undo":false,"matchDay":"","phrase":"","note":"","lookbackMatches":5,"playersFrom":"club","clubRef":""}',
      "wa-1",
    ).facts;
    expect("partnerClubs" in own).toBe(false);
    expect("clubRef" in own).toBe(false);
  });

  // ── Local player pool L10 (2026-10-24): the MatchTime player pool is a
  // third source of players, asked from the organisers' group.
  const recruitFrom = (from: string, clubRef = "", action = "recruit") =>
    parseFacts(
      "admin",
      `{"action":"${action}","payerRef":"","count":0,"coveredRefs":[],"undo":false,"matchDay":"","phrase":"","note":"","lookbackMatches":0,"playersFrom":"${from}","clubRef":"${clubRef}","toMatchTime":true}`,
      "wa-1",
    ).facts;

  it("admin · recruit from the pool: pool, never partner clubs", () => {
    const f = recruitFrom("pool");
    expect(f).toMatchObject({ kind: "admin", action: "recruit", pool: true });
    expect("partnerClubs" in f).toBe(false);
  });

  it("admin · the pool is never guessed: not with a club named, not on another action, not from the club or partners", () => {
    expect(recruitFrom("pool", "Sutton")).toMatchObject({ partnerClubs: true, clubRef: "Sutton" });
    expect("pool" in recruitFrom("pool", "Sutton")).toBe(false);
    expect("pool" in recruitFrom("pool", "", "other")).toBe(false);
    expect("pool" in recruitFrom("club")).toBe(false);
    expect("pool" in recruitFrom("partners")).toBe(false);
    expect("pool" in recruitFrom("")).toBe(false);
  });

  it("admin · the L10 rewrite: playersFrom defined once with its three sources, pool examples EN and TR, near misses", () => {
    const p = EXTRACTOR_PROMPTS.admin;
    for (const source of ["club", "partners", "pool"]) expect(p.split(`\n    "${source}" `).length, source).toBe(2);
    expect(p).toMatch(/"@Match Time ask the pool for a player" \/ "@Match Time havuzdan bir oyuncu bul" -> recruit, playersFrom \["pool"\]/);
    expect(p).toMatch(/"find someone nearby for tonight" \/ "bu akşam için yakınlardan birini bul" -> recruit, playersFrom \["pool"\]/);
    expect(p).toMatch(/"shall we try the pool\?" \/ "havuza soralım mı\?" -> other, toMatchTime false/);
    expect(p).not.toMatch(/partnerClubs/);
  });

  // ── 2026-10-28 (Kemal: "stricter"): where the players come from is read
  // from meaning, and a request that does not say is "unsaid", never the
  // club's own players by default. In HQ code then asks which is meant.

  it("admin · recruit, nowhere said: sourceUnsaid, never the pool or the partners", () => {
    const f = recruitFrom("unsaid");
    expect(f).toMatchObject({ kind: "admin", action: "recruit", sourceUnsaid: true });
    expect("pool" in f).toBe(false);
    expect("partnerClubs" in f).toBe(false);
  });

  it("admin · unsaid is dropped with a club named (another club), on another action, and for every named source", () => {
    expect(recruitFrom("unsaid", "Sutton")).toMatchObject({ partnerClubs: true, clubRef: "Sutton" });
    expect("sourceUnsaid" in recruitFrom("unsaid", "Sutton")).toBe(false);
    expect("sourceUnsaid" in recruitFrom("unsaid", "", "other")).toBe(false);
    for (const from of ["club", "partners", "pool", ""]) expect("sourceUnsaid" in recruitFrom(from), from).toBe(false);
  });

  it("admin · the 2026-10-28 rewrite: three places defined once, a list, the unsaid, several and the answer examples EN and TR", () => {
    const p = EXTRACTOR_PROMPTS.admin;
    for (const source of ["club", "partners", "pool"]) expect(p.split(`\n    "${source}" `).length, source).toBe(2);
    expect(p).not.toMatch(/"unsaid"/);
    expect(p).toMatch(/"we need 2 players for Thursday" \/ "perşembeye 2 kişi lazım" -> recruit, playersFrom \[\]/);
    expect(p).toMatch(/"@Match Time find us a player for Friday" \/ "@Match Time cumaya bir oyuncu bul" -> recruit, playersFrom \[\]/);
    expect(p).toMatch(/"find me players from partner clubs and the player pool" \/ "partnerlere ve havuza sor" -> recruit, playersFrom \["partners","pool"\]/);
    expect(p).toMatch(/"find us players everywhere" \/ "her yerden oyuncu bul" -> recruit, playersFrom \["club","partners","pool"\]/);
    expect(p).toMatch(/"the pool" \/ "havuza" -> recruit, playersFrom \["pool"\]/);
    expect(p).toMatch(/"partners please" \/ "partner kulüplere" -> recruit, playersFrom \["partners"\]/);
    expect(p).toMatch(/"the group" \/ "gruba sor" -> recruit, playersFrom \["club"\]/);
    expect(p).toMatch(/"both" \/ "ikisine de" -> recruit, playersFrom \["partners","pool"\]/);
    // The players' group, the regulars, past players: the club's own, as before.
    expect(p).toMatch(/"ask the group if anyone can play" \/ "MatchTime oyuncu grubuna sor" -> recruit, playersFrom \["club"\]/);
    expect(p).not.toMatch(/[–—]/);
  });

  // ── 2026-10-28, the Friday MT Community incident: "find me players feom
  // partner clubs and player pool" named two places and the field held one.
  const recruitFromList = (from: string[], clubRef = "", action = "recruit") =>
    parseFacts(
      "admin",
      `{"action":"${action}","payerRef":"","count":0,"coveredRefs":[],"undo":false,"matchDay":"","pastGame":false,"phrase":"","note":"","lookbackMatches":0,"playersFrom":${JSON.stringify(from)},"clubRef":"${clubRef}","toMatchTime":true}`,
      "wa-1",
    ).facts;

  it("admin · several places: each one, never sourceUnsaid", () => {
    const f = recruitFromList(["partners", "pool"]);
    expect(f).toMatchObject({ kind: "admin", action: "recruit", partnerClubs: true, pool: true });
    expect("ownClub" in f).toBe(false);
    expect("sourceUnsaid" in f).toBe(false);
    expect(recruitFromList(["club", "partners", "pool"])).toMatchObject({ ownClub: true, partnerClubs: true, pool: true });
    expect(recruitFromList(["club", "pool"])).toMatchObject({ ownClub: true, pool: true });
  });

  it("admin · a club named with the pool: the pool only when the partners are named too", () => {
    expect(recruitFromList(["partners", "pool"], "Sutton")).toMatchObject({ partnerClubs: true, pool: true, clubRef: "Sutton" });
    expect("pool" in recruitFromList(["pool"], "Sutton")).toBe(false);
  });

  it("admin · an empty list is nowhere said; a list on another action is dropped", () => {
    expect(recruitFromList([])).toMatchObject({ sourceUnsaid: true });
    const other = recruitFromList(["partners", "pool"], "", "other");
    for (const k of ["pool", "partnerClubs", "ownClub", "sourceUnsaid"]) expect(k in other, k).toBe(false);
  });

  it("admin · an unknown place in the list is ignored", () => {
    expect(recruitFromList(["moon"])).toMatchObject({ sourceUnsaid: true });
    expect(recruitFromList(["moon", "pool"])).toMatchObject({ pool: true });
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

  // ── 2026-10-28 (Kemal): two admin actions by WhatsApp. "Set the pitch"
  // ("@Match Time our pitch is Goals Sutton") and "try again" after a
  // refusal ("@Match Time added the venue location", MT Test 15:40 UTC,
  // which was read `other` and got the generic "I can't change that").
  const adminOf = (fields: Record<string, unknown>) =>
    parseFacts(
      "admin",
      JSON.stringify({
        action: "other",
        payerRef: "",
        count: 0,
        coveredRefs: [],
        undo: false,
        matchDay: "",
        pastGame: false,
        phrase: "",
        note: "",
        lookbackMatches: 0,
        playersFrom: [],
        clubRef: "",
        venueName: "",
        venueChoice: 0,
        toMatchTime: true,
        ...fields,
      }),
      "wa-1",
    ).facts;

  it("admin · set_venue carries the place as written, trimmed, and the list number only when one was picked", () => {
    expect(adminOf({ action: "set_venue", venueName: "  Goals Sutton " })).toMatchObject({ kind: "admin", action: "set_venue", venueName: "Goals Sutton" });
    expect("venueChoice" in adminOf({ action: "set_venue", venueName: "Goals Sutton" })).toBe(false);
    expect(adminOf({ action: "set_venue", venueName: "Goals Sutton", venueChoice: 2 })).toMatchObject({ venueChoice: 2 });
    // Not a whole positive number: no pick.
    for (const bad of [-1, 0, 1.5, Number.NaN]) expect("venueChoice" in adminOf({ action: "set_venue", venueName: "X", venueChoice: bad }), String(bad)).toBe(false);
  });

  it("admin · the venue fields are dropped on every other action", () => {
    for (const action of ["recruit", "other", "retry_ask"]) {
      const f = adminOf({ action, venueName: "Goals Sutton", venueChoice: 2 });
      expect("venueName" in f, action).toBe(false);
      expect("venueChoice" in f, action).toBe(false);
    }
  });

  it("admin · retry_ask is its own action, with nothing else carried", () => {
    const f = adminOf({ action: "retry_ask", playersFrom: ["pool"] });
    expect(f).toMatchObject({ kind: "admin", action: "retry_ask", toMatchTime: true });
    for (const k of ["pool", "partnerClubs", "sourceUnsaid", "ownClub"]) expect(k in f, k).toBe(false);
  });

  it("admin · the schema requires both venue fields", () => {
    const schema = factsSchemaFor("admin_ops") as { required: string[]; properties: Record<string, { enum?: string[] }> };
    expect(schema.required).toEqual(expect.arrayContaining(["venueName", "venueChoice"]));
    expect(schema.properties.action.enum).toEqual(expect.arrayContaining(["set_venue", "retry_ask"]));
  });

  it("admin · the 2026-10-28 rewrite: every action and field once, the pitch and try-again examples EN and TR", () => {
    const p = EXTRACTOR_PROMPTS.admin;
    for (const action of ["bulk_payment", "fee_waiver", "cancel_match", "restore_match", "reminder", "recruit", "stats_blast", "set_venue", "retry_ask", "other"]) {
      expect(p.split(`\n  "${action}" `).length, action).toBe(2);
    }
    for (const field of ["toMatchTime", "venueName", "venueChoice"]) expect(p.split(`\n  ${field} `).length, field).toBe(2);
    expect(p).toMatch(/"@Match Time our pitch is Goals Sutton" \/ "@Match Time sahamız Goals Sutton" -> set_venue, venueName "Goals Sutton"/);
    expect(p).toMatch(/"@Match Time added the venue location" \/ "@Match Time tamam ekledim" -> retry_ask/);
    expect(p).toMatch(/"done, try again" \/ "şimdi dene" -> retry_ask/);
    expect(p).toMatch(/"2" \/ "ikincisi" -> set_venue, venueName "Goals Sutton", venueChoice 2/);
    expect(p).not.toMatch(/[–—]/);
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
describe("a replacement is two claims with a direction (2026-09-22)", () => {
  const attendanceClaim = (over: Record<string, unknown>) => ({
    subject: "other",
    personRef: "Mojib",
    personNamed: true,
    polarity: "in",
    contingent: false,
    conditionOn: "none",
    tense: "present",
    reported: false,
    replaces: "",
    confidence: 0.95,
    ...over,
  });

  it("asks the model which way the replacement runs, in both languages", () => {
    const p = EXTRACTOR_PROMPTS.attendance;
    expect(p).toMatch(/replaces\s+ONLY on an "in" claim/);
    expect(p).toMatch(/is replacing/i);
    expect(p).toMatch(/in for/i);
    expect(p).toMatch(/takes .*place/i);
    expect(p).toContain("yerine geliyor");
    expect(p).toContain("yerini aliyor");
  });

  it("tells it to report NOTHING rather than guess a direction", () => {
    // The whole safety argument in one sentence: a wrong guess drops a
    // real player, and silence costs one retyped message.
    expect(EXTRACTOR_PROMPTS.attendance).toMatch(
      /CANNOT TELL WHICH OF THE TWO IS ARRIVING[^]*REPORT NO CLAIMS AT ALL/,
    );
  });

  it("carries `replaces` through on an arrival", () => {
    const body = JSON.stringify({
      claims: [attendanceClaim({ replaces: "Najib" })],
      affirmation: "none",
      sideRequests: [],
    });
    const { facts, degradations } = parseFacts("attendance", body, "wa-1");
    expect(degradations).toHaveLength(0);
    expect((facts as AttendanceFacts).claims[0].replaces).toBe("Najib");
  });

  it("trims it, and defaults it to empty when the model omits it", () => {
    const body = JSON.stringify({
      claims: [attendanceClaim({ replaces: "  Najib  " }), attendanceClaim({ replaces: undefined })],
      affirmation: "none",
      sideRequests: [],
    });
    const claims = (parseFacts("attendance", body, "wa-1").facts as AttendanceFacts).claims;
    expect(claims[0].replaces).toBe("Najib");
    expect(claims[1].replaces).toBe("");
  });

  it("DROPS it from an out or a bench claim: only an arrival replaces anyone", () => {
    const body = JSON.stringify({
      claims: [
        attendanceClaim({ polarity: "out", personRef: "Najib", replaces: "Mojib" }),
        attendanceClaim({ polarity: "bench", personRef: "Amir", replaces: "Mojib" }),
      ],
      affirmation: "none",
      sideRequests: [],
    });
    const claims = (parseFacts("attendance", body, "wa-1").facts as AttendanceFacts).claims;
    expect(claims.map((c) => c.replaces)).toEqual(["", ""]);
  });

  it("is a required field of the schema, so the model always answers it", () => {
    const claim = (ATTENDANCE_SCHEMA.properties.claims as { items: { properties: Record<string, unknown>; required: readonly string[] } }).items;
    expect(claim.properties.replaces).toEqual({ type: "string" });
    expect(claim.required).toContain("replaces");
  });
});

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
    const hedges = p.slice(p.indexOf("Hedges:"));
    expect(hedges).toMatch(/^Hedges:[^\n]*in, contingent true, conditionOn "self"/);
    expect(hedges).toMatch(/"maybe"[^\n]*\| "belki"/);
  });
});

describe("admin · season_break (2026-10-29, the prompt rewritten whole)", () => {
  it("is defined once, with its two fields once each, apart from a one-game cancel, EN and TR side by side", () => {
    const p = EXTRACTOR_PROMPTS.admin;
    expect(p.split(`\n  "season_break" `).length).toBe(2);
    for (const field of ["breakMonths", "playMonths"]) expect(p.split(`\n  ${field} `).length, field).toBe(2);
    expect(p).toMatch(/"@Match Time no football in December" \/ "@Match Time aralıkta maç yok" -> season_break, breakMonths \["2026-12"\]/);
    expect(p).toMatch(/"storm, no game Friday" \/ "bu hafta maç yok" -> cancel_match/);
    expect(p).not.toMatch(/[–—]/);
    const schema = factsSchemaFor("admin_ops") as { required: string[]; properties: Record<string, { enum?: string[] }> };
    expect(schema.properties.action.enum).toContain("season_break");
    expect(schema.required).toEqual(expect.arrayContaining(["breakMonths", "playMonths"]));
  });
});

// ── 2026-10-30, FNF HQ: an earlier set of teams back, a pasted sheet, and
//    whether the message is an instruction to MatchTime at all ─────────
describe("teams: restore, set, sides and toMatchTime (2026-10-30)", () => {
  const base = '"includeRefs":[],"teamNames":[],"swaps":[],"moves":[],"pairings":[],"swapSides":false';
  it("parses restore, and an instruction to MatchTime", () => {
    const { facts } = parseFacts("teams", `{"action":"restore",${base},"sides":{"red":[],"yellow":[]},"toMatchTime":true}`, "wa-1");
    expect(facts).toMatchObject({ kind: "teams", action: "restore", toMatchTime: true });
  });
  it("parses set with the two sides as written", () => {
    const { facts } = parseFacts(
      "teams",
      `{"action":"set",${base},"sides":{"red":["Ali"," Bilal",""],"yellow":["Tom"]},"toMatchTime":true}`,
      "wa-1",
    );
    expect(facts).toMatchObject({ kind: "teams", action: "set", sides: { red: ["Ali", "Bilal"], yellow: ["Tom"] } });
  });
  it("a remark is not an instruction; an older answer without the field is not one either", () => {
    expect(parseFacts("teams", `{"action":"swap",${base},"sides":{"red":[],"yellow":[]},"toMatchTime":false}`, "wa-1").facts).toMatchObject({ toMatchTime: false });
    expect(parseFacts("teams", `{"action":"swap",${base}}`, "wa-1").facts).toMatchObject({ toMatchTime: false, sides: { red: [], yellow: [] } });
  });
  it("the schema requires sides and toMatchTime and offers restore and set", () => {
    const schema = factsSchemaFor("balancer") as { required: string[]; properties: Record<string, { enum?: string[] }> };
    expect(schema.required).toEqual(expect.arrayContaining(["sides", "toMatchTime"]));
    expect(schema.properties.action.enum).toEqual(expect.arrayContaining(["restore", "set"]));
  });
  it("the prompt defines restore, set, sides and toMatchTime once each, with EN and TR examples", () => {
    const p = EXTRACTOR_PROMPTS.teams;
    for (const action of ['"restore"', '"set"']) expect(p.split(`\n  ${action} `).length, action).toBe(2);
    for (const field of ["sides", "toMatchTime"]) expect(p.split(`\n${field}\n`).length, field).toBe(2);
    expect(p).toMatch(/"these are the final teams"[^\n]*-> restore/);
    expect(p).toMatch(/"bunları kullan"[^\n]*-> restore/);
    expect(p).toMatch(/-> set, sides/);
    expect(p).toMatch(/"Ali and Habib on one team"[^\n]*-> swap, pairings \[\["Ali","Habib"\]\]/);
  });
});
