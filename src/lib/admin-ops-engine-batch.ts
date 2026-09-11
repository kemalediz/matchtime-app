/**
 * §10 STEP 7 PART 2 — THE `admin_ops` ROUTE, END TO END.
 *
 *   router → admin extractor → engine → APPLY → composer
 *
 * The last route on the mega-prompt, and the one part 1 was most careful
 * about. `answer-batch.ts`'s header states why it was held back:
 *
 *   *"`admin_ops` is real money on a live club (S21 — `PaymentCredit`,
 *    `Attendance.paidAt`) plus a reminder whose time phrase still has to
 *    become a datetime. The engine models the phrase exactly as §3.2 S22
 *    asks and hands it on; nothing resolves it yet, and `date-fns-tz`
 *    doing that resolution is new code on a path that queues a DM. It
 *    also has four guards the engine does not carry — the `reminders`
 *    feature gate, the `subReminderDm` opt-out, the missing-phone branch
 *    and the 60-day window (`route.ts:3925-3995`)."*
 *
 * All four guards are accounted for, and two of them are answered by
 * OWNING LESS rather than by re-implementing a sentence:
 *
 *   | guard                | where it lives now                        |
 *   |----------------------|-------------------------------------------|
 *   | `reminders` feature  | `engine.ts` — `state.features.reminders`  |
 *   | 60-day window        | `engine.ts` — the shipped grace and bound |
 *   | `subReminderDm`      | HERE, as a carve-out: a muted player's    |
 *   |                      | message is DECLINED — see the correction  |
 *   | missing phone        | `engine.ts` degrades → declined, same     |
 *
 * ── THE LAST TWO ROWS SAID SOMETHING THAT STOPPED BEING TRUE ─────────
 *
 * Until 2026-09-06 they read "handed back so the analyzer sends the
 * shipped 🔕 sentence" and "handed back, so the analyzer sends the
 * shipped 🤔 line", and the paragraph under them ended:
 *
 *   "Both shipped branches answer the player with a specific sentence
 *    and a specific react, and inventing a second wording for a shipped
 *    sentence is how two bots start disagreeing with each other in the
 *    same group. Handing the message back costs one analyzer call and
 *    gives the player the exact words they get today."
 *
 * §10 step 8 deleted `analyzeBatch`, the 19,850-token `SYSTEM_PROMPT`
 * and `executeVerdict`. NOBODY SENDS THOSE TWO SENTENCES NOW. A player
 * who muted reminder DMs and then asks for one gets silence instead of
 * the 🔕 line; a reminder for somebody with no phone number on record
 * gets silence instead of the 🤔 line. Both land on the operator DM
 * (`lib/operator-note.ts`) and neither reaches the player.
 *
 * THE ARGUMENT FOR NOT REIMPLEMENTING THEM IS UNCHANGED AND STILL GOOD —
 * a second wording of a shipped sentence is how two bots start
 * disagreeing — but the price went from "one analyzer call" to "the
 * player is told nothing". These are the two clearest candidates in this
 * file for a follow-up that composes the shipped sentences
 * deterministically, in the shape of §10 step 8's four peels
 * (`bench-prompt-answer.ts`, `pasted-roster-registration.ts`). That is a
 * behaviour change and belongs in its own PR, not smuggled into a
 * deletion. Recorded here so the next reader does not have to rediscover
 * it from a silent group.
 *
 * ─────────────────────────────────────────────────────────────────────
 * IT OWNS NOTHING RATHER THAN GUESSING, AND SINCE 2026-09-06 "OWNS
 * NOTHING" MEANS SILENCE
 * ─────────────────────────────────────────────────────────────────────
 * This table used to sit under "FAIL OPEN, ALWAYS", with every "handed
 * back" meaning "the analyzer decides it, which is today's behaviour and
 * therefore cannot be a regression". §10 step 8 deleted the analyzer.
 * A declined message reaches `route.ts`'s "NOBODY OWNED IT" branch unowned: SILENCE in the
 * group, an `AnalyzedMessage` row, and one line on the deduped operator
 * DM (`lib/operator-note.ts`).
 *
 * It is a real behaviour change, accepted in §11.5's own words — "a
 * router with nine routes and an engine with explicit rules will do
 * nothing instead… the club will experience it as 'the bot got dumber'
 * before they experience it as 'the bot stopped being wrong'" — and on
 * this route it is money-adjacent, so read the rows rather than the
 * heading.
 *
 *   • `ADMIN_OPS_ENGINE_ENABLED` is off      → owns nothing → SILENCE +
 *                                              note. The flag is KEPT
 *                                              and now defaults ON; only
 *                                              0/false/no/off turn it
 *                                              off (`route-flags.ts`).
 *   • step 5's gate skipped it               → owns nothing, and NO
 *                                              note: `composeOperatorNote`
 *                                              drops every `none` route
 *   • the router never mentioned the id      → owns nothing → SILENCE +
 *                                              note
 *   • the state load threw                   → owns nothing → SILENCE +
 *                                              note
 *   • the opt-out lookup threw               → owns nothing → SILENCE +
 *                                              note
 *   • the extractor call threw               → THAT message goes SILENT
 *                                              and onto the note. ONE
 *                                              attempt: `extractors.ts`
 *                                              retries the four
 *                                              attendance routes only.
 *   • the facts are not admin facts          → SILENCE + note
 *   • admin action `other`                   → SILENCE + note. This row
 *                                              used to add "the
 *                                              mega-prompt still has
 *                                              intents this route does
 *                                              not model", which was the
 *                                              whole reason declining
 *                                              was safe. Those intents
 *                                              are now modelled by
 *                                              nobody — §14.3's "least
 *                                              designed part of this
 *                                              document", with the note
 *                                              as its only backstop.
 *   • payment tracking is off for the org    → SILENCE. The club said
 *                                              no; nothing failed.
 *   • no genuinely COMPLETED, non-historical
 *     match to credit against                → SILENCE + note. A payment
 *                                              nobody credited, and the
 *                                              note is the only notice.
 *   • the sender muted reminder DMs          → SILENCE + note, where it
 *                                              used to be the shipped 🔕
 *                                              sentence. See the
 *                                              correction above.
 *   • the engine threw                       → owns nothing → SILENCE +
 *                                              note, no retry
 *                                              (`decide()` is pure)
 *   • the engine proposed a write this path
 *     cannot apply                           → owns nothing, loudly →
 *                                              SILENCE + note
 *   • an apply threw                         → owned, but SILENT, and
 *                                              the failure is reported.
 *                                              NOTE: owned means
 *                                              `operator-note.ts` never
 *                                              sees it — an owner
 *                                              claimed the id — so
 *                                              `describeAdminOpsBatch`'s
 *                                              log line is the signal.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THE TAG IS NOT A PRE-FILTER HERE
 * ─────────────────────────────────────────────────────────────────────
 * `answer-batch.ts` refuses an untagged message before the extractor
 * runs, which is free and strictly conservative for its two routes.
 *
 * ⚠️ THIS PARAGRAPH SAID THE OPPOSITE UNTIL 2026-09-06. It read: "two of
 * `admin_ops`'s three actions require a tag and the third does NOT — PR
 * #33's `RECRUIT_COMMAND_IMPLIES_ADDRESSED` makes an admin's recruit
 * command a direct instruction to MatchTime on its own". That waiver was
 * scope creep from the attendance path onto this one, and it made an
 * untagged 20-person mass DM turn on a router coin flip (measured
 * `admin_ops` 13/20 on one real phrasing). All FOUR `admin_ops` actions
 * now require a tag — see `RECRUIT_BLAST_REQUIRES_TAG`, and
 * `STATS_BLAST_REQUIRES_TAG` for the fourth, which arrived on
 * 2026-09-10 and requires an EXPLICIT @-mention rather than the loose
 * `messageTagsBot` test. Read `lib/stats-blast.ts` for why the loose one
 * is not a gate in front of a mass DM: the message that queued 69 of
 * them says "Matchtime" in the middle of a sentence and is therefore
 * `tagged`.
 *
 * IT IS STILL NOT A PRE-FILTER, and that is deliberate rather than
 * leftover. Refusing untagged `admin_ops` messages before extraction
 * would take them out of `ownedIds`, and an unowned id falls through to
 * `route.ts`'s "NOBODY OWNED IT" branch, i.e. an operator DM per
 * untagged admin-shaped line — trading one extractor call for a paging
 * channel full of noise. Which action a message carries is only knowable
 * AFTER extraction anyway, so the tag stays enforced per action, in the
 * engine, exactly where the contract's own `ACTIONY_INTENTS` split lives.
 * The cost is one extractor call on an untagged `admin_ops` message.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE TWO BLASTS ARE DECIDED HERE AND RUN LATER
 * ─────────────────────────────────────────────────────────────────────
 * `recruitRequest` on the outcome is the same field
 * `attendance-engine-batch.ts` already reports, read by the same
 * batch-final pass at `route.ts:2436`, which fires the blast AFTER every
 * write in the batch has landed. That ordering IS the fix for
 * 2026-09-01, where a regex ran the blast first, against a 10/10 squad,
 * and MatchTime told the owner his squad was full one line after he said
 * Najib was out. Applying `recruit_blast` here would rebuild that bug.
 *
 * `statsBlastRequest` (2026-09-10) is the same field for the other mass
 * DM, deferred the same way. It has no ordering argument of its own —
 * the stats blast reads no squad state — but it goes down the same road
 * so there is ONE place in the codebase where a bulk DM is performed,
 * and one shape to review when the next one arrives.
 */
