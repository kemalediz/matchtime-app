/**
 * LIVE CHECK: the attendance extractor (2026-10-20).
 *
 * Spends ANTHROPIC_API_KEY_DEV only (refuses without it). Runs the SHIPPED
 * extractor (`extractForRoute`, its prompt and the user turn production
 * builds) and grades the facts. It holds the cases the 2026-10-20 rewrite
 * was made for:
 *
 *   - Sutton FC, 2026-10-20 14:49 UTC: Kieran (confirmed, teams out) replied
 *     "I've got a bad hamstring so taking it easy" to Abid's "Mojib Habib and
 *     Kieran on same side". The live prompt read a sender OUT at 0.75 and the
 *     engine dropped him. An injury that does not say "I will not / cannot
 *     play" is not an out. The context is rebuilt from production rows.
 *   - fitness notes that still play, and true injury outs, English and
 *     Turkish, including ones the prompt does not quote;
 *   - #343 (Naim, FNF 2026-10-20): "@Match Time out" with the exact recent
 *     chat production showed, with and without his own raw-mention line;
 *   - the 2026-09-09 echo: a bare "In" under a run of other people's "In"s;
 *   - corpus S12 ("replace me and habibi") and S25 ("Confirmed" after a
 *     pending list), read at the extractor;
 *
 * and one case or more for every shape the prompt already reads. The
 * incident set runs RUNS times (default 3), the rest once.
 *
 * ARM=sonnet|haiku runs that model and thinking posture (`arm-model.ts`)
 * instead of the shipped one. PROMPT_FILE=<path> runs that system prompt
 * instead of the shipped one (the before/after arms). OUT=<path> writes
 * every call (latency, tokens, cost, confidence) as JSON.
 *
 * ZERO WRITES: no database client is imported.
 *
 *   node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-attendance-extractor.ts
 *   ARM=haiku ONLY=K1,I1 RUNS=1 node --env-file=.env ./node_modules/.bin/tsx scripts/live-check-attendance-extractor.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spendDevApiKeyOrExit } from "../e2e/helpers/dev-api-key.ts";
import { ARMS, armModel, latency } from "../e2e/helpers/arm-model.ts";
import { EXTRACTOR_CALLS, EXTRACTOR_PROMPTS, extractForRoute } from "../src/lib/pipeline/extractors.ts";
import type { ContextMessage } from "../src/lib/reply-context.ts";
import type { AttendanceFacts, Claim, Route } from "../src/lib/pipeline/types.ts";

spendDevApiKeyOrExit("scripts/live-check-attendance-extractor.ts");

const MAX_USD = 3;
const armName = process.env.ARM;
if (armName && !ARMS[armName]) throw new Error(`ARM must be one of ${Object.keys(ARMS).join(", ")}`);
const arm = armName ? ARMS[armName] : EXTRACTOR_CALLS.attendance;
if (process.env.PROMPT_FILE) EXTRACTOR_PROMPTS.attendance = readFileSync(process.env.PROMPT_FILE, "utf8");
const { model, calls, usd } = armModel(arm, MAX_USD);
const RUNS = Math.max(1, Number(process.env.RUNS ?? 3));

type Line = { author: string | null; body: string };
interface Case {
  id: string;
  body: string;
  /** Graded by `check`; `want` says what it wants, for the log. */
  check: (f: AttendanceFacts) => boolean;
  want: string;
  author?: string;
  route?: Route;
  tagged?: boolean;
  history?: Line[];
  lastBotPost?: string | null;
  reply?: ContextMessage | null;
  now?: Date;
  /** Runs RUNS times (the incident set) instead of once. */
  repeat?: boolean;
  /** The CLUB MEMBERS NAMED line (`membersNamedIn`), as the engine sends it. */
  members?: string[];
}

// ── Grading helpers ───────────────────────────────────────────────────
const self = (f: AttendanceFacts) => f.claims.filter((c) => c.subject === "sender");
const other = (f: AttendanceFacts, re: RegExp) => f.claims.filter((c) => c.subject === "other" && re.test(c.personRef));
const noSelfOut = (f: AttendanceFacts) => !self(f).some((c) => c.polarity === "out" || c.polarity === "bench");
const isOut = (c: Claim) => c.polarity === "out" && !c.contingent;
const selfIn = (f: AttendanceFacts) => self(f).some((c) => c.polarity === "in") && noSelfOut(f);
const selfOutDecided = (f: AttendanceFacts) => self(f).some(isOut) && !self(f).some((c) => c.polarity === "in");
const hedge = (f: AttendanceFacts) =>
  self(f).some((c) => c.polarity === "in" && c.contingent && c.conditionOn === "self") && noSelfOut(f);
