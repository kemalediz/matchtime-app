/**
 * §10 STEP 6 — THE ATTENDANCE PATH, END TO END.
 *
 *   router → extractor → engine → APPLY → composer
 *
 * for the three routes step 6 owns (`self_att`, `other_att`, `offer`)
 * and for nothing else. Everything the router calls `question`,
 * `balancer`, `score`, `admin_ops` or `unsure` still reaches the
 * 18,315-token prompt unchanged, and everything it calls `none` is
 * step 5's business.
 *
 * ─────────────────────────────────────────────────────────────────────
 * FAIL OPEN, ALWAYS
 * ─────────────────────────────────────────────────────────────────────
 * Every failure mode here lands on "the analyzer decides this message",
 * which is today's behaviour and therefore cannot be a regression:
 *
 *   • the flag is off                      → owns nothing
 *   • no active registration match         → owns nothing
 *   • attendance is off for the org        → owns nothing
 *   • the router never mentioned the id    → owns nothing (`undefined`
 *                                            is not a route)
 *   • an open bench prompt for the sender  → owns nothing for them
 *   • the state load throws                → owns nothing
 *   • an extractor call throws             → THAT MESSAGE degrades and
 *                                            is reported; it does not
 *                                            fall back to the analyzer,
 *                                            because the analyzer batch
 *                                            has already been decided
 *                                            by then (see below).
 *
 * OWNERSHIP IS DECIDED BEFORE THE ANALYZER RUNS, on purpose. The route
 * has to know which ids to leave out of `analyzeBatch`, and asking the
 * mega-prompt about a message the engine is also going to decide would
 * mean two deciders and two replies for one message. So the engine runs
 * FIRST, its writes land FIRST, and the analyzer then sees the world
 * those writes made. Within a batch that mixes the two — rare, since
 * the analyzer keeps only the non-attendance routes — that ordering is
 * the honest one: the explicit attendance instructions are applied
 * before anything reasons about the squad.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE ENGINE SEES THE WHOLE WINDOW
 * ─────────────────────────────────────────────────────────────────────
 * Only owned messages are extracted, but EVERY message in the batch is
 * handed to `decide()`. Two rules depend on it and both are §9
 * survivors:
 *
 *   • the banter-drop guard corroborates against the target's own
 *     message in the same window (2026-06-12, Zeeshan);
 *   • the state collapse only lets an author's LATEST writing message
 *     write.
 *
 * A message the engine does not own arrives with `facts: {kind:"none"}`
 * and produces a `noop` outcome with a reason, which is what
 * `assertCoverage` requires and what keeps "exactly one outcome per
 * message" true across the split.
 */
import type { AttendanceWriteFailure } from "./attendance-write-outcome";
import { parsePastedRoster } from "./pasted-roster";
import { extractForRoute } from "./pipeline/extractors";
import { extractorStubFromEnv } from "./pipeline/extractor-stub";
import { anthropicModel, type PipelineModel } from "./pipeline/llm";
import { compose } from "./pipeline/compose";
import { decide } from "./pipeline/engine";
import { engineOwnsRoute, isAttendanceEngineEnabled } from "./pipeline/gate";
import { loadSquadState } from "./pipeline/load-state";
import type {
  AttendanceFacts,
  EngineMessage,
  EngineResult,
  Facts,
  Route,
  SquadState,
} from "./pipeline/types";
import {
  ENGINE_APPLY_DEGRADED_PREFIX,
  analyzedActionFor,
  applyEngineWrites,
  type EngineActor,
  type EngineApplyDeps,
  type EngineAttendanceWrite,
  type EngineWriteResult,
} from "./attendance-engine";

export interface EngineBatchMessage {
  waMessageId: string;
  body: string;
  authorName: string | null;
  senderUserId: string | null;
  senderName: string | null;
  senderIsAdmin: boolean;
  tagged: boolean;
  /** From the router. `undefined` when it never mentioned this id. */
  route: Route | undefined;
  /** Did step 5's gate skip this message? Then step 6 never sees it. */
  gated: boolean;
}

/** What the route needs in order to turn one owned message into exactly
 *  one `ActionForBot` and one `AnalyzedMessage` row. */