import {
  ADMIN_OPS_APPLY_DEGRADED_PREFIX,
  ADMIN_OPS_HANDLED_BY,
  applyPaymentCredit,
  applyReminder,
  composePaymentAck,
  type AdminOpsApplyDeps,
  type EnginePaymentWrite,
  type EngineReminderWrite,
} from "./admin-ops-engine";
import { compose } from "./pipeline/compose";
import { decide as decideDefault } from "./pipeline/engine";
import { extractForRoute } from "./pipeline/extractors";
import { extractorStubFromEnv } from "./pipeline/extractor-stub";
import { anthropicModel, type PipelineModel } from "./pipeline/llm";
import { ADMIN_OPS_ENGINE_ROUTES, stepSevenOwnsRoute } from "./pipeline/route-flags";
import type {
  AdminFacts,
  EngineInput,
  EngineMessage,
  EngineResult,
  Facts,
  Route,
  SquadState,
} from "./pipeline/types";

export { ADMIN_OPS_APPLY_DEGRADED_PREFIX, ADMIN_OPS_HANDLED_BY };

/** The routes this module can own. From `route-flags.ts`, so the flag
 *  and the owner cannot disagree about the list. */
export const ADMIN_OPS_ROUTES = ADMIN_OPS_ENGINE_ROUTES;

