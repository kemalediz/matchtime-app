/**
 * F3, learned setup: A CLUB WITH NO GROUP DESCRIPTION IS READ AS MAIN
 * READS IT (review fix 4 of PR #238, 2026-10-12). A property test. No
 * model, no database.
 *
 * Slice D3 taught the rules about the description. For a club that has
 * none, exactly two things may differ from main:
 *   - the match fee, a suggestion kind main does not have;
 *   - the whole-word rule (review fix 2): a quote that cuts a word in
 *     half is no longer found.
 * The first version of the slice also dropped chat quotes that looked
 * like a masking placeholder ("I removed] him", "[link to pitch] here"),
 * which changed 735 of 4,000 generated plans. Chat is never masked.
 *
 * HOW MAIN IS HERE. `vendored/rules-main-2ebc4f6.ts` is main's rules.ts
 * at the slice's merge base, byte for byte except its four import paths
 * (a test cannot import across git refs). Both rule sets are given the
 * same generated model answers over the same chats:
 *
 *   PARITY    every quote is whole words of a message (or is not in the
 *             chat at all): the detection and the plan must be EQUAL to
 *             main's, the fee aside. 4,000 answers.
 *   STRICTER  quotes are cut anywhere, mid-word included: every quote
 *             today's rules keep is one main finds too, so they never
 *             accept evidence main would refuse. 4,000 answers.
 *
 * The generator is seeded: the same 8,000 answers every run.
 */
import { describe, expect, it } from "vitest";
import * as today from "../rules";
import * as main from "./vendored/rules-main-2ebc4f6";
import { loadFixture } from "./stubs";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Msg = { author: string; text: string; timestamp: string };

/** Chat lines that look like the masking's placeholders, or carry
 *  brackets, prices and formatting: all of them somebody's own words. */
const AWKWARD = [
  "I removed] him from the list",
  "[link to pitch] here lads",
  "number removed from the gate, use the side door",
  "[number removed] is what the bot wrote, odd",
  "email removed] sorry wrong chat",
  "Unpaid lads sit out, repaid ones play",
  "£6 each please, 7 a side, see you at 6",
  "*IN* for _Tuesday_ lads",
  'he said "same squad" again',
  "Kadro aynı, gelmeyenler ödeyecek",
];

const CHATS: Msg[][] = (["rolling", "organiser-picks", "deadlines", "first-come", "turkish", "description-stale"] as const).map((name, i) => {
  const h = loadFixture(name).history as Msg[];
  const extra = AWKWARD.map((text, j) => ({ author: `X${(i + j) % 4}`, text, timestamp: new Date(Date.UTC(2026, 8, 1 + j, 9 + i)).toISOString() }));
  return [...h, ...extra];
});

const SUMMARIES = ["The squad is the same every week", "Players confirm payment in the group", "x", "", "1234567 89", "organiser picks"];

function generator(seed: number, cutAnywhere: boolean) {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const int = (n: number) => Math.floor(rnd() * n);

  /** A quote from one message: whole tokens, or (cutAnywhere) any slice. */
  const quoteFrom = (h: Msg[]): string => {
    const text = pick(h).text;
    if (cutAnywhere && rnd() < 0.6) {
      const start = int(Math.max(1, text.length - 2));
      return text.slice(start, start + 3 + int(40));
    }
    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return text;
    const start = int(tokens.length);
    const span = tokens.slice(start, start + 1 + int(8)).join(rnd() < 0.2 ? "  " : " ");
    return rnd() < 0.15 ? span.toUpperCase() : span;
  };
  const evidence = (h: Msg[]): unknown[] => {
    const n = int(4);
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) {
      const r = rnd();
      if (r < 0.72) out.push(quoteFrom(h));
      else if (r < 0.82 && out.length > 0) out.push(out[out.length - 1]);
      else if (r < 0.94) out.push(pick(SUMMARIES));
      else out.push(pick([7, null, { quote: "in" }]));
    }
    return out;
  };
  /** Now and then, the messages that really state a price. */
  const feeEvidence = (h: Msg[]): unknown[] => {
    const priced = h.filter((m) => m.text.includes("£6"));
    return rnd() < 0.3 && priced.length > 0 ? [pick(priced).text, pick(priced).text] : evidence(h);
  };
  const conf = () => pick(["high", "high", "high", "medium", "low", "certain"]);
  const day = () => pick(["monday", "tuesday", "wednesday", "thursday", "friday", "none", "someday"]);
  const time = () => pick(["21:00", "20:00", "18:00", "10:00", "9:00", "none", "25:00", "23:30"]);

  return () => {
    const h = pick(CHATS);
    const answer = {
      regular_game: rnd() < 0.93,
      squad: { answer: pick(["rolling", "sign_up_each_week", "unclear"]), confidence: conf(), evidence: evidence(h) },
      open_places: { answer: pick(["organisers_pick", "first_to_ask", "unclear"]), confidence: conf(), evidence: evidence(h) },
      drop_out_deadline: { day: day(), time: time(), confidence: conf(), evidence: evidence(h) },
      list_published: { day: day(), time: time(), confidence: conf(), evidence: evidence(h) },
      payments: { answer: pick(["players_confirm_paying", "no_sign"]), confidence: conf(), evidence: evidence(h) },
      monthly_list: {
        answer: pick(["monthly_list", "no_sign", "no_sign", "no_sign"]),
        prepay_for_month: rnd() < 0.5,
        pay_as_you_go_fill_ins: rnd() < 0.5,
        credit_for_missed_games: rnd() < 0.5,
        confidence: conf(),
        evidence: evidence(h),
      },
      weekly_game: {
        day: day(),
        time: time(),
        venue: pick(["", "Goals North Cheam", "Hackney Marshes", "the cage"]),
        players_per_side: pick([0, 5, 6, 7, 14]),
        confidence: conf(),
        evidence: evidence(h),
      },
      match_fee: { amount: pick([0, 6, 7, 150]), currency: pick(["pounds", "other", "none"]), confidence: conf(), evidence: feeEvidence(h) },
    };
    const org = {
      rollingSquadEnabled: rnd() < 0.15,
      benchPickMode: rnd() < 0.15 ? "organiser" : "first-come",
      dropOutDeadlineDay: rnd() < 0.15 ? 1 : null,
      dropOutDeadlineTime: null as string | null,
      listPublishDay: null as number | null,
      listPublishTime: null as string | null,
      paymentTrackingEnabled: rnd() < 0.15,
      language: pick(["en", "tr"]),
      settingsSetByOrganiser: rnd() < 0.2 ? [pick(["rollingSquad", "benchPickMode", "dropOutDeadline", "listPublish", "paymentTracking", "language"])] : [],
    };
    if (org.dropOutDeadlineDay !== null) org.dropOutDeadlineTime = "21:00";
    const weeklyGame = rnd() < 0.9 ? { dayOfWeek: 1 + int(5), time: pick(["19:00", "20:00", "21:00"]), venue: pick(["Goals North Cheam", "Astro"]), playersPerSide: pick([5, 6, 7]) } : null;
    const activities = weeklyGame ? [{ dayOfWeek: weeklyGame.dayOfWeek, time: weeklyGame.time }] : [];
    return { h, answer, org, weeklyGame, activities };
  };
}