export interface EngineMessageOutcome {
  waMessageId: string;
  route: Route;
  reply: string | null;
  react: string | null;
  /** `AnalyzedMessage.intent`. Vocabulary the admin log already
   *  understands, derived from what HAPPENED, never from a model. */
  intent: string;
  /** `AnalyzedMessage.action`, from the writes that landed. */
  action: string;
  /** Machine reasons, one per rule that fired. Never prose for a regex
   *  to parse — nothing in this codebase parses it, and step 6 is the
   *  step that deletes the things that used to. */
  reasoning: string;
  /** Writes that THREW, for the honest ack. */
  failures: AttendanceWriteFailure[];
  /** The sender's own row moved, so the post-batch react audit should
   *  reconcile this react against the database. */
  senderOwnRowMoved: boolean;
  /** An admin asked for a replacement in this same message (PR #33). */
  recruitRequest: boolean;
  /** Personal-uncertainty conditional: record a MAYBE and chase later
   *  (`tentative-followup.ts`). Preserved from `executeVerdict`. */
  recordTentativeForUserId: string | null;
  /** A firm IN/OUT answers any open tentative follow-up. */
  resolveTentativeForUserId: string | null;
}

export interface EngineBatchResult {
  ownedIds: Set<string>;
  outcomes: Map<string, EngineMessageOutcome>;
  /** Attached to the LAST owned message that acted, so the batch has
   *  one squad post and it goes through the same batch-final
   *  composition and collapse as the analyzer's (§10 step 4). */
  squadPostForMessageId: string | null;
  matchId: string | null;
  degradations: string[];
  cost: { usd: number; calls: number; ms: number };
}

/**
 * "The engine owns nothing; the analyzer keeps the batch."
 *
 * A FUNCTION, not a shared const. The result carries a `Set` and a
 * `Map`, and a single frozen-by-convention instance handed to every
 * caller is one `.add()` away from one request's state leaking into
 * the next. Cheap to build, and it takes the accumulated degradations
 * so a fail-open never loses the reason it happened.
 */
function empty(degradations: string[] = []): EngineBatchResult {
  return {
    ownedIds: new Set(),
    outcomes: new Map(),
    squadPostForMessageId: null,
    matchId: null,
    degradations,
    cost: { usd: 0, calls: 0, ms: 0 },
  };
}

export interface EngineBatchDeps extends EngineApplyDeps {
  /** Users with an unresolved bench prompt open on the active match.
   *  See the carve-out below. */
  openBenchPromptUserIds: (matchId: string) => Promise<string[]>;
  /** Injected so tests can drive the whole batch without a key. */
  model?: PipelineModel;
  /** Injected so tests can load a state without a database. */
  loadState?: (orgId: string, now: Date) => Promise<SquadState>;
}