export interface AdminOpsBatchMessage {
  waMessageId: string;
  body: string;
  authorName: string | null;
  senderUserId: string | null;
  senderName: string | null;
  tagged: boolean;
  /** `messageMentionsBotExplicitly` — the STRICTER tag test, read only by
   *  the bulk-DM commands. Omitted → the engine derives it from the body.
   *  See `EngineMessage.taggedExplicitly` and `lib/stats-blast.ts`. */
  taggedExplicitly?: boolean;
  /** From the router. `undefined` when it never mentioned this id. */
  route: Route | undefined;
  /** Did step 5's gate skip this message? Then this never sees it. */
  gated: boolean;
}

export interface AdminOpsMessageOutcome {
  waMessageId: string;
  route: Route;
  reply: string | null;
  react: string | null;
  /** `AnalyzedMessage.intent`, in the vocabulary the admin log speaks —
   *  and derived from what HAPPENED, never from a model. */
  intent: string;
  /** `AnalyzedMessage.action`. */
  action: string;
  /** Machine reasons, one per rule that fired. Never prose for a regex
   *  to parse — nothing in this codebase parses it. */
  reasoning: string;
  /**
   * An admin asked for a recruit blast in this message. The SAME field
   * `attendance-engine-batch.ts` reports, for the same batch-final pass
   * at `route.ts:2436`. The blast must run after the batch's writes.
   */
  recruitRequest: boolean;
  /** The clamped lookback for that blast, or null for the default of 5.
   *  `inviteRecentPlayers` takes it as its second argument. */
  recruitLookbackMatches: number | null;
  /**
   * An admin asked, with an @-tag, for every active member to be DM'd
   * their personal stats link. Same shape as `recruitRequest` and same
   * batch-final pass: this path applies NOTHING, the route performs the
   * blast. It carries no parameters — the recipient list is "every
   * active member with a phone", read from the database by the route,
   * so there is no number here for a model to widen.
   *
   * The gate is `pipeline/engine.ts`'s `stats_blast` branch (admin +
   * an explicit @-mention); this field is what it decided.
   */
  statsBlastRequest: boolean;
  /** A write threw. The caller must not say anything cheerful. */
  writeFailed: boolean;
}