function both(c: ReturnType<ReturnType<typeof generator>>) {
  const dMain = main.parseDetection(c.answer, c.h)!;
  const dToday = today.parseDetection(c.answer, c.h, null)!;
  const pMain = main.planSetup({ detection: dMain, org: c.org, weeklyGame: c.weeklyGame, activities: c.activities, chatLanguage: null });
  const pToday = today.planSetup({ detection: dToday, org: c.org, weeklyGame: c.weeklyGame, activities: c.activities });
  return { dMain, dToday, pMain, pToday };
}

const N = 4_000;

describe("no description: today's rules against main's, on generated answers", () => {
  it(`PARITY: ${N} answers quoting whole words: the same detection and the same plan as main, the fee aside`, () => {
    const next = generator(20261012, false);
    let fees = 0;
    let switched = 0;
    let awkwardKept = 0;
    for (let i = 0; i < N; i++) {
      const c = next();
      const { dMain, dToday, pMain, pToday } = both(c);
      const { matchFee, ...rest } = dToday;
      expect(rest, `detection of answer ${i}`).toEqual(dMain);
      expect(JSON.stringify(dToday), `answer ${i}`).not.toContain("fromDescription");
      const fee = pToday.suggestions.filter((s) => s.key === "matchFee");
      expect({ ...pToday, suggestions: pToday.suggestions.filter((s) => s.key !== "matchFee") }, `plan of answer ${i}`).toEqual(pMain);
      fees += fee.length;
      switched += pMain.applied.length;
      if (matchFee.amount !== null && c.answer.match_fee.currency !== "pounds") throw new Error("a fee in another currency was kept");
      if (/removed\]|\[link|\*IN\*/.test(JSON.stringify(pToday))) awkwardKept++;
    }
    // The generator really exercises the rules: settings are switched,
    // fees are suggested, and the bracketed chat lines are quoted.
    expect(switched).toBeGreaterThan(200);
    expect(fees).toBeGreaterThan(0);
    expect(awkwardKept).toBeGreaterThan(20);
  });

  it(`STRICTER: ${N} answers cut anywhere: every quote today's rules keep is one main finds too`, () => {
    const next = generator(4242, true);
    let differ = 0;
    for (let i = 0; i < N; i++) {
      const c = next();
      const { dToday, pMain, pToday } = both(c);
      for (const k of ["squad", "openPlaces", "dropOutDeadline", "listPublished", "payments", "monthlyList", "weeklyGame"] as const) {
        // Each quote today keeps is one main finds too, taken alone. (The
        // two kept lists need not nest: dropping a mid-word quote early
        // leaves room for a later one.)
        for (const q of dToday[k].evidence) expect(main.verifyEvidence([q], c.h), `${k} of answer ${i}`).toEqual([q]);
      }
      if (JSON.stringify({ ...pToday, suggestions: pToday.suggestions.filter((s) => s.key !== "matchFee") }) !== JSON.stringify(pMain)) differ++;
    }
    // Mid-word cuts are common in this run, so the two must differ often.
    expect(differ).toBeGreaterThan(100);
  });
});
