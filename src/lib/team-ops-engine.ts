/**
 * §10 STEP 8 — THE `generate` APPLY LAYER.
 *
 *   router → teams extractor → engine → APPLY → the balancer's own post
 *
 * `src/lib/pipeline/` decides and composes and is forbidden from
 * writing — `pipeline/__tests__/zero-writes.test.ts` scans every file in
 * that directory on every build. This module is the other side of that
 * line and lives OUTSIDE `pipeline/` for exactly that reason, as
 * `attendance-engine.ts`, `score-engine.ts` and `admin-ops-engine.ts` do.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AT ALL
 * ─────────────────────────────────────────────────────────────────────
 * §10 step 8 deleted the 19,850-token `SYSTEM_PROMPT`. Before it could,
 * every route it decided needed a deterministic owner, and
 * `generate_teams_request` was the last big hole: measured over 120 days
 * of production `AnalyzedMessage` rows on Sutton FC it occurred **23
 * times** — the single most common tagged command to MatchTime, more
 * common than every question shape put together. `answer-batch.ts` owned
 * only `show` and handed the rest back with, in its own words, *"team
 * action \"generate\" still belongs to the balancer"*. There is no
 * balancer to hand it back to any more.
 *
 * ─────────────────────────────────────────────────────────────────────
 * IT DECIDES NOTHING
 * ─────────────────────────────────────────────────────────────────────
 * Who may ask, who gets force-confirmed, who is pinned where, whether a
 * name resolves at all: settled in `engine.ts`'s `handleTeams` before
 * this module is reached, and none of it re-litigated. Every branch
 * below is a mechanical translation of a field the engine already set.
 * The two-line rule this inherits from `score-engine.ts`:
 *
 *   1. THE COPY IS THE SHIPPED COPY, byte for byte
 *      (`route.ts:3661-3690`). A player who has seen one of these posts
 *      before must not be able to tell that anything changed. Inventing
 *      a second wording for a shipped sentence is how two bots start
 *      disagreeing with each other in one group.
 *   2. AN ACK MUST NOT OUTRUN THE WRITE. Composition happens AFTER the
 *      apply and a write that threw takes its utterance with it — §3.2
 *      S7, the 2026-05-15 Erdal incident, where the bot announced a
 *      bench move the database never made and the group believed it.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY THE FORCE-INCLUDE IS NOT AN `attendance` WRITE
 * ─────────────────────────────────────────────────────────────────────
 * "@Match Time generate the teams including Ibrahim" flips a BENCH or
 * DROPPED row to CONFIRMED. That looks like an attendance write and is
 * deliberately not one: it is capacity-BLIND (an admin overriding the
 * format, not a player queueing behind it), so it has none of the bench
 * ordering, offer resolution or promotion authorisation
 * `attendance-engine.ts` applies. Routing it there would silently
 * acquire all of them. It stays inside the one `generate_teams` write,
 * and `forceConfirm` reproduces `route.ts:3591-3617` exactly — the
 * status update and its `AttendanceEvent` in ONE transaction, so the
 * audit trail can never disagree with the row.
 *
 * It imports neither `db` nor Prisma; its dependencies are injected,
 * which is what makes the seam unit-testable without a database, and a
 * test asserts the absence by SCANNING this file, because a comment
 * saying so is worth nothing (four seatbelts were found dead on
 * 2026-08-31, all with comments claiming they worked).
 */
import { t } from "./i18n/t";
import type { Lang } from "./i18n/lang";
import type { ProposedWrite } from "./pipeline/types";

export type EngineGenerateTeamsWrite = Extract<ProposedWrite, { kind: "generate_teams" }>;

/**
 * Prefix on every degradation this layer reports. Mirrors
 * `SCORE_APPLY_DEGRADED_PREFIX` and `ADMIN_OPS_APPLY_DEGRADED_PREFIX`.
 *
 * ⚠️ THESE LINES ARE WRITTEN FOR A HUMAN, not for a fallback
 * classifier. Until §10 step 8 a "handed back" message went to the
 * mega-prompt, which still answered it; with `analyzeBatch` deleted it
 * goes to `route.ts`'s "NOBODY OWNED IT" branch's catch-all, which is SILENT to the group plus
 * one deduped operator note. So every string below has to tell an admin
 * reading a DM what MatchTime did not do, and why.
 *
 * The DM itself is `lib/operator-note.ts`, and it selects on the TYPED
 * fact "no owner claimed this id" — NOT on this prefix. Nothing
 * regex-matches this string, which is §9's "fix the mechanism" spent
 * rather than promised; `composeOperatorNote` prints the clause after
 * the message id verbatim as the "why" on the admin's phone.
 */
export const TEAM_OPS_APPLY_DEGRADED_PREFIX = "team-ops-engine: degraded —";

/** `AnalyzedMessage.handledBy` for a message this path decided. The
 *  AUDIT field, not the wire field — the same split step 5 made for
 *  `router-gate` and step 6 for `attendance-engine`. */
export const TEAM_OPS_HANDLED_BY = "team-ops-engine";