export async function runAttendanceEngineBatch(args: {
  orgId: string;
  now: Date;
  messages: EngineBatchMessage[];
  history: Array<{ author: string | null; body: string }>;
  /**
   * The match the ROUTE believes registration lands on
   * (`findRegistrationMatch`). The engine's own loader picks the active
   * match with the same pure selector but from a 30-day window, so the
   * two can only disagree on a match that has been in flight for over a
   * month — and if they ever do, the engine owns nothing rather than
   * writing to a different match than the rest of the request is
   * describing.
   */
  expectedMatchId: string | null;
  /** The flag, resolved by the caller (which also knows about the
   *  test-only per-request override). Defaults to reading the env, so
   *  no caller can accidentally get an engine it did not ask for. */
  enabled?: boolean;
  deps: EngineBatchDeps;
}): Promise<EngineBatchResult> {
  const { orgId, now, messages, history, expectedMatchId, deps } = args;
  if (!(args.enabled ?? isAttendanceEngineEnabled())) return empty();

  const candidates = messages.filter((m) => !m.gated && engineOwnsRoute(m.route));
  if (candidates.length === 0) return empty();

  const degradations: string[] = [];
  const t0 = Date.now();

  let state: SquadState;
  try {
    state = await (deps.loadState ?? loadSquadState)(orgId, now);
  } catch (err) {
    // Fail open. Owning nothing means the analyzer decides, which is
    // what happens today.
    console.error("[attendance-engine] state load failed; the analyzer keeps the batch:", err);
    return empty();
  }

  // ── The carve-outs, all in the "own nothing" direction ─────────────
  if (!state.features.attendance) return empty();
  if (!state.matchId) {
    // No active registration match. The analyzer's `findRegistrationMatch`
    // would return null too and `executeVerdict` would do nothing, so
    // the outcome is the same either way — but it is the analyzer's
    // silence, with its reply and its `AnalyzedMessage` row, rather
    // than a second kind of silence nobody has seen before.
    return empty();
  }
  if (expectedMatchId !== null && state.matchId !== expectedMatchId) {
    console.warn(
      `[attendance-engine] the route's registration match (${expectedMatchId}) and the ` +
        `engine's (${state.matchId}) disagree; owning nothing`,
    );
    return empty();
  }
  const matchId = state.matchId;

  // A bench player answering an open bench PROMPT in the group is
  // `resolveBenchConfirmation`'s business (`route.ts:2668-2697`) — a
  // different table (`PendingBenchConfirmation`) and a different flow
  // from the `BenchSlotOffer` the engine models. The engine has no
  // concept of it, so a bare "yes" from someone with a prompt open
  // stays with the analyzer. Narrow, provable, and in the safe
  // direction: it costs one analyzer call.
  let promptedUserIds = new Set<string>();
  try {
    promptedUserIds = new Set(await deps.openBenchPromptUserIds(matchId));
  } catch (err) {
    console.error("[attendance-engine] bench-prompt lookup failed; owning nothing:", err);
    return empty();
  }

  const owned = candidates.filter((m) => {
    if (m.senderUserId && promptedUserIds.has(m.senderUserId)) return false;
    // ── PR #39's pasted-roster clamp is NOT reimplemented here ───────
    //
    // A pasted numbered roster is a message shape with its own solved
    // handling in the analyze route: `reconcilePastedRoster` computes
    // the appended names ARITHMETICALLY when the paste restates our own
    // roster post (S26), and `clampRosterDerivedWrites` registers
    // NOBODY off any other list. That exists because PR #35's
    // self-replay measured the same paste registering a DIFFERENT
    // SUBSET on each run — `Nabeel` one time, `Adam, Amir, Ehtisham,
    // Martin` the next.
    //
    // The engine has no equivalent, and a fourteen-line roster routed
    // `other_att` is fourteen third-party IN claims it would happily
    // apply. Rather than reimplement a shipped guard on the one step
    // that can put a player at a pitch with no slot, the shape is
    // simply not owned: it goes to the analyzer, where both rules
    // already run. The test is on the SHAPE and never on who is named,
    // so it cannot be steered by content.
    if (parsePastedRoster(m.body)) return false;
    // ── A SHARED CONTACT CARD IS NOT AN ATTENDANCE MESSAGE ───────────
    //
    // Found by the §10 step 6 replay sweep, adjudicated `old_right`:
    //
    //   2026-06-11, Ehtisham Ul Haq — a forwarded WhatsApp vCard
    //   (`BEGIN:VCARD … FN:Salman Shelly Ftbl … END:VCARD`) followed by
    //   "Add these 2 boys pl". The engine registered a member literally
    //   called "Salman Shelly Ftbl" — the card's display name, football
    //   suffix and all — and registered ONE of the two people asked
    //   for. The incumbent wrote nothing. Production labelled both
    //   messages `noise`.
    //
    // The card's `FN:` line looks exactly like a name to an extractor
    // and passes every check in `identity.ts`, because it IS letters and
    // it IS a person. What makes it wrong is the CONTAINER: a vCard is
    // an attachment WhatsApp renders as text, its display name is
    // whatever the sender saved in their phone, and "add these 2 boys"
    // beside it is `bring_guests_vague` (§3.2 S20) — a guest-name ask,
    // never a registration.
    //
    // Shape, not content: the test is the envelope, so it cannot be
    // steered by who the card names.
    if (/^BEGIN:VCARD/im.test(m.body)) return false;
    return true;
  });
  if (owned.length === 0) return empty();
  const ownedIds = new Set(owned.map((m) => m.waMessageId));

  // ── Stage 2: extractors, in parallel ───────────────────────────────
  const model = deps.model ?? extractorStubFromEnv() ?? anthropicModel();
  // MatchTime's own last post, from the HISTORY the Pi forwards on every
  // call, falling back to the last queued group `BotJob` that
  // `loadSquadState` read.
  //
  // The history wins because it is what actually appeared in the group:
  // a `BotJob` is a queued send, and a group whose last post predates
  // the buffer window has an empty one. §3.2 S25's whole mechanism is
  // that the bot's last post is a KNOWN OBJECT, so a bare "Confirmed"
  // is a lookup rather than an inference — and with the wrong object it
  // is neither. Measured: corpus case
  // `S25-short-confirm-after-pending-list` went 3/3 → 0/3 ("expected
  // MatchTime to say something; it was silent") because the pending
  // list was in the history and `state.lastBotPost` was null.
  //
  // It feeds BOTH the extractor's context block and the engine's
  // `parsePendingSet`, which must agree or the two stages resolve the
  // same "Confirmed" against different posts.
  const lastBotPost =
    [...history].reverse().find((h) => (h.author ?? "").toLowerCase() === "matchtime")?.body ??
    state.lastBotPost ??
    null;
  state = { ...state, lastBotPost };

  let cost = { usd: 0, calls: 0, ms: 0 };
  const factsById = new Map<string, { facts: Facts; degraded: string | null }>();
  await Promise.all(
    owned.map(async (m) => {
      const res = await extractForRoute(model, m.route as Route, {
        id: m.waMessageId,
        body: m.body,
        authorName: m.authorName,
        tagged: m.tagged,
        history,
        lastBotPost,
      });
      for (const d of res.degradations) degradations.push(`extractor ${m.waMessageId}: ${d.detail}`);
      if (res.usage) {
        cost = {
          usd: cost.usd + (res.usage.costUsd ?? 0),
          calls: cost.calls + 1,
          ms: Math.max(cost.ms, res.usage.ms),
        };
      }
      // An extractor that FAILED (as opposed to one that found nothing)
      // must not become silence.
      const failure = res.degradations.find((d) => /failed|could not be parsed/i.test(d.detail));
      factsById.set(m.waMessageId, {
        facts: res.facts,
        degraded: failure ? failure.detail : null,
      });
    }),
  );

  // ── A FAILED EXTRACTION FALLS BACK TO THE ANALYZER, PER MESSAGE ────
  //
  // §11.4 says "on extractor failure, fail closed and surface it". That
  // was written before the analyzer was still standing beside this
  // path, and closed here meant SILENT: no write, no reply, and a
  // player who said IN is not in the squad. Measured on the first live
  // corpus sweep of this step: 27 `529 Overloaded` and 3 `500`s across
  // 10 messages, which took S8 and S13b from 3/3 to 0/3 — not because
  // the engine decided them wrongly but because it never got to decide
  // them at all.
  //
  // The engine is one of TWO deciders and the other one is the
  // incumbent, with every seatbelt still around it. So a message whose
  // extraction failed is simply not owned: it goes back into
  // `batchInputs` and the 18,315-token prompt handles it, exactly as it
  // does today. That is the step's own revert — "flag flips the three
  // routes back" — applied per message and automatically, and it costs
  // one analyzer call.
  //
  // This is only possible because the engine runs BEFORE `analyzeBatch`
  // (see the header). Nothing has been written and no batch has been
  // sent when this decision is made.
  const failedIds = new Set(
    [...factsById.entries()].filter(([, v]) => v.degraded).map(([id]) => id),
  );
  if (failedIds.size > 0) {
    for (const id of failedIds) {
      const detail = factsById.get(id)?.degraded ?? "unknown";
      degradations.push(
        `${ENGINE_APPLY_DEGRADED_PREFIX} ${id}: ${detail} — handing this message back to the analyzer`,
      );
    }
    console.warn(
      `[attendance-engine] ${failedIds.size} extraction(s) failed; those messages go to the ` +
        `analyzer instead of going silent`,
    );
  }
  for (const id of failedIds) ownedIds.delete(id);
  // Carrying `degradations` matters here: this is the branch where
  // EVERY extraction failed, and returning the bare empty result would
  // throw away the only record of why the engine went quiet.
  if (ownedIds.size === 0) return empty(degradations);

  // ── Stage 3: the engine, over the WHOLE window ─────────────────────
  const engineMessages: EngineMessage[] = messages.map((m) => {
    const f = factsById.get(m.waMessageId);
    return {
      id: m.waMessageId,
      body: m.body,
      senderUserId: m.senderUserId,
      senderName: m.senderName ?? m.authorName,
      tagged: m.tagged,
      // A message the engine does not own still carries its real route
      // so the outcome says why nothing happened. `none` is honest for
      // an id the router never mentioned.
      route: m.route ?? "none",
      facts: f?.facts ?? { kind: "none" },
      degraded: f?.degraded ?? null,
    };
  });

  // `decide` asserts its own post-conditions and THROWS on a coverage
  // violation, which is right — a coverage hole is a bug in the engine,
  // not a bad model day. But it must not 500 the analyze request: at
  // this point not one write has happened and the analyzer batch has
  // not been decided, so owning nothing is a complete fail-open back to
  // today's behaviour. §11.5 is honest that the engine is a single
  // point of failure; this is what stops it being a single point of
  // OUTAGE.
  let result: EngineResult;
  try {
    result = decide({ messages: engineMessages, state, now });
  } catch (err) {
    console.error(
      "[attendance-engine] the engine threw; the analyzer keeps the batch:",
      err,
    );
    return empty();
  }
  for (const d of result.degradations) {
    degradations.push(`${d.stage} ${d.messageId ?? "batch"}: ${d.detail}`);
  }

  // ── Stage 3b: APPLY. Only writes from owned messages. ──────────────
  //
  // The engine cannot produce a write from a message it was not given
  // facts for, so this filter is belt and braces — and belt and braces
  // is the right amount for the one step that can put a player at a
  // pitch with no slot.
  const actorByMessageId = new Map<string, EngineActor>(
    messages.map((m) => [
      m.waMessageId,
      { userId: m.senderUserId, name: m.senderName ?? m.authorName, isAdmin: m.senderIsAdmin },
    ]),
  );
  const applicable = result.writes.filter((w) => ownedIds.has(w.sourceMessageId));
  const foreign = result.writes.length - applicable.length;
  if (foreign > 0) {
    degradations.push(
      `${foreign} write(s) came from a message the engine does not own; refused`,
    );
  }
  const applied = await applyEngineWrites({
    matchId,
    writes: applicable,
    actorByMessageId,
    deps,
  });

  // ── Stage 4: composition ───────────────────────────────────────────
  const composed = compose(result);
  const utteranceByMessageId = new Map<string, string[]>();
  let squadPost: string | null = null;
  for (const u of composed.utterances) {
    if (u.messageId === null) {
      squadPost = u.text;
      continue;
    }
    if (!ownedIds.has(u.messageId)) continue;
    const list = utteranceByMessageId.get(u.messageId) ?? [];
    list.push(u.text);
    utteranceByMessageId.set(u.messageId, list);
  }
  const reactByMessageId = new Map(composed.reacts.map((r) => [r.messageId, r.emoji]));
  for (const n of composed.operatorNotes) degradations.push(n);

  // ── Per-message outcomes ───────────────────────────────────────────
  const appliedByMessage = new Map<string, EngineWriteResult[]>();
  for (const a of applied) {
    const list = appliedByMessage.get(a.write.sourceMessageId) ?? [];
    list.push(a);
    appliedByMessage.set(a.write.sourceMessageId, list);
  }

  const outcomes = new Map<string, EngineMessageOutcome>();
  let lastActed: string | null = null;

  for (const m of owned) {
    // A message whose extraction failed is no longer ours — it is in
    // `batchInputs` and the analyzer will decide it. Producing an
    // outcome for it here would give it two deciders and two replies.
    if (!ownedIds.has(m.waMessageId)) continue;
    const engineOutcome = result.outcomes.find((o) => o.messageId === m.waMessageId);
    const writes = appliedByMessage.get(m.waMessageId) ?? [];
    const landed = writes.filter((w) => w.ok).map((w) => w.write);
    const failures = writes
      .filter((w) => !w.ok)
      .map((w) => ({
        action: statusToAction(w.write.status),
        who: w.write.userId === m.senderUserId ? null : w.write.name,
        error: w.error ?? "unknown",
      }));

    const facts = factsById.get(m.waMessageId)?.facts;
    const attendanceFacts: AttendanceFacts | null =
      facts && facts.kind === "attendance" ? facts : null;

    const utterances = utteranceByMessageId.get(m.waMessageId) ?? [];
    // ONE reply per message. Several speech intents for the same
    // message join into one send; they never become two results.
    let reply: string | null = utterances.length > 0 ? utterances.join("\n\n") : null;
    if (landed.length > 0) lastActed = m.waMessageId;

    // An extractor failure must surface on the partial-response admin
    // DM, not vanish. §9 keeps that net and asks for a TYPED error
    // rather than a prefix-matched free-text `reasoning`; this is it.
    const degraded = factsById.get(m.waMessageId)?.degraded ?? null;
    const machineReasons = (engineOutcome?.reasons ?? []).join("; ");
    const reasoning = degraded
      ? `${ENGINE_APPLY_DEGRADED_PREFIX} ${degraded}`
      : `attendance-engine (${m.route}): ${machineReasons || "no rule fired"}`;
    if (degraded) reply = null;

    const senderOwnRowMoved = landed.some((w) => w.userId === m.senderUserId);

    outcomes.set(m.waMessageId, {
      waMessageId: m.waMessageId,
      route: m.route as Route,
      reply,
      react: reactByMessageId.get(m.waMessageId) ?? null,
      intent: intentFor(landed, m.senderUserId, attendanceFacts, reply),
      action: analyzedActionFor(landed, m.senderUserId),
      reasoning,
      failures,
      senderOwnRowMoved,
      // PR #33: a recruit ask alongside a drop must do BOTH, and the
      // blast has to run after the drop lands. The route defers it to
      // the batch-final pass exactly as it does for the analyzer's
      // `recruitRequest`, so the two paths share one implementation and
      // one dedupe.
      recruitRequest: !!attendanceFacts?.sideRequests.includes("recruit") && m.senderIsAdmin,
      recordTentativeForUserId: tentativeUserId(attendanceFacts, m.senderUserId, landed),
      resolveTentativeForUserId: senderOwnRowMoved ? m.senderUserId : null,
    });
  }

  return {
    ownedIds,
    outcomes,
    squadPostForMessageId: squadPost ? (lastActed ?? [...ownedIds].at(-1) ?? null) : null,
    matchId,
    degradations,
    cost: { ...cost, ms: Date.now() - t0 },
  };
}