const noClaims = (f: AttendanceFacts) => f.claims.length === 0;
/** The call for players the third-party-offer and guest-name-ask live specs replay (PROD_HISTORY). */
const SHORT_HISTORY: Line[] = [
  {
    author: "MatchTime",
    body:
      "🗓 *Tuesday 7-a-side* — Tue 1 Sept, 21:30 at Goals North Cheam.\n\n" +
      "*Confirmed (7/14):*\n1. Oscar Owner\n2. Alice Admin\n3. Pete Power\n4. Dan Drummer\n" +
      "5. Felix Fox\n6. Greg Gale\n7. Henry Hill\n\n" +
      "We need *7 more*. Reply *IN* to grab a spot.",
  },
  { author: "Ivan Ice", body: "IN" },
  { author: "Quinn Quick", body: "https://www.instagram.com/reel/DaClAuzs1eQ/" },
  { author: "Ryan Reef", body: "Happy Holiday" },
];
/** An offer to fill a gap is the bench, conditional on the squad (Kemal's ruling, 2026-10-21). */
const gapOffer = (f: AttendanceFacts) =>
  self(f).some((c) => c.polarity === "bench" && c.contingent && c.conditionOn === "squad" && c.basis === "decision") &&
  !self(f).some((c) => c.polarity !== "bench");

// ── The Sutton FC incident, rebuilt from production rows ──────────────
// AnalyzedMessage cmvgsuqu2002108l07n6x7pf4 and the eight lines before it
// in the group; the last group BotJob (17 Oct) is MatchTime's last post,
// as `loadSquadState` reads it. Production's user turn was 621 tokens.
const SUTTON_LAST_POST =
  "✅ *Squad complete (14/14)* for *Tuesday 7-a-side* on Tue 20 Oct 21:30 🙌\n\n*Playing:*\n1. Elnur Mammadov\n2. Mustafa Cayir\n3. Elvin\n4. Idris Yildiz\n5. Ozgur\n6. Yusuf Erdogan\n7. Wasim\n8. Yasin Inan\n9. Abid Kazmi\n10. Kieran\n11. Burak Yildiz\n12. Habib\n13. Sait\n14. Mojib\n\nSee you all there ⚽\n\n🪑 *Bench is open.* Say *IN* and I'll put you on the bench. If someone drops out I tag the bench here and the first to reply *IN* takes the slot.";
const SUTTON_HISTORY: Line[] = [
  { author: "Kemal Ediz", body: "if it is bad, then I will update his score" },
  { author: "Kemal Ediz", body: "@Yusuf Erdogan how fit are you?" },
  { author: "Erdal", body: "in @Match Time" },
  { author: "Yusuf Erdogan", body: "normal fit" },
  { author: "Abid Kazmi", body: "He looks young from his picture" },
  { author: "Kemal Ediz", body: "😀 he is nearly same age as me, hey I may look young in the photo too so nothing to comment 🙂" },
  { author: "Kemal Ediz", body: "@Match Time what is the squad right now?" },
  { author: "Kemal Ediz", body: "@Match Time regenerate the teams as I upgraded Yusuf's ratings." },
];
const SUTTON_NOW = new Date("2026-10-20T13:49:45Z");
const ABID_QUOTE: ContextMessage = {
  at: new Date("2026-10-20T13:44:11Z"),
  text: "Mojib Habib and Kieran on same side",
  topic: null,
  match: null,
  author: { name: "Abid Kazmi" },
};
const sutton = { author: "Kieran", history: SUTTON_HISTORY, lastBotPost: SUTTON_LAST_POST, now: SUTTON_NOW };

// ── #343: Naim, FNF 2026-10-20 (the exact production input) ───────────
const FNF_LAST = "We need 1 more player for Fri 20:30. Say *IN* and the organisers will pick who takes the place. I'll message you if it's you.";
const RAW = "@158055467598020 out";
const naim = { body: "@Match Time out", tagged: true, route: "self_att" as Route, lastBotPost: FNF_LAST, repeat: true };

// ── 2026-09-09: the echo context (`scripts/measure-claimless.ts`) ─────
const ECHO_LAST =
  "⏰ *Correction — kickoff is 21:15 tonight, not 21:30.* The 5-a-side starts 15 minutes earlier than the 7-a-side.\n\n⚽ *Teams for tonight* — 21:15 at Goals North Cheam\n\n*Red*:\n1. Mojib\n2. Burak Yildiz\n3. Habib\n4. Kieran\n5. Raihan\n\n*Yellow*:\n1. Kemal\n2. Mustafa Cayir\n3. Wasim\n4. Idris Yildiz\n5. Abid Kazmi";
const ECHO: Line[] = [
  { author: "Nunu", body: "in" },
  { author: "Wasimp", body: "In" },
  { author: "Abid Kazmi", body: "In" },
];
const echoCase = (id: string, body: string, bare: boolean): Case => ({
  id,
  body,
  author: "Mojib Jalali",
  route: "self_att",
  // The sender's own line is in the buffer, as the Pi forwards it.
  history: [...ECHO, { author: "Mojib Jalali", body }],
  lastBotPost: ECHO_LAST,
  check: bare ? noSelfOut : selfIn,
  want: bare ? "no out (a claimless read is right)" : "the sender in",
});

