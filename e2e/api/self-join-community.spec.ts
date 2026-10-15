/**
 * THE FNF INCIDENT (prod, 2026-10-15 18:31 UTC), replayed against a real
 * Postgres and the real routes.
 *
 * The organiser's main chat ("Friday Night Football 🏟", 49 members) sits
 * inside a WhatsApp COMMUNITY. WhatsApp refused a direct add, so he sent
 * MatchTime an invite and MatchTime joined. Joining put it into the
 * community's PARENT group ("FNF ⚽️", 8 members, the join authored by
 * MatchTime's OWN number) and the community's ANNOUNCEMENTS group too, and
 * the Pi posted three bot-added calls. The parent group's reached the
 * server first and linked the request as "other-organiser-present" (the
 * organiser is in its roster); the main chat then lost. The owner was asked
 * to approve "FNF ⚽️", 8 members.
 *
 * The bodies below are what the Pi of that day sent (no community facts,
 * MatchTime's own number as the parent group's adder), then what the fixed
 * Pi sends. Either way the request must end up on the main chat, and the
 * owner's last word about the club must name it.
 *
 * Deterministic end to end: nothing here calls a model.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect, resetDb } from "../fixtures";
import { E2E, E2E_DB_URL, REPO_ROOT } from "../helpers/env";
import { testDb, type TestDb } from "../helpers/test-db";
import type { APIRequestContext } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const KEY = { "x-api-key": E2E.WHATSAPP_API_KEY };
const ON = { ...KEY, "x-mt-test-self-join": "1" };

/** MatchTime's own account, as the parent group's join event named it. */
const MATCHTIME_PHONE = "447700900959";
const MATCHTIME_LID = "158055467598020";

const others = (n: number, base: number) =>
  Array.from({ length: n }, (_, i) => ({ phone: `4477009${String(base + i).padStart(5, "0")}`, pushname: `P${i}` }));
const organiser = (w: World) => ({ phone: w.phone, lidId: `${w.lid}@lid`, pushname: "Organiser" });

/** One club per scenario, so each starts from a fresh, DM-verified request. */
interface World {
  org: string;
  cc: string;
  code: string;
  main: string;
  parent: string;
  announce: string;
  /** The organiser's verified phone and connect-DM LID (one organiser per club). */
  phone: string;
  lid: string;
}
const world = (n: number, code: string): World => ({
  org: `e2e-cmty-${n}`,
  cc: `e2e-cmty-cc-${n}`,
  code,
  main: `4477009${String(n).padStart(5, "0")}-1596025435@g.us`,
  parent: `12036370000${n}000101@g.us`,
  announce: `12036370000${n}000102@g.us`,
  phone: `44770090097${n}`,
  lid: `15634546661799${n}`,
});

async function seed(db: TestDb, w: World) {
  await db.run(
    `INSERT INTO "Organisation" (id,name,slug,"inviteCode","approvalStatus",language,"createdAt","updatedAt")
     VALUES ($1,'FNF',$1,$2,'draft','en',now(),now())`,
    [w.org, `${w.org}-invite`],
  );
  const user = `${w.org}-owner`;
  await db.run(
    `INSERT INTO "User" (id,name,email,"phoneNumber",onboarded,"isActive","updatedAt")
     VALUES ($1,'Organiser',$2,$3,true,true,now())`,
    [user, `${user}@e2e-test.invalid`, `+${w.phone}`],
  );
  await db.run(`INSERT INTO "Membership" (id,"userId","orgId",role) VALUES ($1,$2,$3,'OWNER')`, [`${user}-mem`, user, w.org]);
  // The columns are UTC without a zone, as the server writes them: `now()`
  // alone would store this machine's local wall time.
  await db.run(
    `INSERT INTO "ClubConnect" (id,"orgId","userId",phone,code,status,"issuedAt","expiresAt","dmAt","dmPhone","dmLid","dmPhoneMatched","addWindowEndsAt","updatedAt") VALUES
       ($1,$2,$3,$4,$5,'dm_verified',(now() at time zone 'utc') - interval '10 minutes',(now() at time zone 'utc') + interval '50 minutes',
        (now() at time zone 'utc') - interval '5 minutes',$4,$6,true,(now() at time zone 'utc') + interval '23 hours',now())`,
    [w.cc, w.org, user, w.phone, w.code, w.lid],
  );
}

