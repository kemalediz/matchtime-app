/**
 * §10 STEP 8 — WHAT REPLACES "FALL BACK TO THE ANALYZER".
 *
 * Every runner in the pipeline shipped with the same failure table, and
 * every row of it ended the same way:
 *
 *   • the route's flag is off                 → the analyzer decides it
 *   • the message is untagged                 → the analyzer decides it
 *   • the extractor call threw                → the analyzer decides it
 *   • the shape is one no composer can answer → the analyzer decides it
 *   • the engine threw                        → the analyzer decides it
 *
 * That table was honest — "which is today's behaviour and therefore
 * cannot be a regression" — for exactly as long as the analyzer existed.
 * Step 8 deletes `analyzeBatch` and the 19,850-token `SYSTEM_PROMPT`, so
 * every one of those arrows now points at nothing, and "fails open"
 * quietly becomes "goes silent".
 *
 * This module is the thing the arrows point at instead.
 *
 * ─────────────────────────────────────────────────────────────────────
 * IT IS AN OPERATOR SURFACE, NOT A SECOND DECIDER
 * ─────────────────────────────────────────────────────────────────────
 *
 * It does not classify, reply, react or write. It decides one thing:
 * whether a message nobody owned is worth a human being told about, and
 * it composes the sentence that tells them. §11.5 accepted the
 * behavioural loss this creates in advance — "a router with nine routes
 * and an engine with explicit rules will do nothing instead… the club
 * will experience it as 'the bot got dumber' before they experience it
 * as 'the bot stopped being wrong'" — and the only thing that makes that
 * loss survivable is that somebody can SEE it.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE RULE IS A ROUTE TEST, NEVER A CONTENT TEST
 * ─────────────────────────────────────────────────────────────────────
 *
 * Two failures are in tension and both are real:
 *
 *   • §9 names "message understood, action silently not taken" this
 *     product's SIGNATURE failure. Baki's drop went unnoticed for
 *     thirteen days for want of any signal at all.
 *   • 69.3% of real traffic is banter (measured over 1,723 production
 *     messages, PR #35). An admin DM per unowned message would fire on
 *     all of it, and a nagging operator surface is an ignored one —
 *     which is the same silence with extra steps.
 *
 * So: a message the router called `none` is never noted, and a message
 * it routed to something actionable that nobody then acted on always is.
 * That reads a ROUTE and not a sentence, which keeps this module on the
 * right side of the line `gate.ts` draws between a classifier (decides
 * what a message means, wrong in both directions) and a seatbelt
 * (decides only whether a human looks, wrong in one).
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT DOES *NOT* REACH HERE, AND WHY EACH ONE IS RIGHT
 * ─────────────────────────────────────────────────────────────────────
 *
 * The caller filters these out before composing, and each is a decision
 * rather than an omission:
 *
 *   • A message a DETERMINISTIC path handled — the stats link, the stats
 *     blast, group→DM Q&A, rating progress, help, the colour swap, the
 *     team swap, a bench-prompt answer, a pasted roster. Nothing failed;
 *     it simply was not the pipeline's business.
 *   • A message an owner OWNED and DECIDED nothing should happen about.
 *     That is a decision with a reason and it already gets an
 *     `AnalyzedMessage` row — §11.2's own mitigation, "log the route
 *     alongside the extracted facts, so triage is one query". Paging an
 *     admin because the engine correctly concluded that a joke was a
 *     joke is the nagging above.
 *
 *     ⚠️ AMENDED 2026-09-09. That paragraph was doing two jobs and only
 *     one of them was sound. An owner that DECIDES is covered by the row
 *     and stays out of the DM, exactly as written. But an owner that
 *     claims a message and comes away with NOTHING TO DECIDE has made no
 *     decision at all, and from out here it read identically to one that
 *     had. Two players' "In" was lost that way. See the second header
 *     block below and `silentDiscard`.
 *   • A message the ORG's features exclude. That is not a failure; it
 *     is the club saying do not do this, and a note there pages a human
 *     because the system is working.
 *
 *     ⚠️ THIS PARAGRAPH USED TO END "The caller filters these out before
 *     composing", AND THE CALLER DID NO SUCH THING. Found on 2026-09-06
 *     by reading this header against `route.ts`, which had no feature
 *     test in its unowned branch at all. `teamBalancing` was covered by
 *     accident — `team-ops-engine-batch.ts` OWNS a message and emits a
 *     `noise` outcome when the feature is off, so it never arrives here
 *     — but `attendance` was not: `attendance-engine-batch.ts` returns
 *     `empty()`, which means UNOWNED. A MoM-and-ratings-only org with
 *     `statsQa` on (enough to keep the pipeline running) would have had
 *     its admin paged for every "in" in the group.
 *
 *     The filter is now IN this module, below, so the claim is true by
 *     construction rather than by promise. That is the whole lesson of
 *     the four seatbelts found dead on 2026-08-31: a comment asserting
 *     that something else handles it is not a mechanism.
 *
 * ─────────────────────────────────────────────────────────────────────
 * IT INHERITS THE PARTIAL-RESPONSE NET RATHER THAN ADDING A SECOND ONE
 * ─────────────────────────────────────────────────────────────────────
 *
 * §9 lists "the partial-response admin DM" (`route.ts:648-720`) among
 * the twenty-two seatbelts that SURVIVE, with one instruction: "Keep,
 * but fix the mechanism: today it prefix-matches free-text `reasoning`;
 * under the new design it matches a typed error, which is what it always
 * wanted to be."
 *
 * This is that fix. The old net selected messages by string-matching six
 * prefixes against `verdict.reasoning`, a field written by the model —
 * the same "that is not an interface, it is a hope" pattern §1 objects
 * to. The new one selects on a typed fact: an id that reached the end of
 * the batch with no owner. Same DM, same 1-hour dedupe, same audience;
 * the input stopped being prose.
 *
 * ⚠️ AMENDED 2026-09-28: IT IS NO LONGER A DM. The owner never read these
 * and they buried the messages he does need, so the note is now RECORDED
 * (an `OpsAlert` event, shown at /admin/health) and sent to nobody. The
 * selection and the sentence below are unchanged; only where it lands
 * moved. See `src/lib/ops-alerts.ts`.
 */
