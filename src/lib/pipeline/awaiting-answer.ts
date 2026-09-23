/**
 * "IS MATCHTIME STILL WAITING FOR AN ANSWER?" — THE ONE FACT THE ROUTER
 * WAS MISSING.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE GAP THIS CLOSES
 * ─────────────────────────────────────────────────────────────────────
 *
 * PR #42 put the router in front of the analyzer, default off, and
 * measured it over all 1,695 production messages that have a body. It
 * routes 80.8% of benign traffic to `none` and would skip the analyzer
 * on 44% of batches. Exactly **two messages of 1,695 (0.12%)** are an
 * attendance write the gate would have lost, and both are the same
 * thing: **a bare `👍`**.
 *
 * ⚠️ READ THAT MEASUREMENT IN ITS OWN TENSE. It was taken while the
 * analyzer existed and "skipped the analyzer" was the thing being
 * counted. §10 step 8 deleted `analyzeBatch`, the 19,850-token
 * `SYSTEM_PROMPT` and `executeVerdict`, so what a `none` route skips now
 * is EVERY OWNER: the message is answered by nobody, and only an
 * operator DM records it (`route.ts`'s "NOBODY OWNED IT" branch, `lib/operator-note.ts`). The
 * numbers below are unchanged and still the reason this file exists —
 * what changed is the price of the two it rescues. Each was a player's
 * slot then and is a player's slot now, but nothing else is looking any
 * more. `pipeline/gate.ts` carries the full argument.
 *
 *   1. 2026-05-05T07:45:08.806Z, Aydın Kocahal, `👍` → production wrote
 *      `IN`. It answered the `PendingBenchConfirmation` MatchTime had
 *      opened for him 32 minutes earlier.
 *   2. 2026-06-15T20:50:09.796Z, Aydın Kocahal, `👍` → production wrote
 *      `IN`. It claimed the `BenchSlotOffer` opened 10 minutes earlier
 *      when Ehtisham Ul Haq dropped.
 *
 * PR #42's own conclusion: *"the floor cannot cover it without becoming
 * a classifier again."* That is right, and it is why there is no `👍`
 * pattern anywhere in this file.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY A ROW AND NOT A REGEX
 * ─────────────────────────────────────────────────────────────────────
 *
 * A bare `👍` means NOTHING on its own. Over the same history it is
 * banter far more often than it is a registration — `👍👍` and
 * `🙏🙏🙏👍` from Nabeel on 2026-06-18, `👍` from David on 2026-07-14,
 * every one of them `noise`. A floor entry matching `👍` would force all
 * of them past the gate regardless of what they answered (the original
 * wording was "to the analyzer"; since §10 step 8 the far end of that
 * channel is the attendance engine, because `unsure` is an owned route),
 * which is the floor doing CLASSIFICATION: exactly what PR #33 deleted,
 * and what PR #42 measured as a complete no-op (183 floor claims,
 * **zero** rescues).
 *
 * The information is not in the token. It is in the conversation, and
 * the part of the conversation that MatchTime writes down is its own
 * open questions:
 *
 *   `BenchSlotOffer`            a slot opened and nobody has claimed it
 *   `PendingBenchConfirmation`  a named bench player was asked to confirm
 *   `TentativeAvailability`     the follow-up DM went out and came back
 *                               with nothing
 *
 * While one of those is open, MatchTime is waiting for an answer, and a
 * `none` route is not trusted. When none is open — which is 99% of the
 * history — nothing here changes anything at all.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE AUDIENCE IS THE GROUP, AND THAT IS FORCED, NOT CHOSEN
 * ─────────────────────────────────────────────────────────────────────
 *
 * A `PendingBenchConfirmation` names one player, so "waiting for an
 * answer from THIS person" would be tighter. The gate cannot use it:
 * it runs before sender resolution, so at route time a message has an
 * author NAME and no user id. Widening to the group is therefore the
 * only shape available, and it is the safe direction — it can only add
 * EXTRACTOR calls, never remove one. (It said "analyzer calls" until
 * 2026-09-06; the rescue rewrites `none` → `unsure`, and `unsure` has
 * been an owned engine route since §10 step 8. Without that membership
 * this rescue would now rescue a message into silence, which is the one
 * way this file could be made worthless without touching it.) Measured
 * cost below.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THERE IS A TTL
 * ─────────────────────────────────────────────────────────────────────
 *
 * A `BenchSlotOffer` lives until kickoff. One real offer
 * (`cmpleeq960000wm9kov23qexz`) stayed open for **22 hours**. Nobody is
 * answering a question 22 hours later, and treating all of it as "still
 * waiting" would drag a day of banter into the attendance extractor for
 * nothing (measured, and written, when the far end was the analyzer; the
 * waste is the same shape and now costs an extractor call each).
 *
 * Measured over the same 1,723 messages, messages inside an open window:
 *
 *   no TTL   119        ← a day of banter, twice
 *   60 min    69        ← the knee
 *   30 min    66
 *   20 min    65
 *   10 min    59        ← and it MISSES case 1 (32.6 min)
 *
 * An hour is the knee and it clears both real cases (10.0 min and
 * 32.6 min) comfortably. It is also six Pi flush windows, so an answer
 * that took two or three flushes to reach the pipeline is still inside
 * it.
 *
 * PURE. Not one import, no clock of its own, no database. The rows come
 * from `load-awaiting-answer.ts`, which is the only thing here that
 * touches Prisma — `router.ts` and `gate.ts` both have to stay loadable
 * in the Playwright worker the recall harness runs in, and a runtime
 * Prisma import anywhere in their graph breaks that.
 */
