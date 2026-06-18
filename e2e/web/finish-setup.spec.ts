/**
 * Finish-setup (onboarding enrichment review + apply).
 *
 * An admin lands on /finish-setup/<sessionId> after the bot has mined the
 * group's chat history into a proposed roster. They review/edit seed
 * ratings + positions, fill in missing phones for unresolved members, set
 * the schedule, and Apply — which writes seeds, positions, phones and the
 * schedule to live records and marks the session "applied".
 *
 *   - mobile-width render + edit a seed rating + add a missing phone +
 *     apply → DB reflects all writes
 *   - re-opening an applied session short-circuits (idempotent; nothing
 *     re-written, no Apply button)
 */
import { test, expect, signInAs, resetDb, U } from "../fixtures";
import { ORG_ID, ACTIVITY_ID, NAME } from "../helpers/constants";

test.describe.configure({ mode: "serial" });

const SESSION_ID = "e2e-onb-finish";

const ROSTER = [
  {
    name: NAME.player, // "Pat Player" — matches U.player by name
    matchedUserId: U.player,
    proposedPosition: "MID",
    proposedSeedRating: 7,
    evidence: "scored twice in the chat",
    confidence: 0.8,
  },
];
const UNRESOLVED = [{ name: NAME.guest, userId: U.guest }]; // Gary Guest, no phone
const SCHEDULE = { dayOfWeek: 4, time: "20:00", venue: "Goals Sutton", playersPerSide: 7 };

test.beforeAll(async () => {
  resetDb();
  const db = (await import("../helpers/test-db")).testDb();
  // The e2e seed does NOT create an OnboardingSession — insert one in the
  // "ready" enrichment state pointed at the seeded org.
  await db.run(
    `INSERT INTO "OnboardingSession"
       (id, "whatsappGroupId", "orgId", stage, source, "selectedFeatures",
        "enrichmentStatus", "proposedRoster", "unresolvedMembers",
        "capturedSchedule", "createdAt", "updatedAt")
     VALUES ($1,$2,$3,'completed','group-add','{}','ready',
             $4::jsonb,$5::jsonb,$6::jsonb, now(), now())`,
    [
      SESSION_ID,
      "e2e-finish-group",
      ORG_ID,
      JSON.stringify(ROSTER),
      JSON.stringify(UNRESOLVED),
      JSON.stringify(SCHEDULE),
    ],
  );
});

test("mobile render + edit seed + add phone + apply writes to the DB", async ({ page, db }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs(page, U.admin, `/finish-setup/${SESSION_ID}`);

  // Roster entry rendered with its evidence.
  await expect(page.getByText(NAME.player).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("scored twice in the chat")).toBeVisible();

  // Edit Pat's seed rating 7 → 9.
  const seedInput = page.getByLabel(/seed rating/i).first();
  await seedInput.fill("9");
  await page.keyboard.press("Tab");

  // Fill Gary Guest's missing phone.
  const phoneInput = page.getByLabel(new RegExp(NAME.guest, "i"));
  await phoneInput.fill("+447700900099");

  // Apply. On success the client shows "Setup complete"; the server-action
  // re-render of this route may instead surface the "already completed"
  // server card (the session is now applied) — either is a success signal.
  await page.getByRole("button", { name: /apply/i }).click();
  await expect(page.getByText(/setup complete|already completed/i)).toBeVisible({ timeout: 30_000 });

  // ── DB assertions ──
  // Seed rating written (overwrites the proposed value with the admin edit).
  await expect
    .poll(async () => {
      const row = await db.one<{ seedRating: number | null }>(
        `SELECT "seedRating" FROM "User" WHERE id = $1`,
        [U.player],
      );
      return row?.seedRating ?? null;
    })
    .toBe(9);

  // Position upserted for the activity.
  expect(
    await db.count(
      `SELECT COUNT(*) FROM "PlayerActivityPosition" WHERE "userId" = $1 AND "activityId" = $2`,
      [U.player, ACTIVITY_ID],
    ),
  ).toBe(1);
  const posRow = await db.one<{ positions: string[] }>(
    `SELECT positions FROM "PlayerActivityPosition" WHERE "userId" = $1 AND "activityId" = $2`,
    [U.player, ACTIVITY_ID],
  );
  expect(posRow?.positions).toContain("MID");

  // Phone added to the previously phone-less guest, normalised to E.164.
  const guest = await db.one<{ phoneNumber: string | null }>(
    `SELECT "phoneNumber" FROM "User" WHERE id = $1`,
    [U.guest],
  );
  expect(guest?.phoneNumber).toBe("+447700900099");

  // Session marked applied.
  const sess = await db.one<{ enrichmentStatus: string | null }>(
    `SELECT "enrichmentStatus" FROM "OnboardingSession" WHERE id = $1`,
    [SESSION_ID],
  );
  expect(sess?.enrichmentStatus).toBe("applied");
});

test("re-opening an applied session short-circuits (idempotent)", async ({ page, db }) => {
  const seedBefore = (
    await db.one<{ seedRating: number | null }>(`SELECT "seedRating" FROM "User" WHERE id = $1`, [U.player])
  )?.seedRating;
  const posBefore = await db.count(
    `SELECT COUNT(*) FROM "PlayerActivityPosition" WHERE "userId" = $1 AND "activityId" = $2`,
    [U.player, ACTIVITY_ID],
  );

  await signInAs(page, U.admin, `/finish-setup/${SESSION_ID}`);

  // Already-completed panel; no Apply button.
  await expect(page.getByText(/already completed/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /apply/i })).toHaveCount(0);

  // Nothing re-written.
  const seedAfter = (
    await db.one<{ seedRating: number | null }>(`SELECT "seedRating" FROM "User" WHERE id = $1`, [U.player])
  )?.seedRating;
  expect(seedAfter).toBe(seedBefore);
  expect(seedAfter).toBe(9);
  expect(
    await db.count(
      `SELECT COUNT(*) FROM "PlayerActivityPosition" WHERE "userId" = $1 AND "activityId" = $2`,
      [U.player, ACTIVITY_ID],
    ),
  ).toBe(posBefore);
});