/**
 * ─────────────────────────────────────────────────────────────────────
 * 2026-09-09 — "DID ANYBODY OWN IT?" WAS THE WRONG QUESTION
 * ─────────────────────────────────────────────────────────────────────
 *
 * Two real players typed "In" for Tuesday's match. The attendance engine
 * CLAIMED both messages, wrote nothing, said nothing, and neither player
 * was registered:
 *
 *   18:47  Abid Kazmi    "In"  self_att  action=none
 *   18:57  Mojib Jalali  "In"  self_att  action=none
 *          "short confirmation with no pending set in the bot's last post"
 *
 * Kemal saw it in the group. Nothing told him, and the reason is
 * structural rather than a missing string: this module's input was
 * MESSAGES NOBODY OWNED, and a message an owner claimed and then did
 * nothing with is not in that set. It was answering "did anything CLAIM
 * this?" when the question that matters is "did anything HAPPEN?".
 *
 * `owned` below is the second input, and `silentDiscard` is its rule.
 * That function is the whole of this change and the argument is written
 * out where it is defined; the short version is that most no-ops really
 * are correct, so the test has to separate a DECISION with a reason from
 * an UNDERSTANDING that came away with nothing — and it has to do that
 * WITHOUT reading anybody's prose, because a deny-list of reason strings
 * drifts the moment somebody adds a rule, which is exactly the failure
 * it exists to catch.
 */
import type { Disposition, Route } from "./pipeline/types";

/**
 * The phrase every note carries, so it can be found by text.
 *
 * It used to be what the 1-hour DM dedupe searched `BotJob.text` for.
 * Since 2026-09-28 the note is not a DM at all: it is recorded as an
 * `OpsAlert` event for the owner's /admin/health page (see
 * `src/lib/ops-alerts.ts`), deduped on `dedupeKey`. The phrase stays
 * pinned by the tests because the e2e specs find the note by it.
 */
export const OPERATOR_NOTE_MARKER = "routed to an action but nothing handled";

/** A message that reached the end of the batch with nobody owning it. */
export interface UnownedMessage {
  waMessageId: string;
  body: string;
  authorName: string | null;
  /** The router's answer. `undefined` means the router never mentioned
   *  this id at all, which is a coverage hole rather than a decision. */
  route: Route | undefined;
}

