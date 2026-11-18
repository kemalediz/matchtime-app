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
// "WHO DO YOU MEAN?" IS AN OPEN QUESTION TOO
// ═══════════════════════════════════════════════════════════════════════
//
// When MatchTime asks a poster who someone in their message is, the
// poster's reply has to be understood as the answer: a ROW saying
// MatchTime asked, the one-hour TTL above, and the router's override site.
// Only the person asked answers it, and the router decides whether the
// reply does (`clarificationLine`). Kept apart from `AwaitingQuestion`s so
// one never displaces a real bench offer as "the" open question.
//
// The stats "who do you mean?" (2026-09-23, `AnalyzedMessage` rows with
// intent `stats_clarification`) was deleted on 2026-11-18 with the stats
// answers that asked it; the place in the squad (below) is the one left.

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
  /** A stats question (absent, as always) or a place in the squad
   *  (2026-11-17, `AttendanceAsk`). */
  about?: "attendance";
  /** For `about: "attendance"`: the name asked about, as written. */
  ref?: string;
  /** For `about: "attendance"`: the members MatchTime offered. */
  candidateIds?: string[];
}

function askerKey(userId: string | null, name: string | null): string | null {
  if (userId) return `u:${userId}`;
  if (name) return `n:${name}`;
  return null;
}

/** PURE. Is this message from the person the clarification was put to? */
export function isFromAsker(
  c: StatsClarification,
  m: { senderUserId?: string | null; authorName: string | null },
): boolean {
  if (c.askerUserId && m.senderUserId !== undefined) return m.senderUserId === c.askerUserId;
  return !!c.askerName && m.authorName === c.askerName;
}


// ═══════════════════════════════════════════════════════════════════════
// …AND SO IS "WHO IS ABU AYOUB?" ABOUT A PLACE IN THE SQUAD (2026-11-17)
// ═══════════════════════════════════════════════════════════════════════
//
// Sutton, 17 Nov: "@Match Time Abu Ayoub is IN as a guest", and who-is-who
// could not tell Abu Ayoub from the member Yoobie. The attendance engine
// now asks ("Do you mean Yoobie, or is Abu Ayoub a new player?") and the
// answer rides THIS mechanism: the asker only, the same one-hour TTL, the
// same MATCHTIME ASKED line for the router and the extractor (`about`
// picks its wording and its reader).
//
// ── THE ROW IS NOT THE MESSAGE'S OWN (review of #618). The asking
// message keeps its real `AnalyzedMessage.intent` ("in" when the sender's
// own claim landed beside the question), so the question is recorded
// apart, as a `SentNotification` (what MatchTime sent, no migration):
// kind `attendance-ask`, key `attendance-ask:<org>:<waMessageId>`, the
// asker as `targetUser`, and in `text` (JSON) the earlier message, the
// name asked about and the members offered. The answer is bound to those:
// `engine.ts` acts only on the asked name. It is closed by `answeredAt`.

export const ATTENDANCE_ASK_KIND = "attendance-ask";

/** The key prefix of one club's attendance questions. */
export function attendanceAskKeyPrefix(orgId: string): string {
  return `${ATTENDANCE_ASK_KIND}:${orgId}:`;
}

/** What an attendance question's row carries in `text`. */
export interface AttendanceAskPayload {
  v: 1;
  askerName: string | null;
  /** The earlier message the question is about, verbatim. */
  body: string;
  /** The name asked about, as that message wrote it. */
  ref: string;
  candidateIds: string[];
  /** Set when the asker's answer was read. */
  answeredAt?: string | null;
}

/** The `SentNotification` columns an attendance question is read from. */
export interface AttendanceAskRow {
  id: string;
  key: string;
  targetUser: string | null;
  text: string | null;
  createdAt: Date;
}

/** PURE. The `text` of a row, or null when it is not one we can read. */
export function parseAttendanceAsk(text: string | null): AttendanceAskPayload | null {
  try {
    const p = JSON.parse(text ?? "") as Partial<AttendanceAskPayload>;
    if (p?.v !== 1 || typeof p.body !== "string" || typeof p.ref !== "string" || !Array.isArray(p.candidateIds)) return null;
    return {
      v: 1,
      askerName: typeof p.askerName === "string" ? p.askerName : null,
      body: p.body,
      ref: p.ref,
      candidateIds: p.candidateIds.filter((x): x is string => typeof x === "string"),
      answeredAt: typeof p.answeredAt === "string" ? p.answeredAt : null,
    };
  } catch {
    return null;
  }
}

/** PURE. The attendance questions still open at `now`, at most one per
 *  asker (the newest), in the shape every reader of a clarification uses. */
export function openAttendanceAsks(rows: AttendanceAskRow[], orgId: string, now: Date): StatsClarification[] {
  const prefix = attendanceAskKeyPrefix(orgId);
  const latest = new Map<string, { r: AttendanceAskRow; p: AttendanceAskPayload }>();
  for (const r of rows) {
    if (!r.key.startsWith(prefix)) continue;
    const p = parseAttendanceAsk(r.text);
    const asker = p ? askerKey(r.targetUser, p.askerName) : null;
    if (!p || !asker) continue;
    const cur = latest.get(asker);
    if (!cur || r.createdAt.getTime() > cur.r.createdAt.getTime()) latest.set(asker, { r, p });
  }
  const out: StatsClarification[] = [];
  for (const { r, p } of latest.values()) {
    if (p.answeredAt) continue;
    const q = { id: r.id, orgId, kind: "tentative-followup" as const, askedAt: r.createdAt, closesAt: null };
    if (!isAnswerWindowOpen(q, now)) continue;
    out.push({
      id: r.id,
      orgId,
      askerUserId: r.targetUser,
      askerName: p.askerName,
      questionBody: p.body,
      askedAt: r.createdAt,
      about: "attendance",
      ref: p.ref,
      candidateIds: p.candidateIds,
    });
  }
  return out.sort((a, b) => a.askedAt.getTime() - b.askedAt.getTime());
}