/** What the Pi posted on 2026-10-15, per group. */
const OLD_BOT = {
  parent: (w: World) => ({
    groupId: w.parent,
    groupSubject: "FNF ⚽️",
    addedByPhone: MATCHTIME_PHONE,
    addedByLid: MATCHTIME_LID,
    participants: [organiser(w), ...others(7, 100)],
  }),
  main: (w: World) => ({
    groupId: w.main,
    groupSubject: "Friday Night Football 🏟",
    addedByPhone: w.phone,
    addedByLid: w.lid,
    participants: [organiser(w), ...others(48, 200)],
    postability: { announce: false, communityAnnounce: false, botIsAdmin: false },
  }),
  announce: (w: World) => ({
    groupId: w.announce,
    groupSubject: "FNF ⚽️",
    participants: [organiser(w), ...others(48, 200)],
    postability: { announce: true, communityAnnounce: true, botIsAdmin: false },
  }),
};

/** What the fixed Pi posts: the community facts, and no adder when the
 *  join was authored by MatchTime itself. */
const NEW_BOT = {
  parent: (w: World) => {
    const { addedByPhone: _p, addedByLid: _l, ...rest } = OLD_BOT.parent(w);
    return { ...rest, community: { isCommunity: true, isCommunityAnnounce: false, linkedParent: null } };
  },
  main: (w: World) => ({
    ...OLD_BOT.main(w),
    community: { isCommunity: false, isCommunityAnnounce: false, linkedParent: w.parent },
  }),
  announce: (w: World) => ({
    ...OLD_BOT.announce(w),
    community: { isCommunity: false, isCommunityAnnounce: true, linkedParent: w.parent },
  }),
};

async function botAdded(request: APIRequestContext, data: Record<string, unknown>) {
  const res = await request.post("/api/whatsapp/bot-added", { headers: ON, data });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

const connect = (db: TestDb, w: World) =>
  db.one<{
    status: string;
    groupId: string | null;
    groupSubject: string | null;
    memberCount: number | null;
    adderMatch: string | null;
    addedByPhone: string | null;
    capturedHistory: Array<{ text: string }> | null;
  }>(`SELECT status,"groupId","groupSubject","memberCount","adderMatch","addedByPhone","capturedHistory" FROM "ClubConnect" WHERE id = $1`, [
    w.cc,
  ]);

const clubStatus = async (db: TestDb, w: World) =>
  (await db.one<{ approvalStatus: string }>(`SELECT "approvalStatus" FROM "Organisation" WHERE id = $1`, [w.org]))
    ?.approvalStatus;

/** Every owner DM about this club, oldest first. */
const ownerDms = (db: TestDb, w: World) =>
  db.all<{ text: string; refId: string }>(
    `SELECT text, "refId" FROM "PlatformJob" WHERE phone = $1 AND kind = 'dm' AND "refId" LIKE $2 ORDER BY "createdAt", id`,
    [E2E.APPROVER_PHONE, `${w.cc}%`],
  );
const organiserAcks = (db: TestDb, w: World) =>
  db.all<{ refId: string }>(`SELECT "refId" FROM "PlatformJob" WHERE phone = $1 AND "refId" = $2`, [
    w.phone,
    `${w.cc}:in-group`,
  ]);
const traces = (db: TestDb, groupId: string) =>
  db.count(
    `SELECT (SELECT COUNT(*) FROM "UnsolicitedGroup" WHERE "groupId" = $1)
          + (SELECT COUNT(*) FROM "PlatformJob" WHERE "groupId" = $1)
          + (SELECT COUNT(*) FROM "ClubConnect" WHERE "groupId" = $1) AS count`,
    [groupId],
  );

/** The request is on the main chat, the club waits, and the owner's LAST
 *  word about it names the main chat, with the code to answer. */
async function expectLinkedToMainChat(db: TestDb, w: World) {
  expect(await connect(db, w)).toMatchObject({
    status: "group_linked",
    groupId: w.main,
    groupSubject: "Friday Night Football 🏟",
    memberCount: 49,
    adderMatch: "phone",
    addedByPhone: w.phone,
  });
  expect(await clubStatus(db, w)).toBe("pending");
  const owner = await ownerDms(db, w);
  expect(owner.length).toBeGreaterThan(0);
  const last = owner[owner.length - 1].text;
  expect(last).toContain(`"Friday Night Football 🏟", 49 members`);
  expect(last).toContain(`Reply APPROVE ${w.code} or REJECT ${w.code}`);
  expect(last).toContain("the organiser (matched by phone)");
  expect(await organiserAcks(db, w)).toHaveLength(1);
  // The announcements group: never linked, never left, nobody told.
  expect(await traces(db, w.announce)).toBe(0);
}

const W1 = world(1, "UYS5");
const W2 = world(2, "UYS6");
const W3 = world(3, "UYS7");
const W4 = world(4, "UYS8");
const W5 = world(5, "UYS9");

test.beforeAll(async () => {
  resetDb();
  const db = testDb();
  for (const w of [W1, W2, W3, W4, W5]) await seed(db, w);
});

const execFileAsync = promisify(execFile);
/** scripts/relink-self-join.ts against the embedded test DB. */
async function relinkScript(extra: string[], w: World, adderPhone: string = w.phone) {
  const argv = [
    "tsx",
    "scripts/relink-self-join.ts",
    "--connect",
    w.cc,
    "--group",
    w.main,
    "--subject",
    "Friday Night Football 🏟",
    "--members",
    "49",
    "--adder-phone",
    adderPhone,
    ...extra,
  ];
  return execFileAsync("npx", argv, {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: E2E_DB_URL, SELF_JOIN_APPROVER_PHONES: E2E.APPROVER_PHONE },
    timeout: 120_000,
  }).catch((err: Error & { stdout?: string; stderr?: string; code?: number }) => ({
    stdout: err.stdout ?? "",
    stderr: err.stderr ?? "",
    code: err.code,
  }));
}