/**
 * A message an owner DID claim, with the typed facts `silentDiscard`
 * reads. Every field is something the pipeline already produces, and not
 * one of them is a sentence.
 */
export interface OwnedMessage {
  waMessageId: string;
  body: string;
  authorName: string | null;
  /** The router's answer. An owned message always has one. */
  route: Route;
  /** `MessageOutcome.disposition` — the engine's own typed verdict.
   *  `acted` means it emitted a write or flagged a speech turn. */
  disposition: Disposition;
  /** Did MatchTime reply or react to this message? Kept separate from
   *  `disposition` because a caller can add words the engine never
   *  flagged (the honest ack, the unresolved-sender nudge), and a player
   *  who was told something is not a silent discard. */
  spoke: boolean;
  /** Did the sender resolve to a squad member? */
  senderResolved: boolean;
  /** How many claims the EXTRACTOR came away with, about anybody. The
   *  count, never the content — see `silentDiscard`. */
  claimCount: number;
  /** How many side requests (chase, recruit) it came away with. */
  sideRequestCount: number;
  /**
   * The owner's machine reason line, for the BULLET only.
   *
   * ⚠️ DISPLAY, NEVER A TEST. `silentDiscard` does not look at this
   * field and must not: deciding on prose is the failure this module
   * exists to catch. Printing prose that a human then reads is the same
   * thing `reasonFor` already does with `degradations`, and it is the
   * difference between a DM that says "nothing happened" and one that
   * says which rule stopped it. Null when the owner did not report one.
   */
  why?: string | null;
}

/**
 * The routes on which coming away empty-handed is a defect.
 *
 * `self_att` is "the SENDER is joining or leaving THIS match themselves"
 * and `offer` is "a contingent or tentative commitment by anyone". Both
 * are the router ASSERTING that somebody committed to something. If the
 * extractor then found nothing at all, the two stages contradict each
 * other and a real message went nowhere.
 *
 * The other two engine routes are deliberately NOT here:
 *
 *   • `unsure` MEANS "attendance-shaped but the router genuinely cannot
 *     tell". An empty extraction is that route's EXPECTED outcome, so
 *     noting it would page an admin for the router's uncertainty on
 *     every near-miss — the nagging this module's first header is about.
 *   • `other_att` is where the interaction contract lives. All three
 *     production tag refusals were `other_att` and they cannot be
 *     anything else: `engine.ts`'s `claimNeedsTag` returns false for
 *     `subject === "sender"`, so a tag is never required for a sender's
 *     own attendance. Refusing a third-party instruction is the contract
 *     WORKING.
 *
 * A route added later defaults to NOT being noted here, which is the
 * opposite of `worthNoting`'s default and deliberately so: the unowned
 * list's failure mode is a coverage hole, so it fails loud; this one's
 * is a flood, so it fails quiet. The two lists mean different things,
 * which is the same reason `worthNoting` spells out `ENGINE_ROUTES`
 * rather than importing it.
 */
const SILENCE_IS_SUSPICIOUS_ON: readonly Route[] = ["self_att", "offer"];

/**
 * SHOULD A HUMAN BE TOLD THAT NOTHING HAPPENED TO THIS OWNED MESSAGE?
 *
 * All five must hold, and each is a typed fact rather than a string:
 *
 *   1. the ROUTE asserts a commitment was made (above);
 *   2. the SENDER resolved to a member — an unresolved sender is a
 *      different failure with a different remedy, and the admin
 *      console's unresolved queue already lists them;
 *   3. the engine did not ACT — `disposition` is the engine's own word
 *      for it, set to `acted` by `emit()` and by every speech branch
 *      that counts as answering the player;
 *   4. MatchTime said nothing — no reply, no react;
 *   5. the extractor came away with NO CLAIM and NO SIDE REQUEST.
 *
 * (5) IS THE ONE THAT DOES THE WORK, and it is why this is not a list of
 * reason strings. Every correct no-op in production had the extractor
 * resolve SOMETHING which the engine then declined for a stated reason:
 *
 *   "no change for Mojib"                  1 claim → already true
 *   "contingent drop for X: holding"       1 claim → held on purpose
 *   "requires an @Match Time tag"          1 claim → refused on purpose
 *   "below the confidence floor"           1 claim → distrusted on purpose
 *   "availability … not a commitment"      1 claim → held on purpose
 *   "chase nudge: no attendance change"    1 side request → a nudge
 *
 * The defect had NEITHER: `claims: []`, `affirmation: "yes"`, and a
 * pending set that turned out to be empty. The pipeline was handed a
 * player's own "In" and came away with nothing at all to decide about.
 * That is not a decision, it is a hole — and a rule added under
 * `engine.ts` later cannot quietly join the silent bucket the way a new
 * reason string would, because joining it requires the EXTRACTOR to have
 * produced nothing, which no engine rule can arrange.
 *
 * `degraded` counts alongside `noop` on purpose: a degraded owner that
 * also said nothing is exactly as invisible to the club as a noop one.
 */