// ── helpers ─────────────────────────────────────────────────────────

function statusToAction(s: EngineAttendanceWrite["status"]): AttendanceWriteFailure["action"] {
  return s === "CONFIRMED" ? "IN" : s === "BENCH" ? "BENCH" : "OUT";
}

/**
 * `AnalyzedMessage.intent`, in the vocabulary the admin log and the
 * `none`-bucket shadow already speak. Derived from the OUTCOME, which
 * is cold-audit 1.3's complaint about the existing column ("records the
 * intent, not the outcome") answered by construction.
 */
export function intentFor(
  landed: EngineAttendanceWrite[],
  senderUserId: string | null,
  facts: AttendanceFacts | null,
  reply: string | null,
): string {
  const own = senderUserId ? landed.find((w) => w.userId === senderUserId) : undefined;
  if (own) return own.status === "DROPPED" ? "out" : "in";
  if (landed.length > 0) return "in";
  if (facts?.claims.some((c) => c.contingent)) return "conditional_in";
  if (facts?.sideRequests.includes("recruit")) return "replacement_request";
  return reply ? "question" : "noise";
}

/**
 * Personal-uncertainty conditionals ("in if my back holds up") write
 * nothing and are chased ~24h before kickoff. The engine declines the
 * write; the follow-up is a real product behaviour on the shipped path
 * (`executeVerdict`'s `recordTentative`) and step 6 must not lose it.
 *
 * Read from the FACTS — `contingent` + `conditionOn: "self"` — which is
 * the schema field §9 says `looksLikeConditionalDrop` becomes, not from
 * anybody's prose.
 */
export function tentativeUserId(
  facts: AttendanceFacts | null,
  senderUserId: string | null,
  landed: EngineAttendanceWrite[],
): string | null {
  if (!facts || !senderUserId) return null;
  if (landed.some((w) => w.userId === senderUserId)) return null;
  const self = facts.claims.find(
    (c) =>
      c.subject === "sender" &&
      c.contingent &&
      c.conditionOn === "self" &&
      c.polarity !== "out" &&
      c.tense !== "past" &&
      c.tense !== "hypothetical",
  );
  return self ? senderUserId : null;
}
