/**
 * Group-simulator scenario matrix — ONBOARDING (group-add flow).
 *
 * "Adding the bot IS the onboarding": through the simulator this drives
 * bot-added → intro → consent (EVERYTHING) → admins (name+phone AND
 * @mention) → when&where → live org, asserting the full artefact set:
 * OWNER + ADMIN memberships, features, Activity, first Match, roster
 * import (@lid skipped) and the magic-link DMs. Plus the safety
 * property: a LIVE org's group can never re-enter onboarding.
 *
 * (The deterministic-regex parsing micro-cases live in
 * src/lib/__tests__/onboarding-parse.test.ts and e2e/api/onboarding.spec.ts;
 * this file covers the simulator-driven end-to-end shape.)
 */
import { test, expect, resetDb } from "../fixtures";
import type { TestDb } from "../helpers/test-db";
import { createGroup, createOnboardingGroup } from "./group";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
});

const OWNER_PHONE = "447700915000";
const COADMIN_NAMED = "447700915001";
const COADMIN_MENTION = "447700915002";

const SNAPSHOT = [
  { phone: "447700915010", pushname: "Ana Aboard" },
  { phone: "447700915011", pushname: "Bob Builder" },
  { lidId: "999888777666@lid", pushname: "Privacy Pete" }, // no phone → skipped
];

const session = (db: TestDb, groupId: string) =>
  db.one<{ stage: string; pendingAdmins: unknown[] | null }>(
    `SELECT * FROM "OnboardingSession" WHERE "whatsappGroupId" = $1 ORDER BY "createdAt" DESC`,
    [groupId],
  );

test("a LIVE org's group never re-enters onboarding when the bot is re-added", async ({ request, db }) => {
  const live = await createGroup(request, db, {});
  const res = await live.botAdded({
    groupSubject: "Should Be Ignored FC",
    addedByPhone: OWNER_PHONE,
    participants: SNAPSHOT,
  });
  expect(res.ignored).toBe("live-org");
  expect(res.introText).toBeNull();
  expect(
    await db.count(`SELECT COUNT(*) FROM "OnboardingSession" WHERE "whatsappGroupId" = $1`, [live.groupId]),
  ).toBe(0);
});