export function silentDiscard(m: OwnedMessage): boolean {
  if (!SILENCE_IS_SUSPICIOUS_ON.includes(m.route)) return false;
  if (!m.senderResolved) return false;
  if (m.disposition === "acted") return false;
  if (m.spoke) return false;
  return m.claimCount === 0 && m.sideRequestCount === 0;
}

export interface OperatorNoteInput {
  /** Named in the DM so an admin of two clubs knows which group to open. */
  orgName: string;
  /** Every fresh message no owner and no deterministic path claimed. */
  messages: UnownedMessage[];
  /**
   * Every fresh message an owner DID claim. OPTIONAL, and absent means
   * "report none of them" — a caller that has not been taught to pass
   * these keeps the pre-2026-09-09 behaviour exactly, which is the one
   * direction of default that cannot make an existing note noisier.
   * Only the ones `silentDiscard` selects reach the DM.
   */
  owned?: OwnedMessage[];
  /** Every runner's degradation lines, verbatim. Each already carries
   *  the message id it is about, so they are matched by substring
   *  rather than by a parallel structure that could drift out of step. */
  degradations: string[];
  /**
   * The org's feature switches, for the suppression described in the
   * header. OPTIONAL, and absent means SUPPRESS NOTHING — a caller that
   * forgets to pass them gets a noisier note, which is recoverable in
   * one glance; the other default would be silence, which is what this
   * module exists to prevent.
   */
  features?: { attendance?: boolean };
}

export interface OperatorNote {
  /** Ids the caller should record as unowned. Never truncated — the
   *  cap below applies only to the DM's text. */
  noteIds: string[];
  /** The DM body, or null when there is nothing to say. */
  text: string | null;
  /** Stable per set-of-ids, so the caller can suppress a repeat without
   *  string-matching the body the way the old net did. */
  dedupeKey: string | null;
}

/**
 * The one route that is never worth a human's attention.
 *
 * Deliberately a single-element check rather than an allowlist of the
 * routes that ARE noted: a route added later must default to being
 * SEEN. A new route silently joining the "not worth mentioning" bucket
 * is precisely the S1 coverage hole this whole file is about.
 */
function worthNoting(
  route: Route | undefined,
  features: OperatorNoteInput["features"],
): boolean {
  if (route === "none") return false;
  // A club that switched attendance off does not want to hear about
  // attendance. These are exactly `gate.ts`'s `ENGINE_ROUTES`, and they
  // are spelled out rather than imported for the reason `RETRYING_ROUTES`
  // is: the two lists mean different things, and a future route could
  // join one without joining the other.
  if (
    features?.attendance === false &&
    (route === "self_att" || route === "other_att" || route === "offer" || route === "unsure")
  ) {
    return false;
  }
  return true;
}

/** How many messages the DM spells out before it summarises the rest.
 *  A batch that fails wholesale must not send a wall of text nobody
 *  reads — the cap is the difference between a signal and a flood. */
const MAX_LISTED = 6;
const MAX_BODY_CHARS = 90;

