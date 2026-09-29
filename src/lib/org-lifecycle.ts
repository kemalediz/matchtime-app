/**
 * Org LIFECYCLE — "does this club still exist?" — and the rule that
 * decides whether a recurring fixture should be generated for it.
 *
 * ── The bug this exists to fix (2026-09-09) ──────────────────────────
 *
 * `/api/cron/generate-matches` selected `Activity` rows with
 * `isActive: true` and never joined the organisation. So a club that
 * churned kept being handed a weekly fixture forever. Sutton Lads
 * churned on 2026-06-18 (MatchTime was removed from their group after
 * an incident; the org was left dormant and its data deliberately
 * retained) and was still being given a Thursday fixture in September —
 * one for Thu 10 Sept 2026 surfaced in a status report nearly three
 * months later. Nothing was watching, because nothing had ever been
 * asked to.
 *
 * ── Why `dormantAt` and not `whatsappBotEnabled` ─────────────────────
 *
 * `whatsappBotEnabled` is the flag that LOOKS like a lifecycle state —
 * Sutton Lads has it false, Sutton FC has it true — and it is the wrong
 * one. It is a MUTE switch. Kemal muted the very-much-alive Sutton FC
 * with it twice in the week of 2026-09-06 while doing engineering work,
 * and the weekly generator kept running for them, correctly, because
 * that club is alive and playing. Gate generation on the mute switch
 * and an hour of maintenance silently costs a live club its next
 * squad — a squad nobody notices is missing until kickoff. That is a
 * worse failure than the one being fixed: the ghost fixture is visible
 * and harmless, the missing one is invisible and expensive.
 *
 * The same argument retires the other three candidates —
 * `paymentTrackingEnabled`, `paymentCollectionEnabled` and
 * `stripeChargesEnabled` are all false for Sutton FC too at various
 * times, and say nothing about whether a club exists.
 *
 * ── Why DECLARED and not INFERRED ────────────────────────────────────
 *
 * The tempting alternative is to infer dormancy: no attendance, no
 * messages, bot disabled, for N weeks. It was rejected. A club on a
 * summer break, a winter break, a venue closure or a fixture gap is
 * indistinguishable from a churned one by those signals, and the
 * failure mode of guessing wrong is the silent one above — the squad
 * that should have existed and does not, discovered by the players.
 * An inferred flag also flips back and forth on its own, so the reason
 * a fixture is missing becomes a question nobody can answer from the
 * data. A human who knows the group is gone sets one field, once.
 *
 * ── What this is NOT ─────────────────────────────────────────────────
 *
 * Not `Activity.isActive`. That is a different axis and is unchanged:
 * `isActive` is the per-FIXTURE switch (a format switch deliberately
 * leaves the old format's Activity active — see match-slot.ts), this
 * is the per-CLUB one. Both are checked here, because either alone is
 * wrong.
 *
 * Not deletion. `deleteOrganisation` wipes everything; dormancy is the
 * honest middle state that stops MatchTime acting on its own initiative
 * while keeping the history. It is reversible: a club that comes back
 * next season is the same club.
 *
 * Pure functions, no DB import, so the cron can load candidates and
 * delegate the decision here (and so it is unit-testable).
 */

import { isClubApproved } from "./club-approval-state";

/** The only field of an Organisation that says whether the club exists. */
export interface OrgLifecycle {
  /** NULL = live. A timestamp = a human declared this club dormant then. */
  dormantAt: Date | null;
}

/**
 * The one Prisma `where` fragment for "the club still exists". Exported
 * so the next caller that needs it copies the rule rather than inventing
 * a second one — the whole bug was two different ideas of "active".
 */
export const LIVE_ORG_WHERE = { dormantAt: null } as const;

/**
 * Dormant = the field is set. PRESENCE, not a comparison against now():
 * the column records THAT a human declared the club gone, and comparing
 * it to a clock would add a second way to be wrong (server timezone, a
 * mistyped year) for no gain, since nothing schedules dormancy ahead.
 */
export function isOrgDormant(org: OrgLifecycle): boolean {
  return org.dormantAt !== null && org.dormantAt !== undefined;
}

export function isOrgLive(org: OrgLifecycle): boolean {
  return !isOrgDormant(org);
}

/** An Activity considered for fixture generation, plus its club. */
export interface FixtureCandidate {
  /** `Activity.isActive` — the per-fixture switch. Unchanged semantics. */
  isActive: boolean;
  /** Lifecycle plus club approval (self-join, 2026-09-29): a club that
   *  is not approved gets no fixtures either. See club-approval.ts. */
  org: OrgLifecycle & { approvalStatus: string };
}

/**
 * Why an activity was skipped. `org-dormant` is reported separately from
 * `activity-inactive` because they mean completely different things to
 * whoever reads the cron's output: one club is gone, one fixture is off.
 */
export type FixtureSkipReason = "org-dormant" | "org-not-approved" | "activity-inactive";

/**
 * The rule. Returns null when a fixture SHOULD be generated, or the
 * reason it should not.
 *
 * Note what is deliberately absent: this function cannot see
 * `whatsappBotEnabled`, so no amount of muting can stop a live club's
 * fixtures. That is the point.
 *
 * Org dormancy is checked first so a dormant club with a deactivated
 * activity is reported as the bigger fact — the club, not the fixture.
 */
export function fixtureSkipReason(candidate: FixtureCandidate): FixtureSkipReason | null {
  if (isOrgDormant(candidate.org)) return "org-dormant";
  // A self-join club waiting for approval (or rejected, or suspended)
  // must cost nothing and post nothing, so it gets no fixture. Every
  // club that predates self-join is "approved" by the column default.
  if (!isClubApproved(candidate.org)) return "org-not-approved";
  if (!candidate.isActive) return "activity-inactive";
  return null;
}

export interface GeneratablePartition<T> {
  /** Candidates the generator should proceed with. */
  generate: T[];
  /** Everything it must not, each with the reason it was dropped. */
  skipped: Array<{ item: T; reason: FixtureSkipReason }>;
  /** Convenience count for the cron's response body / logs. */
  skippedDormantOrgs: number;
  /** Activities skipped because their club is not approved. */
  skippedNotApprovedOrgs: number;
}

/**
 * Split candidates into "generate" and "skipped, because…" BEFORE the
 * generation loop runs.
 *
 * Filtering up front rather than `continue`-ing inside the loop is
 * deliberate. This repo has had six incidents in the
 * terminal-short-circuit class — a `continue` added near the top of a
 * loop silently deletes every guard beneath it. The generation loop
 * below this call already carries the ghost-match slot dedupe, which is
 * load-bearing; adding another early exit above it is exactly the shape
 * that keeps going wrong. A candidate that reaches the loop is one this
 * function has already cleared.
 */
export function partitionGeneratable<T extends FixtureCandidate>(
  candidates: T[],
): GeneratablePartition<T> {
  const generate: T[] = [];
  const skipped: Array<{ item: T; reason: FixtureSkipReason }> = [];

  for (const item of candidates) {
    const reason = fixtureSkipReason(item);
    if (reason === null) generate.push(item);
    else skipped.push({ item, reason });
  }

  return {
    generate,
    skipped,
    skippedDormantOrgs: skipped.filter((s) => s.reason === "org-dormant").length,
    skippedNotApprovedOrgs: skipped.filter((s) => s.reason === "org-not-approved").length,
  };
}
