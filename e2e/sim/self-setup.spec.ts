/**
 * Self-setup, end to end, the way the Pi drives it (2026-09-17).
 *
 *   POST /api/whatsapp/bot-added      the bot was added to a group
 *   POST /api/whatsapp/analyze        every reply the group makes
 *   GET  /api/whatsapp/orgs           what the Pi monitors after a restart
 *
 * Two full flows, one English and one Turkish: added → intro → consent →
 * admins → when and where → the org is live with the right language, one
 * Activity, the first Match generated → the first real "in" / "varım"
 * registers through the normal attendance pipeline. Then the session
 * lifecycle a live group depends on: a live org always wins over a
 * leftover session, a stale session expires, a tagged "stop" ends one,
 * and the Pi's restart list carries every active stage.
 *
 * The LLM is stubbed (ANTHROPIC_API_KEY is inert in the e2e env), so
 * every onboarding turn exercises the deterministic parsers. The one
 * attendance message at the end of each flow arms the router and
 * extractor seams the way `e2e/sim/group.ts` does; the Turkish one uses
 * the router FLOOR (PR #90) so no route is hand-mapped for "varım".
 */
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
import { clearPipelineStubs, selfIn, setExtractorStub, setRouterStub } from "../helpers/stub";
import type { APIRequestContext } from "@playwright/test";
import type { TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  resetDb();
  clearPipelineStubs();
});

const HEADERS = { "x-api-key": E2E.WHATSAPP_API_KEY };
const RUN = Date.now().toString(36);
let n = 0;
const msgId = () => `sim-setup-${RUN}-${++n}`;