function clip(s: string, n: number): string {
  const one = (s || "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

/**
 * Find the degradation line a runner wrote about this message, if any.
 *
 * Substring on the id rather than a structured lookup, because the
 * runners format their own lines and each shape ("`answer-batch:
 * degraded — <id>: …`", "`[extractor <id>] …`") already embeds it. A
 * parallel map would be a second place for the id to be wrong.
 */
function reasonFor(id: string, degradations: string[]): string | null {
  const hit = degradations.find((d) => d.includes(id));
  if (!hit) return null;
  // Strip the id and the runner's own prefix: the admin does not need
  // a WhatsApp message id, they need the sentence after it.
  const after = hit.slice(hit.indexOf(id) + id.length).replace(/^[:\s—-]+/, "");
  return clip(after.length > 0 ? after : hit, 120);
}

/** What a silent-discard bullet says when no runner wrote a reason line
 *  for the id. The unowned bullets need no such sentence — the headline
 *  already says nobody handled them — but "an owner took this and
 *  produced nothing" is the fact the reader needs here, and it is not
 *  visible from anywhere else. */
const SILENT_DISCARD_NOTE = "MatchTime claimed this and recorded nothing";

/**
 * Drop an owner's `<name> (<route>): ` prefix from a reason line.
 *
 * COSMETIC AND NOTHING ELSE. The bullet already prints `[self_att]` one
 * character earlier, so leaving the prefix on says the route twice in
 * fifteen characters. This is the same trim `reasonFor` does to a
 * degradation line, and like that one it cannot change WHETHER a message
 * is reported — only how the sentence reads. A prefix it does not
 * recognise is left alone.
 */
function stripOwnerPrefix(why: string): string {
  return why.replace(/^[a-z][a-z0-9 _-]*\([a-z_]+\):\s*/i, "");
}

/**
 * House style for the owner's health page, where this note is shown: no
 * em or en dashes. The reason lines come from other modules' prose, so
 * the rule is applied here, at the one place they are printed.
 */
function noDashes(s: string): string {
  return s.replace(/\s*[—–]\s*/g, ": ");
}

export function composeOperatorNote(input: OperatorNoteInput): OperatorNote {
  const noted = input.messages.filter((m) => worthNoting(m.route, input.features));
  // The SAME feature suppression the unowned list gets. Both routes in
  // `SILENCE_IS_SUSPICIOUS_ON` are attendance routes, so without this an
  // attendance-off org would be told about every "in" through the new
  // door — the 2026-09-06 bug arriving a second time.
  const notedOwned = (input.owned ?? []).filter(
    (m) => silentDiscard(m) && worthNoting(m.route, input.features),
  );
  if (noted.length + notedOwned.length === 0) {
    return { noteIds: [], text: null, dedupeKey: null };
  }

  // Unowned first: it is the older and broader class, and an admin
  // reading top-down should see "nothing touched this" before "something
  // touched this and stopped".
  const all: Array<{
    waMessageId: string;
    body: string;
    authorName: string | null;
    route: Route | undefined;
    fallbackWhy: string | null;
  }> = [
    ...noted.map((m) => ({ ...m, fallbackWhy: null })),
    ...notedOwned.map((m) => ({
      waMessageId: m.waMessageId,
      body: m.body,
      authorName: m.authorName,
      route: m.route as Route | undefined,
      fallbackWhy: m.why ? clip(stripOwnerPrefix(m.why), 120) : SILENT_DISCARD_NOTE,
    })),
  ];

  const n = all.length;
  const lines = all.slice(0, MAX_LISTED).map((m) => {
    const who = m.authorName ?? "?";
    const why = reasonFor(m.waMessageId, input.degradations) ?? m.fallbackWhy;
    const routeLabel = m.route ?? "no route";
    return `• "${clip(m.body, MAX_BODY_CHARS)}" by ${who} [${routeLabel}]${why ? `: ${noDashes(why)}` : ""}`;
  });
  if (n > MAX_LISTED) lines.push(`• …and ${n - MAX_LISTED} more`);

  const text =
    `⚠️ MatchTime: ${n} message${n === 1 ? "" : "s"} in the latest batch for *${input.orgName}* ` +
    `${OPERATOR_NOTE_MARKER} ${n === 1 ? "it" : "them"}:\n\n` +
    lines.join("\n") +
    `\n\nMatchTime didn't respond to ${n === 1 ? "it" : "them"}. ` +
    `Check the group and act manually if any were attendance changes.`;

  return {
    noteIds: all.map((m) => m.waMessageId),
    text,
    dedupeKey: all
      .map((m) => m.waMessageId)
      .sort()
      .join(","),
  };
}
