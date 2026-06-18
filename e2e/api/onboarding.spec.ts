/**
 * Phase 1 autonomous onboarding — "adding the bot IS the onboarding"
 * (MDs/autonomous-onboarding-design-2026-06-12.md, group-add flow).
 *
 * Drives the REAL flow the Pi bot drives:
 *   POST /api/whatsapp/bot-added            (self-add detected)
 *   POST /api/whatsapp/analyze              (the group's replies)
 * with the LLM unavailable (ANTHROPIC_API_KEY is inert in the e2e env),
 * so every assertion exercises the deterministic regex path.
 *
 * Covers:
 *   - live-org short-circuit (a configured group can NEVER re-enter
 *     onboarding — the safety property protecting Sutton FC et al.)
 *   - bot-added → OnboardingSession(stage=introduced) + intro text
 *   - idempotent re-add
 *   - junk replies fall open (silent, no state change)
 *   - "YES" → recommended bundle, replier captured as admin
 *   - combined "Tuesdays 9pm at Goals" → org + OWNER membership +
 *     Activity + first Match + roster import + magic-link DM BotJob
 *   - "EVERYTHING" → payment tracking enabled too
 *   - named subset ("just MoM and ratings") → exactly those features
 *     (+ derived featureSquadFromList)
 *
 * NOTE: the e2e server runs with ONBOARDING_AUTOSTART=1 (helpers/env)
 * — the flag's OFF-by-default behaviour is unit-tested in
 * src/lib/__tests__/onboarding-parse.test.ts.
 */
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
import type { APIRequestContext } from "@playwright/test";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

let n = 0;
const msgId = () => `e2e-onb-${Date.now()}-${++n}`;

const HEADERS = { "x-api-key": E2E.WHATSAPP_API_KEY };

