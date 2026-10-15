/**
 * "GETTING <CLUB> READY" AT GO (2026-10-15), against a real Postgres and
 * the real dm-reply and due-posts routes (admin-onboarding-rules.ts).
 *
 * An FNF-like club (organisers announce and pick, admin group linked and
 * routed there, a game in a few days) says GO: the admins get the
 * checklist ONCE, as an admin-group BotJob that the next poll posts in the
 * admin group; a second GO adds nothing. A club whose manager already told
 * it by hand (scripts/mark-admin-onboarding-sent.ts's claim) gets nothing.
 * The players' hello says the organisers share the list and teams.
 *
 * Deterministic end to end: no model is called by anything here.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";

test.describe.configure({ mode: "serial" });

const HEADERS = { "x-api-key": E2E.WHATSAPP_API_KEY };
let n = 0;
const msgId = () => `e2e-ao-${Date.now()}-${++n}`;
const bare = (phone: string) => phone.replace(/^\+/, "");
const utc = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const FERN = {
  id: "e2e-ao-fern",
  name: "Fern FC",
  group: "120363900000000301@g.us",
  adminGroup: "120363900000000302@g.us",
  subject: "Fern Friday 9s",
  ownerId: "e2e-ao-faye",
  ownerPhone: "+447700902101",
};
const MARKED = {
  id: "e2e-ao-mark",
  name: "Marked FC",
  group: "120363900000000303@g.us",
  adminGroup: "120363900000000304@g.us",
  subject: "Marked 9s",
  ownerId: "e2e-ao-mo",
  ownerPhone: "+447700902102",
};
const KICKOFF = new Date(Date.now() + 3 * 24 * 3600_000);
const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "Europe/London" }).format(KICKOFF);

async function dm(request: APIRequestContext, phone: string, body: string) {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: HEADERS,
    data: { phone: bare(phone), body, waMessageId: msgId(), authorName: null },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

/** A club approved and setting up, FNF-like, with its admin group linked. */
async function fnfLikeClub(db: TestDb, c: typeof FERN) {
  await db.run(
    `INSERT INTO "User" (id, name, email, "phoneNumber", onboarded, "isActive", "updatedAt") VALUES ($1,$2,$3,$4,true,true,now())`,
    [c.ownerId, "Faye Organiser", `${c.ownerId}@e2e-test.invalid`, c.ownerPhone],
  );
  await db.run(
    `INSERT INTO "Organisation" ("id","name","slug","inviteCode","approvalStatus","approvedAt","whatsappGroupId",
       "whatsappBotEnabled","setupStage","language","adminGroupId","adminChannelMode","listAnnouncer","benchPickMode",
       "rollingSquadEnabled","createdAt","updatedAt")
     VALUES ($1,$2,$1,$3,'approved',$5::timestamp,$4,false,'setting-up','en',$6,'admin-group','organisers','organiser',true,now(),now())`,
    [c.id, c.name, `${c.id}-invite`, c.group, utc(-3 * 3600_000), c.adminGroup],
  );
  await db.run(`INSERT INTO "Membership" (id, "userId", "orgId", role) VALUES ($1,$2,$3,'OWNER')`, [`${c.ownerId}-m`, c.ownerId, c.id]);
  await db.run(
    `INSERT INTO "ClubConnect" ("id","orgId","userId","phone","code","status","expiresAt","groupId","groupSubject","linkedAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,'closed',now() + interval '1 hour',$6,$7,now() - interval '4 hours',now())`,
    [`${c.id}-cc`, c.id, c.ownerId, bare(c.ownerPhone), c.id.slice(-4).toUpperCase(), c.group, c.subject],
  );
  await db.run(
    `INSERT INTO "Sport" ("id","orgId","name","playersPerTeam","positions","teamLabels","createdAt","updatedAt")
     VALUES ($1,$2,'Football 9-a-side',9,ARRAY['GK','DEF','MID','FWD'],ARRAY['Red','Yellow'],now(),now())`,
    [`${c.id}-sport`, c.id],
  );
  await db.run(
    `INSERT INTO "Activity" ("id","orgId","sportId","name","dayOfWeek","time","venue","isActive","deadlineHours","createdAt","updatedAt")
     VALUES ($1,$2,$3,'Weekly game',5,'21:00','Powerleague',true,5,now(),now())`,
    [`${c.id}-activity`, c.id, `${c.id}-sport`],
  );
  await db.run(
    `INSERT INTO "Match" (id,"activityId",date,"maxPlayers",status,"attendanceDeadline","updatedAt")
     VALUES ($1,$2,$3::timestamp,18,'UPCOMING',$3::timestamp,now())`,
    [`${c.id}-next`, `${c.id}-activity`, KICKOFF.toISOString()],
  );
}

