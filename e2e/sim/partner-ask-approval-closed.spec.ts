/**
 * Group-simulator scenario: an ask a partner club's organisers were asked
 * to APPROVE closes before they answer (Monday night vets and FNF HQ,
 * 2026-11-09). Sutton FC, with standing approval, had the ask posted and
 * heard "filled"; FNF, asked to approve in HQ, heard nothing, and the
 * approval question sat there for a game that needed nobody.
 *
 *   - the partner has HQ: the approval is asked there; when the asking
 *     club's places fill, ONE "no longer needed" line goes to that HQ, once,
 *     and NOTHING to its players' group;
 *   - a late "@Match Time YES" replying to the old approval posts nothing
 *     anywhere and says it is no longer needed;
 *   - the partner has no HQ (its admins were asked by DM): the same line, by
 *     DM, to the same admins.
 *
 * Stubbed: the asking organiser's words (router admin_ops, extractor
 * `recruit` from partners) and the HQ router's `approve`. Everything else is
 * the shipped code: `requestPartnerAsk`, the approval notice and its
 * record, the due-posts sweep, `tellClose`, the HQ safe-YES door. $0.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect, resetDb } from "../fixtures";
import { E2E } from "../helpers/env";
import { clearPipelineStubs, engineOn } from "../helpers/stub";
import type { TestDb } from "../helpers/test-db";
import { createGroup } from "./group";

const ASK = "@Match Time ask Friday Night Football if anyone can play";
const recruitFromPartners = {
  route: "admin_ops",
  facts: {
    action: "recruit",
    payerRef: "",
    count: 0,
    coveredRefs: [],
    undo: false,
    matchDay: "",
    phrase: "",
    note: "",
    lookbackMatches: 0,
    playersFrom: "partners",
    clubRef: "Friday Night Football",
  },
};

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  resetDb();
});
test.afterAll(() => {
  clearPipelineStubs();
  resetDb();
});

let seq = 0;

/** Monday Night Vets (2 of 4 in) and its partner Friday Night Football,
 *  which approves each ask; with HQ, or with its admins by DM. */
async function world(request: APIRequestContext, db: TestDb, opts: { hq: boolean }) {
  const n = ++seq;
  const asker = await createGroup(request, db, {
    name: "Monday Night Vets",
    maxPlayers: 4,
    attendance: [
      { key: "owner", status: "CONFIRMED" },
      { key: "alice", status: "CONFIRMED" },
    ],
  });
  const partner = await createGroup(request, db, { name: "Friday Night Football", upcomingMatch: false });
  const hq = `sim-hq-xclose-${n}@g.us`;
  await db.run(`UPDATE "Organisation" SET "quietHoursEnabled" = false WHERE id = $1`, [partner.orgId]);
  if (opts.hq) await db.run(`UPDATE "Organisation" SET "adminGroupId" = $2, "adminChannelMode" = 'admin-group' WHERE id = $1`, [partner.orgId, hq]);
  await db.run(
    `INSERT INTO "ClubPartnership" (id,"askerOrgId","partnerOrgId",status,"partnerApproval","askerAcceptedAt","partnerAcceptedAt","createdByUserId","createdAt","updatedAt")
     VALUES ($1,$2,$3,'active','each-ask',now(),now(),$4,now(),now())`,
    [`sim-xclose-pair-${n}`, asker.orgId, partner.orgId, asker.player("owner").userId],
  );
  return { asker: asker.attach(request), partner: partner.attach(request), hq };
}

const theAsk = (db: TestDb, askerOrgId: string) =>
  db.one<{ id: string; status: string; reason: string | null }>(`SELECT id, status, reason FROM "PartnerAsk" WHERE "askerOrgId" = $1`, [askerOrgId]);

const NO_LONGER = /^✅ No longer needed: \*Monday Night Vets\* have filled their places for \w{3} \d{1,2} \w{3}\. Thanks, nothing to do\.$/;