export type AwaitingKind = "bench-slot-offer" | "bench-confirmation" | "tentative-followup";

/** One question MatchTime asked and has not had an answer to. */
export interface AwaitingQuestion {
  /** The row's id, so a route can be traced back to what opened it. */
  id: string;
  orgId: string;
  kind: AwaitingKind;
  /** When MatchTime asked. */
  askedAt: Date;
  /** When the row stops being open on its own terms — resolved,
   *  expired, or kickoff. `null` when nothing bounds it. */
  closesAt: Date | null;
}

/**
 * How long after asking MatchTime is still treated as waiting.
 *
 * See the essay above for the measurement this number comes from. It is
 * deliberately a constant rather than a flag: a knob here is a knob on
 * how much banter reaches the attendance extractor — and, in the other
 * direction, on how many real answers go silent, which is what a `none`
 * costs since §10 step 8. The honest way to change it is to re-run the
 * recall sweep.
 */
export const GROUP_QUESTION_TTL_MS = 60 * 60 * 1000;

/** PURE. Is `q` still open at `now`? */
export function isAnswerWindowOpen(q: AwaitingQuestion, now: Date): boolean {
  const t = now.getTime();
  const asked = q.askedAt.getTime();
  if (t < asked) return false;
  if (t - asked >= GROUP_QUESTION_TTL_MS) return false;
  if (q.closesAt && t >= q.closesAt.getTime()) return false;
  return true;
}

/**
 * PURE. The open question this batch could be answering, or null.
 *
 * Earliest first, so the answer is stable when two slots opened at once
 * (2026-05-25 and 2026-05-26 both produced offer pairs milliseconds
 * apart) and a report can name one of them rather than "some question".
 */
export function openQuestionAt(
  questions: AwaitingQuestion[],
  orgId: string,
  now: Date,
): AwaitingQuestion | null {
  let best: AwaitingQuestion | null = null;
  for (const q of questions) {
    if (q.orgId !== orgId) continue;
    if (!isAnswerWindowOpen(q, now)) continue;
    if (!best || q.askedAt.getTime() < best.askedAt.getTime()) best = q;
  }
  return best;
}

