/**
 * /api/whatsapp/due-posts — payment-chase suppression.
 *
 * Three suppression behaviours, all keyed off whether a player has paid:
 *
 *   1. Per-player "still outstanding" pay-link DM (bot-scheduler.ts:1357-1400).
 *      Fires in the 18:00-19:00 London window for each unpaid, phone-bearing,
 *      non-collector, non-direct-pending confirmed player. paidAt set →
 *      suppressed (line 1372).
 *
 *   2. Collector "X will pay you directly" confirm-receipt nudge
 *      (bot-scheduler.ts:1402-1437). Fires while ANY confirmed player is
 *      directPending && !paid (line 1403). Goes silent once they're paid.
 *
 *   3. Group "N payments still pending" unpaid tail (buildUnpaidTail,
 *      bot-scheduler.ts:225-289), appended to the UPCOMING match's
 *      17:00-18:00 evening-update group message. Counts non-collector
 *      confirmed players with paidAt == null on the last completed match
 *      (the PAY match). Marking one paid drops the count by one.
 *
 * Time is pinned with the x-test-now header (MT_TEST_MODE=1). Each test
 * resets the DB in beforeEach so it starts from the canonical fixture
 * world, then mutates forward WITHIN the test to prove the gate is
 * evaluated at send time.
 */
import { test, expect, resetDb } from "../fixtures";
import { U, MATCH, londonAt } from "../helpers/constants";
import { E2E } from "../helpers/env";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

interface Instruction {
  kind: string;
  key?: string;
  targetUser?: string;
  text?: string;
}

test.beforeEach(() => {
  resetDb();
});

async function duePostsAt(request: APIRequestContext, now: Date): Promise<Instruction[]> {
  const res = await request.get(
    `/api/whatsapp/due-posts?groupId=${encodeURIComponent(E2E.GROUP_ID)}`,
    { headers: { "x-api-key": E2E.WHATSAPP_API_KEY, "x-test-now": now.toISOString() } },
  );
  expect(res.status(), await res.text()).toBe(200);
  const json = await res.json();
  return (json.instructions ?? []) as Instruction[];
}

/**
 * Replicates londonDateKey(now) from bot-scheduler.ts:1366 — the
 * Europe/London "YYYY-MM-DD" used in the dedupe keys. Computed here so
 * the expected key strings match the server byte-for-byte.
 */