// ── Corpus S12 and S25, from e2e/corpus/incidents.jsonl ──────────────
interface CorpusCase {
  id: string;
  world: { lastBotPost?: string };
  history: Line[];
  messages: Array<{ from: string; body: string; tag?: boolean }>;
}
const corpus = readFileSync(new URL("../e2e/corpus/incidents.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((l) => l.trim().startsWith("{"))
  .map((l) => JSON.parse(l) as CorpusCase & { world: { players: Array<{ key: string; name: string }> } });
function fromCorpus(id: string, index = 0): Pick<Case, "body" | "author" | "tagged" | "history" | "lastBotPost"> {
  const c = corpus.find((x) => x.id === id);
  if (!c) throw new Error(`corpus case ${id} not found`);
  const m = c.messages[index];
  const author = c.world.players.find((p) => p.key === m.from)?.name ?? m.from;
  const last = c.world.lastBotPost ?? [...c.history].reverse().find((h) => h.author === "MatchTime")?.body ?? null;
  return { body: m.body, author, tagged: !!m.tag || /@Match Time/.test(m.body), history: c.history, lastBotPost: last };
}

const CASES: Case[] = [
  // ── The incident and its family (repeat) ───────────────────────────
  { id: "K1", ...sutton, body: "I’ve got a bad hamstring so taking it easy", route: "unsure", reply: ABID_QUOTE, repeat: true, check: noSelfOut, want: "no out: he is playing carefully" },
  { id: "I1", ...sutton, body: "bit sore from Sunday but I'll be there", route: "unsure", repeat: true, check: selfIn, want: "the sender in, never out" },
  { id: "I2", ...sutton, body: "dizim ağrıyor ama gelirim", route: "unsure", repeat: true, check: selfIn, want: "the sender in, never out" },
  { id: "I3", ...sutton, body: "hamstring's gone, can't make it tonight", route: "unsure", repeat: true, check: selfOutDecided, want: "the sender out, decided" },
  { id: "I4", ...sutton, body: "sakatım, gelemiyorum", route: "unsure", repeat: true, check: selfOutDecided, want: "the sender out, decided" },
  // Held out: not quoted in the prompt.
  { id: "H1", ...sutton, body: "calf is a bit tight, I'll just sit at the back tonight", route: "unsure", repeat: true, check: noSelfOut, want: "no out" },
  { id: "H2", ...sutton, body: "ayak bileğim biraz ağrıyor, idare ederim", route: "unsure", repeat: true, check: noSelfOut, want: "no out" },
  { id: "H3", ...sutton, body: "pulled my calf yesterday, I'm out tonight sorry lads", route: "unsure", repeat: true, check: selfOutDecided, want: "the sender out, decided" },
  { id: "H4", ...sutton, body: "bileğim sakatlandı, bu akşam oynayamam", route: "unsure", repeat: true, check: selfOutDecided, want: "the sender out, decided" },

  // ── #343 ───────────────────────────────────────────────────────────
  { id: "N1", ...naim, author: "Naim", history: [{ author: "Kieran", body: RAW }, { author: "Naim", body: RAW }], now: new Date("2026-10-20T10:36:38Z"), check: selfOutDecided, want: "the sender out (own raw line still shown)" },
  { id: "N2", ...naim, author: "Naim", history: [{ author: "Kieran", body: RAW }], now: new Date("2026-10-20T10:36:38Z"), check: selfOutDecided, want: "the sender out" },
  { id: "N3", ...naim, author: "Kieran", history: [{ author: "Kieran", body: RAW }], now: new Date("2026-10-20T10:30:42Z"), check: selfOutDecided, want: "the sender out" },

  // ── Corpus S12 and S25 ─────────────────────────────────────────────
  {
    id: "S12",
    ...fromCorpus("S12-mojib-replacement-request-drops-sender"),
    route: "self_att",
    repeat: true,
    check: (f) => selfOutDecided(f) && other(f, /habib/i).some(isOut),
    want: "the sender out AND habibi out, neither contingent",
  },
  {
    id: "S25",
    ...fromCorpus("S25-short-confirm-after-pending-list"),
    route: "unsure",
    repeat: true,
    check: (f) => f.affirmation === "yes" && noSelfOut(f),
    want: 'affirmation "yes"',
  },

  {
    id: "S1a",
    ...fromCorpus("S1-ibrahim-baki-verdict-coverage", 0),
    route: "self_att",
    repeat: true,
    check: selfOutDecided,
    want: "the sender out: a flu AND asking to be replaced",
  },
  {
    id: "S1b",
    ...fromCorpus("S1-ibrahim-baki-verdict-coverage", 1),
    route: "self_att",
    repeat: true,
    check: selfOutDecided,
    want: "the sender out",
  },
  {
    id: "S16b",
    ...fromCorpus("S16b-wasim-relays-najib"),
    route: "other_att",
    repeat: true,
    check: (f) => other(f, /najib/i).some((c) => c.polarity === "in" && !c.contingent && c.tense !== "past" && c.tense !== "hypothetical" && c.basis === "decision"),
    want: "Najib in, reported, a decision",
  },

  // A third party offered: the sender is not a claim (corpus A5, third-party-offer and guest-name-ask live specs).
  {
    id: "P5",
    ...fromCorpus("A5-amir-brother-ghost-user"),
    route: "offer",
    repeat: true,
    check: (f) => self(f).length === 0 && f.claims.some((c) => c.subject === "other" && !c.personNamed && c.polarity === "in"),
    want: "the brother in, unnamed; no claim for the sender",
  },
  { id: "G1", body: "I can bring someone if you're short", route: "offer", repeat: true, check: (f) => self(f).length === 0 && f.claims.some((c) => c.subject === "other" && !c.personNamed), want: "someone in, unnamed; no claim for the sender" },
  { id: "G2", body: "my mate could fill in if you're short", route: "offer", repeat: true, check: (f) => self(f).length === 0 && f.claims.some((c) => c.subject === "other" && !c.personNamed), want: "the mate, unnamed; no claim for the sender" },

  // Corpus S20, and S9's "Aydin can take my spot". The corpus harness shows the wall clock as NOW, so
  // on 2026-10-21 (Wednesday) S20's "Tue 21:30" post sat a day behind it; the bench-ruling draft then
  // read "two of my guys can play" at 0.6, under the 0.7 floor, and the guest name ask never ran.
  { id: "S20a", ...fromCorpus("S20-amir-two-of-my-guys"), route: "other_att", repeat: true, check: (f) => self(f).length === 0 && f.claims.some((c) => c.subject === "other" && !c.personNamed && c.polarity === "in" && c.confidence >= 0.7), want: "two guys in, unnamed, at the floor or above (the guest name ask runs before any contingency hold)" },
  { id: "S20b", ...fromCorpus("S20-amir-two-of-my-guys"), now: new Date("2026-10-21T04:02:00Z"), route: "other_att", repeat: true, check: (f) => self(f).length === 0 && f.claims.some((c) => c.subject === "other" && !c.personNamed && c.polarity === "in" && c.confidence >= 0.7), want: "the same, with NOW the day after the posted match day" },
  { id: "S9", ...fromCorpus("S9-aydin-promote-from-bench-no-hedge"), route: "other_att", repeat: true, check: (f) => selfOutDecided(f) && other(f, /aydin/i).some((c) => c.polarity === "in" && !c.contingent && c.confidence >= 0.7), want: "the sender out, Aydin in, not contingent" },

  // The same offers under the 7/14 call for players the third-party-offer and guest-name-ask live
  // specs show (2026-10-21: with this context the bench ruling's first draft benched the SENDER of
  // "I can bring someone", and read "my brother Shahrokh can play" as contingent, which holds it).
  { id: "G3", body: "I can bring someone if you need", history: SHORT_HISTORY, lastBotPost: SHORT_HISTORY[0].body, author: "Noah North", route: "offer", repeat: true, check: (f) => self(f).length === 0 && f.claims.some((c) => c.subject === "other" && !c.personNamed && c.polarity === "in"), want: "someone in, unnamed; no claim for the sender" },
  { id: "G4", body: "I can bring someone if you're short", history: SHORT_HISTORY, lastBotPost: SHORT_HISTORY[0].body, author: "Quinn Quick", route: "offer", repeat: true, check: (f) => self(f).length === 0 && f.claims.some((c) => c.subject === "other" && !c.personNamed && c.polarity === "in"), want: "someone in, unnamed; no claim for the sender" },
  { id: "G5", body: "my brother Shahrokh can play", history: SHORT_HISTORY, lastBotPost: SHORT_HISTORY[0].body, author: "Noah North", route: "other_att", repeat: true, check: (f) => self(f).length === 0 && other(f, /shahrokh/i).some((c) => c.polarity === "in" && !c.contingent && c.confidence >= 0.7), want: "Shahrokh in, not contingent, at the floor or above" },
  { id: "G6", body: "two of my guys can play", history: SHORT_HISTORY, lastBotPost: SHORT_HISTORY[0].body, author: "Amir Ahmadi", route: "other_att", repeat: true, check: (f) => self(f).length === 0 && f.claims.some((c) => c.subject === "other" && !c.personNamed && c.polarity === "in" && c.confidence >= 0.7), want: "two guys in, unnamed, at the floor or above (corpus S20)" },
  { id: "O9", body: "ping me if you need one more", history: SHORT_HISTORY, lastBotPost: SHORT_HISTORY[0].body, author: "Quinn Quick", route: "offer", repeat: true, check: gapOffer, want: "bench, contingent, squad, decision, under a 7/14 call" },

  // An offer to fill a gap puts the sender on the bench, contingent on the squad (Kemal's ruling,
  // 2026-10-21; third-party-offer live spec "ping me if you need one more"). Neither an in nor a maybe.
  { id: "O1", body: "ping me if you need one more", route: "offer", repeat: true, check: gapOffer, want: "bench, contingent, squad, decision" },
  { id: "O2", body: "I can play if you're short", route: "offer", repeat: true, check: gapOffer, want: "bench, contingent, squad, decision" },
  { id: "O3", body: "count me in if someone drops", route: "offer", repeat: true, check: gapOffer, want: "bench, contingent, squad, decision" },
  { id: "O4", body: "I'll be the 14th if you're short", route: "offer", repeat: true, check: gapOffer, want: "bench, contingent, squad, decision" },
  { id: "O5", body: "eksik olursa ben gelirim", route: "offer", repeat: true, check: gapOffer, want: "bench, contingent, squad, decision" },
  { id: "O6", body: "biri çıkarsa beni yazın", route: "offer", repeat: true, check: gapOffer, want: "bench, contingent, squad, decision" },
  { id: "O7", body: "happy to fill in if anyone drops out", route: "offer", repeat: true, check: gapOffer, want: "bench, contingent, squad, decision (held out)" },
  { id: "O8", body: "bir kişi lazım olursa söyleyin, oynarım", route: "offer", repeat: true, check: gapOffer, want: "bench, contingent, squad, decision (held out)" },

  // Side requests: a named gap is "recruit", a general nudge is "chase" (recruit-live "a plain shortage
  // ask from an admin fires the blast" and corpus S12b / PR33). The first draft of the rewrite read
  // "we're 4 short, anyone free?" as a chase on both models; the old prompt read it as recruit.
  { id: "SR1", body: "lads we're 4 short for tuesday, anyone free?", author: "Oscar Owner", route: "offer", repeat: true, check: (f) => self(f).length === 0 && f.sideRequests.includes("recruit"), want: "recruit, no claim for the sender" },
  { id: "SR1h", body: "lads we're 4 short for tuesday, anyone free?", history: SHORT_HISTORY, lastBotPost: SHORT_HISTORY[0].body, author: "Oscar Owner", route: "offer", repeat: true, check: (f) => self(f).length === 0 && f.sideRequests.includes("recruit"), want: "recruit, under MatchTime's own call for players" },
  { id: "SR2", body: "@all we need more players pls", author: "Kemal Ediz", route: "offer", repeat: true, check: (f) => self(f).length === 0 && f.sideRequests.includes("chase") && !f.sideRequests.includes("recruit"), want: "chase only, no claim for the sender" },
  { id: "SR3", body: "2 short for Friday, who can play?", author: "Oscar Owner", route: "offer", repeat: true, check: (f) => self(f).length === 0 && f.sideRequests.includes("recruit"), want: "recruit (held out)" },
  { id: "SR4", body: "salı için 3 kişi eksiğiz, gelebilecek var mı?", author: "Oscar Owner", route: "offer", repeat: true, check: (f) => self(f).length === 0 && f.sideRequests.includes("recruit"), want: "recruit (held out, Turkish)" },
  { id: "SR5", body: "come on lads, more players needed", author: "Oscar Owner", route: "offer", repeat: true, check: (f) => self(f).length === 0 && f.sideRequests.includes("chase") && !f.sideRequests.includes("recruit"), want: "chase only (held out)" },
  // ── FNF HQ 2026-10-24 13:47: a claim plus a question to MatchTime ────
  // The exact body, as HQ hands it to the engine (tagged, other_att, no
  // history; Glazers had left the club, so no CLUB MEMBERS NAMED line).
  // Production read the OUT and `sideRequests: []`.
  { id: "Q1", body: "Glazers is out now.\n\n@Match Time what is the list?", author: "Kemal Ediz", route: "other_att", tagged: true, repeat: true, check: (f) => other(f, /glazers/i).some(isOut) && f.sideRequests.includes("question"), want: "Glazers out, plus question (the incident)" },
  { id: "Q1tr", body: "Glazers yok artık.\n\n@Match Time liste ne?", author: "Kemal Ediz", route: "other_att", tagged: true, check: (f) => other(f, /glazers/i).some(isOut) && f.sideRequests.includes("question"), want: "Glazers out, plus question (Turkish)" },
  { id: "Q2", body: "Najib can't make it. @Match Time how many are we now?", author: "Oscar Owner", route: "other_att", tagged: true, check: (f) => other(f, /najib/i).some(isOut) && f.sideRequests.includes("question"), want: "Najib out, plus question (held out)" },
  { id: "Q3", body: "@Match Time Tom out", author: "Oscar Owner", route: "other_att", tagged: true, check: (f) => other(f, /tom/i).some(isOut) && !f.sideRequests.includes("question"), want: "Tom out, no question" },
  { id: "Q4", body: "Tom is out, @Sam are you free friday?", author: "Oscar Owner", route: "other_att", tagged: true, check: (f) => other(f, /tom/i).some(isOut) && !f.sideRequests.includes("question"), want: "Tom out, no question: it is put to Sam" },
  { id: "Q5", body: "Tom yok, @Ali cuma gelebilir misin?", author: "Oscar Owner", route: "other_att", tagged: true, check: (f) => other(f, /tom/i).some(isOut) && !f.sideRequests.includes("question"), want: "Tom out, no question: put to Ali (Turkish)" },

  // ── 2026-09-09 echo (once each) ────────────────────────────────────
  ...["In", "in", "IN", "I'm in", "im in", "In for Tuesday", "count me in", "count me", "add me", "put me down", "I'll play", "I'm there", "yes im in"].map((b, i) =>
    echoCase(`E${i + 1}`, b, false),
  ),
  ...["yes", "yep", "sure", "go on then", "👍", "ok"].map((b, i) => echoCase(`B${i + 1}`, b, true)),

  // ── Every shape the prompt already reads (once each) ───────────────
  { id: "A1", body: "I'm in", check: selfIn, want: "in" },
  { id: "A2", body: "varım", check: selfIn, want: "in" },
  { id: "A3", body: "can't make it this week", check: selfOutDecided, want: "out" },
  { id: "A4", body: "bu hafta yokum", check: selfOutDecided, want: "out" },
  { id: "A5", body: "me too", history: [{ author: "Ali Khan", body: "I'm in" }], check: selfIn, want: "the sender in" },
  { id: "A6", body: "ben de", history: [{ author: "Ali Khan", body: "ben varım" }], check: selfIn, want: "the sender in" },
  { id: "A7", body: "in, for bench", check: (f) => self(f).some((c) => c.polarity === "bench"), want: "bench" },
  { id: "A8", body: "yedeğe yaz beni", check: (f) => self(f).some((c) => c.polarity === "bench"), want: "bench" },
  { id: "A9", body: "in", history: [{ author: "MatchTime", body: SUTTON_LAST_POST }], lastBotPost: SUTTON_LAST_POST, author: "Mojib", check: (f) => self(f).some((c) => c.polarity === "in") && !self(f).some((c) => c.polarity === "bench"), want: "in, not bench, at 14/14" },
  { id: "A10", body: "varım", lastBotPost: SUTTON_LAST_POST, author: "Habib", check: (f) => self(f).some((c) => c.polarity === "in") && !self(f).some((c) => c.polarity === "bench"), want: "in, not bench, at 14/14" },
  { id: "B10", body: "I'm free Tuesday if you need me", check: (f) => self(f).length > 0 && self(f).every((c) => c.basis === "availability" || c.polarity === "out"), want: "availability" },
  { id: "B11", body: "I'm around if you're short", check: (f) => self(f).length > 0 && self(f).every((c) => c.basis === "availability"), want: "availability" },
  { id: "B12", body: "put me down if you're short", check: gapOffer, want: "bench, contingent, squad, decision" },
  { id: "B13", body: "count me as the 14th if you need one", check: gapOffer, want: "bench, contingent, squad, decision" },
  { id: "B14", body: "I'm free Tuesday, put me down", check: (f) => self(f).some((c) => c.polarity === "in" && c.basis === "decision"), want: "in, decision" },
  { id: "B15", body: "I will be back Tuesday week", check: (f) => !self(f).some((c) => c.polarity === "in" && c.basis === "decision"), want: "no decided in" },
  { id: "B16", body: "I'm in for next Tuesday", check: (f) => self(f).some((c) => c.polarity === "in" && c.basis === "decision"), want: "in, decision" },
  { id: "C1", body: "maybe", check: hedge, want: "the hedge" },
  { id: "C2", body: "belki", check: hedge, want: "the hedge" },
  { id: "C3", body: "50/50 for tuesday", check: hedge, want: "the hedge" },
  { id: "C4", body: "bakacağım", check: hedge, want: "the hedge" },
  { id: "C5", body: "I can drop out if it helps", check: (f) => self(f).some((c) => c.polarity === "out" && c.contingent && c.conditionOn === "squad"), want: "out, contingent, squad" },
  { id: "C6", body: "happy to drop if you find someone", check: (f) => self(f).some((c) => c.polarity === "out" && c.contingent), want: "out, contingent" },
  { id: "C7", body: "I'm out, anyone able to replace me?", check: (f) => selfOutDecided(f) && f.sideRequests.includes("recruit"), want: "out, not contingent, recruit" },
  { id: "C8", body: "kaleye geçerim", check: (f) => self(f).some((c) => c.polarity === "in" && !c.contingent), want: "in, contingent false" },
  { id: "C9", body: "in if my back holds up", check: (f) => self(f).some((c) => c.polarity === "in" && c.contingent), want: "in, contingent" },
  { id: "D1", body: "Ali said he's coming", check: (f) => other(f, /ali/i).some((c) => c.polarity === "in" && c.reported), want: "Ali in, reported" },
  { id: "D2", body: "Mehmet gelemiyor", check: (f) => other(f, /mehmet/i).some((c) => c.polarity === "out"), want: "Mehmet out" },
  {
    id: "D3",
    body: "he's out",
    reply: { at: new Date("2026-10-20T09:00:00Z"), text: "running late, see you there", topic: null, match: null, author: { name: "Ali Khan" } },
    check: (f) => other(f, /ali khan/i).some((c) => c.polarity === "out"),
    want: 'personRef "Ali Khan", out',
  },
  { id: "D4", body: "I'm in +1", check: (f) => selfIn(f) && f.claims.some((c) => c.subject === "other" && c.personRef.includes("+1") && !c.personNamed && c.polarity === "in"), want: "the sender in and a +1 guest" },
  { id: "D5", body: "I'm in, and my brother can play too", check: (f) => selfIn(f) && f.claims.some((c) => c.subject === "other" && !c.personNamed && c.polarity === "in"), want: "two claims, the brother unnamed" },
  { id: "R1", body: "Mojib is replacing Najib", check: (f) => other(f, /mojib/i).some((c) => c.polarity === "in" && /najib/i.test(c.replaces)) && other(f, /najib/i).some((c) => c.polarity === "out"), want: "Mojib in replaces Najib, Najib out" },
  { id: "R2", body: "Najib yerine Mojib", check: (f) => other(f, /mojib/i).some((c) => c.polarity === "in" && /najib/i.test(c.replaces)) && other(f, /najib/i).some((c) => c.polarity === "out"), want: "Mojib in replaces Najib, Najib out" },
  { id: "R3", body: "benim yerime Mojib oynayacak", check: (f) => other(f, /mojib/i).some((c) => c.polarity === "in" && /me|ben/i.test(c.replaces)) && self(f).some((c) => c.polarity === "out"), want: "Mojib in replaces me, the sender out" },
  { id: "R4", body: "Ali is coming, Mehmet can't make it", check: (f) => other(f, /ali/i).some((c) => c.polarity === "in" && !c.replaces) && other(f, /mehmet/i).some((c) => c.polarity === "out"), want: "two ordinary claims" },
  { id: "R5", body: "Hi guys, Mojib is replacing Najib on the list. We can change", check: (f) => other(f, /mojib/i).some((c) => c.polarity === "in" && /najib/i.test(c.replaces)), want: "Mojib in replaces Najib" },
  { id: "T1", body: "Zeeshan is out lol vote him out", check: (f) => other(f, /zeeshan/i).some((c) => c.polarity === "out"), want: "Zeeshan out" },
  { id: "T2", body: "I was in last week", check: (f) => !self(f).some((c) => c.tense !== "past" && c.tense !== "hypothetical"), want: "past only" },
  { id: "T3", body: "if I WAS in the team it would not be ruined", check: (f) => !self(f).some((c) => c.tense !== "past" && c.tense !== "hypothetical"), want: "hypothetical only" },
  { id: "T4", body: "count me in whenever you are short", check: (f) => gapOffer(f) && self(f).some((c) => c.tense === "future"), want: "bench, contingent, squad, future" },
  { id: "T5", body: "what time is kickoff?", check: noClaims, want: "no claims" },
  { id: "T6", body: "Mojib Habib and Kieran on same side", author: "Abid Kazmi", history: SUTTON_HISTORY.slice(0, 2), lastBotPost: SUTTON_LAST_POST, check: noClaims, want: "no claims" },
  { id: "T7", body: "we need one more for tuesday, anyone?", check: (f) => noSelfOut(f) && f.sideRequests.length > 0, want: "a side request, no claim for the sender" },
  // FNF HQ 2026-10-24: Glazers, a member added minutes earlier. Without the
  // CLUB MEMBERS NAMED line the extractor read no claim in either (2 of 2).
  ...[
    { id: "GZ1", body: "Glazers OUT" },
    { id: "GZ2", body: "Glazers out. I was just testing you" },
    // 12:41 and 12:42/12:46 UTC: no claim, and an out at 0.5-0.6 (held under HQ's 0.7 floor).
    { id: "GZ7", body: "Remove glazers" },
    { id: "GZ8", body: "Glazers out" },
  ].map((g) => ({
    ...g,
    author: "Abdul-Hafeez",
    route: "other_att" as Route,
    tagged: true,
    members: ["Glazers"],
    repeat: true,
    check: (f: AttendanceFacts) => other(f, /^glazers$/i).some((c) => isOut(c) && c.confidence >= 0.7) && noSelfOut(f),
    want: "Glazers out, at 0.7 or above (HQ's floor)",
  })),
  // FNF HQ 2026-10-24 12:52 UTC: "AH out", AH being the alias the club set
  // for Abdul-Hafeez. Production sent no CLUB MEMBERS NAMED line (AH0, the
  // input as it was); the line now shows the alias with the member's name.
  { id: "AH0", body: "AH out", author: "Raihan", route: "other_att", tagged: true, check: (f) => other(f, /^(ah|abdul-hafeez)$/i).some(isOut) && noSelfOut(f), want: "AH out (production's input, no line)" },
  { id: "AH0b", body: "AH IN", author: "Raihan", route: "other_att", tagged: true, check: (f) => other(f, /^(ah|abdul-hafeez)$/i).some((c) => c.polarity === "in") && self(f).length === 0, want: "AH in, not the sender (no line)" },
  // "ah" as the word, with no member listed: still the sender's own place.
  { id: "AH4", body: "ah ok, I'm in", check: (f) => selfIn(f) && f.claims.every((c) => c.subject === "sender"), want: "the sender in, no one called ah" },
  { id: "AH5", body: "Ah sorry lads can't make it tonight", check: (f) => selfOutDecided(f) && f.claims.every((c) => c.subject === "sender"), want: "the sender out, no one called ah" },
  ...[
    { id: "AH1", body: "AH out", polarity: "out" },
    { id: "AH2", body: "AH IN", polarity: "in" },
    { id: "AH3", body: "AH yok bu hafta", polarity: "out" },
  ].map((g) => ({
    id: g.id,
    body: g.body,
    author: "Raihan",
    route: "other_att" as Route,
    tagged: true,
    members: ["AH (Abdul-Hafeez)"],
    check: (f: AttendanceFacts) =>
      other(f, /^(ah|abdul-hafeez)$/i).some((c) => c.polarity === g.polarity && !c.contingent && c.confidence >= 0.7) && self(f).length === 0,
    want: `AH ${g.polarity}, not the sender, at 0.7 or above`,
  })),
  { id: "GZ3", body: "Glazers in", author: "Nasir", route: "other_att", tagged: true, members: ["Glazers"], check: (f) => other(f, /^glazers$/i).some((c) => c.polarity === "in") && self(f).length === 0, want: "Glazers in, not the sender" },
  // A listed member whose name is also an ordinary word is read as the word.
  { id: "GZ4", body: "will you play tonight?", members: ["Will Smith"], check: (f) => !other(f, /will/i).length, want: "no claim for Will" },
  { id: "GZ5", body: "Mark my words, it'll be wet on Friday", members: ["Mark Jones"], check: noClaims, want: "no claims" },
  { id: "GZ6", body: "Mark is out this week", members: ["Mark Jones"], route: "other_att", check: (f) => other(f, /mark/i).some(isOut), want: "Mark out" },
];

async function main() {
  const only = process.env.ONLY?.split(",");
  const cases = only ? CASES.filter((c) => only.includes(c.id)) : CASES;
  const results: Array<{ id: string; run: number; body: string; pass: boolean; got: unknown }> = [];
  for (const c of cases) {
    const runs = c.repeat ? RUNS : 1;
    for (let run = 1; run <= runs; run++) {
      const ex = await extractForRoute(model, c.route ?? "self_att", {
        id: `${c.id}-${run}`,
        body: c.body,
        authorName: c.author ?? "Can Demir",
        tagged: c.tagged ?? c.body.includes("@Match Time"),
        history: c.history ?? [],
        lastBotPost: c.lastBotPost ?? null,
        reply: c.reply ?? null,
        ...(c.members ? { members: c.members } : {}),
        now: c.now ?? new Date("2026-10-20T11:00:00Z"),
      });
      const f = ex.facts.kind === "attendance" ? ex.facts : null;
      const pass = !!f && c.check(f);
      const got = f
        ? {
            claims: f.claims.map((x) => `${x.subject === "sender" ? "sender" : x.personRef}:${x.polarity}${x.contingent ? `/cont-${x.conditionOn}` : ""}/${x.basis}/${x.tense}${x.replaces ? `/replaces=${x.replaces}` : ""}${x.reported ? "/reported" : ""}${x.personNamed ? "" : "/unnamed"}@${x.confidence}`),
            affirmation: f.affirmation,
            sideRequests: f.sideRequests,
          }
        : ex.degradations.map((d) => d.detail);
      results.push({ id: c.id, run, body: c.body, pass, got });
      console.log(`${pass ? "PASS" : "FAIL"}  ${c.id}${runs > 1 ? `#${run}` : ""}  ${JSON.stringify(c.body)}  ${JSON.stringify(got)}  (want ${c.want})`);
    }
  }
  const passed = results.filter((r) => r.pass).length;
  const lat = latency(calls);
  const empty = calls.filter((c) => c.empty).length;
  const maxOut = Math.max(0, ...calls.map((c) => c.outputTokens));
  const failedIds = [...new Set(results.filter((r) => !r.pass).map((r) => r.id))];
  console.log(
    `\n${passed}/${results.length} passed on ${arm.model}${process.env.PROMPT_FILE ? ` with ${process.env.PROMPT_FILE}` : ""}. ` +
      `Failing: ${failedIds.join(", ") || "none"}. ` +
      `Calls ${calls.length}, cost $${usd().toFixed(5)} ($${(usd() / Math.max(1, calls.length)).toFixed(6)}/call), ` +
      `p50 ${lat.p50} ms, p90 ${lat.p90} ms, empty ${empty}, max output ${maxOut} tokens (dev key).`,
  );
  if (process.env.OUT) writeFileSync(process.env.OUT, JSON.stringify({ model: arm.model, results, calls, p50: lat.p50, p90: lat.p90, usd: usd() }, null, 2));
  process.exit(passed === results.length ? 0 : 1);
}

void main();