/** Human wording for a degradation line and for the recall report. */
export function describeQuestion(q: AwaitingQuestion): string {
  return `${q.kind} ${q.id} opened ${q.askedAt.toISOString()}`;
}


// ═══════════════════════════════════════════════════════════════════════
// A STATS CLARIFICATION IS AN OPEN QUESTION TOO (2026-09-23)
// ═══════════════════════════════════════════════════════════════════════
//
// Kemal: "if it can't recognise a name or something, i think it should
// honestly ask the person who posted that message in the group". When a
// stats question names somebody who is not in the squad, or who could be
// two members, MatchTime asks the poster instead of guessing
// (`stats-answer.ts`, `ask_stats_person`). The poster's reply has to be
// understood as the answer, and this is the mechanism that already knows
// how: a ROW saying MatchTime asked, the one-hour TTL above, and the
// router's override site with its `awaiting` source label.
//
// ── THE ROW. No new table. The asking message is recorded like every
// owned message, as an `AnalyzedMessage`, with the intent
// `stats_clarification`; its `body` IS the original question and its
// `authorUserId` / `authorName` ARE the asker. The reply that answers it
// is recorded with `stats_clarified`, which closes it. So "is a
// clarification open?" is one indexed read (`[orgId, createdAt]`) of
// rows the route writes anyway.
//
// ── TWO NARROWINGS against the bench-offer rescue, both deliberate:
//
//   1. ONLY THE ASKER. A bench offer is answered by whoever claims the
//      slot, so it widens to the group. A "who do you mean?" is answered
//      by the person it was put to, and anybody else's "Idris" is
//      ordinary chat.
//   2. ONLY A REPLY THAT READS AS A NAME (`clarificationSubject`). The
//      asker's "I'm in" an hour later is attendance, and must stay so.
//
// ── WHY THESE ARE NOT `AwaitingQuestion`s. `openQuestionAt` picks ONE
// question for the whole group and rescues everybody's `none`. Folding a
// clarification into that list would let the asker's question displace a
// real bench offer (or the reverse) as "the" open question. Kept as a
// separate list, both rescues run, and the bench behaviour is byte for
// byte what it was.

export const STATS_CLARIFICATION_INTENT = "stats_clarification";
export const STATS_CLARIFIED_INTENT = "stats_clarified";

/** The `AnalyzedMessage` columns a clarification is read from. */
export interface StatsClarificationRow {
  id: string;
  orgId: string;
  intent: string | null;
  authorUserId: string | null;
  authorName: string | null;
  body: string | null;
  createdAt: Date;
}

/** One "who do you mean?" MatchTime is still waiting on. */
export interface StatsClarification {
  /** The `AnalyzedMessage` row of the ORIGINAL question. */
  id: string;
  orgId: string;
  askerUserId: string | null;
  askerName: string | null;
  /** The original question, verbatim. Re-read when the answer arrives. */
  questionBody: string;
  askedAt: Date;
}

function askerKey(userId: string | null, name: string | null): string | null {
  if (userId) return `u:${userId}`;
  if (name) return `n:${name}`;
  return null;
}

/** PURE. The clarifications still open at `now`, at most one per asker
 *  (a newer question from the same person replaces the older one). */