test.afterAll(() => {
  resetDb();
});

test("THE REAL SEQUENCE, as the Pi sent it that day: the parent group first, then the main chat, then the announcements group", async ({
  request,
  db,
}) => {
  await botAdded(request, OLD_BOT.parent(W1));
  const main = await botAdded(request, OLD_BOT.main(W1));
  expect(main).toMatchObject({ selfJoin: "linked", silent: true, introText: null });
  const announce = await botAdded(request, OLD_BOT.announce(W1));
  expect(announce).toMatchObject({ selfJoin: "community-group", silent: true, introText: null });

  await expectLinkedToMainChat(db, W1);
  // The owner was asked about the parent group first: he now has the
  // correction, naming what it replaces.
  const owner = await ownerDms(db, W1);
  expect(owner.map((j) => j.refId)).toEqual([W1.cc, `${W1.cc}:relinked:${W1.main}`]);
  expect(owner[0].text).toContain(`"FNF ⚽️", 8 members`);
  expect(owner[1].text).toContain(`Correction: *FNF* (ref ${W1.code}) is now linked to "Friday Night Football 🏟", 49 members.`);
  expect(owner[1].text).toContain(`It replaces "FNF ⚽️", 8 members`);
  // The parent group is not linked any more, and is not left either.
  expect(await traces(db, W1.parent)).toBe(0);

  // Delivered again (the Pi retries): nothing new.
  expect(await botAdded(request, OLD_BOT.main(W1))).toMatchObject({ selfJoin: "already-linked" });
  expect(await ownerDms(db, W1)).toHaveLength(2);
  expect(await organiserAcks(db, W1)).toHaveLength(1);
});

test("the main chat's history bundle arrives AFTER the add: it lands on the request now linked to the main chat", async ({
  request,
  db,
}) => {
  const late = await botAdded(request, {
    groupId: W1.main,
    lateHistory: true,
    enrichmentHistory: [{ author: "P1", authorPhone: null, text: "who's in friday", timestamp: new Date().toISOString() }],
  });
  expect(late).toMatchObject({ ok: true, ignored: "late-history", introText: null });
  expect((await connect(db, W1))?.capturedHistory?.map((m) => m.text)).toEqual(["who's in friday"]);

  // A late bundle for a group no request is linked to writes nothing at all.
  const stray = await botAdded(request, {
    groupId: W1.parent,
    lateHistory: true,
    enrichmentHistory: [{ author: "P1", authorPhone: null, text: "x", timestamp: new Date().toISOString() }],
  });
  expect(stray).toMatchObject({ ok: true, ignored: "late-history" });
  expect(await traces(db, W1.parent)).toBe(0);
});

test("the owner approves: the club gets the main chat", async ({ request, db }) => {
  const res = await request.post("/api/whatsapp/dm-reply", {
    headers: ON,
    data: { phone: E2E.APPROVER_PHONE, body: `APPROVE ${W1.code}`, waMessageId: `e2e-cmty-approve-${Date.now()}` },
  });
  expect(res.status(), await res.text()).toBe(200);
  const org = await db.one<{ approvalStatus: string; whatsappGroupId: string | null }>(
    `SELECT "approvalStatus","whatsappGroupId" FROM "Organisation" WHERE id = $1`,
    [W1.org],
  );
  expect(org).toEqual({ approvalStatus: "approved", whatsappGroupId: W1.main });
});

test("the fixed Pi: the parent and announcements groups are refused outright, the main chat links, one owner DM", async ({
  request,
  db,
}) => {
  expect(await botAdded(request, NEW_BOT.parent(W2))).toMatchObject({
    selfJoin: "community-group",
    ignored: "community-group",
    silent: true,
    introText: null,
  });
  expect(await connect(db, W2)).toMatchObject({ status: "dm_verified", groupId: null });
  expect(await clubStatus(db, W2)).toBe("draft");

  expect(await botAdded(request, NEW_BOT.main(W2))).toMatchObject({ selfJoin: "linked" });
  expect(await botAdded(request, NEW_BOT.announce(W2))).toMatchObject({ selfJoin: "community-group" });

  await expectLinkedToMainChat(db, W2);
  expect((await ownerDms(db, W2)).map((j) => j.refId)).toEqual([W2.cc]);
  expect(await traces(db, W2.parent)).toBe(0);
});