test("the partner has HQ: asked there; the places fill: ONE line in HQ, nothing in its players' group; a late YES posts nothing", async ({ request, db }) => {
  const { asker, partner, hq } = await world(request, db, { hq: true });
  await asker.post("owner", ASK, { ...recruitFromPartners, tag: true });
  const ask = await theAsk(db, asker.orgId);
  expect(ask?.status).toBe("awaiting-approval");
  // The approval question went to FNF's HQ, and is on record.
  const asked = await partner.botJobs("admin-group");
  expect(asked).toHaveLength(1);
  expect(asked[0].text).toMatch(/OK to post this in your players' group\?/);
  expect(await db.one(`SELECT key FROM "SentNotification" WHERE key = $1`, [`xask:${ask!.id}:approval-asked`])).toBeTruthy();

  // Monday Night Vets fill their own places.
  await asker.setAttendance("pete", "CONFIRMED");
  await asker.setAttendance("dan", "CONFIRMED");
  await asker.duePosts(new Date(), { claim: true });
  expect(await theAsk(db, asker.orgId)).toMatchObject({ status: "cancelled", reason: "filled" });
  const hqLines = (await partner.botJobs("admin-group")).map((j) => j.text);
  expect(hqLines).toHaveLength(2);
  expect(hqLines[1]).toMatch(NO_LONGER);
  // Never FNF's players' group: it never saw the ask.
  expect(await partner.botJobs("group")).toEqual([]);

  // Once: the next poll tells nobody again.
  await asker.duePosts(new Date(), { claim: true });
  await partner.duePosts(new Date(), { claim: true });
  expect(await partner.botJobs("admin-group")).toHaveLength(2);

  // An organiser's late "@Match Time YES", replying to the old approval.
  engineOn({ yes: { route: "approve" } });
  const question = await db.one<{ text: string }>(`SELECT text FROM "AdminGroupMessage" WHERE "orgId" = $1 AND "askRef" = $2`, [partner.orgId, `xask:${ask!.id}`]);
  const res = await request.post("/api/whatsapp/admin-group", {
    headers: { "x-api-key": E2E.WHATSAPP_API_KEY },
    data: {
      channel: "admin-group",
      botMentioned: true,
      groupId: hq,
      messageId: `sim-xclose-yes-${Date.now()}`,
      text: "yes",
      senderPhone: partner.player("owner").phone!.replace(/^\+/, ""),
      timestamp: String(Math.floor(Date.now() / 1000)),
      quotedText: question!.text,
      quotedFromMatchTime: true,
    },
  });
  expect(res.status(), await res.text()).toBe(200);
  const out = (await res.json()) as { outcome?: string; replyText?: string | null };
  expect(out.outcome).toBe("xask-no-longer-needed");
  expect(out.replyText).toMatch(/^No longer needed: \*Monday Night Vets\*'s ask for \w{3} \d{1,2} \w{3} has closed, so I haven't posted anything\. Nothing to do\.$/);
  expect(await theAsk(db, asker.orgId)).toMatchObject({ status: "cancelled" });
  expect(await partner.botJobs("group")).toEqual([]);
});

test("the partner has no HQ: its admins were asked by DM, and the same admins hear it is no longer needed, by DM", async ({ request, db }) => {
  const { asker, partner } = await world(request, db, { hq: false });
  await asker.post("owner", ASK, { ...recruitFromPartners, tag: true });
  const askedTo = (await partner.botJobs("dm")).filter((j) => /OK to post|say yes or no/i.test(j.text)).map((j) => j.phone);
  expect(askedTo.length).toBeGreaterThan(0);

  await asker.setAttendance("pete", "CONFIRMED");
  await asker.setAttendance("dan", "CONFIRMED");
  await asker.duePosts(new Date(), { claim: true });
  const told = (await partner.botJobs("dm")).filter((j) => NO_LONGER.test(j.text)).map((j) => j.phone);
  expect(told.sort()).toEqual([...askedTo].sort());
  expect(await partner.botJobs("group")).toEqual([]);
  expect(await partner.botJobs("admin-group")).toEqual([]);
});
