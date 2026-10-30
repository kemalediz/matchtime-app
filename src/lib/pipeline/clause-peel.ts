/**
 * WHAT A FAST PATH TOOK, AND WHAT IS LEFT FOR THE PIPELINE.
 *
 * A fast path that owns only part of a message (the monthly reader's list,
 * with the member's own words around it as `residual`) leaves the rest in
 * the batch, so the router and the attendance engine still read it. Its
 * own outcome is deferred (`ClauseReport`) and merged into the ONE result
 * the pipeline produces for that message (`applyClauseReports`):
 * MatchTime replies once or not at all.
 *
 * The regex clause splitter that stood here (`splitClauses`, `peelClause`:
 * newlines, sentence ends, "; " and ", and") is deleted (2026-10-30, Kemal:
 * "no string parsing at all"). What part of a message a fast path took is
 * now said by the model that read it (the monthly reader's `residual`),
 * never cut out of the words by code.
 */

/** What a fast path took, and what is left for the pipeline. */
export interface ClausePeel {
  /** The clause the fast path recognised. Pass THIS to the handler. */
  consumed: string;
  /** Everything else in the message, in order. `""` when the fast path
   *  legitimately owns the whole thing. */
  residual: string;
}

/**
 * TWO OWNERS WROTE. ONE SPEAKS.
 *
 * "MatchTime replies once or not at all" is the invariant the whole tail
 * of the analyze route protects, and clause peeling is the first thing
 * in this codebase that routinely produces TWO candidate sentences for
 * ONE message: the fast path's ack for the clause it took, and the
 * owner's ack for the residual. They are merged into a single outbound
 * message here rather than pushed as two results.
 *
 * This is `mergeRecruitReply`'s rule, generalised — that function solved
 * exactly this shape for the recruit blast on 2026-09-01 and now
 * delegates here so there is one implementation of "one send" rather
 * than two that can drift.
 *
 * Whitespace-only counts as silence; two identical lines collapse rather
 * than being said twice.
 */
export function mergeOneReply(
  first: string | null | undefined,
  second: string | null | undefined,
): string | null {
  const a = (first ?? "").trim();
  const b = (second ?? "").trim();
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  if (a === b) return a;
  return `${a}\n\n${b}`;
}

/**
 * WHAT A FAST PATH DID TO THE CLAUSE IT TOOK — deferred, because the
 * message it came from is still in the batch and the pipeline has not
 * finished with it yet.
 *
 * Exactly the fields `claimFastPath` would have written straight to
 * `AnalyzedMessage` and `ActionForBot` if the fast path had owned the
 * whole message. Same shape as `pastedRosterReports` in the analyze
 * route, and for the same reason.
 */
export interface ClauseReport {
  handledBy: "fast-path" | "error";
  intent: string;
  action: string | null;
  reasoning: string;
  react: string | null;
  reply: string | null;
}

/** The slice of `ActionForBot` this module needs. Structural on purpose:
 *  the route's own type stays the route's business. */
export interface MergeableResult {
  waMessageId: string;
  handledBy: string;
  intent: string | null;
  react: string | null;
  reply: string | null;
}

/**
 * THE ROW AND THE WORDS THAT WERE DEFERRED, PUT BACK — into the ONE
 * result the pipeline produced for that message.
 *
 * Pure but for the injected `augment`, which is the route's
 * `augmentAnalysis` (the same function the recruit blast uses to add an
 * outcome to a row that already exists — `AnalyzedMessage.waMessageId`
 * is UNIQUE and a second create is silently swallowed, so appending is
 * the only way both halves survive).
 *
 * ── THE THREE RULES, AND WHY EACH ────────────────────────────────────
 *
 *   REPLY   merged, never appended as a second result. One send.
 *   REACT   the OWNER's wins when it has one. It describes the write
 *           that actually landed — and for a sender's own attendance it
 *           has already been reconciled against the final database row
 *           (the Zeeshan 2026-06-12 pass). The fast path's react only
 *           fills a hole.
 *   LABEL   overwritten only when the owner recorded NOTHING. A result
 *           left `ignored`/`noise` means the residual reached the end of
 *           the batch unclaimed, so the only thing that happened to this
 *           message is what the fast path did, and the admin log must
 *           say `team_swap` rather than `noise`. When an owner DID
 *           decide, its label stands and the fast path's outcome is
 *           appended to `action`/`reasoning` — the row then reads
 *           "out+team-swap", which is the truth.
 *
 * A missing result is logged, never invented: every message in the batch
 * gets exactly one result from the loop, so this cannot happen, and an
 * unreachable branch that silently drops a WRITE that already landed is
 * how a fix becomes the next incident.
 */
export async function applyClauseReports(args: {
  reports: Map<string, ClauseReport>;
  results: MergeableResult[];
  augment: (a: {
    waMessageId: string;
    action: string;
    reasoningSuffix: string;
    handledBy?: string;
    intent?: string;
  }) => Promise<void>;
}): Promise<void> {
  for (const [id, report] of args.reports) {
    const target = args.results.find((r) => r.waMessageId === id);
    if (!target) {
      console.error(
        `[analyze] clause report for ${id} found no result to merge into — ` +
          `the fast path's write LANDED and its words are being dropped`,
      );
      continue;
    }
    target.reply = mergeOneReply(target.reply, report.reply);
    target.react = target.react ?? report.react;
    const ownerSaidNothing =
      target.handledBy === "ignored" ||
      target.intent === "noise" ||
      target.intent === "unclear";
    if (ownerSaidNothing) {
      target.handledBy = report.handledBy;
      target.intent = report.intent;
    }
    await args.augment({
      waMessageId: id,
      action: report.action ?? "none",
      reasoningSuffix: report.reasoning,
      ...(ownerSaidNothing
        ? { handledBy: report.handledBy, intent: report.intent }
        : {}),
    });
  }
}