test("the three posts at once, as they raced that day: whoever wins, the main chat ends up linked", async ({ request, db }) => {
  await Promise.all([
    botAdded(request, OLD_BOT.main(W3)),
    botAdded(request, OLD_BOT.parent(W3)),
    botAdded(request, OLD_BOT.announce(W3)),
  ]);
  await expectLinkedToMainChat(db, W3);
  expect(await traces(db, W3.parent)).toBeLessThanOrEqual(1); // an old Pi's parent post may be recorded unsolicited
});

test("an approved club is never moved: the organiser's later add of another group does not touch it", async ({ request, db }) => {
  await botAdded(request, OLD_BOT.parent(W4));
  await db.run(`UPDATE "Organisation" SET "approvalStatus" = 'approved', "approvedAt" = now() WHERE id = $1`, [W4.org]);
  await botAdded(request, OLD_BOT.main(W4));
  expect(await connect(db, W4)).toMatchObject({ status: "group_linked", groupId: W4.parent, adderMatch: "other-organiser-present" });
  expect((await ownerDms(db, W4)).map((j) => j.refId)).toEqual([W4.cc]);
});

test("scripts/relink-self-join.ts corrects a request left as FNF's was: dry run by default, refuses without evidence, --apply moves it", async ({
  request,
  db,
}) => {
  test.setTimeout(240_000);
  // FNF's state in prod: linked to the parent group on weak evidence; the
  // main chat's add lost the race and wrote nothing.
  await botAdded(request, OLD_BOT.parent(W5));
  expect(await connect(db, W5)).toMatchObject({ groupId: W5.parent, adderMatch: "other-organiser-present" });

  // Nothing shows MatchTime is in the main chat yet: refused.
  const refused = await relinkScript([], W5);
  expect(refused.stdout).toContain(`REFUSED: nothing shows MatchTime is in ${W5.main}`);
  expect(await connect(db, W5)).toMatchObject({ groupId: W5.parent });

  // The Pi reported its reading for the main chat (it does for every group it reads).
  const reading = await request.post("/api/whatsapp/group-postability", {
    headers: KEY,
    data: { groupId: W5.main, announce: false, communityAnnounce: false, botIsAdmin: false, canPost: true },
  });
  expect(reading.status(), await reading.text()).toBe(200);

  const dry = await relinkScript([], W5);
  console.log(`[relink dry run]\n${dry.stdout}`);
  expect(dry.stdout).toContain(`DRY RUN (pass --apply to write): club "FNF" (ref ${W5.code})`);
  expect(dry.stdout).toContain(`from: ${W5.parent} "FNF ⚽️", 8 member(s), adderMatch=other-organiser-present`);
  expect(dry.stdout).toContain(`to:   ${W5.main} "Friday Night Football 🏟", 49 member(s), adderMatch=phone`);
  expect(await connect(db, W5)).toMatchObject({ groupId: W5.parent });
  expect(await ownerDms(db, W5)).toHaveLength(1);

  // Somebody else's number as the adder: refused.
  const notOrganiser = await relinkScript(["--apply"], W5, "447700900999");
  expect(notOrganiser.stdout).toContain("REFUSED: the adder given is not this request's organiser");
  expect(await connect(db, W5)).toMatchObject({ groupId: W5.parent });

  const applied = await relinkScript(["--apply"], W5);
  console.log(`[relink apply]\n${applied.stdout}`);
  expect(applied.stdout).toContain("result: linked");
  expect(applied.stdout).toContain("owner DM: corrected");
  expect(await connect(db, W5)).toMatchObject({
    status: "group_linked",
    groupId: W5.main,
    groupSubject: "Friday Night Football 🏟",
    memberCount: 49,
    adderMatch: "phone",
  });
  expect(await clubStatus(db, W5)).toBe("pending");
  const owner = await ownerDms(db, W5);
  expect(owner.map((j) => j.refId)).toEqual([W5.cc, `${W5.cc}:relinked:${W5.main}`]);
  expect(owner[1].text).toContain(`Correction: *FNF* (ref ${W5.code}) is now linked to "Friday Night Football 🏟", 49 members.`);
  expect(await organiserAcks(db, W5)).toHaveLength(1);

  // Run again: refused (already linked there), nothing new.
  const again = await relinkScript(["--apply"], W5);
  expect(again.stdout).toContain("REFUSED");
  expect(await ownerDms(db, W5)).toHaveLength(2);
});