async function postBotAdded(
  request: APIRequestContext,
  data: Record<string, unknown>,
) {
  const res = await request.post("/api/whatsapp/bot-added", {
    headers: HEADERS,
    data,
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function say(
  request: APIRequestContext,
  groupId: string,
  body: string,
  authorPhone: string,
  authorName: string | null = null,
  // Raw WhatsApp mention JIDs, forwarded UNCHANGED (e.g. "447…@c.us",
  // "…@lid") — exactly what the bot puts on the analyze payload.
  mentions?: string[],
) {
  const res = await request.post("/api/whatsapp/analyze", {
    headers: HEADERS,
    data: {
      groupId,
      messages: [
        {
          waMessageId: msgId(),
          body,
          authorPhone,
          authorName,
          timestamp: new Date().toISOString(),
          ...(mentions ? { mentions } : {}),
        },
      ],
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  const json = await res.json();
  const reply: string | null = json.results?.[0]?.reply ?? null;
  return { json, reply };
}

const session = (db: TestDb, groupId: string) =>
  db.one<{
    id: string;
    stage: string;
    source: string;
    groupName: string | null;
    adminUserId: string | null;
    selectedFeatures: string[];
    dayOfWeek: number | null;
    kickoffTime: string | null;
    venue: string | null;
    recurrence: string | null;
    playersPerSide: number | null;
    orgId: string | null;
    pendingAdmins: Array<{ name: string | null; phone: string | null; mention: string | null }> | null;
  }>(
    `SELECT * FROM "OnboardingSession" WHERE "whatsappGroupId" = $1 ORDER BY "createdAt" DESC`,
    [groupId],
  );

// Per-run-unique group ids so a re-run against a persistent cluster
// can't collide with leftovers.
const RUN = Date.now().toString(36);
const GROUP_A = `e2e-onb-a-${RUN}@g.us`; // YES happy path
const GROUP_B = `e2e-onb-b-${RUN}@g.us`; // EVERYTHING
const GROUP_C = `e2e-onb-c-${RUN}@g.us`; // named subset
const GROUP_D = `e2e-onb-d-${RUN}@g.us`; // co-admins by name+phone
const GROUP_E = `e2e-onb-e-${RUN}@g.us`; // "just me" → zero co-admins
const GROUP_F = `e2e-onb-f-${RUN}@g.us`; // co-admin via tap-to-@-mention

const ADMIN_PHONE = "447700900050"; // as the bot forwards it (no "+")
const ADMIN_E164 = "+447700900050";

const SNAPSHOT = [
  { phone: "447700900051", pushname: "Ana Aboard" },
  { phone: "447700900052", pushname: "Bob Builder" },
  { phone: "905551112233", pushname: "Cem Çelik" },
  { lidId: "1234567890@lid", pushname: "Privacy Pete" }, // no phone → skipped
];

// ───────────────────────── safety property ──────────────────────────────

test("a LIVE org's group does NOT trigger onboarding (short-circuit)", async ({
  request,
  db,
}) => {
  const res = await postBotAdded(request, {
    groupId: E2E.GROUP_ID, // the seeded, bot-enabled fixture org
    groupSubject: "Should Be Ignored FC",
    addedByPhone: ADMIN_PHONE,
    participants: SNAPSHOT,
  });
  expect(res.ignored).toBe("live-org");
  expect(res.introText).toBeNull();
  const count = await db.count(
    `SELECT COUNT(*) FROM "OnboardingSession" WHERE "whatsappGroupId" = $1`,
    [E2E.GROUP_ID],
  );
  expect(count).toBe(0);
});

// ───────────────────────── happy path: YES ──────────────────────────────

test("bot-added creates an introduced session and returns the intro", async ({
  request,
  db,
}) => {
  const res = await postBotAdded(request, {
    groupId: GROUP_A,
    groupSubject: "Tuesday Ballers FC",
    addedByPhone: ADMIN_PHONE,
    participants: SNAPSHOT,
  });
  expect(res.ok).toBe(true);
  expect(res.introText).toContain("MatchTime");
  expect(res.introText).toContain("YES");
  expect(res.introText).toContain("EVERYTHING");
  // Now the DESCRIPTIVE full-menu pitch — names the headline features.
  expect(res.introText).toContain("Squad list");
  expect(res.introText).toContain("Fair teams");
  expect(res.introText).toContain("Man of the Match");
  expect(res.introText).toContain("Player ratings");
  expect(res.introText).toContain("Payment tracking");

  const s = await session(db, GROUP_A);
  expect(s?.stage).toBe("introduced");
  expect(s?.source).toBe("group-add");
  expect(s?.groupName).toBe("Tuesday Ballers FC");
});

test("re-adding the bot is idempotent (no second session)", async ({
  request,
  db,
}) => {
  const res = await postBotAdded(request, {
    groupId: GROUP_A,
    groupSubject: "Tuesday Ballers FC",
  });
  expect(res.existing).toBe(true);
  const count = await db.count(
    `SELECT COUNT(*) FROM "OnboardingSession" WHERE "whatsappGroupId" = $1`,
    [GROUP_A],
  );
  expect(count).toBe(1);
});

test("ordinary chat after the intro falls open — silent, still introduced", async ({
  request,
  db,
}) => {
  const { reply } = await say(request, GROUP_A, "anyone seen my boots?", "447700900051");
  expect(reply).toBeNull();
  const s = await session(db, GROUP_A);
  expect(s?.stage).toBe("introduced");
  expect(s?.adminUserId).toBeNull();
});

test('"YES" → recommended bundle, replier captured as owner, admins asked', async ({
  request,
  db,
}) => {
  const { reply } = await say(request, GROUP_A, "YES", ADMIN_PHONE, "Adam Admin");
  // YES now advances to the `admins` stage (asks for additional admins),
  // NOT straight to details.
  expect(reply?.toLowerCase()).toContain("who else helps run");

  const s = await session(db, GROUP_A);
  expect(s?.stage).toBe("admins");
  expect(s?.selectedFeatures).toEqual(
    expect.arrayContaining([
      "attendance",
      "bench",
      "teamBalancing",
      "momVoting",
      "playerRating",
      "reminders",
    ]),
  );
  expect(s?.selectedFeatures).not.toContain("paymentTracking");
  expect(s?.adminUserId).not.toBeNull();

  const admin = await db.one<{ phoneNumber: string }>(
    `SELECT "phoneNumber" FROM "User" WHERE id = $1`,
    [s!.adminUserId],
  );
  expect(admin?.phoneNumber).toBe(ADMIN_E164);
});

test('admin question "just me" → details asked, no pending admins', async ({
  request,
  db,
}) => {
  const { reply } = await say(request, GROUP_A, "just me", ADMIN_PHONE, "Adam Admin");
  expect(reply).toContain("when and where do you play?");

  const s = await session(db, GROUP_A);
  expect(s?.stage).toBe("details");
  expect(s?.pendingAdmins ?? []).toHaveLength(0);
});

test('"Tuesdays 9pm at Goals Wembley" → org live: OWNER, activity, match, roster, magic link', async ({
  request,
  db,
}) => {
  const { reply } = await say(
    request,
    GROUP_A,
    "Tuesdays 9pm at Goals Wembley",
    ADMIN_PHONE,
    "Adam Admin",
  );
  expect(reply).toContain("All set");

  const s = await session(db, GROUP_A);
  expect(s?.stage).toBe("completed");
  expect(s?.dayOfWeek).toBe(2);
  expect(s?.kickoffTime).toBe("21:00");
  expect(s?.venue).toBe("Goals Wembley");
  expect(s?.recurrence).toBe("weekly"); // defaulted, never asked
  expect(s?.playersPerSide).toBe(7); // defaulted, never asked

  // Org created from the group subject, bot enabled.
  const org = await db.one<{
    id: string;
    name: string;
    whatsappBotEnabled: boolean;
    featureAttendance: boolean;
    featureBench: boolean;
    featureTeamBalancing: boolean;
    featureMomVoting: boolean;
    featurePlayerRating: boolean;
    featureReminders: boolean;
    featureStatsQa: boolean;
    featureSquadFromList: boolean;
    paymentTrackingEnabled: boolean;
  }>(`SELECT * FROM "Organisation" WHERE "whatsappGroupId" = $1`, [GROUP_A]);
  expect(org?.name).toBe("Tuesday Ballers FC");
  expect(org?.whatsappBotEnabled).toBe(true);
  expect(org?.featureAttendance).toBe(true);
  expect(org?.featureBench).toBe(true);
  expect(org?.featureTeamBalancing).toBe(true);
  expect(org?.featureMomVoting).toBe(true);
  expect(org?.featurePlayerRating).toBe(true);
  expect(org?.featureReminders).toBe(true);
  expect(org?.featureStatsQa).toBe(true); // always-on
  expect(org?.featureSquadFromList).toBe(false); // attendance is on
  expect(org?.paymentTrackingEnabled).toBe(false); // YES ≠ payments

  // OWNER membership for the YES-replier — the core fix.
  const owner = await db.one<{ role: string }>(
    `SELECT m.role FROM "Membership" m JOIN "User" u ON u.id = m."userId"
     WHERE m."orgId" = $1 AND u."phoneNumber" = $2`,
    [org!.id, ADMIN_E164],
  );
  expect(owner?.role).toBe("OWNER");

  // Activity from the combined answer (venue = FREE TEXT, no geocode).
  const activity = await db.one<{
    id: string;
    name: string;
    dayOfWeek: number;
    time: string;
    venue: string;
    isActive: boolean;
  }>(`SELECT * FROM "Activity" WHERE "orgId" = $1`, [org!.id]);
  expect(activity?.name).toBe("Tuesday Ballers FC");
  expect(activity?.dayOfWeek).toBe(2);
  expect(activity?.time).toBe("21:00");
  expect(activity?.venue).toBe("Goals Wembley");
  expect(activity?.isActive).toBe(true); // weekly

  // First match auto-generated (7-a-side default → 14 slots).
  const match = await db.one<{ maxPlayers: number; status: string }>(
    `SELECT * FROM "Match" WHERE "activityId" = $1`,
    [activity!.id],
  );
  expect(match?.maxPlayers).toBe(14);
  expect(match?.status).toBe("UPCOMING");

  // Roster auto-import: 3 phone-resolvable snapshot members + the
  // admin = 4 memberships; the @lid-only participant is skipped.
  const members = await db.count(
    `SELECT COUNT(*) FROM "Membership" WHERE "orgId" = $1 AND "leftAt" IS NULL`,
    [org!.id],
  );
  expect(members).toBe(4);
  const ana = await db.one<{ name: string | null }>(
    `SELECT u.name FROM "User" u JOIN "Membership" m ON m."userId" = u.id
     WHERE m."orgId" = $1 AND u."phoneNumber" = '+447700900051'`,
    [org!.id],
  );
  expect(ana?.name).toBe("Ana Aboard");

  // Magic-link DM queued for the admin → /admin.
  const dm = await db.one<{ phone: string; text: string }>(
    `SELECT phone, text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm'`,
    [org!.id],
  );
  expect(dm?.phone).toBe(ADMIN_PHONE);
  expect(dm?.text).toContain("admin");
  expect(dm?.text).toMatch(/https?:\/\//);

  // The completion post mentions the imported roster.
  expect(reply).toContain("squad");
});

// ───────────────────────── EVERYTHING path ──────────────────────────────

test('"EVERYTHING" enables payment tracking too', async ({ request, db }) => {
  await postBotAdded(request, {
    groupId: GROUP_B,
    groupSubject: "Sunday League Legends",
    addedByPhone: null,
    participants: [],
  });
  await say(request, GROUP_B, "EVERYTHING", "447700900060", "Olive Owner");
  // New `admins` stage — answer "just me" to reach `details`.
  await say(request, GROUP_B, "just me", "447700900060", "Olive Owner");
  const { reply } = await say(
    request,
    GROUP_B,
    "we play saturdays 10am at Hackney Marshes, 11 a side",
    "447700900060",
    "Olive Owner",
  );
  expect(reply).toContain("All set");

  const org = await db.one<{
    id: string;
    paymentTrackingEnabled: boolean;
    paymentCollectionEnabled: boolean;
    featureAttendance: boolean;
  }>(`SELECT * FROM "Organisation" WHERE "whatsappGroupId" = $1`, [GROUP_B]);
  expect(org?.paymentTrackingEnabled).toBe(true);
  expect(org?.paymentCollectionEnabled).toBe(false); // NEVER chat-set
  expect(org?.featureAttendance).toBe(true);

  // 11-a-side from the answer, Saturday 10:00.
  const activity = await db.one<{ dayOfWeek: number; time: string; venue: string }>(
    `SELECT * FROM "Activity" WHERE "orgId" = $1`,
    [org!.id],
  );
  expect(activity?.dayOfWeek).toBe(6);
  expect(activity?.time).toBe("10:00");
  expect(activity?.venue).toBe("Hackney Marshes");

  // Owner captured from the EVERYTHING replier (no adder phone given).
  const owner = await db.one<{ role: string }>(
    `SELECT m.role FROM "Membership" m JOIN "User" u ON u.id = m."userId"
     WHERE m."orgId" = $1 AND u."phoneNumber" = '+447700900060'`,
    [org!.id],
  );
  expect(owner?.role).toBe("OWNER");
});

// ───────────────────────── named-subset path ────────────────────────────

test('"just MoM and ratings" → exactly those + derived squad-from-list', async ({
  request,
  db,
}) => {
  await postBotAdded(request, {
    groupId: GROUP_C,
    groupSubject: "Thursday 5s",
    addedByPhone: "447700900070",
    participants: [{ phone: "447700900071", pushname: "Pat Player" }],
  });
  await say(request, GROUP_C, "just MoM and ratings please", "447700900070");
  // New `admins` stage — answer "just me" to reach `details`.
  await say(request, GROUP_C, "just me", "447700900070");
  const { reply } = await say(
    request,
    GROUP_C,
    "thursdays 6:30pm at PowerLeague Shoreditch, 5-a-side",
    "447700900070",
  );
  expect(reply).toContain("All set");

  const org = await db.one<{
    id: string;
    featureMomVoting: boolean;
    featurePlayerRating: boolean;
    featureAttendance: boolean;
    featureBench: boolean;
    featureSquadFromList: boolean;
    paymentTrackingEnabled: boolean;
  }>(`SELECT * FROM "Organisation" WHERE "whatsappGroupId" = $1`, [GROUP_C]);
  expect(org?.featureMomVoting).toBe(true);
  expect(org?.featurePlayerRating).toBe(true);
  expect(org?.featureAttendance).toBe(false);
  expect(org?.featureBench).toBe(false);
  expect(org?.paymentTrackingEnabled).toBe(false);
  // MoM/ratings WITHOUT attendance → squad read from pasted lists.
  expect(org?.featureSquadFromList).toBe(true);

  // 5-a-side → 10 slots on the first match.
  const match = await db.one<{ maxPlayers: number }>(
    `SELECT mt."maxPlayers" FROM "Match" mt
     JOIN "Activity" a ON a.id = mt."activityId" WHERE a."orgId" = $1`,
    [org!.id],
  );
  expect(match?.maxPlayers).toBe(10);
});

// ───────────────────────── admins stage ─────────────────────────────────

const COADMIN_OWNER = "447700900100";
const COADMIN_1 = "447700900201";
const COADMIN_2 = "447700900202";

test('admins stage: two named co-admins → 2 ADMIN memberships + magic-link DMs', async ({
  request,
  db,
}) => {
  await postBotAdded(request, {
    groupId: GROUP_D,
    groupSubject: "Co-Admin FC",
    addedByPhone: COADMIN_OWNER,
    participants: [],
  });

  // YES → owner captured, advances to the `admins` stage.
  const yes = await say(request, GROUP_D, "YES", COADMIN_OWNER, "Cara Owner");
  expect(yes.reply?.toLowerCase()).toContain("who else helps run");
  let s = await session(db, GROUP_D);
  expect(s?.stage).toBe("admins");

  // Name two co-admins by name+phone (phones not in the owner/snapshot).
  const adminsReply = await say(
    request,
    GROUP_D,
    `Baki ${COADMIN_1} and Derya ${COADMIN_2}`,
    COADMIN_OWNER,
    "Cara Owner",
  );
  // Advances to details, asking when&where.
  expect(adminsReply.reply).toContain("when and where do you play?");
  s = await session(db, GROUP_D);
  expect(s?.stage).toBe("details");
  expect(s?.pendingAdmins ?? []).toHaveLength(2);

  // Complete with the when&where answer.
  const done = await say(
    request,
    GROUP_D,
    "Tuesdays 9pm at Goals Wembley",
    COADMIN_OWNER,
    "Cara Owner",
  );
  expect(done.reply).toContain("All set");

  s = await session(db, GROUP_D);
  expect(s?.stage).toBe("completed");

  const org = await db.one<{ id: string }>(
    `SELECT id FROM "Organisation" WHERE "whatsappGroupId" = $1`,
    [GROUP_D],
  );

  // OWNER = the YES replier.
  const owner = await db.one<{ role: string }>(
    `SELECT m.role FROM "Membership" m JOIN "User" u ON u.id = m."userId"
     WHERE m."orgId" = $1 AND u."phoneNumber" = $2`,
    [org!.id, `+${COADMIN_OWNER}`],
  );
  expect(owner?.role).toBe("OWNER");

  // Exactly 2 ADMIN memberships, for the two co-admin phones.
  const adminCount = await db.count(
    `SELECT COUNT(*) FROM "Membership" WHERE "orgId" = $1 AND role = 'ADMIN' AND "leftAt" IS NULL`,
    [org!.id],
  );
  expect(adminCount).toBe(2);

  for (const phone of [COADMIN_1, COADMIN_2]) {
    const m = await db.one<{ role: string }>(
      `SELECT m.role FROM "Membership" m JOIN "User" u ON u.id = m."userId"
       WHERE m."orgId" = $1 AND u."phoneNumber" = $2`,
      [org!.id, `+${phone}`],
    );
    expect(m?.role).toBe("ADMIN");

    // Magic-link DM queued for each co-admin.
    const dm = await db.one<{ phone: string; text: string }>(
      `SELECT phone, text FROM "BotJob"
       WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2`,
      [org!.id, phone],
    );
    expect(dm?.phone).toBe(phone);
    expect(dm?.text.toLowerCase()).toContain("admin");
    expect(dm?.text).toMatch(/https?:\/\//);
  }
});

test('admins stage: "just me" → zero ADMIN memberships (only the OWNER)', async ({
  request,
  db,
}) => {
  await postBotAdded(request, {
    groupId: GROUP_E,
    groupSubject: "Solo Admin FC",
    addedByPhone: "447700900110",
    participants: [],
  });

  await say(request, GROUP_E, "YES", "447700900110", "Solo Sam");
  let s = await session(db, GROUP_E);
  expect(s?.stage).toBe("admins");

  const adminsReply = await say(request, GROUP_E, "just me", "447700900110", "Solo Sam");
  expect(adminsReply.reply).toContain("when and where do you play?");
  s = await session(db, GROUP_E);
  expect(s?.stage).toBe("details");
  expect(s?.pendingAdmins ?? []).toHaveLength(0);

  const done = await say(
    request,
    GROUP_E,
    "Mondays 8pm at the cage",
    "447700900110",
    "Solo Sam",
  );
  expect(done.reply).toContain("All set");

  const org = await db.one<{ id: string }>(
    `SELECT id FROM "Organisation" WHERE "whatsappGroupId" = $1`,
    [GROUP_E],
  );
  const adminCount = await db.count(
    `SELECT COUNT(*) FROM "Membership" WHERE "orgId" = $1 AND role = 'ADMIN' AND "leftAt" IS NULL`,
    [org!.id],
  );
  expect(adminCount).toBe(0);

  const owner = await db.one<{ role: string }>(
    `SELECT m.role FROM "Membership" m JOIN "User" u ON u.id = m."userId"
     WHERE m."orgId" = $1 AND u."phoneNumber" = '+447700900110'`,
    [org!.id],
  );
  expect(owner?.role).toBe("OWNER");
});

// ───────────────── admins stage: tap-to-@-mention ────────────────────────
//
// The owner TAPS "@" and picks a member rather than typing a number. The
// bot forwards that as a raw mention JID in `mentions[]` (NOT typed digits
// in the body). The admin parser resolves "<digits>@c.us" → phone → ADMIN
// membership. This is the producer→parser wiring this fix adds.

const MENTION_OWNER = "447700900120";
const MENTION_COADMIN = "447700900221";

test('admins stage: @-tagged co-admin via mentions[] → ADMIN membership', async ({
  request,
  db,
}) => {
  await postBotAdded(request, {
    groupId: GROUP_F,
    groupSubject: "Mention FC",
    addedByPhone: MENTION_OWNER,
    participants: [],
  });

  // YES → owner captured, advances to the `admins` stage.
  const yes = await say(request, GROUP_F, "YES", MENTION_OWNER, "Mara Owner");
  expect(yes.reply?.toLowerCase()).toContain("who else helps run");
  let s = await session(db, GROUP_F);
  expect(s?.stage).toBe("admins");

  // The owner taps "@" to pick the co-admin — the body has the visible
  // "@<name>" text but the machine-readable identity is the raw JID in
  // mentions[]. NO typed digits in the body.
  const adminsReply = await say(
    request,
    GROUP_F,
    "@Berk",
    MENTION_OWNER,
    "Mara Owner",
    [`${MENTION_COADMIN}@c.us`],
  );
  expect(adminsReply.reply).toContain("when and where do you play?");
  s = await session(db, GROUP_F);
  expect(s?.stage).toBe("details");
  expect(s?.pendingAdmins ?? []).toHaveLength(1);

  // Complete with the when&where answer.
  const done = await say(
    request,
    GROUP_F,
    "Tuesdays 9pm at Goals Wembley",
    MENTION_OWNER,
    "Mara Owner",
  );
  expect(done.reply).toContain("All set");

  const org = await db.one<{ id: string }>(
    `SELECT id FROM "Organisation" WHERE "whatsappGroupId" = $1`,
    [GROUP_F],
  );

  // The @-tagged member is now an ADMIN membership.
  const admin = await db.one<{ role: string }>(
    `SELECT m.role FROM "Membership" m JOIN "User" u ON u.id = m."userId"
     WHERE m."orgId" = $1 AND u."phoneNumber" = $2`,
    [org!.id, `+${MENTION_COADMIN}`],
  );
  expect(admin?.role).toBe("ADMIN");

  const adminCount = await db.count(
    `SELECT COUNT(*) FROM "Membership" WHERE "orgId" = $1 AND role = 'ADMIN' AND "leftAt" IS NULL`,
    [org!.id],
  );
  expect(adminCount).toBe(1);
});