const jobs = (db: TestDb, orgId: string) =>
  db.all<{ id: string; kind: string; text: string; sendAfter: Date | null }>(
    `SELECT id, kind, text, "sendAfter" FROM "BotJob" WHERE "orgId" = $1 ORDER BY "createdAt" ASC, id ASC`,
    [orgId],
  );

test.beforeAll(async () => {
  await resetDb();
  const db = testDb();
  await fnfLikeClub(db, FERN);
  await fnfLikeClub(db, MARKED);
  // The manager told Marked FC by hand: the mark script's claims.
  await db.run(
    `INSERT INTO "SentNotification" (id, key, kind) VALUES ('e2e-ao-c1', $1, 'admin-onboarding'), ('e2e-ao-c2', $2, 'admin-onboarding')`,
    [`org-${MARKED.id}:getting-ready`, `org-${MARKED.id}:first-teams`],
  );
});
test.afterAll(() => resetDb());

test("GO: the admins get 'Getting <club> ready' once, in the admin group, and the hello says the organisers share the list and teams", async ({ request, db }) => {
  expect(await dm(request, FERN.ownerPhone, "GO")).toMatchObject({ handled: "setup-go", outcome: "went-live", orgId: FERN.id });

  const all = await jobs(db, FERN.id);
  const hello = all.filter((j) => j.kind === "group");
  const ready = all.filter((j) => j.kind === "admin-group");
  expect(hello).toHaveLength(1);
  expect(hello[0].text).toContain("📣 *List and teams:* the organisers share the squad list and the teams with you.");
  expect(hello[0].text).not.toContain("Fair teams");
  expect(hello[0].text).not.toContain("I'll put you on the bench and the organisers pick who plays");

  expect(ready).toHaveLength(1);
  expect(ready[0].text).toBe(
    [
      "🧰 *Getting Fern FC ready*",
      `📋 Paste the squad list for ${WEEKDAY}'s game here now. I'll show you what it changes, and *YES* within 30 minutes applies it.`,
      "💬 No need to tag me here. I read every message from an admin in this group, so just type the command. Your normal chat is fine too, I only act on clear instructions. In the main chat, players say IN or OUT without tagging me, and tag me only to ask me something.",
      "Type *help* here any time to see what I take.",
    ].join("\n\n"),
  );
  expect(await db.count(`SELECT COUNT(*) FROM "SentNotification" WHERE key = $1`, [`org-${FERN.id}:getting-ready`])).toBe(1);

  // GO again: already live, nothing more for the admins.
  await dm(request, FERN.ownerPhone, "GO");
  expect((await jobs(db, FERN.id)).filter((j) => j.kind === "admin-group")).toHaveLength(1);
});

test("the next poll posts it in the admin group, inside the posting hours", async ({ request, db }) => {
  const ready = (await jobs(db, FERN.id)).find((j) => j.kind === "admin-group")!;
  // Tomorrow 12:00 UTC: inside 09:00 to 22:59 London, after any overnight hold.
  const at = new Date(Date.now() + 24 * 3600_000);
  at.setUTCHours(12, 0, 0, 0);
  const res = await request.get(`/api/whatsapp/due-posts?groupId=${encodeURIComponent(FERN.group)}`, {
    headers: { ...HEADERS, "x-no-claim": "1", "x-test-now": at.toISOString(), "x-mt-pi-caps": "admin-group" },
  });
  expect(res.status(), await res.text()).toBe(200);
  const instructions = ((await res.json()).instructions ?? []) as Array<{ kind: string; key: string; groupId?: string; text?: string }>;
  expect(instructions.find((i) => i.key === `botjob-${ready.id}`)).toMatchObject({
    kind: "admin-group-message",
    groupId: FERN.adminGroup,
    text: ready.text,
  });
});

test("a club the manager already told by hand (the mark script's claims) gets nothing at GO", async ({ request, db }) => {
  expect(await dm(request, MARKED.ownerPhone, "GO")).toMatchObject({ handled: "setup-go", outcome: "went-live", orgId: MARKED.id });
  const all = await jobs(db, MARKED.id);
  expect(all.filter((j) => j.kind === "group")).toHaveLength(1);
  expect(all.filter((j) => j.kind === "admin-group")).toEqual([]);
});