async function botAdded(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post("/api/whatsapp/bot-added", { headers: HEADERS, data });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

interface Said {
  reply: string | null;
  json: {
    results?: Array<{ reply: string | null; intent: string | null; react: string | null }>;
    onboarding?: { stage: string; completed: boolean; language: string };
    ignored?: string;
    orgId?: string;
  };
}

async function say(
  request: APIRequestContext,
  groupId: string,
  body: string,
  author: { phone: string; name: string | null },
  opts: { tag?: boolean; id?: string } = {},
): Promise<Said> {
  const res = await request.post("/api/whatsapp/analyze", {
    headers: HEADERS,
    data: {
      groupId,
      messages: [
        {
          waMessageId: opts.id ?? msgId(),
          body,
          authorPhone: author.phone,
          authorName: author.name,
          timestamp: new Date().toISOString(),
          ...(opts.tag ? { botMentioned: true } : {}),
        },
      ],
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  const json = (await res.json()) as Said["json"];
  return { json, reply: json.results?.[0]?.reply ?? null };
}

const session = (db: TestDb, groupId: string) =>
  db.one<{
    id: string;
    stage: string;
    language: string;
    groupName: string | null;
    adminUserId: string | null;
    orgId: string | null;
    createdAt: Date;
  }>(`SELECT * FROM "OnboardingSession" WHERE "whatsappGroupId" = $1 ORDER BY "createdAt" DESC`, [
    groupId,
  ]);

const org = (db: TestDb, groupId: string) =>
  db.one<{ id: string; name: string; language: string; whatsappBotEnabled: boolean }>(
    `SELECT id, name, language, "whatsappBotEnabled" FROM "Organisation" WHERE "whatsappGroupId" = $1`,
    [groupId],
  );

// ══════════════════════════ the English flow ═══════════════════════════

const EN_GROUP = `sim-setup-en-${RUN}@g.us`;
const ADAM = { phone: "447700900310", name: "Adam Admin" };
const BEN = { phone: "447700900311", name: "Ben Player" };

test("EN 1: added to an English group, the intro is short and in English", async ({ request, db }) => {
  const res = await botAdded(request, {
    groupId: EN_GROUP,
    groupSubject: "Tuesday Ballers FC",
    addedByPhone: ADAM.phone,
    participants: [
      { phone: ADAM.phone, pushname: ADAM.name },
      { phone: BEN.phone, pushname: BEN.name },
    ],
    enrichmentHistory: [
      { author: "Ben Player", authorPhone: BEN.phone, text: "who's in for tuesday lads", timestamp: new Date().toISOString() },
      { author: "Adam Admin", authorPhone: ADAM.phone, text: "im in, 9pm at goals as usual", timestamp: new Date().toISOString() },
    ],
  });
  expect(res.language).toBe("en");
  expect(res.introText).toContain("*YES*");
  expect(res.introText.length).toBeLessThan(400);
  expect(res.introText).not.toContain("Payment tracking"); // no pitch
  const s = await session(db, EN_GROUP);
  expect(s?.stage).toBe("introduced");
  expect(s?.language).toBe("en");
});

test("EN 2: the Pi's restart list carries the group while it is introduced", async ({ request }) => {
  const res = await request.get("/api/whatsapp/orgs", { headers: HEADERS });
  const json = (await res.json()) as { onboardingGroups: string[] };
  expect(json.onboardingGroups).toContain(EN_GROUP);
});

test("EN 3: YES → the admins question; the analyze response tells the Pi the stage", async ({ request, db }) => {
  const r = await say(request, EN_GROUP, "YES", ADAM);
  expect(r.reply).toContain("Who else helps run this group?");
  expect(r.json.onboarding).toEqual({ stage: "admins", completed: false, language: "en" });
  expect((await session(db, EN_GROUP))?.stage).toBe("admins");
});

test("EN 4: the restart list still carries the group at the admins stage (the stage the old list omitted)", async ({ request }) => {
  const res = await request.get("/api/whatsapp/orgs", { headers: HEADERS });
  const json = (await res.json()) as { onboardingGroups: string[] };
  expect(json.onboardingGroups).toContain(EN_GROUP);
});

test("EN 5: just me → the when-and-where question", async ({ request, db }) => {
  const r = await say(request, EN_GROUP, "just me", ADAM);
  expect(r.reply).toContain("when and where do you play?");
  expect((await session(db, EN_GROUP))?.stage).toBe("details");
});

test("EN 6: the combined answer → live org, Activity, first Match, completed=true for the Pi", async ({ request, db }) => {
  const r = await say(request, EN_GROUP, "Tuesdays 9pm at Goals Wembley", ADAM);
  expect(r.reply).toContain("All set");
  expect(r.reply).toContain("How to use me");
  expect(r.json.onboarding?.completed).toBe(true);
  expect(r.json.onboarding?.stage).toBe("completed");

  const o = await org(db, EN_GROUP);
  expect(o?.whatsappBotEnabled).toBe(true);
  expect(o?.language).toBe("en");
  expect(o?.name).toBe("Tuesday Ballers FC");

  const activity = await db.one<{ id: string; dayOfWeek: number; time: string; venue: string }>(
    `SELECT * FROM "Activity" WHERE "orgId" = $1`,
    [o!.id],
  );
  expect(activity).toMatchObject({ dayOfWeek: 2, time: "21:00", venue: "Goals Wembley" });
  const match = await db.one<{ status: string; maxPlayers: number }>(
    `SELECT status, "maxPlayers" FROM "Match" WHERE "activityId" = $1`,
    [activity!.id],
  );
  expect(match).toMatchObject({ status: "UPCOMING", maxPlayers: 14 });

  // The completion post IS the group's intro: the scheduler's own
  // English intro is marked sent so it never posts a second one.
  const intro = await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key = $1`, [
    `org-${o!.id}:bot-intro`,
  ]);
  expect(intro).toBe(1);

  // The restart list no longer lists the group as onboarding: it is an org.
  const res = await request.get("/api/whatsapp/orgs", { headers: HEADERS });
  const json = (await res.json()) as { orgs: Array<{ whatsappGroupId: string }>; onboardingGroups: string[] };
  expect(json.onboardingGroups).not.toContain(EN_GROUP);
  expect(json.orgs.map((x) => x.whatsappGroupId)).toContain(EN_GROUP);
});

test("EN 7: the first real 'in' registers through the normal pipeline", async ({ request, db }) => {
  const id = msgId();
  setRouterStub({ floor: false, routes: { [id]: "self_att" } });
  setExtractorStub({ bodies: { in: selfIn() } });
  const r = await say(request, EN_GROUP, "in", BEN, { id });
  expect(r.json.onboarding).toBeUndefined(); // the normal analyzer, not onboarding
  expect(r.json.results?.[0]?.react).toBe("✅");
  const o = await org(db, EN_GROUP);
  const confirmed = await db.count(
    `SELECT COUNT(*) FROM "Attendance" a JOIN "Match" m ON m.id = a."matchId"
     JOIN "Activity" ac ON ac.id = m."activityId" JOIN "User" u ON u.id = a."userId"
     WHERE ac."orgId" = $1 AND a.status = 'CONFIRMED' AND u."phoneNumber" = $2`,
    [o!.id, `+${BEN.phone}`],
  );
  expect(confirmed).toBe(1);
  clearPipelineStubs();
});

// ══════════════════════════ the Turkish flow ═══════════════════════════

const TR_GROUP = `sim-setup-tr-${RUN}@g.us`;
const ERDAL = { phone: "447700900320", name: "Erdal" };
const ILKAY = { phone: "447700900321", name: "İlkay" };

test("TR 1: added to a Turkish group, the intro is short and in Turkish", async ({ request, db }) => {
  const res = await botAdded(request, {
    groupId: TR_GROUP,
    groupSubject: "Cuma Halı Saha ⚽",
    addedByPhone: ERDAL.phone,
    participants: [
      { phone: ERDAL.phone, pushname: ERDAL.name },
      { phone: ILKAY.phone, pushname: ILKAY.name },
    ],
    enrichmentHistory: [
      { author: "İlkay", authorPhone: ILKAY.phone, text: "cuma kaç kişiyiz", timestamp: new Date().toISOString() },
      { author: "Erdal", authorPhone: ERDAL.phone, text: "ben varım, saat 21:30 sim arena", timestamp: new Date().toISOString() },
    ],
  });
  expect(res.language).toBe("tr");
  expect(res.introText).toContain("*EVET*");
  expect(res.introText).toContain("MatchTime");
  expect(res.introText).not.toMatch(/[—–]/);
  expect(res.introText.length).toBeLessThan(400);
  expect((await session(db, TR_GROUP))?.language).toBe("tr");
});

test("TR 2: ordinary Turkish chat after the intro is ignored (falls open)", async ({ request, db }) => {
  const r = await say(request, TR_GROUP, "abi dün maç efsaneydi", ILKAY);
  expect(r.reply).toBeNull();
  expect((await session(db, TR_GROUP))?.stage).toBe("introduced");
});

test("TR 3: evet → the admins question in Turkish, the replier is the admin", async ({ request, db }) => {
  const r = await say(request, TR_GROUP, "evet", ERDAL);
  expect(r.reply).toContain("yönetici sensin");
  expect(r.reply).toContain("sadece ben");
  expect(r.json.onboarding).toEqual({ stage: "admins", completed: false, language: "tr" });
  const s = await session(db, TR_GROUP);
  expect(s?.adminUserId).not.toBeNull();
});

test("TR 4: sadece ben → the when-and-where question in Turkish", async ({ request, db }) => {
  const r = await say(request, TR_GROUP, "sadece ben", ERDAL);
  expect(r.reply).toContain("ne zaman ve nerede oynuyorsunuz?");
  expect((await session(db, TR_GROUP))?.stage).toBe("details");
});

test("TR 5: 'Cuma 21:30, Sim Arena, 7'ye 7' → live Turkish org, Friday 21:30, 14 slots", async ({ request, db }) => {
  const r = await say(request, TR_GROUP, "Cuma 21:30, Sim Arena, 7'ye 7", ERDAL);
  expect(r.reply).toContain("Hazırız");
  expect(r.reply).toContain("Cuma 21:30");
  expect(r.reply).toContain("Sim Arena");
  expect(r.reply).toContain("Beni nasıl kullanırsınız");
  expect(r.reply).not.toMatch(/[—–]/);
  expect(r.json.onboarding?.completed).toBe(true);

  const o = await org(db, TR_GROUP);
  expect(o?.whatsappBotEnabled).toBe(true);
  expect(o?.language).toBe("tr");
  expect(o?.name).toBe("Cuma Halı Saha ⚽");

  const activity = await db.one<{ id: string; dayOfWeek: number; time: string; venue: string; isActive: boolean }>(
    `SELECT * FROM "Activity" WHERE "orgId" = $1`,
    [o!.id],
  );
  expect(activity).toMatchObject({ dayOfWeek: 5, time: "21:30", venue: "Sim Arena", isActive: true });
  const match = await db.one<{ status: string; maxPlayers: number }>(
    `SELECT status, "maxPlayers" FROM "Match" WHERE "activityId" = $1`,
    [activity!.id],
  );
  expect(match).toMatchObject({ status: "UPCOMING", maxPlayers: 14 });

  // Owner membership for Erdal, roster import for İlkay.
  const owner = await db.one<{ role: string }>(
    `SELECT m.role FROM "Membership" m JOIN "User" u ON u.id = m."userId" WHERE m."orgId" = $1 AND u."phoneNumber" = $2`,
    [o!.id, `+${ERDAL.phone}`],
  );
  expect(owner?.role).toBe("OWNER");
  const members = await db.count(`SELECT COUNT(*) FROM "Membership" WHERE "orgId" = $1 AND "leftAt" IS NULL`, [o!.id]);
  expect(members).toBe(2);

  // The admin's magic-link DM is in Turkish.
  const dm = await db.one<{ text: string }>(`SELECT text FROM "BotJob" WHERE "orgId" = $1 AND kind = 'dm'`, [o!.id]);
  expect(dm?.text).toContain("yöneticisi sensin");
  expect(dm?.text).toMatch(/https?:\/\//);
});

test("TR 6: the first real 'varım' registers via the router floor, no route hand-mapped", async ({ request, db }) => {
  setRouterStub({ floor: true, routes: {} });
  setExtractorStub({ bodies: { varım: selfIn() } });
  const r = await say(request, TR_GROUP, "varım", ILKAY);
  expect(r.json.onboarding).toBeUndefined();
  expect(r.json.results?.[0]?.react).toBe("✅");
  const o = await org(db, TR_GROUP);
  const confirmed = await db.count(
    `SELECT COUNT(*) FROM "Attendance" a JOIN "Match" m ON m.id = a."matchId"
     JOIN "Activity" ac ON ac.id = m."activityId" JOIN "User" u ON u.id = a."userId"
     WHERE ac."orgId" = $1 AND a.status = 'CONFIRMED' AND u."phoneNumber" = $2`,
    [o!.id, `+${ILKAY.phone}`],
  );
  expect(confirmed).toBe(1);
  clearPipelineStubs();
});

test("TR 7: '@Match Time yardım' answers in Turkish once the org is live", async ({ request }) => {
  const r = await say(request, TR_GROUP, "@Match Time yardım", ILKAY, { tag: true });
  expect(r.json.results?.[0]?.intent).toBe("help");
  expect(r.reply).toContain("MatchTime yardım");
  expect(r.reply).toContain("@Match Time yardım takımlar");
  expect(r.reply).not.toMatch(/[—–]/);
});

// ══════════════════ the consent reply corrects the language ════════════

test("a group the detector could not read is English until someone answers 'evet'", async ({ request, db }) => {
  const g = `sim-setup-flip-${RUN}@g.us`;
  const res = await botAdded(request, { groupId: g, groupSubject: "Galaxy FC", addedByPhone: "447700900330" });
  expect(res.language).toBe("en");
  expect(res.languageConfident).toBe(false);
  const r = await say(request, g, "evet", { phone: "447700900330", name: "Mehmet" });
  expect(r.reply).toContain("yönetici sensin");
  expect((await session(db, g))?.language).toBe("tr");
  // and 'yes' in the other direction
  const g2 = `sim-setup-flip2-${RUN}@g.us`;
  const res2 = await botAdded(request, {
    groupId: g2,
    groupSubject: "Salı Maçı",
    addedByPhone: "447700900331",
  });
  expect(res2.language).toBe("tr");
  const r2 = await say(request, g2, "yes", { phone: "447700900331", name: "Tom" });
  expect(r2.reply).toContain("Who else helps run this group?");
  expect((await session(db, g2))?.language).toBe("en");
});

// ══════════════════════ session lifecycle (defect 5) ═══════════════════

test("a live org always wins: a leftover session cannot hijack a group set up another way", async ({ request, db }) => {
  const g = `sim-setup-live-${RUN}@g.us`;
  await botAdded(request, { groupId: g, groupSubject: "Leftover FC", addedByPhone: "447700900340" });
  expect((await session(db, g))?.stage).toBe("introduced");

  // The manual route (enable-*.ts) creates a bot-enabled org for the same group.
  await db.run(
    `INSERT INTO "Organisation" (id, name, slug, "inviteCode", "whatsappGroupId", "whatsappBotEnabled", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, true, now())`,
    [`org-live-${RUN}`, "Leftover FC (manual)", `leftover-${RUN}`, `inv-${RUN}`, g],
  );

  // "YES" would have advanced the session; it must not: the org owns the group.
  const r = await say(request, g, "YES", { phone: "447700900340", name: "Ola" });
  expect(r.json.onboarding).toBeUndefined();
  expect(r.reply).toBeNull();
  expect((await session(db, g))?.stage).toBe("abandoned");

  // A re-add is ignored for the same reason.
  const again = await botAdded(request, { groupId: g, groupSubject: "Leftover FC" });
  expect(again.ignored).toBe("live-org");
});

test("a stale session expires: it stops owning the group and the next add starts fresh", async ({ request, db }) => {
  const g = `sim-setup-stale-${RUN}@g.us`;
  await botAdded(request, { groupId: g, groupSubject: "Stale FC", addedByPhone: "447700900350" });
  await db.run(
    `UPDATE "OnboardingSession" SET "createdAt" = now() - interval '15 days' WHERE "whatsappGroupId" = $1`,
    [g],
  );

  // Not in the Pi's restart list any more.
  const list = (await (await request.get("/api/whatsapp/orgs", { headers: HEADERS })).json()) as { onboardingGroups: string[] };
  expect(list.onboardingGroups).not.toContain(g);

  // A "YES" two weeks later does nothing and the session is abandoned.
  const r = await say(request, g, "YES", { phone: "447700900350", name: "Sam" });
  expect(r.reply).toBeNull();
  expect(r.json.onboarding).toBeUndefined();
  expect((await session(db, g))?.stage).toBe("abandoned");

  // Adding the bot again starts a fresh session with a fresh intro.
  const res = await botAdded(request, { groupId: g, groupSubject: "Stale FC", addedByPhone: "447700900350" });
  expect(res.existing).toBeUndefined();
  expect(res.introText).toContain("*YES*");
  const count = await db.count(`SELECT COUNT(*) FROM "OnboardingSession" WHERE "whatsappGroupId" = $1`, [g]);
  expect(count).toBe(2);
  expect((await session(db, g))?.stage).toBe("introduced");
});

test("a tagged '@Match Time stop' ends the session with one short reply, in the session's language", async ({ request, db }) => {
  const g = `sim-setup-cancel-${RUN}@g.us`;
  await botAdded(request, { groupId: g, groupSubject: "Cuma Maçı", addedByPhone: "447700900360" });
  await say(request, g, "evet", { phone: "447700900360", name: "Ali" });
  const r = await say(request, g, "@Match Time iptal", { phone: "447700900360", name: "Ali" }, { tag: true });
  expect(r.reply).toContain("kurulumu durdurdum");
  expect(r.json.onboarding).toEqual({ stage: "abandoned", completed: false, language: "tr" });
  expect((await session(db, g))?.stage).toBe("abandoned");
  // Silent afterwards.
  const r2 = await say(request, g, "sadece ben", { phone: "447700900360", name: "Ali" });
  expect(r2.reply).toBeNull();
  expect(r2.json.ignored).toBe("unknown-or-disabled-group");
});
