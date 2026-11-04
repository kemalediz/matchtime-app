/**
 * GUARD, A RATCHET: NO NEW FILE WORKS OUT THE CLUB'S FACTS ITSELF (plan
 * section 3.6, 2).
 *
 * The list below is every source file that, on the day the summary was
 * built (slice A0, 2026-11-04, origin/main 19c75141), names one of the club
 * columns the summary now carries: `squadMode`, `paymentTrackingEnabled`,
 * `paymentCollectionEnabled`, `paymentHolderId`, `minPlayers`,
 * `paygPricePence`, `listAnnouncer`. It is a mechanical upper bound (a
 * comment, a string table or a pure rule module counts too), which is what
 * a ratchet needs.
 *
 *   - A file NOT on the list that starts to name one fails: take the fact
 *     from the club summary (src/lib/club-summary) instead, or, for a
 *     writer (a settings save, `startMonth`), add it to WRITERS with why.
 *   - A file on the list that no longer names any fails too: delete it from
 *     the list, so the ratchet only ever tightens. Each Phase A slice
 *     removes the files it moved onto the summary.
 *
 * The summary's own files are exempt: they are where the facts live.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../../..");
const COLUMNS = /\b(squadMode|paymentTrackingEnabled|paymentCollectionEnabled|paymentHolderId|minPlayers|paygPricePence|listAnnouncer)\b/;

/** Files that WRITE these columns and so must name them for good, with why.
 *  Empty in A0: today's writers are on TODAY like everyone else, and move
 *  here by name as the slices take the readers off. */
const WRITERS = new Map<string, string>([]);

/** Today's readers. Shrinks slice by slice. */
const TODAY = new Set<string>([
  "app/actions/activities.ts",
  "app/actions/block-bookings.ts",
  "app/actions/onboarding.ts",
  "app/actions/org.ts",
  "app/actions/payments.ts",
  "app/actions/squad-month.ts",
  "app/actions/teams-ready.ts",
  "app/admin/activities/page.tsx",
  "app/admin/layout.tsx",
  "app/admin/matches/[matchId]/switch-format/page.tsx",
  "app/admin/months/credits/page.tsx",
  "app/admin/months/page.tsx",
  "app/admin/settings/page.tsx",
  "app/api/org/settings/route.ts",
  "app/api/whatsapp/dm-reply/route.ts",
  "app/api/whatsapp/poll-vote/route.ts",
  "app/collect/[matchId]/page.tsx",
  "app/matches/[matchId]/page.tsx",
  "app/month/collect/page.tsx",
  "app/month/page.tsx",
  "app/pay/[matchId]/page.tsx",
  "components/landing/landing-content.ts",
  "components/settings/list-announcer-row.tsx",
  "components/settings/monthly-squad-section.tsx",
  "lib/activity-format-switch.ts",
  "lib/admin-group-help.ts",
  "lib/admin-group-intro.ts",
  "lib/admin-group-understand.ts",
  "lib/admin-group.ts",
  "lib/admin-onboarding-rules.ts",
  "lib/admin-onboarding.ts",
  "lib/admin-ops-engine-batch.ts",
  "lib/attendance.ts",
  "lib/bench-confirmation.ts",
  "lib/bot-scheduler.ts",
  "lib/club-billing-dms.ts",
  "lib/club-billing-rules.ts",
  "lib/club-billing-view.ts",
  "lib/club-billing.ts",
  "lib/club-setup-dm-rules.ts",
  "lib/club-setup-dm.ts",
  "lib/club-setup.ts",
  "lib/direct-payment.ts",
  "lib/dm-copy.ts",
  "lib/fee-confirm-reaction.ts",
  "lib/fee-confirm.ts",
  "lib/fee-waiver.ts",
  "lib/flex-format-rules.ts",
  "lib/format-resize.ts",
  "lib/format-switch-words.ts",
  "lib/friend-link/facts.ts",
  "lib/generate-upcoming-matches.ts",
  "lib/group-hello.ts",
  "lib/i18n/strings.en.ts",
  "lib/list-announcer-store.ts",
  "lib/list-announcer.ts",
  "lib/match-cancel.ts",
  "lib/min-players.ts",
  "lib/month-close.ts",
  "lib/month-member-games.ts",
  "lib/month-newcomers.ts",
  "lib/month-not-started.ts",
  "lib/month-payment.ts",
  "lib/month-seed-hq.ts",
  "lib/month-seed-read.ts",
  "lib/month-signup.ts",
  "lib/monthly-week-asks.ts",
  "lib/monthly-week-copy.ts",
  "lib/monthly-week-rules.ts",
  "lib/monthly-week.ts",
  "lib/my-payments-rules.ts",
  "lib/my-payments.ts",
  "lib/onboarding-conversation.ts",
  "lib/org-features.ts",
  "lib/org-lifecycle.ts",
  "lib/organiser-pick.ts",
  "lib/organisers-list-copy.ts",
  "lib/payment-claim-classifier.ts",
  "lib/payment-claim.ts",
  "lib/payment-flow.ts",
  "lib/payment-messages.ts",
  "lib/payments-live-announce.ts",
  "lib/payments.ts",
  "lib/pipeline/answer-batch.ts",
  "lib/pipeline/compose.ts",
  "lib/pipeline/extractors.ts",
  "lib/pipeline/load-state.ts",
  "lib/pipeline/payment-answer.ts",
  "lib/pipeline/types.ts",
  "lib/player-range-save.ts",
  "lib/player-range-words.ts",
  "lib/pool/offer-facts.ts",
  "lib/season-break-dm.ts",
  "lib/seed-nudge-rules.ts",
  "lib/seed-nudge.ts",
  "lib/settings-info.ts",
  "lib/settings-search.ts",
  "lib/setup-learning/rules.ts",
  "lib/setup-learning/run.ts",
  "lib/setup-learning/view.ts",
  "lib/squad-announce.ts",
  "lib/squad-month-rules.ts",
  "lib/squad-month.ts",
  "lib/squad-short.ts",
  "lib/team-balancer.ts",
  "lib/team-generation.ts",
  "lib/team-proposal-rules.ts",
  "lib/team-proposal.ts",
  "lib/user-merge-plan.ts",
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (["__tests__", "generated", "node_modules", "club-summary"].includes(name)) continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const readers = sourceFiles(SRC)
  .filter((f) => COLUMNS.test(readFileSync(f, "utf8")))
  .map((f) => path.relative(SRC, f))
  .sort();

describe("club facts are read from the summary, not from new queries (ratchet)", () => {
  it("the scan is alive", () => {
    for (const known of ["lib/bot-scheduler.ts", "lib/org-features.ts", "app/api/whatsapp/dm-reply/route.ts"]) expect(readers).toContain(known);
  });

  it("no new file names a club column the summary carries", () => {
    const added = readers.filter((f) => !TODAY.has(f) && !WRITERS.has(f));
    expect(added, `read the fact from src/lib/club-summary instead (or list a writer in WRITERS with the reason): ${added.join(", ")}`).toEqual([]);
  });

  it("a file that no longer names one is taken off the list (the ratchet only tightens)", () => {
    const gone = [...TODAY].filter((f) => !readers.includes(f));
    expect(gone, `delete these from TODAY in source-guard.test.ts: ${gone.join(", ")}`).toEqual([]);
  });
});