function londonDateKey(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// dayKey == londonDateKey(now) per bot-scheduler.ts:1366
const payChaseKey = (uid: string, dayKey: string) => `${MATCH.pay}:pay-chase:${uid}:${dayKey}`;
const collectorKey = (dayKey: string) => `${MATCH.pay}:pay-chase-collector:${dayKey}`; // :1405
const eveningKey = (dayKey: string) => `${MATCH.upcoming}:evening-update:${dayKey}`; // :844

/** Mark a confirmed attendance paid the way the direct/cash confirm flow does. */
async function markPaidDirect(
  db: { run: (sql: string, params: unknown[]) => Promise<void> },
  matchId: string,
  userId: string,
) {
  await db.run(
    `UPDATE "Attendance"
       SET "paidAt" = now(), "directPendingAt" = null,
           "paymentMethod" = 'direct', "directConfirmedByUserId" = $3
     WHERE "matchId" = $1 AND "userId" = $2`,
    [matchId, userId, U.collector],
  );
}

test("per-player pay-link DM is suppressed once the player is marked paid", async ({
  request,
  db,
}) => {
  const now = londonAt(0, 18, 30); // inside the 18:00-19:00 pay-chase window
  const dayKey = londonDateKey(now); // dayKey == londonDateKey(now) per bot-scheduler.ts:1366

  // Before any mutation: both unpaid phone-bearing players get the DM.
  const before = await duePostsAt(request, now);
  const beforeKeys = before.map((i) => i.key);

  expect(beforeKeys).toContain(payChaseKey(U.player, dayKey));
  expect(beforeKeys).toContain(payChaseKey(U.fresh, dayKey));

  const playerDm = before.find((i) => i.key === payChaseKey(U.player, dayKey));
  expect(playerDm?.kind).toBe("dm");
  expect(playerDm?.targetUser).toBe(U.player);
  expect(playerDm?.text).toMatch(/still outstanding/);

  const freshDm = before.find((i) => i.key === payChaseKey(U.fresh, dayKey));
  expect(freshDm?.targetUser).toBe(U.fresh);
  expect(freshDm?.text).toMatch(/still outstanding/);

  // Mark Pat Player paid (direct/cash path). Re-run at the SAME instant.
  await markPaidDirect(db, MATCH.pay, U.player);
  const after = await duePostsAt(request, now);
  const afterKeys = after.map((i) => i.key);

  // Pat's DM is gone (paidAt → suppressed, :1372); Ian's still fires.
  expect(afterKeys).not.toContain(payChaseKey(U.player, dayKey));
  expect(afterKeys).toContain(payChaseKey(U.fresh, dayKey));
});

test("a card-paid player never receives a pay-link DM", async ({ request }) => {
  // Riley Rater is seeded paidAt via card (qty 2). They must never appear
  // in the pay-chase loop, before any mutation.
  const now = londonAt(0, 18, 30);
  const dayKey = londonDateKey(now); // dayKey == londonDateKey(now) per bot-scheduler.ts:1366

  const instructions = await duePostsAt(request, now);
  const raterDms = instructions.filter(
    (i) => i.key === payChaseKey(U.rater, dayKey) || i.targetUser === U.rater,
  );
  // No pay-chase DM targeted at the card-paid player.
  expect(raterDms.filter((i) => i.key?.includes(":pay-chase:"))).toHaveLength(0);
});

test("group 'N payments still pending' tail drops as players are marked paid", async ({
  request,
  db,
}) => {
  const now = londonAt(0, 17, 30); // inside the 17:00-18:00 evening-update window
  const dayKey = londonDateKey(now); // dayKey == londonDateKey(now) per bot-scheduler.ts:1366

  // Before: 3 unpaid on the PAY match (player, guest, fresh; collector + rater excluded/paid).
  const before = await duePostsAt(request, now);
  const eveningBefore = before.find((i) => i.key === eveningKey(dayKey));
  expect(eveningBefore, "evening-update group message for the upcoming match").toBeTruthy();
  expect(eveningBefore?.kind).toBe("group-message");
  expect(eveningBefore?.text).toContain("payments still pending");
  // Template: "💳 *3* payments still pending for last week's match"
  expect(eveningBefore?.text).toContain("3");
  expect(eveningBefore?.text).toMatch(/3 payments still pending|\*3\* payments still pending/);

  // Mark Pat Player paid → count goes 3 → 2 (still plural). Re-run, no reset.
  await markPaidDirect(db, MATCH.pay, U.player);
  const after = await duePostsAt(request, now);
  const eveningAfter = after.find((i) => i.key === eveningKey(dayKey));
  expect(eveningAfter?.text).toContain("payments still pending");
  expect(eveningAfter?.text).toContain("2");
  expect(eveningAfter?.text).not.toContain("3 payments still pending");
  expect(eveningAfter?.text).not.toContain("*3* payments still pending");

  // NOTE: the PaymentCredit subtraction path (bot-scheduler.ts:268-273) is
  // covered in the unit test (payment-suppression.test.ts) rather than
  // here — inserting a PaymentCredit row needs payerUserId/recordedById/
  // recordedAt and is brittle to seed inline; the paidAt count drop above
  // is the core e2e deliverable.
});

test("collector confirm-receipt nudge goes silent once the direct-pending player pays", async ({
  request,
  db,
}) => {
  const now = londonAt(0, 18, 30); // collector nudge shares the 18:00-19:00 window
  const dayKey = londonDateKey(now); // dayKey == londonDateKey(now) per bot-scheduler.ts:1366

  // Before: Gary Guest is direct-pending (no phone, but that doesn't gate
  // the COLLECTOR nudge) → the collector gets nudged.
  const before = await duePostsAt(request, now);
  const nudgeBefore = before.find((i) => i.key === collectorKey(dayKey));
  expect(nudgeBefore, "collector confirm-receipt nudge").toBeTruthy();
  expect(nudgeBefore?.kind).toBe("dm");
  expect(nudgeBefore?.targetUser).toBe(U.collector);
  expect(nudgeBefore?.text).toMatch(/pay you directly/);

  // Confirm Gary's direct payment → pendingDirect empties → nudge stops.
  await markPaidDirect(db, MATCH.pay, U.guest);
  const after = await duePostsAt(request, now);
  expect(after.map((i) => i.key)).not.toContain(collectorKey(dayKey));
});