// ── The shipped copy, lifted verbatim ────────────────────────────────

/** `route.ts:3565`. Said when no upcoming match qualifies. English;
 *  the language-aware form is `teamOpsNoMatchReply(lang)`. */
export const TEAM_OPS_NO_MATCH_REPLY = "No match lined up to build teams for.";
export function teamOpsNoMatchReply(lang?: Lang | string | null): string {
  return t(lang).team_ops_no_match;
}

/** `route.ts:3690`. The balancer declined — not enough confirmed
 *  players, or the match is completed or cancelled. */
export function composeBalancerRefusal(reason: string, lang?: Lang | string | null): string {
  return t(lang).balancer_refusal({ reason });
}

/**
 * `route.ts:3661-3689`, byte for byte.
 *
 * Prefixes go ABOVE the team sheet and suffixes BELOW it, in the shipped
 * order: includes, then pins, then the two "couldn't find" notes. The
 * order matters — `_Pinned per the request_` ends up nearest the post
 * because it was applied last — and it is preserved rather than tidied.
 */
export function composeGenerateTeamsReply(args: {
  /** `generateTeamsForMatch`'s own output. The real line-ups. */
  groupPost: string;
  includedNames: string[];
  /** "Kemal Ediz → RED", already rendered by the caller from the write. */
  pinnedLog: string[];
  unmatchedIncludes: string[];
  unmatchedPins: string[];
  lang?: Lang | string | null;
}): string {
  const s = t(args.lang);
  let text = args.groupPost;
  if (args.includedNames.length > 0) {
    text = `${s.team_gen_note_including({ names: args.includedNames })}\n\n${text}`;
  }
  if (args.pinnedLog.length > 0) {
    text = `${s.team_gen_note_pinned({ pinned: args.pinnedLog })}\n\n${text}`;
  }
  if (args.unmatchedIncludes.length > 0) {
    text += `\n\n${s.team_gen_note_unmatched_includes({ names: args.unmatchedIncludes })}`;
  }
  if (args.unmatchedPins.length > 0) {
    text += `\n\n${s.team_gen_note_unmatched_pins({ names: args.unmatchedPins })}`;
  }
  return text;
}

// ── The seam ─────────────────────────────────────────────────────────

/** What `generateTeamsForMatch` returns, restated so this module can
 *  stay free of `team-generation.ts` (which imports Prisma). The real
 *  result carries an extra `matchId` on the ok arm and is assignable to
 *  this. */
export type TeamGenerationOutcome =
  | { ok: true; groupPost: string }
  | { ok: false; reason: string };

export interface TeamOpsApplyDeps {
  /**
   * The target match, and EXACTLY the shipped selector
   * (`route.ts:3553-3560`): `status IN (UPCOMING, TEAMS_GENERATED,
   * TEAMS_PUBLISHED)` AND `attendanceDeadline > now - 24h`, ordered by
   * `date ASC`, first row.
   *
   * NOT `SquadState.matchId`. `selectRegistrationMatch` answers a
   * different question ("where does an IN land?") and can decline to
   * pick a match at all while a previous one is still in flight —
   * precisely the evening somebody asks for the teams. The two are kept
   * apart on purpose and the runner never substitutes one for the other.
   */
  selectTeamsMatch: (orgId: string, now: Date) => Promise<{ id: string } | null>;
  /**
   * Flip ONE attendance row to CONFIRMED, in the SAME transaction as the
   * `AttendanceEvent` that records it. `route.ts:3591-3617`:
   *
   *   $transaction(async (tx) => {
   *     await tx.attendance.update({ where: { id }, data: { status: "CONFIRMED" } });
   *     await recordAttendanceEvent(tx, {...}, {
   *       cause: "admin-message", actorKind: "admin",
   *       actorUserId, sourceRef: waMessageId,
   *       note: `force-included in a team-generation request as "<ref>"`,
   *     });
   *   });
   *
   * MUST be idempotent: a row already CONFIRMED is left alone and
   * records no event, as the shipped `if (target.status !== "CONFIRMED")`
   * guard does. A row that does not exist on the match is not this
   * layer's problem — the engine resolved against the match's own
   * attendance rows.
   */
  forceConfirm: (args: {
    matchId: string;
    userId: string;
    /** The words the message used, for the event note. */
    ref: string;
    /** The message id, for `AttendanceEvent.sourceRef`. */
    sourceRef: string;
    /** Who typed it, or null for an unresolved sender. */
    actorUserId: string | null;
  }) => Promise<void>;
  /** `generateTeamsForMatch(matchId, opts)`. Runs the balancer, writes
   *  every `TeamAssignment`, moves `Match.status` to TEAMS_GENERATED and
   *  returns the group post. The ONE way teams are built on this path. */
  generateTeams: (
    matchId: string,
    opts: {
      pinnedToTeam?: Record<string, "RED" | "YELLOW">;
      teamNames?: [string, string];
    },
  ) => Promise<TeamGenerationOutcome>;
}

