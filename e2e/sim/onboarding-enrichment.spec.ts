/**
 * Group-simulator scenario — ONBOARDING ENRICHMENT trigger + admin DM.
 *
 * Drives the group-add onboarding to COMPLETION exactly like
 * onboarding.spec.ts, but injects an `enrichmentHistory` payload on the
 * completing (when&where → details) turn. On completion the conversation
 * fires runOnboardingEnrichment (fire-and-forget) which persists
 * enrichmentStatus:"ready" on the OnboardingSession and queues a DM to
 * the admin with a magic link into /finish-setup/<sessionId>.
 *
 * Test env has ANTHROPIC_API_KEY="" so the analyzer returns null →
 * enrichment still persists "ready" with an empty roster (playerCount 0)
 * and STILL DMs the admin. The DM must be queued and must contain NO raw
 * phone number.
 *
 * Negative: an onboarding WITHOUT enrichmentHistory queues no enrichment
 * DM and leaves enrichmentStatus NULL.
 */
import { test, expect } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createOnboardingGroup } from "./group";

test.describe.configure({ mode: "serial" });

// Distinct phone block from onboarding.spec.ts to avoid cross-test
// User/phone collisions in the serial DB.
const OWNER_PHONE = "447700916000";

// Marker text unique to the enrichment DM (the normal admin magic-link DM
// also contains "/r/", so we MUST key on enrichment-specific copy).
const ENRICHMENT_MARKER = "drafted positions";

const enrichmentHistory = [
  { author: "Coach", authorPhone: null, text: "Najib saved us again on Thursday, MOTM", timestamp: Date.now() },
  { author: "Talha", authorPhone: null, text: "Talha hat-trick on Thursday 🔥", timestamp: Date.now() },
  { author: "Captain", authorPhone: null, text: "Squad: Najib GK, Talha ST, Baki CB, the usual", timestamp: Date.now() },
];

const sessionRow = (db: TestDb, groupId: string) =>
  db.one<{ id: string; enrichmentStatus: string | null }>(
    `SELECT id, "enrichmentStatus" FROM "OnboardingSession"
     WHERE "whatsappGroupId" = $1 ORDER BY "createdAt" DESC`,
    [groupId],
  );

/** Drive bot-added → EVERYTHING → admins → (details, completing) to a live
 *  org. The completing turn carries the given enrichmentHistory (or none).
 *  Returns the org id. */
async function completeOnboarding(
  request: Parameters<typeof createOnboardingGroup>[0],
  ownerPhone: string,
  groupSubject: string,
  history?: typeof enrichmentHistory,
): Promise<{ groupId: string; orgId: string }> {
  const onb = createOnboardingGroup(request);

  const added = await onb.botAdded({
    groupSubject,
    addedByPhone: ownerPhone,
    participants: [],
  });
  expect(added.ok).toBe(true);

  await onb.say("EVERYTHING", { phone: ownerPhone, name: "Olive Owner" });
  await onb.say("just me for now", { phone: ownerPhone, name: "Olive Owner" });
  // Completing turn — carries enrichmentHistory only when provided.
  const done = await onb.say(
    "we play saturdays 10am at Hackney Marshes, 11 a side",
    { phone: ownerPhone, name: "Olive Owner" },
    history ? { enrichmentHistory: history } : undefined,
  );
  expect(done.reply).toContain("All set");

  return { groupId: onb.groupId, orgId: "" };
}

test("completing onboarding WITH enrichment history fires enrichment + DMs the admin a /finish-setup link (no PII)", async ({ request, db }) => {
  const { groupId } = await completeOnboarding(
    request,
    OWNER_PHONE,
    "Enrichment Sat FC",
    enrichmentHistory,
  );

  const org = await db.one<{ id: string }>(
    `SELECT id FROM "Organisation" WHERE "whatsappGroupId" = $1`,
    [groupId],
  );
  expect(org?.id).toBeTruthy();

  // Enrichment runs fire-and-forget after the response — poll the session.
  await expect
    .poll(async () => (await sessionRow(db, groupId))?.enrichmentStatus, { timeout: 20_000 })
    .toBe("ready");

  // The enrichment DM must be queued (keyed on enrichment-specific copy,
  // NOT just "/r/" — the admin magic-link DM also has "/r/").
  await expect
    .poll(
      async () =>
        await db.count(
          `SELECT COUNT(*) FROM "BotJob"
           WHERE "orgId" = $1 AND kind = 'dm' AND text ILIKE '%' || $2 || '%'`,
          [org!.id, ENRICHMENT_MARKER],
        ),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);

  const dm = await db.one<{ text: string }>(
    `SELECT text FROM "BotJob"
     WHERE "orgId" = $1 AND kind = 'dm' AND text ILIKE '%' || $2 || '%'
     ORDER BY "createdAt" DESC`,
    [org!.id, ENRICHMENT_MARKER],
  );
  expect(dm?.text).toBeTruthy();
  // Magic short link into /finish-setup.
  expect(dm!.text).toContain("/r/");
  // PII-SAFE: no raw phone number anywhere in the DM text.
  expect(dm!.text).not.toContain("+44");
  expect(dm!.text).not.toMatch(/\d{10,}/);
});

test("completing onboarding WITHOUT enrichment history queues NO enrichment DM and leaves enrichmentStatus null", async ({ request, db }) => {
  const NO_HIST_OWNER = "447700916100";
  const { groupId } = await completeOnboarding(
    request,
    NO_HIST_OWNER,
    "No-Enrichment Sat FC",
    undefined,
  );

  const org = await db.one<{ id: string }>(
    `SELECT id FROM "Organisation" WHERE "whatsappGroupId" = $1`,
    [groupId],
  );
  expect(org?.id).toBeTruthy();

  // Give any (incorrectly-fired) enrichment a few seconds to settle.
  await new Promise((r) => setTimeout(r, 4_000));

  // No enrichment-specific DM.
  expect(
    await db.count(
      `SELECT COUNT(*) FROM "BotJob"
       WHERE "orgId" = $1 AND kind = 'dm' AND text ILIKE '%' || $2 || '%'`,
      [org!.id, ENRICHMENT_MARKER],
    ),
  ).toBe(0);

  // enrichmentStatus untouched.
  expect((await sessionRow(db, groupId))?.enrichmentStatus).toBeNull();
});