test("bot-added → intro → EVERYTHING → admins (@mention + name+phone) → when&where → live org", async ({ request, db }) => {
  const onb = createOnboardingGroup(request);

  // 1. The add itself starts the conversation.
  const added = await onb.botAdded({
    groupSubject: "Sim Sunday FC",
    addedByPhone: OWNER_PHONE,
    participants: SNAPSHOT,
  });
  expect(added.ok).toBe(true);
  expect(added.introText).toContain("MatchTime");
  expect((await session(db, onb.groupId))?.stage).toBe("introduced");

  // 2. Ordinary chat falls open — silent, still waiting on consent.
  const chat = await onb.say("anyone seen my shin pads?", { phone: "447700915010" });
  expect(chat.reply).toBeNull();
  expect((await session(db, onb.groupId))?.stage).toBe("introduced");

  // 3. EVERYTHING → all features incl. payment tracking; asks for admins.
  const yes = await onb.say("EVERYTHING", { phone: OWNER_PHONE, name: "Olive Owner" });
  expect(yes.reply?.toLowerCase()).toContain("who else helps run");
  expect((await session(db, onb.groupId))?.stage).toBe("admins");

  // 4. Two co-admins: one by name+phone, one by @mention.
  const admins = await onb.say(`Baki ${COADMIN_NAMED} and @${COADMIN_MENTION}`, {
    phone: OWNER_PHONE,
    name: "Olive Owner",
  });
  expect(admins.reply).toContain("when and where do you play?");
  const s = await session(db, onb.groupId);
  expect(s?.stage).toBe("details");
  expect(s?.pendingAdmins ?? []).toHaveLength(2);

  // 5. When & where → org goes live.
  const done = await onb.say("we play saturdays 10am at Hackney Marshes, 11 a side", {
    phone: OWNER_PHONE,
    name: "Olive Owner",
  });
  expect(done.reply).toContain("All set");
  expect((await session(db, onb.groupId))?.stage).toBe("completed");

  // Org: EVERYTHING = recommended bundle + payment tracking ON.
  const org = await db.one<{
    id: string;
    name: string;
    whatsappBotEnabled: boolean;
    featureAttendance: boolean;
    featureBench: boolean;
    featureMomVoting: boolean;
    featurePlayerRating: boolean;
    paymentTrackingEnabled: boolean;
    paymentCollectionEnabled: boolean;
    featureSquadFromList: boolean;
  }>(`SELECT * FROM "Organisation" WHERE "whatsappGroupId" = $1`, [onb.groupId]);
  expect(org?.name).toBe("Sim Sunday FC");
  expect(org?.whatsappBotEnabled).toBe(true);
  expect(org?.featureAttendance).toBe(true);
  expect(org?.featureBench).toBe(true);
  expect(org?.featureMomVoting).toBe(true);
  expect(org?.featurePlayerRating).toBe(true);
  expect(org?.paymentTrackingEnabled).toBe(true);
  expect(org?.paymentCollectionEnabled).toBe(false); // NEVER chat-set
  expect(org?.featureSquadFromList).toBe(false); // attendance is on

  // OWNER = the consenting replier.
  const owner = await db.one<{ role: string }>(
    `SELECT m.role FROM "Membership" m JOIN "User" u ON u.id = m."userId"
     WHERE m."orgId" = $1 AND u."phoneNumber" = $2`,
    [org!.id, `+${OWNER_PHONE}`],
  );
  expect(owner?.role).toBe("OWNER");

  // BOTH co-admins (named and @mentioned) became ADMIN + got a magic-link DM.
  for (const phone of [COADMIN_NAMED, COADMIN_MENTION]) {
    const role = await db.one<{ role: string }>(
      `SELECT m.role FROM "Membership" m JOIN "User" u ON u.id = m."userId"
       WHERE m."orgId" = $1 AND u."phoneNumber" = $2`,
      [org!.id, `+${phone}`],
    );
    expect(role?.role).toBe("ADMIN");
    const dm = await db.one<{ text: string }>(
      `SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2`,
      [org!.id, phone],
    );
    expect(dm?.text.toLowerCase()).toContain("admin");
    expect(dm?.text).toMatch(/https?:\/\//);
  }

  // Activity + first match from the combined answer (11-a-side → 22 slots).
  const activity = await db.one<{ id: string; dayOfWeek: number; time: string; venue: string }>(
    `SELECT * FROM "Activity" WHERE "orgId" = $1`,
    [org!.id],
  );
  expect(activity?.dayOfWeek).toBe(6);
  expect(activity?.time).toBe("10:00");
  expect(activity?.venue).toBe("Hackney Marshes");
  const match = await db.one<{ maxPlayers: number; status: string }>(
    `SELECT * FROM "Match" WHERE "activityId" = $1`,
    [activity!.id],
  );
  expect(match?.maxPlayers).toBe(22);
  expect(match?.status).toBe("UPCOMING");

  // Roster import: 2 phone-resolvable snapshot members + owner + 2
  // co-admins = 5; the @lid-only participant is SKIPPED.
  expect(
    await db.count(`SELECT COUNT(*) FROM "Membership" WHERE "orgId" = $1 AND "leftAt" IS NULL`, [org!.id]),
  ).toBe(5);
  const ana = await db.one<{ name: string | null }>(
    `SELECT u.name FROM "User" u JOIN "Membership" m ON m."userId" = u.id
     WHERE m."orgId" = $1 AND u."phoneNumber" = '+447700915010'`,
    [org!.id],
  );
  expect(ana?.name).toBe("Ana Aboard");

  // Owner's admin magic-link DM.
  const ownerDm = await db.one<{ text: string }>(
    `SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm' AND phone = $2`,
    [org!.id, OWNER_PHONE],
  );
  expect(ownerDm?.text).toMatch(/https?:\/\//);
});