export function openStatsClarifications(
  rows: StatsClarificationRow[],
  orgId: string,
  now: Date,
): StatsClarification[] {
  const latest = new Map<string, StatsClarificationRow>();
  const answeredAt = new Map<string, number>();
  for (const r of rows) {
    if (r.orgId !== orgId) continue;
    const key = askerKey(r.authorUserId, r.authorName);
    if (!key) continue;
    if (r.intent === STATS_CLARIFIED_INTENT) {
      answeredAt.set(key, Math.max(answeredAt.get(key) ?? 0, r.createdAt.getTime()));
    } else if (r.intent === STATS_CLARIFICATION_INTENT) {
      const cur = latest.get(key);
      if (!cur || r.createdAt.getTime() > cur.createdAt.getTime()) latest.set(key, r);
    }
  }
  const out: StatsClarification[] = [];
  for (const [key, r] of latest) {
    const q = { id: r.id, orgId, kind: "tentative-followup" as const, askedAt: r.createdAt, closesAt: null };
    if (!isAnswerWindowOpen(q, now)) continue;
    if ((answeredAt.get(key) ?? 0) > r.createdAt.getTime()) continue;
    out.push({
      id: r.id,
      orgId,
      askerUserId: r.authorUserId,
      askerName: r.authorName,
      questionBody: r.body ?? "",
      askedAt: r.createdAt,
    });
  }
  return out.sort((a, b) => a.askedAt.getTime() - b.askedAt.getTime());
}

/** PURE. Is this message from the person the clarification was put to? */
export function isFromAsker(
  c: StatsClarification,
  m: { senderUserId?: string | null; authorName: string | null },
): boolean {
  if (c.askerUserId && m.senderUserId !== undefined) return m.senderUserId === c.askerUserId;
  return !!c.askerName && m.authorName === c.askerName;
}

const LEADING_TAG = /^\s*@\s*match\s*time\b[\s,:]*/iu;
const LEADING_FILLER =
  /^(?:(?:oh|ah|sorry|no|nope|i\s+mean|i\s+meant|meant|i\s+mean\s+to\s+say|the\s+one\s+i\s+mean\s+is|it'?s|yani|pardon|özür\s+dilerim)[\s,!.:]+)+/iu;
const TRAILING_FILLER_TR = /\s+(?:demek\s+istedim|demek\s+istiyorum|kastettim|kastediyorum)\s*$/iu;
/** A Turkish case suffix after an apostrophe: "Mojib'i", "Idris'in". */
const APOSTROPHE_SUFFIX = /['’]\p{L}+$/u;
/** Words that make a short reply something other than a name. */
const NOT_A_NAME = new Set([
  "in", "out", "im", "i'm", "i", "me", "yes", "no", "yeah", "yep", "nope", "ok", "okay", "k", "thanks", "thank",
  "you", "cheers", "ta", "lol", "haha", "hahaha", "maybe", "sure", "bench", "is", "for", "the", "and", "a", "all",
  "everyone", "nobody", "never", "mind", "nevermind", "var", "yok", "evet", "hayır", "hayir", "tamam", "tmm",
  "belki", "ben", "beni", "benim", "sağol", "sagol", "teşekkürler", "tesekkurler", "herkes", "kimse",
]);

/**
 * PURE. The name a reply gives, when the whole reply reads as naming
 * somebody ("Idris", "I mean Mojib Jalali", "Mojib'i kastettim"), else
 * null. Deliberately strict: it is what lets the asker's reply past the
 * router, so "I'm in" and "Mojib is in for Tuesday" must come back null.
 */
export function clarificationSubject(body: string): string | null {
  let s = (body ?? "").trim().replace(LEADING_TAG, "");
  s = s.replace(LEADING_FILLER, "").replace(TRAILING_FILLER_TR, "");
  s = s.replace(/^[\s"'“”‘’(]+|[\s"'“”‘’).,!?]+$/gu, "").trim();
  if (!s) return null;
  const tokens = s.split(/\s+/);
  if (tokens.length > 3) return null;
  const cleaned: string[] = [];
  for (const raw of tokens) {
    const tok = raw.replace(APOSTROPHE_SUFFIX, "");
    if (!/^\p{L}[\p{L}.-]*$/u.test(tok)) return null;
    if (NOT_A_NAME.has(tok.toLocaleLowerCase("tr")) || NOT_A_NAME.has(tok.toLowerCase())) return null;
    cleaned.push(tok);
  }
  const out = cleaned.join(" ");
  return out.length >= 2 ? out : null;
}