export interface GenerateTeamsApplyResult {
  write: EngineGenerateTeamsWrite;
  /** The match the balancer ran against, or null when none qualified. */
  matchId: string | null;
  /** The balancer ran AND the assignments were written. */
  generated: boolean;
  /**
   * Something THREW. Distinct from `generated: false`, which also covers
   * the two shipped answers that are not failures at all: no upcoming
   * match, and a balancer that declined with a reason. Only this one
   * silences the message.
   */
  failed: boolean;
  error?: string;
  /** What to say to the group. `null` only when `failed`. */
  reply: string | null;
  /** The shipped reacts: ⚽ on a real post, 🤔 on either refusal. */
  react: string | null;
  /** For the audit trail; the reply already contains them. */
  includedNames: string[];
  pinnedLog: string[];
  /**
   * Every reference the engine could not place, includes and pins
   * together. These are ALREADY in the group post's "couldn't find …"
   * suffixes; they are surfaced separately so the runner can put them in
   * the operator log too. A name MatchTime could not place is the shape
   * a human has to fix by hand, and a line only the group ever sees is a
   * line nobody triages.
   */
  unmatchedNoted: string[];
}

/**
 * Apply ONE `generate_teams` write.
 *
 * Sequential over the force-includes rather than `Promise.all`, and that
 * is not caution: they are rows on ONE match, `generateTeamsForMatch`
 * re-reads the whole CONFIRMED set immediately afterwards, and racing a
 * handful of updates buys nothing while making the failure ordering
 * unreproducible.
 *
 * ONE FAILURE MODE, ONE ANSWER. The shipped path wraps the entire block
 * in a single `try` and sets `finalReply = null` on any throw
 * (`route.ts:3686-3689`) — silence rather than a half-truth. That is
 * reproduced exactly: a force-include that throws stops the balancer
 * from running at all, because the alternative is posting line-ups that
 * silently omit the player the message was ABOUT.
 */
export async function applyGenerateTeams(args: {
  /** From `deps.selectTeamsMatch`. `null` is a real answer, not an
   *  error — see `TEAM_OPS_NO_MATCH_REPLY`. */
  matchId: string | null;
  write: EngineGenerateTeamsWrite;
  /** The member who typed the message, for `AttendanceEvent.actorUserId`. */
  actorUserId: string | null;
  deps: TeamOpsApplyDeps;
  /** The group's language; English when absent. */
  lang?: Lang | string | null;
}): Promise<GenerateTeamsApplyResult> {
  const { matchId, write, actorUserId, deps, lang } = args;
  const includedNames = write.forceInclude.map((f) => f.name);
  const pinnedLog = write.pinned.map((p) => `${p.name} → ${p.team}`);
  const base = {
    write,
    matchId,
    includedNames,
    pinnedLog,
    unmatchedNoted: [...write.unmatchedIncludes, ...write.unmatchedPins],
  };

  if (!matchId) {
    // `route.ts:3563-3566`. Not a failure: the group asked a reasonable
    // question and gets the shipped answer.
    return {
      ...base,
      generated: false,
      failed: false,
      reply: teamOpsNoMatchReply(lang),
      react: "🤔",
    };
  }

  try {
    for (const inc of write.forceInclude) {
      await deps.forceConfirm({
        matchId,
        userId: inc.userId,
        ref: inc.ref,
        sourceRef: write.sourceMessageId,
        actorUserId,
      });
    }

    const pinnedToTeam: Record<string, "RED" | "YELLOW"> = {};
    for (const p of write.pinned) pinnedToTeam[p.userId] = p.team;

    const result = await deps.generateTeams(matchId, {
      // `undefined` rather than `{}` when empty, exactly as
      // `route.ts:3655-3658` passes it: an empty object and an absent
      // one are the same to the balancer today, and matching the shipped
      // call means they cannot diverge if that ever stops being true.
      ...(Object.keys(pinnedToTeam).length > 0 ? { pinnedToTeam } : {}),
      ...(write.teamNames ? { teamNames: write.teamNames } : {}),
    });

    if (!result.ok) {
      // The balancer declined — "not enough confirmed players — 9/14",
      // "match is completed". A REASON, said out loud, which is the
      // whole difference between this product and a bot that shrugs.
      return {
        ...base,
        generated: false,
        failed: false,
        reply: composeBalancerRefusal(result.reason, lang),
        react: "🤔",
      };
    }

    return {
      ...base,
      generated: true,
      failed: false,
      reply: composeGenerateTeamsReply({
        groupPost: result.groupPost,
        includedNames,
        pinnedLog,
        unmatchedIncludes: write.unmatchedIncludes,
        unmatchedPins: write.unmatchedPins,
        lang,
      }),
      react: "⚽",
    };
  } catch (err) {
    // §3.2 S7. A post announcing teams that were never written is worse
    // than no post, and the operator hears about it through the
    // degradation the runner raises.
    console.error("[team-ops-engine] generate teams failed:", err);
    return {
      ...base,
      generated: false,
      failed: true,
      error: err instanceof Error ? err.message : String(err),
      reply: null,
      react: null,
    };
  }
}