export interface AdminOpsBatchResult {
  ownedIds: Set<string>;
  outcomes: Map<string, AdminOpsMessageOutcome>;
  degradations: string[];
  cost: { usd: number; calls: number; ms: number };
}

export interface AdminOpsBatchDeps extends AdminOpsApplyDeps {
  /** Members who have turned reminder DMs off (`Membership.subReminderDm
   *  = false`). See the carve-out table in the header. */
  reminderMutedUserIds: () => Promise<string[]>;
  /** Injected so tests can drive the whole batch without a key. */
  model?: PipelineModel;
  /** Injected so tests can load a state without a database. */
  loadState?: (orgId: string, now: Date) => Promise<SquadState>;
  /** Injected so a test can prove the write assertion and the
   *  throw-safety without a fabricated rule in the real engine. */
  decide?: (input: EngineInput) => EngineResult;
}

function empty(degradations: string[] = []): AdminOpsBatchResult {
  return {
    ownedIds: new Set(),
    outcomes: new Map(),
    degradations,
    cost: { usd: 0, calls: 0, ms: 0 },
  };
}

export async function runAdminOpsBatch(args: {
  orgId: string;
  now: Date;
  messages: AdminOpsBatchMessage[];
  history: Array<{ author: string | null; body: string }>;
  enabled: Set<Route>;
  deps: AdminOpsBatchDeps;
}): Promise<AdminOpsBatchResult> {
  const { orgId, now, messages, history, enabled, deps } = args;
  const t0 = Date.now();

  // ── Ownership, part 1: everything knowable without a model ─────────
  const candidates = messages.filter(
    (m) => !m.gated && stepSevenOwnsRoute(m.route, enabled, ADMIN_OPS_ROUTES),
  );
  if (candidates.length === 0) return empty();

  const degradations: string[] = [];

  let state: SquadState;
  try {
    state = deps.loadState
      ? await deps.loadState(orgId, now)
      : await (await import("./pipeline/load-state")).loadSquadState(orgId, now);
  } catch (err) {
    const detail = `${ADMIN_OPS_APPLY_DEGRADED_PREFIX} state load failed (${
      err instanceof Error ? err.message : String(err)
    }); nobody handles these messages — they go silent and onto this note`;
    console.error("[admin-ops-engine] state load failed:", err);
    return empty([detail]);
  }

  let muted: Set<string>;
  try {
    muted = new Set(await deps.reminderMutedUserIds());
  } catch (err) {
    // The opt-out is a promise MatchTime made to a player who asked it
    // to stop messaging them. A lookup that failed is not permission to
    // DM them anyway, so own nothing.
    //
    // It used to add "and let the analyzer, which does its own lookup,
    // decide". §10 step 8 deleted the analyzer and its lookup with it,
    // so this is now the only decision: no reminder is set, nobody is
    // DM'd, and an admin is told on the note. The promise is still kept
    // — which was always the point of the branch — but nothing else
    // happens either.
    const detail = `${ADMIN_OPS_APPLY_DEGRADED_PREFIX} the reminder opt-out lookup failed (${
      err instanceof Error ? err.message : String(err)
    }); nobody handles these messages — they go silent and onto this note`;
    console.error("[admin-ops-engine] opt-out lookup failed:", err);
    return empty([detail]);
  }

  // ── Stage 2: extractors, in parallel ───────────────────────────────
  const model = deps.model ?? extractorStubFromEnv() ?? anthropicModel();
  const lastBotPost =
    [...history].reverse().find((h) => (h.author ?? "").toLowerCase() === "matchtime")?.body ??
    state.lastBotPost ??
    null;
  state = { ...state, lastBotPost };

  let cost = { usd: 0, calls: 0, ms: 0 };
  const factsById = new Map<string, Facts>();
  await Promise.all(
    candidates.map(async (m) => {
      const res = await extractForRoute(model, m.route as Route, {
        id: m.waMessageId,
        body: m.body,
        authorName: m.authorName,
        tagged: m.tagged,
        history,
        lastBotPost,
      });
      for (const d of res.degradations) {
        degradations.push(`extractor ${m.waMessageId}: ${d.detail}`);
      }
      if (res.usage) {
        cost = {
          usd: cost.usd + (res.usage.costUsd ?? 0),
          calls: cost.calls + 1,
          ms: Math.max(cost.ms, res.usage.ms),
        };
      }
      const failure = res.degradations.find((d) => /failed|could not be parsed/i.test(d.detail));
      if (failure) {
        // ONE attempt: `extractors.ts` retries the four attendance
        // routes and not this one. Until §10 step 8 this line said
        // "handing this message back to the analyzer" — it named a
        // deleted function, and it told an operator reading the DM that
        // the message was safe at the moment it was lost.
        degradations.push(
          `${ADMIN_OPS_APPLY_DEGRADED_PREFIX} ${m.waMessageId}: ${failure.detail} — ` +
            `nobody handles this message: no reply in the group, and it is on this note`,
        );
        return;
      }
      factsById.set(m.waMessageId, res.facts);
    }),
  );

  // ── The payment target, decided once, before anything is owned ─────
  //
  // EXACTLY the shipped selector (`route.ts:3801-3803`): the most recent
  // genuinely COMPLETED, non-historical match. `SquadState.completedMatch`
  // is now WIDER than that — it also holds a match that has been played
  // but never scored — because the `score` route needs it to be. Money
  // does not: crediting a payment against a match nobody has recorded a
  // result for, or against a seeded backfill row, is not a shape this
  // owns.
  //
  // WHAT HAPPENS WHEN THE TWO DISAGREE, corrected 2026-09-06. This used
  // to end: "the analyzer keeps the message and its own query picks the
  // older COMPLETED match, exactly as today." §10 step 8 deleted the
  // analyzer AND its query. Nobody picks the older match: the payment is
  // not credited, the group is told nothing, and the admin gets a line
  // on the operator DM naming the message and the reason. The
  // conservative choice is unchanged and still right — money credited
  // against the wrong match is the failure §13 calls unrecoverable — but
  // it is now paid for in uncredited payments rather than in one
  // analyzer call, and this is real money on Sutton FC.
  const completed = state.completedMatch;
  const paymentMatchId =
    completed && completed.status === "COMPLETED" && !completed.isHistorical
      ? completed.id
      : null;

  // ── Ownership, part 2: shapes only visible after extraction ────────
  //
  // ON THE `continue`s. Three defects in one week came from a terminal
  // `continue` silently skipping every guard below it, so, explicitly:
  // the ONLY effect of a full pass through this loop body is
  // `ownedIds.add(...)`. There is no write, no send, no state mutation
  // and no later guard inside it, so a `continue` can skip exactly one
  // thing — ownership — which is the intent. Everything a skipped
  // message still needs happens OUTSIDE the loop: it reaches `decide()`
  // with `facts: {kind:"none"}` (so `assertCoverage` still sees one
  // outcome per input id and the window is intact for its neighbours),
  // it gets no entry in `outcomes` (so the analyze route finds no owner
  // and records it as unowned — silence plus the operator note, since
  // §10 step 8 deleted the verdict it used to leave alone), and its
  // reason is already in `degradations` before the `continue` runs.
  const ownedIds = new Set<string>();
  for (const m of candidates) {
    const facts = factsById.get(m.waMessageId);
    if (!facts) continue; // extraction failed; already reported above.
    // NAMED `hand` FOR A HAND-BACK IT NO LONGER PERFORMS. The name is
    // kept because every call site below reads `hand("why")`, and
    // renaming a helper inside a documentation-correction pass is how
    // such a pass acquires a bug. The SENTENCE is corrected: an operator
    // reads it on their phone, and "handing this message back to the
    // analyzer" named a function deleted in §10 step 8.
    const hand = (why: string) =>
      degradations.push(
        `${ADMIN_OPS_APPLY_DEGRADED_PREFIX} ${m.waMessageId}: ${why} — ` +
          `nobody handles this message: no reply in the group, and it is on this note`,
      );

    if (facts.kind !== "admin") {
      hand(`the admin extractor returned "${facts.kind}" facts`);
      continue;
    }

    if (facts.action === "other") {
      // This used to read: "The mega-prompt still models admin intents
      // this route does not: `show_teams_request` phrasings that land
      // here, stats asks, and anything §14.3 calls 'the least designed
      // part of this document'. A silent shrug is the failure this
      // design exists to remove."
      //
      // §10 step 8 deleted the mega-prompt, so nothing models them and
      // the shrug is what happens — with the operator note as the thin
      // thing separating it from §9's signature failure. `other` is the
      // widest hole this file has, and it is deliberately a wide hole
      // rather than a guess.
      hand("admin action \"other\" has no deterministic handler on this path");
      continue;
    }

    if (facts.action === "bulk_payment") {
      if (!state.features.paymentTracking) {
        // The org-level kill switch (`route.ts:3779-3786`). The bot is
        // silent either way, which is the club's own choice.
        //
        // It used to add that "going through the analyzer keeps the
        // `AnalyzedMessage` trail identical to today's". Since §10 step
        // 8 the row is written by `route.ts`'s "NOBODY OWNED IT" branch instead, tagged
        // `ignored` with `no owner: route=admin_ops` and this reason
        // appended — a different row, same question answerable from it.
        hand("payment tracking is off for this org");
        continue;
      }
      if (!paymentMatchId) {
        hand(
          `no genuinely COMPLETED, non-historical match to credit against ` +
            `(last played: ${completed ? `${completed.id} (${completed.status})` : "none"})`,
        );
        continue;
      }
    }

    if (facts.action === "reminder" && m.senderUserId && muted.has(m.senderUserId)) {
      // The per-category opt-out (`route.ts:3955-3967`). The player
      // asked MatchTime to stop DMing them, so no DM is queued — and
      // that half of the behaviour is intact and is the half that
      // matters legally.
      //
      // WHAT IS LOST, PLAINLY. The shipped path "answers that out loud
      // with a 🔕 rather than swallowing the request", and this comment
      // used to justify declining on the grounds that "that sentence
      // lives in the analyzer; a second wording of it here is how two
      // bots start disagreeing in one group". §10 step 8 deleted the
      // analyzer, so the 🔕 sentence is not sent by anybody: the player
      // asks for a reminder and MatchTime says nothing at all. The
      // no-second-wording argument is still right; the price is now a
      // confused player rather than one analyzer call. See the header
      // for why the fix is its own PR.
      hand("the sender has muted reminder DMs (subReminderDm=false)");
      continue;
    }

    ownedIds.add(m.waMessageId);
  }
  if (ownedIds.size === 0) return empty(degradations);

  // ── Stage 3: the engine, over the WHOLE window ─────────────────────
  const engineMessages: EngineMessage[] = messages.map((m) => ({
    id: m.waMessageId,
    body: m.body,
    senderUserId: m.senderUserId,
    senderName: m.senderName ?? m.authorName,
    tagged: m.tagged,
    ...(m.taggedExplicitly === undefined ? {} : { taggedExplicitly: m.taggedExplicitly }),
    route: m.route ?? "none",
    facts: ownedIds.has(m.waMessageId)
      ? (factsById.get(m.waMessageId) ?? { kind: "none" })
      : { kind: "none" },
    degraded: null,
  }));

  let result: EngineResult;
  try {
    result = (deps.decide ?? decideDefault)({ messages: engineMessages, state, now });
  } catch (err) {
    // No retry: `decide()` is pure over `{messages, state, now}`, so the
    // same input throws the same way. (It used to be safe to be terse
    // here because the analyzer picked the batch up; since §10 step 8
    // this is the end of the line for every `admin_ops` message in the
    // window.)
    const detail = `${ADMIN_OPS_APPLY_DEGRADED_PREFIX} the engine threw (${
      err instanceof Error ? err.message : String(err)
    }); nobody handles these messages — they go silent and onto this note`;
    console.error("[admin-ops-engine] the engine threw:", err);
    return empty([...degradations, detail]);
  }
  for (const d of result.degradations) {
    degradations.push(`[${d.stage}${d.messageId ? ` ${d.messageId}` : ""}] ${d.detail}`);
  }

  // ── THE WRITE ASSERTION ────────────────────────────────────────────
  //
  // This path applies exactly three kinds and refuses the batch over
  // anything else. A write it does not understand would have no
  // authorisation pass and nowhere to land, and it would be LOST rather
  // than refused — the shape four dead seatbelts had on 2026-08-31.
  const payments: EnginePaymentWrite[] = [];
  const reminders: EngineReminderWrite[] = [];
  const recruitByMessage = new Map<string, number | null>();
  const statsBlastIds = new Set<string>();
  const foreign: string[] = [];
  for (const w of result.writes) {
    if (!ownedIds.has(w.sourceMessageId)) {
      foreign.push(`${w.kind} (from an unowned message)`);
      continue;
    }
    if (w.kind === "payment_credit") payments.push(w);
    else if (w.kind === "reminder") reminders.push(w);
    else if (w.kind === "recruit_blast") recruitByMessage.set(w.sourceMessageId, w.lookbackMatches);
    // Deferred to the route's batch-final pass, exactly like
    // `recruit_blast` and for the same reason — see the header, and
    // `lib/stats-blast.ts` for why the classification moved here at all.
    else if (w.kind === "stats_blast") statsBlastIds.add(w.sourceMessageId);
    else foreign.push(w.kind);
  }
  if (foreign.length > 0) {
    const detail =
      `${ADMIN_OPS_APPLY_DEGRADED_PREFIX} the engine proposed ${foreign.length} write(s) this ` +
      `path cannot apply (${[...new Set(foreign)].join(", ")}); owning nothing — these ` +
      `messages go silent and onto this note`;
    console.error(`[admin-ops-engine] ${detail}`);
    return empty([...degradations, detail]);
  }

  // ── Stage 3b: APPLY ────────────────────────────────────────────────
  //
  // `recruit_blast` is deliberately absent. See the header.
  const replyByMessage = new Map<string, string>();
  const failedIds = new Set<string>();
  const actedIds = new Set<string>();

  for (const w of payments) {
    if (!paymentMatchId) {
      // Unreachable: ownership refused a bulk_payment without a target.
      // Asserted anyway, because "unreachable" is what the comments on
      // four dead seatbelts said.
      degradations.push(
        `${ADMIN_OPS_APPLY_DEGRADED_PREFIX} ${w.sourceMessageId}: a payment credit reached ` +
          `the apply layer with no target match; refused`,
      );
      failedIds.add(w.sourceMessageId);
      continue;
    }
    const sender = messages.find((m) => m.waMessageId === w.sourceMessageId);
    const applied = await applyPaymentCredit({
      matchId: paymentMatchId,
      write: w,
      // The ADMIN who typed it, never the payer. `handleAdmin` has
      // already established that the sender is one.
      recordedByUserId: sender?.senderUserId ?? w.payerUserId,
      deps,
    });
    if (!applied.ok) {
      degradations.push(
        `${ADMIN_OPS_APPLY_DEGRADED_PREFIX} ${w.sourceMessageId}: crediting ` +
          `${w.count} payment(s) to ${w.payerName} on match ${paymentMatchId} failed ` +
          `(${applied.error})`,
      );
      failedIds.add(w.sourceMessageId);
      continue;
    }
    // The ack is built from what LANDED, not from what was asked for —
    // and it REPLACES the composer's generic `payment_ack`, because the
    // shipped sentence carries the unpaid count the chase depends on and
    // the composer cannot see payment state at all.
    replyByMessage.set(w.sourceMessageId, composePaymentAck(applied, w.payerName));
    actedIds.add(w.sourceMessageId);
  }

  for (const w of reminders) {
    const sender = messages.find((m) => m.waMessageId === w.sourceMessageId);
    const applied = await applyReminder({
      write: w,
      name: sender?.senderName ?? sender?.authorName ?? null,
      note: w.note,
      deps,
    });
    if (!applied.ok) {
      degradations.push(
        `${ADMIN_OPS_APPLY_DEGRADED_PREFIX} ${w.sourceMessageId}: queueing the reminder for ` +
          `${w.whenLabel} failed (${applied.error})`,
      );
      failedIds.add(w.sourceMessageId);
      continue;
    }
    actedIds.add(w.sourceMessageId);
  }

  // ── Stage 4: composition, AFTER the apply ──────────────────────────
  const composed = compose(result);
  const composedByMessage = new Map<string, string[]>();
  for (const u of composed.utterances) {
    if (u.messageId === null) {
      degradations.push(
        `${ADMIN_OPS_APPLY_DEGRADED_PREFIX} a batch-level post was composed on the admin path; dropped`,
      );
      continue;
    }
    if (!ownedIds.has(u.messageId)) continue;
    const list = composedByMessage.get(u.messageId) ?? [];
    list.push(u.text);
    composedByMessage.set(u.messageId, list);
  }
  // A payment ack computed from what the apply layer ACTUALLY DID wins
  // over the composer's `payment_ack`, which knows nothing about payment
  // state and so cannot carry the unpaid count the chase depends on.
  // Everything else the composer produced stands.
  for (const [id, list] of composedByMessage) {
    if (replyByMessage.has(id)) continue;
    replyByMessage.set(id, list.join("\n\n"));
  }
  const reactByMessageId = new Map(composed.reacts.map((r) => [r.messageId, r.emoji]));
  for (const n of composed.operatorNotes) {
    if (!degradations.includes(n)) degradations.push(n);
  }

  // ── Per-message outcomes ───────────────────────────────────────────
  const outcomes = new Map<string, AdminOpsMessageOutcome>();
  for (const m of messages) {
    if (!ownedIds.has(m.waMessageId)) continue;
    const engineOutcome = result.outcomes.find((o) => o.messageId === m.waMessageId);
    const facts = factsById.get(m.waMessageId);
    const action = facts?.kind === "admin" ? (facts as AdminFacts).action : "other";
    const failed = failedIds.has(m.waMessageId);
    const machineReasons = (engineOutcome?.reasons ?? []).join("; ");
    const isRecruit = recruitByMessage.has(m.waMessageId);
    const isStatsBlast = statsBlastIds.has(m.waMessageId);

    // §3.2 S7: a write that threw says nothing at all.
    const reply = failed ? null : (replyByMessage.get(m.waMessageId) ?? null);
    const react = failed
      ? null
      : (reactByMessageId.get(m.waMessageId) ??
        // The shipped reacts, carried rather than moved into the engine:
        // losing them would be a visible change on a flag advertised as
        // a like-for-like move. `route.ts:3911` (payment) and `:3990`
        // (reminder).
        (actedIds.has(m.waMessageId) && action === "bulk_payment"
          ? "👍"
          : actedIds.has(m.waMessageId) && action === "reminder"
            ? "⏰"
            : null));

    outcomes.set(m.waMessageId, {
      waMessageId: m.waMessageId,
      route: m.route as Route,
      reply,
      react,
      // The vocabulary `AnalysisIntent` already uses, so the admin log
      // and the nightly sweeps need no new cases.
      intent:
        action === "bulk_payment"
          ? "bulk_payment_credit"
          : action === "reminder"
            ? "reminder_request"
            : isRecruit
              ? "recruit_recent"
              : // The label the deleted fast path wrote, kept so the
                // admin log's vocabulary and every sweep over it are
                // unchanged by the move from regex to model.
                isStatsBlast
                ? "stats_blast"
                : "noise",
      action: failed ? "none" : actedIds.has(m.waMessageId) ? action : react ? "react" : reply ? "reply" : "none",
      reasoning:
        `${ADMIN_OPS_HANDLED_BY} (${m.route}): ${machineReasons || "no rule fired"}` +
        (failed ? "; the write FAILED and nothing was said" : ""),
      recruitRequest: isRecruit,
      recruitLookbackMatches: recruitByMessage.get(m.waMessageId) ?? null,
      statsBlastRequest: isStatsBlast,
      writeFailed: failed,
    });
  }

  return { ownedIds, outcomes, degradations, cost: { ...cost, ms: Date.now() - t0 } };
}

/**
 * WHAT THE ADMIN-OPS ENGINE DID, AND WHAT IT LOST, for the operator.
 *
 * Pure and exported for the reason `describeEngineBatch` is: the same
 * lines were once composed behind `if (ownedIds.size > 0)`, which
 * silences them in exactly the case they exist for.
 */
export function describeAdminOpsBatch(
  batch: AdminOpsBatchResult,
  batchSize: number,
): { warns: string[]; info: string | null } {
  const warns = batch.degradations.map((d) => `[analyze] admin-ops-engine degraded: ${d}`);
  const info =
    batch.ownedIds.size > 0 || batch.degradations.length > 0
      ? `[analyze] admin-ops-engine: decided ${batch.ownedIds.size}/${batchSize} message(s), ` +
        `$${batch.cost.usd.toFixed(5)} across ${batch.cost.calls} extractor call(s) ` +
        `in ${batch.cost.ms}ms`
      : null;
  return { warns, info };
}
